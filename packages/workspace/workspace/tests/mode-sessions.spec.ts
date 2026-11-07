import { expect, it, vi } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { WorkspaceSessionAdmission } from '../src/mode-sessions.ts'
import { barrier, modeFixture } from './mode-fixture.ts'

function persist(f: Awaited<ReturnType<typeof modeFixture>>, id: SessionId): void {
  const header: SessionHeader = { id, cwd: f.path, version: SESSION_FORMAT_VERSION, createdAt: Date.now(), isSeeded: false }
  f.headers.set(id, header)
}

function createIn(f: Awaited<ReturnType<typeof modeFixture>>) {
  return async (admission: WorkspaceSessionAdmission) => {
    persist(f, admission.sessionId)
    return { sessionId: admission.sessionId, value: admission.sessionId }
  }
}

it.each(['single-vm', 'single-docker'] as const)('saves at most one ordinary Session under competing %s creates', async (mode) => {
  const f = await modeFixture({ mode })
  const entered = barrier(), finish = barrier()
  const create = vi.fn(async (admission: WorkspaceSessionAdmission) => {
    entered.resolve(); await finish.promise
    return createIn(f)(admission)
  })
  const first = f.registry.withSessionCreation(f.workspace.id, undefined, create, f.options)
  await entered.promise
  const second = f.registry.withSessionCreation(f.workspace.id, undefined, create, f.options)
  finish.resolve()
  const id = await first
  await expect(second).rejects.toMatchObject({ code: 'workspace/session-limit', details: { firstSessionId: id } })
  expect(create).toHaveBeenCalledOnce()
  expect(f.headers.size).toBe(1)
  expect(f.workspace.modeConfig).toMatchObject({ modeLocked: true, firstSessionId: id, operationState: 'ready' })
  expect(f.workspace.sessionIds).toEqual([id])
})

it('waits for switching before capturing the first Session mode', async () => {
  const f = await modeFixture()
  const prepared = barrier(), settled = barrier()
  f.adapter.prepare = vi.fn(async () => { prepared.resolve(); await settled.promise })
  f.ctx.effect(() => f.registry.modes.registerRuntime(f.adapter))
  const change = f.registry.modes.setMode({ workspaceId: f.workspace.id, mode: 'single-docker', expectedRevision: 0 }, f.options)
  await prepared.promise
  let captured: string | undefined
  const creation = f.registry.withSessionCreation(f.workspace.id, undefined, async (admission) => {
    captured = admission.mode
    return createIn(f)(admission)
  }, f.options)
  settled.resolve(); await change; await creation
  expect(captured).toBe('single-docker')
})

it('permanently refuses a switch queued behind successful Session creation, including same-value edits', async () => {
  const f = await modeFixture()
  f.ctx.effect(() => f.registry.modes.registerRuntime(f.adapter))
  const entered = barrier(), finish = barrier()
  const creation = f.registry.withSessionCreation(f.workspace.id, undefined, async (admission) => {
    entered.resolve(); await finish.promise
    return createIn(f)(admission)
  }, f.options)
  await entered.promise
  const change = f.registry.modes.setMode({ workspaceId: f.workspace.id, mode: 'single-vm', expectedRevision: 0 }, f.options)
  finish.resolve(); await creation
  await expect(change).rejects.toMatchObject({ code: 'workspace/mode-locked' })
  await expect(f.registry.modes.setMode({ workspaceId: f.workspace.id, mode: 'multi-vm', expectedRevision: f.workspace.modeConfig.revision }, f.options))
    .rejects.toMatchObject({ code: 'workspace/mode-locked' })
  expect(f.adapter.prepare).not.toHaveBeenCalled()
})

it('releases the reservation after a definite creation miss', async () => {
  const f = await modeFixture({ mode: 'single-vm' })
  await expect(f.registry.withSessionCreation(f.workspace.id, undefined, async () => { throw new Error('preset unavailable') }, f.options))
    .rejects.toThrow('preset unavailable')
  expect(f.workspace.modeConfig).toMatchObject({ operationState: 'ready', modeLocked: false, firstSessionId: null })
  await f.registry.withSessionCreation(f.workspace.id, undefined, createIn(f), f.options)
  expect(f.headers.size).toBe(1)
})

