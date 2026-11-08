import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { afterEach, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { executionRequest } from '../src/execution.ts'
import type { RunnerRunningSandbox } from '../src/runner-client.ts'
import WorkspaceSshBackend from '../src/ssh.ts'
import type { WorkspaceSshServices } from '../src/ssh-runtime.ts'

const remote = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('../src/ssh-runtime.ts', () => ({ createWorkspaceSshServices: remote.create }))

const alice = WorkspaceId('alice-workspace')
const bob = WorkspaceId('bob-workspace')
const binding = (instanceId: string) => ({ instanceId, host: instanceId, launch: { kind: 'node-script' as const, node: '/usr/bin/node' }, helper: '/opt/helper.js', helperHash: 'a'.repeat(64), workspace: `/remote/${instanceId}` })
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.clearAllMocks()
})

function world(root: string, pending = false) {
  const connection = new AbortController()
  const completed = Promise.withResolvers<SubprocessOutcome>()
  const observed = Promise.withResolvers<undefined>()
  const cleanup = vi.fn(async () => true)
  const spawn = vi.fn((spec: SubprocessSpawnSpec): SubprocessHandle => {
    const done = pending ? completed.promise : Promise.resolve({ exitCode: 7, signal: null })
    const abort = (): void => { completed.resolve({ exitCode: null, signal: 'SIGTERM' }) }
    spec.signal?.addEventListener('abort', abort, { once: true })
    void done.finally(() => { spec.signal?.removeEventListener('abort', abort) }).catch(() => {})
    observed.resolve(undefined)
    return { stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
      collected: { stdout: { readFrom: () => ({ text: 'original\n', nextOffset: 9, lossy: false }) }, stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } },
      done, waitForExit: cleanup, terminate: abort }
  })
  const request = async <T>(_method: string, _params: unknown, schema: z.ZodType<T>): Promise<T> => schema.parse(null)
  const close = vi.fn(async () => { connection.abort() })
  // The external SSH provider is the only mocked capability; lifecycle behavior belongs to the backend.
  const services: WorkspaceSshServices = { root, close, ssh: { signal: connection.signal, request, checkHealth: async () => {} },
    fs: {} as FileSystem, subprocess: { spawn } }
  return { services, spawn, close, request, connection, cleanup, observed: observed.promise, completed }
}

async function setup(options: { pending?: boolean; maxExecutions?: number } = {}) {
  const a = world('/remote/vm-a', options.pending)
  const b = world('/remote/vm-b')
  remote.create.mockImplementation(async (config: { host: string }) => config.host === 'vm-a' ? a.services : b.services)
  const ctx = new Context()
  contexts.push(ctx)
  const fiber = ctx.plugin(WorkspaceSshBackend, { bindings: { [alice]: binding('vm-a'), [bob]: binding('vm-b') }, maxExecutions: options.maxExecutions ?? 32, graceMs: 50 })
  await fiber
  return { ctx, backend: ctx.sandboxRunnerClient, fiber, a, b }
}

function request(opened: RunnerRunningSandbox, command = 'printf original') {
  return executionRequest.parse({ executionId: randomUUID(), expectedContainerId: opened.containerId, command, workdir: '.', timeoutMs: 1000 })
}

test('concurrent opens reuse a connection while distinct workspaces retain independent generations and roots', async () => {
  const f = await setup()
  const [a, same, b] = await Promise.all([f.backend.open(alice, '/projects/alice'), f.backend.open(alice, '/projects/alice'), f.backend.open(bob, '/projects/bob')])
  expect(a.containerId).toBe(same.containerId)
  expect(b.containerId).not.toBe(a.containerId)
  expect(remote.create).toHaveBeenCalledTimes(2)
  expect(remote.create.mock.calls[0]?.[0]).not.toHaveProperty('instanceId')
  const exec = request(a)
  expect(await f.backend.execute(alice, exec)).toMatchObject({ exitCode: 7, stdout: { text: 'original\n' } })
  expect(f.a.spawn.mock.calls[0]?.[0]).toMatchObject({ cwd: '/remote/vm-a', argv: ['/bin/bash', '--noprofile', '--norc', '-c', exec.command] })
  expect(f.b.spawn).not.toHaveBeenCalled()
  expect(await f.backend.files(alice, a.containerId)).toMatchObject({ root: '/remote/vm-a', fs: f.a.services.fs })
  await expect(f.backend.open(alice, '/projects/other')).rejects.toMatchObject({ code: 'sandbox_workspace_conflict' })
  expect(() => f.backend.execute(bob, exec)).toThrow()
})

