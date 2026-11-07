import { describe, expect, it, vi } from 'vitest'
import { barrier, modeFixture } from './mode-fixture.ts'
import { WorkspaceId } from '../src/index.ts'

describe('workspace mode coordination', () => {
  it('persists four modes with increasing revisions and rejects stale edits', async () => {
    const f = await modeFixture()
    f.ctx.effect(() => f.registry.modes.registerRuntime(f.adapter))
    expect(f.workspace.modeConfig).toMatchObject({ mode: 'multi-vm', revision: 0, modeLocked: false, operationState: 'ready' })
    for (const mode of ['single-vm', 'single-docker', 'multi-docker', 'multi-vm'] as const) {
      const revision = f.workspace.modeConfig.revision
      const result = await f.registry.modes.setMode({ workspaceId: f.workspace.id, mode, expectedRevision: revision }, f.options)
      expect(result).toMatchObject({ mode, operationState: 'ready', revision: revision + 3 })
      await expect(f.registry.modes.setMode({ workspaceId: f.workspace.id, mode: 'single-vm', expectedRevision: revision }, f.options))
        .rejects.toMatchObject({ code: 'workspace/mode-revision-conflict' })
    }
    await expect(f.registry.modes.setMode({ workspaceId: f.workspace.id, mode: 'multi-vm', expectedRevision: f.workspace.modeConfig.revision }, f.options))
      .resolves.toEqual(f.workspace.modeConfig)
    expect(f.adapter.prepare).toHaveBeenCalledTimes(4)
    expect(() => f.registry.modes.get(WorkspaceId('absent'))).toThrow('workspace/not-found')
  })

  it('rejects unavailable or unsupported adapters before writing intent', async () => {
    const f = await modeFixture()
    const request = { workspaceId: f.workspace.id, mode: 'single-vm' as const, expectedRevision: 0 }
    await expect(f.registry.modes.setMode(request, f.options)).rejects.toMatchObject({ code: 'workspace/mode-runtime-unavailable' })
    expect(() => f.registry.modes.registerRuntime({ ...f.adapter, supportedModes: ['single-vm'] })).toThrow('default mode')
    f.ctx.effect(() => f.registry.modes.registerRuntime({ ...f.adapter, supportedModes: ['multi-vm'] }))
    await expect(f.registry.modes.setMode(request, f.options)).rejects.toMatchObject({ code: 'workspace/mode-unsupported' })
    expect(f.workspace.modeConfig.revision).toBe(0)
  })

  it('lets readers share a slot and keeps later readers behind a waiting writer', async () => {
    const f = await modeFixture()
    f.ctx.effect(() => f.registry.modes.registerRuntime(f.adapter))
    const first = await f.registry.modes.acquireUse(f.workspace.id, f.options)
    const second = await f.registry.modes.acquireUse(f.workspace.id, f.options)
    const prepared = barrier(), finish = barrier()
    f.adapter.prepare = vi.fn(async () => { prepared.resolve(); await finish.promise })
    const change = f.registry.modes.setMode({ workspaceId: f.workspace.id, mode: 'single-vm', expectedRevision: 0 }, f.options)
    const reader = f.registry.modes.acquireUse(f.workspace.id, f.options)
    expect(f.adapter.prepare).not.toHaveBeenCalled()
    first.release(); first.release()
    expect(f.adapter.prepare).not.toHaveBeenCalled()
    second.release()
    await prepared.promise
    expect(f.registry.modes.get(f.workspace.id)).toMatchObject({ mode: 'multi-vm', operationState: 'switching' })
    finish.resolve()
    await change
    const lease = await reader
    expect(lease.config.mode).toBe('single-vm')
    lease.release()
  })

  it('rechecks captured authority after waiting and releases rejected slots', async () => {
    const f = await modeFixture()
    const lease = await f.registry.modes.acquireUse(f.workspace.id, f.options)
    let authorized = true
    const options = { ...f.options, admit: () => { if (!authorized) throw new Error('authority lost') } }
    const change = f.registry.modes.setMode({ workspaceId: f.workspace.id, mode: 'single-vm', expectedRevision: 0 }, options)
    authorized = false; lease.release()
    await expect(change).rejects.toThrow('authority lost')
    const following = await f.registry.modes.acquireUse(f.workspace.id, f.options)
    following.release()
  })

  it('settles rollback before reporting preparation failure', async () => {
    const f = await modeFixture()
    f.adapter.prepare = vi.fn(async () => { throw new Error('copy failed') })
    f.ctx.effect(() => f.registry.modes.registerRuntime(f.adapter))
    await expect(f.registry.modes.setMode({ workspaceId: f.workspace.id, mode: 'single-vm', expectedRevision: 0 }, f.options))
      .rejects.toMatchObject({ code: 'workspace/mode-switch-failed', details: { phase: 'prepare', recoveryRequired: false, outcomeUnknown: false } })
    expect(f.adapter.settle).toHaveBeenCalledWith(expect.objectContaining({ from: 'multi-vm', to: 'single-vm' }), 'rollback', expect.any(AbortSignal))
    expect(f.workspace.modeConfig).toMatchObject({ mode: 'multi-vm', operationState: 'ready' })
  })

  it('retains the commit identity and deduplicates concurrent recovery after settlement failure', async () => {
    const f = await modeFixture()
    f.adapter.settle = vi.fn(async () => { throw new Error('publish failed') })
    f.ctx.effect(() => f.registry.modes.registerRuntime(f.adapter))
    await expect(f.registry.modes.setMode({ workspaceId: f.workspace.id, mode: 'single-vm', expectedRevision: 0 }, f.options))
      .rejects.toMatchObject({ code: 'workspace/mode-switch-failed', details: { recoveryRequired: true } })
    const original = vi.mocked(f.adapter.settle).mock.calls[0]![0]
    expect(f.workspace.modeConfig).toMatchObject({ mode: 'multi-vm', operationState: 'recovery-required' })
    await expect(f.registry.modes.acquireUse(f.workspace.id, f.options)).rejects.toMatchObject({ code: 'workspace/mode-recovery-required' })
    const entered = barrier(), settled = barrier()
    f.adapter.settle = vi.fn(async () => { entered.resolve(); await settled.promise })
    const recovery = f.registry.modes.recover(f.workspace.id, f.options)
    await entered.promise
    const concurrent = f.registry.modes.recover(f.workspace.id, f.options)
    settled.resolve()
    await Promise.all([recovery, concurrent])
    expect(f.adapter.settle).toHaveBeenCalledExactlyOnceWith(original, 'commit', expect.any(AbortSignal))
    expect(f.workspace.modeConfig).toMatchObject({ mode: 'single-vm', operationState: 'ready' })
  })

  it('finishes the durable commit even if the caller cancels during settlement', async () => {
    const f = await modeFixture(), caller = new AbortController()
    f.adapter.settle = vi.fn(async (_change, _decision, signal) => {
      caller.abort()
      expect(signal.aborted).toBe(false)
    })
    f.ctx.effect(() => f.registry.modes.registerRuntime(f.adapter))
    await expect(f.registry.modes.setMode({ workspaceId: f.workspace.id, mode: 'single-docker', expectedRevision: 0 }, { ...f.options, signal: caller.signal }))
      .resolves.toMatchObject({ mode: 'single-docker', operationState: 'ready' })
  })

  it('loads pending intent without an adapter and retries automatic recovery after a failed attempt', async () => {
    const first = await modeFixture()
    first.adapter.settle = vi.fn(async () => { throw new Error('offline') })
    const unregister = first.registry.modes.registerRuntime(first.adapter)
    await expect(first.registry.modes.setMode({ workspaceId: first.workspace.id, mode: 'single-vm', expectedRevision: 0 }, first.options)).rejects.toThrow()
    await unregister()
    await first.ctx.fiber.dispose()
    const restarted = await modeFixture({ pool: first.pool, path: first.path })
    expect(restarted.workspace.modeConfig.operationState).toBe('recovery-required')
    restarted.adapter.settle = vi.fn(async () => { throw new Error('still offline') })
    const dispose = restarted.registry.modes.registerRuntime(restarted.adapter)
    await expect(restarted.registry.modes.recover(restarted.workspace.id, restarted.options)).rejects.toThrow('still offline')
    await dispose()
    restarted.ctx.effect(() => restarted.registry.modes.registerRuntime(first.adapter = {
      ...first.adapter, settle: vi.fn(async () => {}),
    }))
    await restarted.registry.modes.recover(restarted.workspace.id, restarted.options)
    expect(restarted.workspace.modeConfig).toMatchObject({ mode: 'single-vm', operationState: 'ready' })
  })

  it('withdraws admission and waits for real lease release before unregistering', async () => {
    const f = await modeFixture()
    const unregister = f.registry.modes.registerRuntime(f.adapter)
    const lease = await f.registry.modes.acquireUse(f.workspace.id, f.options)
    const disposal = unregister()
    expect(lease.signal.aborted).toBe(true)
    expect(() => lease.admit()).toThrow()
    let done = false
    void disposal.then(() => { done = true })
    await Promise.resolve()
    expect(done).toBe(false)
    lease.release()
    await disposal
    expect(done).toBe(true)
  })
  it('retries the rollback direction when preparation and rollback both fail', async () => {
    const f = await modeFixture()
    f.adapter.prepare = vi.fn(async () => { throw new Error('prepare failed') })
    f.adapter.settle = vi.fn(async () => { throw new Error('rollback failed') })
    f.ctx.effect(() => f.registry.modes.registerRuntime(f.adapter))
    await expect(f.registry.modes.setMode({ workspaceId: f.workspace.id, mode: 'single-vm', expectedRevision: 0 }, f.options))
      .rejects.toMatchObject({ details: { recoveryRequired: true } })
    const original = vi.mocked(f.adapter.settle).mock.calls[0]![0]
    f.adapter.settle = vi.fn(async () => {})
    await f.registry.modes.recover(f.workspace.id, f.options)
    expect(f.adapter.settle).toHaveBeenCalledExactlyOnceWith(original, 'rollback', expect.any(AbortSignal))
    expect(f.workspace.modeConfig).toMatchObject({ mode: 'multi-vm', operationState: 'ready' })
  })

  it('retains the commit decision when final metadata persistence fails', async () => {
    const f = await modeFixture()
    f.adapter.settle = vi.fn(async () => { f.pool.failNextWrites = 1 })
    f.ctx.effect(() => f.registry.modes.registerRuntime(f.adapter))
    await expect(f.registry.modes.setMode({ workspaceId: f.workspace.id, mode: 'multi-docker', expectedRevision: 0 }, f.options))
      .rejects.toMatchObject({ details: { phase: 'persist', recoveryRequired: true } })
    f.adapter.settle = vi.fn(async () => {})
    await f.registry.modes.recover(f.workspace.id, f.options)
    expect(f.adapter.settle).toHaveBeenCalledWith(expect.anything(), 'commit', expect.any(AbortSignal))
    expect(f.workspace.modeConfig.mode).toBe('multi-docker')
  })

  it('rolls back when writing the commit decision fails', async () => {
    const f = await modeFixture()
    f.adapter.prepare = vi.fn(async () => { f.pool.failNextWrites = 1 })
    f.ctx.effect(() => f.registry.modes.registerRuntime(f.adapter))
    await expect(f.registry.modes.setMode({ workspaceId: f.workspace.id, mode: 'single-vm', expectedRevision: 0 }, f.options))
      .rejects.toMatchObject({ details: { phase: 'persist', recoveryRequired: false } })
    expect(f.adapter.settle).toHaveBeenCalledWith(expect.anything(), 'rollback', expect.any(AbortSignal))
    expect(f.workspace.modeConfig).toMatchObject({ mode: 'multi-vm', operationState: 'ready' })
  })

  it('reports an initial persistence failure without invoking the runtime', async () => {
    const f = await modeFixture()
    f.ctx.effect(() => f.registry.modes.registerRuntime(f.adapter))
    f.pool.failNextWrites = 1
    await expect(f.registry.modes.setMode({ workspaceId: f.workspace.id, mode: 'single-vm', expectedRevision: 0 }, f.options))
      .rejects.toMatchObject({ code: 'workspace/mode-switch-failed', details: {
        phase: 'persist', recoveryRequired: false, outcomeUnknown: false,
      } })
    expect(f.adapter.prepare).not.toHaveBeenCalled()
    expect(f.workspace.modeConfig).toMatchObject({ mode: 'multi-vm', revision: 0, operationState: 'ready' })
  })

  it('cancels a queued reader without releasing another operation slot', async () => {
    const f = await modeFixture()
    const entered = barrier(), finish = barrier()
    f.adapter.prepare = vi.fn(async () => { entered.resolve(); await finish.promise })
    f.ctx.effect(() => f.registry.modes.registerRuntime(f.adapter))
    const change = f.registry.modes.setMode({ workspaceId: f.workspace.id, mode: 'single-vm', expectedRevision: 0 }, f.options)
    await entered.promise
    const caller = new AbortController()
    const reader = f.registry.modes.acquireUse(f.workspace.id, { ...f.options, signal: caller.signal })
    caller.abort()
    await expect(reader).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.workspace.modeConfig.operationState).toBe('switching')
    finish.resolve(); await change
  })

  it('allows a different Workspace to proceed while a reader holds the first', async () => {
    const f = await modeFixture(), other = await modeFixture()
    const lease = await f.registry.modes.acquireUse(f.workspace.id, f.options)
    other.ctx.effect(() => other.registry.modes.registerRuntime(other.adapter))
    await other.registry.modes.setMode({ workspaceId: other.workspace.id, mode: 'single-vm', expectedRevision: 0 }, other.options)
    expect(other.workspace.modeConfig.mode).toBe('single-vm')
    lease.release()
  })

})