it('retains a failed setup identity with a durable log and recovers it only after lifecycle takeover', async () => {
  const f = await modeFixture({ mode: 'single-vm' }), id = SessionId('failed-setup')
  await expect(f.registry.withSessionCreation(f.workspace.id, id, async () => {
    persist(f, id); throw new Error('setup failed after save')
  }, f.options)).rejects.toMatchObject({ code: 'workspace/mode-recovery-required' })
  expect(f.registry.findSession(id)?.id).toBe(f.workspace.id)
  await expect(f.registry.withSessionCreation(f.workspace.id, undefined, createIn(f), f.options))
    .rejects.toMatchObject({ code: 'workspace/mode-recovery-required' })
  await expect(f.registry.modes.recover(f.workspace.id, f.options)).rejects.toMatchObject({ code: 'workspace/mode-recovery-required' })
  f.ctx.on('workspace/recover-session', async (_id, next) => { await next(); return true })
  await f.registry.modes.recover(f.workspace.id, f.options)
  expect(f.workspace.modeConfig).toMatchObject({ firstSessionId: id, modeLocked: true, operationState: 'ready' })
  expect(f.headers.size).toBe(1)
})

it('retains the reservation after atomic attachment persistence fails', async () => {
  const f = await modeFixture({ mode: 'single-docker' }), id = SessionId('attach-failed')
  await expect(f.registry.withSessionCreation(f.workspace.id, id, async (admission) => {
    const result = await createIn(f)(admission)
    f.pool.failNextWrites = 1
    return result
  }, f.options)).rejects.toMatchObject({ code: 'workspace/mode-recovery-required' })
  expect(f.workspace.sessionIds).toEqual([])
  expect(f.workspace.modeConfig.firstSessionId).toBeNull()
  f.ctx.on('workspace/recover-session', async (_id, next) => { await next(); return true })
  await f.registry.modes.recover(f.workspace.id, f.options)
  expect(f.workspace.modeConfig.firstSessionId).toBe(id)
})

it('preserves quota and forbids archives and forks after the first Session is filtered', async () => {
  const f = await modeFixture({ mode: 'single-vm' }), id = await f.registry.withSessionCreation(f.workspace.id, undefined, createIn(f), f.options)
  await f.ctx.fiber.dispose()
  const next = await modeFixture({ pool: f.pool, path: f.path })
  expect(next.workspace.sessionIds).toEqual([])
  expect(next.registry.findSession(id)?.id).toBe(next.workspace.id)
  expect(() => next.registry.assertSessionOperation(id, 'fork')).toThrow('workspace/session-operation-forbidden')
  const stop = vi.fn()
  next.ctx.on('workspace/session-stop', stop)
  await expect(next.registry.archiveSession(id, { stopActivity: true })).rejects.toMatchObject({ code: 'workspace/session-operation-forbidden' })
  expect(stop).not.toHaveBeenCalled()
  await expect(next.registry.withSessionCreation(next.workspace.id, undefined, createIn(next), next.options)).rejects.toMatchObject({ code: 'workspace/session-limit' })
})

it('reuses the same single-mode identity and refuses a replacement reservation', async () => {
  const f = await modeFixture({ mode: 'single-vm' }), id = await f.registry.withSessionCreation(f.workspace.id, undefined, createIn(f), f.options)
  await expect(f.registry.withSessionCreation(f.workspace.id, id, async (admission) => {
    await admission.reserve(SessionId('replacement'))
    return { sessionId: id, value: id }
  }, f.options)).rejects.toMatchObject({ code: 'session/reuse-unavailable' })
  expect(f.workspace.modeConfig.operationState).toBe('ready')
  expect(f.headers.size).toBe(1)
  await expect(f.registry.withSessionCreation(f.workspace.id, id, createIn(f), f.options)).resolves.toBe(id)
})