test('duplicate original requests return the retained result; changed commands never replay', async () => {
  const f = await setup()
  const opened = await f.backend.open(alice, '/projects/alice')
  const exec = request(opened)
  const [one, two] = await Promise.all([f.backend.execute(alice, exec), f.backend.execute(alice, { ...exec })])
  expect(two).toBe(one)
  expect(await f.backend.execute(alice, exec)).toBe(one)
  expect(f.a.spawn).toHaveBeenCalledTimes(1)
  expect(() => f.backend.execute(alice, { ...exec, command: 'changed' })).toThrow()
})

test('cancellation before dispatch creates a retained receipt and never starts the command', async () => {
  const f = await setup()
  const opened = await f.backend.open(alice, '/projects/alice')
  const exec = request(opened)
  expect(await f.backend.cancel(alice, exec)).toMatchObject({ cancellation: 'requested' })
  await expect(f.backend.execute(alice, exec)).rejects.toMatchObject({ code: 'execution_cancelled', execution: { cleanup: 'not_started' } })
  await expect(f.backend.execute(alice, exec)).rejects.toMatchObject({ code: 'execution_cancelled' })
  expect(f.a.spawn).not.toHaveBeenCalled()
})

test.each(['cancel', 'timeout'] as const)('%s retains generation after confirmed managed cleanup', async (mode) => {
  const f = await setup({ pending: true })
  const opened = await f.backend.open(alice, '/projects/alice')
  const exec = { ...request(opened), timeoutMs: mode === 'timeout' ? 20 : 1000 }
  const pending = f.backend.execute(alice, exec)
  const failed = expect(pending).rejects.toMatchObject({ code: mode === 'timeout' ? 'execution_timeout' : 'execution_cancelled', execution: { cleanup: 'processes_cleaned' } })
  await f.a.observed
  if (mode === 'cancel') await f.backend.cancel(alice, exec)
  await failed
  expect(await f.backend.status(alice)).toEqual(opened)
  expect(f.a.cleanup).toHaveBeenCalled()
})

test('caller wait cancellation does not cancel accepted command or allow its replay', async () => {
  const f = await setup({ pending: true })
  const opened = await f.backend.open(alice, '/projects/alice')
  const exec = request(opened)
  const observer = new AbortController()
  const pending = f.backend.execute(alice, exec, observer.signal)
  await f.a.observed
  observer.abort()
  await expect(pending).rejects.toMatchObject({ code: 'runner_outcome_unknown' })
  expect(f.a.spawn.mock.calls[0]?.[0].signal?.aborted).toBe(false)
  f.a.completed.resolve({ exitCode: 0, signal: null })
  expect(await f.backend.execute(alice, exec)).toMatchObject({ exitCode: 0 })
  expect(f.a.spawn).toHaveBeenCalledTimes(1)
})

test('close drains accepted work and reopening rejects old execution, cancel and file leases', async () => {
  const f = await setup({ pending: true })
  const opened = await f.backend.open(alice, '/projects/alice')
  const lease = await f.backend.files(alice, opened.containerId)
  const exec = request(opened)
  const pending = f.backend.execute(alice, exec)
  const stopped = expect(pending).rejects.toMatchObject({ execution: { reason: 'shutdown', cleanup: 'processes_cleaned' } })
  await f.a.observed
  expect(await f.backend.close(alice)).toEqual({ state: 'closed' })
  await stopped
  expect(f.a.close).toHaveBeenCalledTimes(1)
  expect(lease.signal.aborted).toBe(true)
  const next = world('/remote/vm-a')
  remote.create.mockResolvedValue(next.services)
  const reopened = await f.backend.open(alice, '/projects/alice')
  expect(reopened.containerId).not.toBe(opened.containerId)
  expect(() =>{  lease.assertCurrent() }).toThrow()
  expect(() => f.backend.execute(alice, exec)).toThrow()
  await expect(f.backend.cancel(alice, exec)).rejects.toMatchObject({ code: 'sandbox_workspace_conflict' })
  await expect(f.backend.files(alice, opened.containerId)).rejects.toMatchObject({ code: 'sandbox_workspace_conflict' })
  expect(next.spawn).not.toHaveBeenCalled()
})

