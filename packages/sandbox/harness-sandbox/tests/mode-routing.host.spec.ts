/** Mode selection and resource settlement against the supplied workspace admission interface. */
import { expect, test, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { IWorkspaceModes, WorkspaceId, WorkspaceMode, WorkspaceModeUseLease } from '@deepseek-ai/dsh-workspace/types'
import type { WorkspaceFileScope } from '@deepseek-ai/dsh-fs/workspace-access'
import type { SandboxContainerId } from '../src/runner-client.ts'
import { WorkspaceModeRouting, WorkspaceModeRoutingError, type WorkspaceModeTarget } from '../src/mode-routing.ts'

const workspace = brandString<WorkspaceId>('workspace-a')
const allModes: readonly WorkspaceMode[] = ['single-vm', 'multi-vm', 'single-docker', 'multi-docker']

function target(mode: WorkspaceMode) {
  const containerId = brandString<SandboxContainerId>(mode)
  return {
    execution: {
      open: vi.fn(async () => ({ state: 'running' as const, containerId })),
      close: vi.fn(async () => ({ state: 'closed' as const })),
      status: vi.fn(async () => ({ state: 'running' as const, containerId })),
      execute: vi.fn(async () => { throw new Error('No command configured') }),
      cancel: vi.fn(async () => { throw new Error('No cancellation configured') }),
      files: vi.fn(async () => { throw new Error('No text-file operation configured') }),
    },
    files: {
      list: vi.fn(async () => ({ entries: [{ name: mode, kind: 'file' as const }], truncated: false })),
      download: vi.fn<WorkspaceModeTarget['files']['download']>(async () => { throw new Error('No download configured') }),
      upload: vi.fn<WorkspaceModeTarget['files']['upload']>(async (_scope, name) => ({ name, bytes: 0 })),
    },
  } satisfies WorkspaceModeTarget
}

function fixture(initial: WorkspaceMode = 'multi-vm') {
  let mode = initial
  const controller = new AbortController()
  const admit = vi.fn()
  const release = vi.fn()
  const targets = new Map(allModes.map(value => [value, target(value)]))
  const scope: WorkspaceFileScope = { workspaceId: workspace, project: '/registered/workspace-a', signal: controller.signal, admit }
  const lease = (): WorkspaceModeUseLease => ({
    config: { workspaceId: workspace, mode, revision: 1, operationState: 'ready', modeLocked: false, lockReason: null, firstSessionId: null },
    signal: controller.signal, admit, release,
  })
  const modes: Pick<IWorkspaceModes, 'acquireUse'> = { acquireUse: vi.fn(async () => lease()) }
  const routing = new WorkspaceModeRouting(modes, targets)
  return { routing, targets, modes, scope, controller, admit, release, lease, setMode(value: WorkspaceMode) { mode = value } }
}

test.each(allModes)('%s selects its configured execution and file providers', async (mode) => {
  const f = fixture(mode)
  const selected = f.targets.get(mode)!
  await expect(f.routing.open(f.scope, 'task')).resolves.toMatchObject({ containerId: mode })
  await expect(f.routing.list(f.scope, '', 20)).resolves.toMatchObject({ entries: [{ name: mode }] })
  expect(selected.execution.open).toHaveBeenCalledWith(workspace, f.scope.project)
  for (const [otherMode, other] of f.targets) if (otherMode !== mode) {
    expect(other.execution.open).not.toHaveBeenCalled()
    expect(other.files.list).not.toHaveBeenCalled()
  }
  expect(f.release).toHaveBeenCalledTimes(2)
})

test('selects after waiting for admission and never reads an earlier mode', async () => {
  const f = fixture('multi-vm')
  const admitted = Promise.withResolvers<WorkspaceModeUseLease>()
  vi.mocked(f.modes.acquireUse).mockReturnValueOnce(admitted.promise)
  const pending = f.routing.open(f.scope, 'task')
  f.setMode('single-docker')
  admitted.resolve(f.lease())
  await expect(pending).resolves.toMatchObject({ containerId: 'single-docker' })
  expect(f.targets.get('multi-vm')!.execution.open).not.toHaveBeenCalled()
})

test('a waiting workspace does not select or block another workspace backend', async () => {
  const f = fixture('multi-vm')
  const firstReady = Promise.withResolvers<undefined>()
  const otherId = brandString<WorkspaceId>('workspace-b')
  vi.mocked(f.modes.acquireUse).mockImplementation(async (id) => {
    if (id === workspace) await firstReady.promise
    const lease = f.lease()
    return { ...lease, config: { ...lease.config, workspaceId: id, mode: id === workspace ? 'multi-vm' : 'single-docker' } }
  })
  const first = f.routing.open(f.scope, 'task')
  const other = { ...f.scope, workspaceId: otherId, project: '/registered/workspace-b' }
  await expect(f.routing.open(other, 'task')).resolves.toMatchObject({ containerId: 'single-docker' })
  expect(f.targets.get('single-docker')!.execution.open).toHaveBeenCalledWith(otherId, other.project)
  expect(f.targets.get('multi-vm')!.execution.open).not.toHaveBeenCalled()
  firstReady.resolve(undefined)
  await first
  expect(f.targets.get('multi-vm')!.execution.open).toHaveBeenCalledWith(workspace, f.scope.project)
})

test.each(['single-vm', 'single-docker'] as const)('%s refuses both manual lifecycle operations before provider calls', async (mode) => {
  const f = fixture(mode)
  for (const operation of ['open', 'close'] as const) {
    await expect(f.routing[operation](f.scope, 'manual')).rejects.toMatchObject({ reason: 'manual-operation-forbidden' })
  }
  expect(f.targets.get(mode)!.execution.open).not.toHaveBeenCalled()
  expect(f.targets.get(mode)!.execution.close).not.toHaveBeenCalled()
  expect(f.release).toHaveBeenCalledTimes(2)
})

test.each(['multi-vm', 'multi-docker'] as const)('%s retains manual lifecycle operations', async (mode) => {
  const f = fixture(mode)
  await f.routing.open(f.scope, 'manual')
  await f.routing.close(f.scope, 'manual')
  expect(f.targets.get(mode)!.execution.close).toHaveBeenCalledWith(workspace)
})

test('an unsupported mode fails without substituting another backend or host files', async () => {
  const f = fixture('single-vm')
  const routing = new WorkspaceModeRouting(f.modes, new Map([['multi-docker', f.targets.get('multi-docker')!]]))
  await expect(routing.list(f.scope, '', 1)).rejects.toBeInstanceOf(WorkspaceModeRoutingError)
  expect(f.targets.get('multi-docker')!.files.list).not.toHaveBeenCalled()
  expect(f.release).toHaveBeenCalledOnce()
})

test('provider failure retains its identity and releases admission', async () => {
  const f = fixture()
  const failure = new Error('provider disconnected')
  f.targets.get('multi-vm')!.files.list.mockRejectedValueOnce(failure)
  await expect(f.routing.list(f.scope, '', 1)).rejects.toBe(failure)
  expect(f.release).toHaveBeenCalledOnce()
})

test('withdrawn authority while waiting prevents every resource call', async () => {
  const f = fixture()
  const admitted = Promise.withResolvers<WorkspaceModeUseLease>()
  vi.mocked(f.modes.acquireUse).mockReturnValueOnce(admitted.promise)
  const pending = f.routing.open(f.scope, 'task')
  const failure = new Error('ownership withdrawn')
  f.admit.mockImplementation(() => { throw failure })
  admitted.resolve(f.lease())
  await expect(pending).rejects.toBe(failure)
  expect(f.release).toHaveBeenCalledOnce()
  expect(f.targets.get('multi-vm')!.execution.open).not.toHaveBeenCalled()
})

test('cancellation while waiting releases a returned lease before resource access', async () => {
  const f = fixture()
  const admitted = Promise.withResolvers<WorkspaceModeUseLease>()
  vi.mocked(f.modes.acquireUse).mockReturnValueOnce(admitted.promise)
  const pending = f.routing.list(f.scope, '', 1)
  const failure = new Error('cancelled')
  f.controller.abort(failure)
  admitted.resolve(f.lease())
  await expect(pending).rejects.toBe(failure)
  expect(f.release).toHaveBeenCalledOnce()
  expect(f.targets.get('multi-vm')!.files.list).not.toHaveBeenCalled()
})

test('already cancelled requests do not enter the coordinator', async () => {
  const f = fixture()
  const failure = new Error('cancelled')
  f.controller.abort(failure)
  await expect(f.routing.open(f.scope, 'task')).rejects.toBe(failure)
  expect(f.modes.acquireUse).not.toHaveBeenCalled()
})

test('download returns its body before settlement and retains admission through cleanup', async () => {
  const f = fixture()
  const cleanup = Promise.withResolvers<undefined>()
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([42])); controller.close() } })
  f.targets.get('multi-vm')!.files.download.mockResolvedValueOnce({ bytes: 1, body, settled: cleanup.promise })
  const stream = await f.routing.download(f.scope, 'result.csv', 10)
  expect(await new Response(stream.body).arrayBuffer()).toEqual(new Uint8Array([42]).buffer)
  expect(f.release).not.toHaveBeenCalled()
  cleanup.resolve(undefined)
  await stream.settled
  expect(f.release).toHaveBeenCalledOnce()
})

