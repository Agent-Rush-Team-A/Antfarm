/** Real account, prompt, inbox and native tool consumers with substituted mode coordinators/providers. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import type { WorkspaceFileScope } from '@deepseek-ai/dsh-fs/workspace-access'
import type { IWorkspaceModes, WorkspaceId, WorkspaceMode, WorkspaceModeOperationOptions } from '@deepseek-ai/dsh-workspace/types'
import WorkspaceSandbox from '../src/index.ts'
import WorkspaceModeBackend from '../src/mode-backend.ts'
import { WorkspaceModeDirectoryFiles } from '../src/mode-directory-files.ts'
import { WorkspaceModeRuntimeAdapter } from '../src/mode-runtime.ts'
import type { WorkspaceModeTarget } from '../src/mode-routing.ts'
import type { RunnerRunningSandbox, SandboxContainerId } from '../src/runner-client.ts'
import * as Bash from '../src/bash.ts'
import * as Files from '../src/files.ts'
import { conversationFixture } from './fixtures/conversation.ts'
import { BashModel } from './fixtures/bash.ts'

const modes: readonly WorkspaceMode[] = ['single-vm', 'multi-vm', 'single-docker', 'multi-docker']

async function fixture(mode: WorkspaceMode = 'single-docker') {
  const model = new BashModel()
  const f = await conversationFixture(model)
  await f.unloadConversation()
  await f.sandboxFiber.dispose()
  const files = f.ctx.isolate('fs')
  await files.plugin(LocalFileSystem, { cwd: f.home })
  const selected = new Map<WorkspaceId, WorkspaceMode>([[f.alice.id, mode], [f.bob.id, 'multi-vm']])
  const counts = new Map<WorkspaceId, number>()
  const config = (id: WorkspaceId) => ({ workspaceId: id, mode: selected.get(id)!, revision: 1,
    operationState: 'ready' as const, modeLocked: true, lockReason: 'first-session-created' as const, firstSessionId: f.agent.id })
  const lease = (id: WorkspaceId, options: WorkspaceModeOperationOptions) => {
    options.admit()
    counts.set(id, (counts.get(id) ?? 0) + 1)
    let released = false
    return { config: config(id), signal: options.signal, admit: () => { options.signal.throwIfAborted(); options.admit() },
      release: () => { if (!released) { released = true; counts.set(id, counts.get(id)! - 1) } } }
  }
  const coordinator = {
    get: config,
    acquireUse: vi.fn(async (id: WorkspaceId, options: WorkspaceModeOperationOptions) => lease(id, options)),
    registerRuntime: vi.fn(() => vi.fn(async () => {})),
  } satisfies Pick<IWorkspaceModes, 'get' | 'acquireUse' | 'registerRuntime'>
  let sequence = 0
  const targets = new Map<WorkspaceMode, WorkspaceModeTarget & { roots: Map<WorkspaceId, string>; created: RunnerRunningSandbox[] }>()
  for (const value of modes) {
    const roots = new Map<WorkspaceId, string>()
    for (const account of [f.alice, f.bob]) {
      const root = value.endsWith('docker') ? account.workspace.path : join(f.home, value, account.id)
      await mkdir(root, { recursive: true })
      roots.set(account.id, root)
    }
    const running = new Map<WorkspaceId, RunnerRunningSandbox>()
    const created: RunnerRunningSandbox[] = []
    const backend = {
      open: vi.fn(async (id: WorkspaceId) => {
        const existing = running.get(id)
        if (existing !== undefined) return existing
        const target = { state: 'running' as const, containerId: brandString<SandboxContainerId>(`${value}-${++sequence}`) }
        running.set(id, target)
        created.push(target)
        return target
      }),
      close: vi.fn(async (id: WorkspaceId) => { running.delete(id); return { state: 'closed' as const } }),
      status: vi.fn(async (id: WorkspaceId) => running.get(id) ?? { state: 'closed' as const }),
      execute: vi.fn<WorkspaceModeTarget['execution']['execute']>(async (_id, request) => ({ executionId: request.executionId, exitCode: 0,
        stdout: { text: value, truncated: false }, stderr: { text: '', truncated: false } })),
      cancel: vi.fn<WorkspaceModeTarget['execution']['cancel']>(async (_id, request) => ({ executionId: request.executionId,
        containerId: request.expectedContainerId, cancellation: 'requested' as const })),
      files: vi.fn<WorkspaceModeTarget['execution']['files']>(async (id, target, signal) => {
        if (running.get(id)?.containerId !== target) throw new Error('Original generation unavailable')
        return { fs: files.fs, root: roots.get(id)!, signal: signal ?? new AbortController().signal,
          assertCurrent: () => { if (running.get(id)?.containerId !== target) throw new Error('Original generation unavailable') } }
      }),
    } satisfies WorkspaceModeTarget['execution']
    targets.set(value, { execution: backend, roots, created,
      files: new WorkspaceModeDirectoryFiles(async scope => ({ root: roots.get(scope.workspaceId)!,
        assertCurrent: () => { scope.admit() } })) })
  }
  const resources = new Map(modes.map(value => [value, {
    checkpoint: async () => ({ root: f.alice.workspace.path }), stage: async () => {}, publish: async () => {},
    retire: async () => {}, discard: async () => {}, restore: async () => {},
  }]))
  const fiber = f.ctx.plugin(WorkspaceModeBackend, { modes: coordinator, targets, runtime: new WorkspaceModeRuntimeAdapter(resources) })
  await fiber
  await f.ctx.plugin(WorkspaceSandbox, { backend: 'provided', workspaceRoot: f.workspaceRoot })
  await f.reloadConversation()
  await f.ctx.plugin(Bash)
  await f.ctx.plugin(Files)
  const results: import('@deepseek-ai/dsh-session').SessionEvent<'tool/result'>[] = []
  f.ctx.on('session/event', (_session, event) => { if (event.type === 'tool/result') results.push(event) }, { global: true })
  const scope: WorkspaceFileScope = { workspaceId: f.alice.id, project: f.alice.workspace.path,
    signal: new AbortController().signal, admit: () => {} }
  return { ...f, model, coordinator, lease, counts, targets, fiber, scope, selected, results,
    backend: targets.get(mode)!.execution, created: targets.get(mode)!.created,
    run: async (name = 'bash', args: unknown = { command: 'pwd', description: 'Inspect directory' }) => {
      model.toolName = name; model.args = args
      await f.prompt(randomUUID())
      f.release()
      await f.agent.whenIdle()
    } }
}

test.each(modes)('%s routes the real native Bash consumer and preserves its lifecycle policy', async (mode) => {
  const f = await fixture(mode)
  await f.run()
  expect(f.backend.execute).toHaveBeenCalledOnce()
  for (const [other, target] of f.targets) if (other !== mode) expect(target.execution.execute).not.toHaveBeenCalled()
  expect(JSON.stringify(f.results)).toContain(mode)
  if (mode.startsWith('single')) {
    await vi.waitFor(() =>{  expect(f.backend.close).toHaveBeenCalledOnce() })
    expect(await f.rpc(f.alice.cookie, 'open', { workspaceId: f.alice.id })).toMatchObject({ ok: false,
      error: { code: 'sandbox/manual-operation-forbidden' } })
  } else {
    expect(f.backend.close).not.toHaveBeenCalled()
    expect(await f.rpc(f.alice.cookie, 'close', { workspaceId: f.alice.id })).toMatchObject({ ok: true })
  }
})

test.each(['multi-docker', 'multi-vm'] as const)('%s manual opening stays counted while mode admission waits', async (mode) => {
  const f = await fixture(mode)
  const waiting = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<undefined>()
  f.coordinator.acquireUse.mockImplementationOnce(async (id, options) => {
    entered.resolve(undefined); await waiting.promise; return f.lease(id, options)
  })
  const opened = f.ctx.workspaceSandbox.openForUser(f.alice.user.userId, f.alice.id)
  try {
    expect(f.ctx.workspaceSandbox.activityForUser(f.alice.user.userId, f.alice.id))
      .toMatchObject({ busy: true, openings: 1, idleSince: null })
    await entered.promise
    expect(f.ctx.workspaceSandbox.activityForUser(f.alice.user.userId, f.alice.id))
      .toMatchObject({ busy: true, openings: 1, idleSince: null })
    expect(f.backend.open).not.toHaveBeenCalled()
  } finally { waiting.resolve(undefined); await opened }
  expect(f.ctx.workspaceSandbox.activityForUser(f.alice.user.userId, f.alice.id))
    .toMatchObject({ busy: false, openings: 0, sandbox: { state: 'running' } })
  expect(f.backend.open).toHaveBeenCalledOnce()
  expect(f.counts.get(f.alice.id)).toBe(0)
})

test('failed manual mode admission releases its opening count without starting a sandbox', async () => {
  const f = await fixture('multi-docker')
  const failure = new Error('Mode admission unavailable')
  f.coordinator.acquireUse.mockRejectedValueOnce(failure)
  const opened = f.ctx.workspaceSandbox.openForUser(f.alice.user.userId, f.alice.id)
  expect(f.ctx.workspaceSandbox.activityForUser(f.alice.user.userId, f.alice.id))
    .toMatchObject({ busy: true, openings: 1 })
  await expect(opened).rejects.toBe(failure)
  expect(f.ctx.workspaceSandbox.activityForUser(f.alice.user.userId, f.alice.id))
    .toMatchObject({ busy: false, openings: 0, idleSince: null })
  expect(f.backend.open).not.toHaveBeenCalled()
})

test.each(['cancelled', 'failed'] as const)('stopped idle scan preserves %s mode admission outcome', async (outcome) => {
  const f = await fixture('multi-docker')
  let now = 100
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  await f.ctx.workspaceSandbox.openForUser(f.alice.user.userId, f.alice.id)
  const activity = f.ctx.workspaceSandbox.activityForUser(f.alice.user.userId, f.alice.id)
  if (activity.sandbox.state !== 'running' || activity.idleSince === null) throw new Error('Expected idle running sandbox')
  const target = { revision: activity.revision, idleSince: activity.idleSince,
    version: activity.version, containerId: activity.sandbox.containerId }
  now += 1000
  const waiting = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<undefined>()
  const lifetime = new AbortController()
  const failure = new Error('Mode admission failed independently of cancellation')
  f.coordinator.acquireUse.mockImplementationOnce(async (_id, options) => {
    entered.resolve(undefined); await waiting.promise
    if (outcome === 'failed') throw failure
    options.signal.throwIfAborted()
    throw new Error('Expected aborted mode admission')
  })
  const closed = f.ctx.workspaceSandbox.closeIfIdleForUser(f.alice.user.userId, f.alice.id, target, 1000, lifetime.signal)
  const checked = outcome === 'cancelled'
    ? expect(closed).resolves.toEqual({ state: 'skipped' }) : expect(closed).rejects.toBe(failure)
  try {
    await entered.promise
    lifetime.abort(new Error('Idle scanner stopped'))
  } finally { waiting.resolve(undefined); await checked }
  expect(f.ctx.workspaceSandbox.activityForUser(f.alice.user.userId, f.alice.id)).toEqual(activity)
  expect(f.backend.status).not.toHaveBeenCalled()
  expect(f.backend.close).not.toHaveBeenCalled()
  expect(f.counts.get(f.alice.id)).toBe(0)
})

test('input received before recycling retains the current generation while coordinator admission waits', async () => {
  const f = await fixture()
  await f.prompt('first')
  await f.entered.promise
  const waiting = Promise.withResolvers<undefined>()
  const received = Promise.withResolvers<undefined>()
  f.coordinator.acquireUse.mockImplementationOnce(async (id, options) => {
    received.resolve(undefined); await waiting.promise; return f.lease(id, options)
  })
  const next = f.prompt('next')
  await received.promise
  f.release()
  await f.agent.whenIdle()
  expect(f.backend.close).not.toHaveBeenCalled()
  waiting.resolve(undefined)
  await next
  await f.agent.whenIdle()
  await vi.waitFor(() =>{  expect(f.backend.close).toHaveBeenCalledOnce() })
  expect(f.backend.open).toHaveBeenCalledOnce()
})

test('input during deletion waits for another generation and status reports the existing barrier', async () => {
  const f = await fixture()
  const deletion = Promise.withResolvers<undefined>()
  const started = Promise.withResolvers<undefined>()
  const close = vi.mocked(f.backend.close).getMockImplementation()!
  vi.mocked(f.backend.close).mockImplementationOnce(async (id) => { started.resolve(undefined); await deletion.promise; return close(id) })
  await f.run()
  await started.promise
  const next = f.prompt('after-close')
  expect(await f.rpc(f.alice.cookie, 'status', { workspaceId: f.alice.id })).toMatchObject({ ok: true, value: { state: 'closing' } })
  expect(f.backend.open).toHaveBeenCalledOnce()
  deletion.resolve(undefined)
  await next
  await f.agent.whenIdle()
  await vi.waitFor(() =>{  expect(f.backend.close).toHaveBeenCalledTimes(2) })
  expect(f.backend.open).toHaveBeenCalledTimes(2)
  expect(f.created[0]?.containerId).not.toBe(f.created[1]?.containerId)
})

test('single VM delegates the captured generation even after the helper health check fails', async () => {
  const f = await fixture('single-vm')
  const closeTask = vi.fn(async (id: WorkspaceId, target: SandboxContainerId) => {
    expect(target).toBe(f.created[0]?.containerId)
    return f.backend.close(id)
  })
  f.backend.closeTask = closeTask
  await f.prompt('original')
  await f.entered.promise
  vi.mocked(f.backend.status).mockResolvedValue({ state: 'cleanup_required' })
  f.release()
  await f.agent.whenIdle()
  await vi.waitFor(() => {
    expect(closeTask).toHaveBeenCalledExactlyOnceWith(f.alice.id, f.created[0]?.containerId)
  })
})

test('native write/edit/read use the selected persistent file world across task generations', async () => {
  const f = await fixture()
  await f.run('write', { file_path: '/workspace/result.txt', content: 'old value\n' })
  await f.run('edit', { file_path: '/workspace/result.txt', old_string: 'old', new_string: 'new' })
  await f.run('read', { file_path: '/workspace/result.txt' })
  expect(await readFile(join(f.alice.workspace.path, 'result.txt'), 'utf8')).toBe('new value\n')
  expect(JSON.stringify(f.results)).toContain('new value')
  expect(f.targets.get('multi-vm')!.execution.files).not.toHaveBeenCalled()
  await vi.waitFor(() =>{  expect(f.backend.close).toHaveBeenCalledTimes(3) })
})

test('an independent resource retains both the environment and mode lease after turn completion', async () => {
  const f = await fixture()
  await f.prompt('retained')
  const turn = await f.entered.promise
  const permission = f.ctx.sandboxConversation.forTurn(f.agent, turn.turn)
  const finish = await permission.resources.retain()
  f.release()
  await f.agent.whenIdle()
  expect(f.backend.close).not.toHaveBeenCalled()
  expect(f.counts.get(f.alice.id)).toBe(1)
  await finish()
  await vi.waitFor(() =>{  expect(f.counts.get(f.alice.id)).toBe(0) })
  expect(f.backend.close).toHaveBeenCalledOnce()
})

test('late cleanup cannot revoke input or close a newer automatic generation', async () => {
  const f = await fixture()
  await f.prompt('original')
  const turn = await f.entered.promise
  const original = f.ctx.sandboxConversation.forTurn(f.agent, turn.turn)
  f.release()
  await f.agent.whenIdle()
  await vi.waitFor(() =>{  expect(f.backend.close).toHaveBeenCalledOnce() })
  f.hold()
  await f.prompt('replacement')
  await expect(f.ctx.workspaceSandbox.closeForExecution(original)).rejects.toMatchObject({ code: 'gateway/cancelled' })
  expect(f.backend.close).toHaveBeenCalledOnce()
  expect(f.ctx.workspaceSandboxState.permits.active(f.alice.id)).toBe(1)
  f.release()
  await f.agent.whenIdle()
  await vi.waitFor(() =>{  expect(f.backend.close).toHaveBeenCalledTimes(2) })
})

test('binary upload and download work before execution and retain streaming mode admission', async () => {
  const f = await fixture()
  async function* chunks() { yield Buffer.from('persisted\n') }
  await f.ctx.workspaceFileAccess.upload(f.scope, 'input.txt', chunks(), 100)
  const stream = await f.ctx.workspaceFileAccess.download(f.scope, 'input.txt', 100)
  expect(f.counts.get(f.alice.id)).toBe(1)
  expect(await new Response(stream.body).text()).toBe('persisted\n')
  await stream.settled
  expect(f.counts.get(f.alice.id)).toBe(0)
  expect(f.backend.open).not.toHaveBeenCalled()
})

test('single VM reads retain the mode lease when the execution generation requires cleanup', async () => {
  const f = await fixture('single-vm')
  const files = f.targets.get('single-vm')!.files
  const list = vi.spyOn(files, 'list').mockResolvedValue({ entries: [{ name: 'input.txt', kind: 'file' }], truncated: false })
  const read = Promise.withResolvers<undefined>()
  vi.spyOn(files, 'download').mockResolvedValue({ bytes: 0, body: new ReadableStream(), settled: read.promise })
  f.backend.closeTask = vi.fn(async () => { throw new Error('Original VM deletion is unconfirmed') })
  const recover = f.backend.recoverTask = vi.fn(async () => { throw new Error('Original VM still exists') })

  const first = await f.ctx.sandboxRunnerClient.admit(f.scope)
  await first.ready()
  await expect(first.release()).rejects.toMatchObject({ phase: 'close' })
  try {
    await expect(f.ctx.sandboxRunnerClient.status(f.alice.id)).resolves.toEqual({ state: 'cleanup_required' })
    await expect(f.ctx.workspaceFileAccess.list(f.scope, '', 100)).resolves.toMatchObject({ entries: [{ name: 'input.txt' }] })
    expect(list).toHaveBeenCalledOnce()
    const stream = await f.ctx.workspaceFileAccess.download(f.scope, 'input.txt', 100)
    expect(f.counts.get(f.alice.id)).toBe(1)
    read.resolve(undefined)
    await stream.settled
    expect(f.counts.get(f.alice.id)).toBe(0)
    expect(recover).not.toHaveBeenCalled()
    expect(f.backend.open).toHaveBeenCalledOnce()
  } finally {
    read.resolve(undefined)
    await f.fiber.dispose().catch(() => {})
  }
})

test('unloading mode admission cancels a live turn and waits for actual environment destruction', async () => {
  const f = await fixture()
  await f.prompt('unload')
  await f.entered.promise
  await f.fiber.dispose()
  expect(f.backend.close).toHaveBeenCalledOnce()
  expect(f.counts.get(f.alice.id)).toBe(0)
  await f.agent.whenIdle()
})

test('invalid file receipts never start a selected container', async () => {
  const f = await fixture()
  const source = { kind: 'user' as const, rpcId: brandString<import('@deepseek-ai/dsh-api-session-controller/types').SessionRequestId>('bad'),
    principal: { kind: 'user' as const, userId: f.alice.user.userId } }
  await expect(f.controller.prompt({ sessionId: f.agent.id, requestId: source.rpcId, mode: 'queue',
    content: [{ type: 'file', receiptId: brandString<import('@deepseek-ai/dsh-client-file-upload').FileUploadReceiptId>('missing') }] }, source)).rejects.toBeDefined()
  expect(f.backend.open).not.toHaveBeenCalled()
  expect(f.counts.get(f.alice.id)).toBe(0)
})

test.each(modes)('%s releases an exclusive Workspace without nested mode admission or opening a replacement', async (mode) => {
  const f = await fixture(mode)
  await f.backend.open(f.alice.id, f.alice.workspace.path)
  f.coordinator.acquireUse.mockClear()
  vi.mocked(f.backend.open).mockClear()
  await expect(f.ctx.sandboxRunnerClient.closeWorkspace(f.alice.id)).resolves.toMatchObject({ state: 'closed' })
  expect(f.backend.close).toHaveBeenCalledWith(f.alice.id)
  expect(f.coordinator.acquireUse).not.toHaveBeenCalled()
  expect(f.backend.open).not.toHaveBeenCalled()
})