it('reserves a multi-mode fallback before writing and preserves the first permanent lock', async () => {
  const f = await modeFixture()
  const first = await f.registry.withSessionCreation(f.workspace.id, undefined, createIn(f), f.options)
  const replacement = SessionId('multi-replacement')
  await f.registry.withSessionCreation(f.workspace.id, first, async (admission) => {
    await admission.reserve(replacement)
    expect(f.registry.findSession(replacement)?.id).toBe(f.workspace.id)
    persist(f, replacement)
    return { sessionId: replacement, value: replacement }
  }, f.options)
  expect(f.workspace.sessionIds).toEqual([replacement, first])
  expect(f.workspace.modeConfig.firstSessionId).toBe(first)
  await f.registry.archiveSession(replacement)
  expect(f.registry.archivedSessionIds).toEqual([replacement])
})

it('blocks message admission until creation and recovery have settled', async () => {
  const f = await modeFixture({ mode: 'single-vm' }), id = SessionId('message-pending')
  await expect(f.registry.withSessionCreation(f.workspace.id, id, async (admission) => {
    persist(f, admission.sessionId)
    expect(() => f.registry.assertSessionReady(id)).toThrow('workspace/mode-recovery-required')
    throw new Error('setup left a log')
  }, f.options)).rejects.toMatchObject({ code: 'workspace/mode-recovery-required' })
  expect(() => f.registry.assertSessionReady(id)).toThrow('workspace/mode-recovery-required')
  f.ctx.on('workspace/recover-session', async (_id, next) => { await next(); return true })
  await f.registry.modes.recover(f.workspace.id, f.options)
  expect(() => f.registry.assertSessionReady(id)).not.toThrow()
})

it('aborts creation on runtime withdrawal and drains its actual cleanup', async () => {
  const f = await modeFixture(), entered = barrier(), finish = barrier(), aborted = barrier()
  const dispose = f.registry.modes.registerRuntime(f.adapter)
  const creation = f.registry.withSessionCreation(f.workspace.id, undefined, async (admission) => {
    admission.signal.addEventListener('abort', () => { aborted.resolve() }, { once: true })
    entered.resolve(); await finish.promise
    admission.signal.throwIfAborted()
    return createIn(f)(admission)
  }, f.options)
  await entered.promise
  let disposed = false
  const disposal = dispose().then(() => { disposed = true })
  await aborted.promise
  expect(disposed).toBe(false)
  finish.resolve()
  await expect(creation).rejects.toMatchObject({ name: 'AbortError' })
  await disposal
  expect(f.headers.size).toBe(0)
  expect(f.workspace.modeConfig.operationState).toBe('ready')
})

it('refuses a retained identity from another Workspace before reserving or creating', async () => {
  const f = await modeFixture()
  const first = await f.registry.withSessionCreation(f.workspace.id, undefined, createIn(f), f.options)
  const other = await modeFixture()
  const target = await f.registry.create(other.path)
  const create = vi.fn(createIn(f))
  await expect(f.registry.withSessionCreation(target.id, first, create, f.options)).rejects.toThrow('another Workspace')
  expect(create).not.toHaveBeenCalled()
  expect(target.modeConfig).toMatchObject({ revision: 0, modeLocked: false, operationState: 'ready' })
})

it('rechecks captured creation authority in the final attachment write', async () => {
  const f = await modeFixture()
  let checks = 0
  const options = { ...f.options, admit: () => {
    if (++checks === 3) throw new Error('ownership revoked before attachment')
  } }
  await expect(f.registry.withSessionCreation(f.workspace.id, undefined, createIn(f), options))
    .rejects.toMatchObject({ code: 'workspace/mode-recovery-required' })
  expect(checks).toBe(3)
  expect(f.workspace.modeConfig).toMatchObject({ operationState: 'recovery-required', firstSessionId: null })
  expect(f.headers.size).toBe(1)
})