test('download cleanup failure remains observable after releasing the lease', async () => {
  const f = fixture()
  const cleanup = Promise.withResolvers<undefined>()
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })
  f.targets.get('multi-vm')!.files.download.mockResolvedValueOnce({ bytes: 0, body, settled: cleanup.promise })
  const stream = await f.routing.download(f.scope, 'result.csv', 10)
  const failure = new Error('descriptor cleanup failed')
  cleanup.reject(failure)
  await expect(stream.settled).rejects.toBe(failure)
  expect(f.release).toHaveBeenCalledOnce()
})

test('failure to open a download releases the lease', async () => {
  const f = fixture()
  const failure = new Error('file missing')
  f.targets.get('multi-vm')!.files.download.mockRejectedValueOnce(failure)
  await expect(f.routing.download(f.scope, 'missing.csv', 10)).rejects.toBe(failure)
  expect(f.release).toHaveBeenCalledOnce()
})

test('upload cancellation retains admission until provider cleanup completes', async () => {
  const f = fixture()
  const started = Promise.withResolvers<undefined>()
  const cleanup = Promise.withResolvers<undefined>()
  const failure = new Error('upload cancelled')
  f.targets.get('multi-vm')!.files.upload.mockImplementationOnce(async (scope) => {
    started.resolve(undefined)
    await cleanup.promise
    scope.admit()
    return { name: 'input.csv', bytes: 1 }
  })
  async function* chunks() { yield new Uint8Array([42]) }
  const pending = f.routing.upload(f.scope, 'input.csv', chunks(), 10)
  await started.promise
  f.controller.abort(failure)
  expect(f.release).not.toHaveBeenCalled()
  cleanup.resolve(undefined)
  await expect(pending).rejects.toBe(failure)
  expect(f.release).toHaveBeenCalledOnce()
})

test('nested execution helpers use one admitted backend without reacquiring', async () => {
  const f = fixture()
  await f.routing.withExecution(f.scope, async ({ backend, scope }) => {
    await backend.open(scope.workspaceId, scope.project)
    await backend.status(scope.workspaceId)
  })
  expect(f.modes.acquireUse).toHaveBeenCalledOnce()
  expect(f.release).toHaveBeenCalledOnce()
})