test('disconnect immediately withdraws file leases and quarantines work without host fallback', async () => {
  const f = await setup()
  const opened = await f.backend.open(alice, '/projects/alice')
  const lease = await f.backend.files(alice, opened.containerId)
  f.a.close.mockRejectedValue(new Error('unreachable cleanup'))
  f.a.connection.abort(new Error('connection lost'))
  expect(lease.signal.aborted).toBe(true)
  expect(await f.backend.status(alice)).toEqual({ state: 'cleanup_required' })
  await expect(f.backend.open(alice, '/projects/alice')).rejects.toMatchObject({ code: 'sandbox_cleanup_required' })
  expect(() => f.backend.execute(alice, request(opened))).toThrow()
  await expect(f.backend.close(alice)).rejects.toMatchObject({ code: 'runner_outcome_unknown' })
  expect(await f.backend.status(alice)).toEqual({ state: 'cleanup_required' })
  expect(f.a.spawn).not.toHaveBeenCalled()
})

test('unknown execution stops further work; acknowledged original-helper closure permits recovery', async () => {
  const f = await setup({ pending: true })
  const opened = await f.backend.open(alice, '/projects/alice')
  f.a.cleanup.mockRejectedValueOnce(new Error('observation lost'))
  const pending = f.backend.execute(alice, request(opened))
  const unknown = expect(pending).rejects.toMatchObject({ code: 'execution_outcome_unknown', execution: { cleanup: 'unconfirmed' } })
  await f.a.observed
  f.a.completed.reject(new Error('result lost'))
  await unknown
  expect(await f.backend.status(alice)).toEqual({ state: 'cleanup_required' })
  expect(await f.backend.close(alice)).toEqual({ state: 'closed' })
})

test('record capacity refuses new execution ids while preserving retrieval and cancellation', async () => {
  const f = await setup({ maxExecutions: 1 })
  const opened = await f.backend.open(alice, '/projects/alice')
  const exec = request(opened)
  await f.backend.execute(alice, exec)
  expect(() => f.backend.execute(alice, request(opened))).toThrow()
  expect(await f.backend.execute(alice, exec)).toMatchObject({ exitCode: 7 })
  expect(await f.backend.cancel(alice, exec)).toMatchObject({ cancellation: 'settled' })
  expect(f.a.spawn).toHaveBeenCalledTimes(1)
})

test('provider unload cancels, drains and withdraws original capabilities', async () => {
  const f = await setup({ pending: true })
  const opened = await f.backend.open(alice, '/projects/alice')
  const pending = f.backend.execute(alice, request(opened))
  const stopped = expect(pending).rejects.toMatchObject({ code: 'execution_cancelled' })
  await f.a.observed
  await f.fiber.dispose()
  await stopped
  expect(f.a.close).toHaveBeenCalledTimes(1)
  expect(f.ctx.get('sandboxRunnerClient')).toBeUndefined()
  await expect(f.backend.open(alice, '/projects/alice')).rejects.toMatchObject({ code: 'runner_unavailable' })
})

test('closing during connection startup drains that attempt and prevents a late running publication', async () => {
  const f = await setup()
  const starting = Promise.withResolvers<WorkspaceSshServices>()
  remote.create.mockReturnValueOnce(starting.promise)
  const pending = f.backend.open(alice, '/projects/alice')
  const rejected = expect(pending).rejects.toMatchObject({ code: 'sandbox_workspace_conflict' })
  const closing = f.backend.close(alice)
  starting.resolve(f.a.services)
  expect(await closing).toEqual({ state: 'closed' })
  await rejected
  expect(f.a.close).toHaveBeenCalledTimes(1)
  expect(await f.backend.status(alice)).toEqual({ state: 'closed' })
})

test.each([
  { a: binding('vm-a'), b: binding('vm-a') },
  { a: binding('vm-a'), b: { ...binding('vm-b'), host: 'vm-a' } },
  { a: { ...binding('vm-a'), helperHash: 'invalid' }, b: binding('vm-b') },
])('rejects invalid or reused bindings before starting SSH', (bindings) => {
  const ctx = new Context()
  contexts.push(ctx)
  expect(() => new WorkspaceSshBackend(ctx, { bindings: { [alice]: bindings.a, [bob]: bindings.b } })).toThrow()
  expect(remote.create).not.toHaveBeenCalled()
})
