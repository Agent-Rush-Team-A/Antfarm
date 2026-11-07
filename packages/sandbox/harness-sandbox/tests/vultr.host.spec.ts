import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { SshWorkspaceFiles } from '@deepseek-ai/dsh-ssh/workspace-files'
import type { WorkspaceRuntimeFiles } from '../src/backend.ts'
import type { RunnerRunningSandbox, SandboxContainerId } from '../src/runner-client.ts'
import type { WorkspaceSshRuntime } from '../src/ssh-controller.ts'
import type { WorkspaceSshServices } from '../src/ssh-runtime.ts'
import { VultrApi, type VultrInstance, type VultrSnapshot } from '../src/vultr-api.ts'
import { Config } from '../src/vultr-config.ts'
import { CloudWorkspaceStore } from '../src/vultr-storage.ts'
import { VultrWorkspaceController } from '../src/vultr-controller.ts'
import type { VultrProvisioning } from '../src/vultr-provision.ts'
import type { RunnerExecutionRequest, RunnerExecutionIdentity } from '../src/execution.ts'
import { executionRequest } from '../src/execution.ts'

const linuxTest = test.runIf(process.platform === 'linux')
const roots: string[] = []
const controllers: VultrWorkspaceController[] = []
afterEach(async () => {
  await Promise.all(controllers.splice(0).map(controller => controller.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

function cloud() {
  const instances = new Map<string, VultrInstance>()
  const snapshots = new Map<string, VultrSnapshot>()
  const createdSnapshot = Promise.withResolvers<undefined>()
  const createdInstance = Promise.withResolvers<undefined>()
  let createReplyLost = false
  let snapshotReplyLost = false
  let complete = true
  const requests: { method: string; path: string; body?: Record<string, unknown> }[] = []
  const transport: typeof fetch = async (input, options) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname.replace('/v2', '')
    const method = options?.method ?? 'GET'
    if (options?.body !== undefined && typeof options.body !== 'string') throw new Error('Fixture expected JSON request text')
    const body: Record<string, unknown> = options?.body === undefined ? {}
      : z.record(z.string(), z.unknown()).parse(JSON.parse(options.body))
    requests.push({ method, path, body })
    if (path === '/instances' && method === 'GET') return Response.json({ instances: [...instances.values()],
      meta: { links: { next: null } } })
    if (path === '/snapshots' && method === 'GET') return Response.json({ snapshots: [...snapshots.values()],
      meta: { links: { next: null } } })
    if (path === '/instances' && method === 'POST') {
      const instance = { id: brandString<VultrInstance['id']>(randomUUID()), label: String(body.label),
        tags: z.array(z.string()).parse(body.tags),
        status: 'active', power_status: 'running', server_status: 'ok', main_ip: '127.0.0.1' }
      instances.set(instance.id, instance)
      createdInstance.resolve(undefined)
      if (createReplyLost) throw new Error('Lost create acknowledgement')
      return Response.json({ instance })
    }
    if (path === '/snapshots' && method === 'POST') {
      const source = instances.get(String(body.instance_id))
      if (source?.power_status !== 'stopped') throw new Error('Snapshot requested before VM stopped')
      const snapshot = { id: brandString<VultrSnapshot['id']>(randomUUID()), description: String(body.description),
        status: complete ? 'complete' : 'pending' }
      snapshots.set(snapshot.id, snapshot)
      createdSnapshot.resolve(undefined)
      if (snapshotReplyLost) return new Response(null, { status: 503 })
      return Response.json({ snapshot })
    }
    const parts = path.split('/')
    const id = parts[2] ?? ''
    if (parts[1] === 'instances') {
      const instance = instances.get(id)
      if (instance === undefined) return new Response(null, { status: 404 })
      if (method === 'DELETE') {
        if (![...snapshots.values()].some(snapshot => snapshot.status === 'complete')) throw new Error('VM removed before preservation')
        instances.delete(id)
        return new Response(null, { status: 204 })
      }
      if (method === 'POST') {
        instance.power_status = parts[3] === 'halt' ? 'stopped' : 'running'
        return new Response(null, { status: 204 })
      }
      return Response.json({ instance })
    }
    const snapshot = snapshots.get(id)
    if (snapshot === undefined) return new Response(null, { status: 404 })
    if (method === 'DELETE') { snapshots.delete(id); return new Response(null, { status: 204 }) }
    return Response.json({ snapshot })
  }
  return { instances, snapshots, requests, transport, createdSnapshot, createdInstance,
    setCreateLost: (value = true) => { createReplyLost = value }, setSnapshotLost: () => { snapshotReplyLost = true },
    pendingSnapshots: () => { complete = false },
    completeSnapshots: () => { for (const snapshot of snapshots.values()) snapshot.status = 'complete' } }
}

function sshRuntime() {
  const worlds = new Map<WorkspaceId, { running: RunnerRunningSandbox; services: WorkspaceSshServices }>()
  const services: WorkspaceSshServices = {
    root: '/remote', close: async () => {}, fs: {} as WorkspaceRuntimeFiles['fs'], subprocess: { spawn: vi.fn() },
    ssh: { signal: new AbortController().signal, request: async <T>(method: string, _fields: unknown,
      schema: z.ZodType<T>) => schema.parse(method === 'workspace.list' ? { entries: [], truncated: false } : null) },
  }
  const runtime: Pick<WorkspaceSshRuntime,
    'bind' | 'open' | 'status' | 'close' | 'pause' | 'files' | 'execute' | 'cancel' | 'binary' | 'releaseStopped' | 'dispose'> = {
    bind: vi.fn(),
    dispose: vi.fn(async () => { worlds.clear() }),
    releaseStopped: vi.fn(async (id: WorkspaceId) => { worlds.delete(id) }),
    open: vi.fn(async (id: WorkspaceId) => {
      let world = worlds.get(id)
      if (world === undefined) { world = { running: { state: 'running',
        containerId: brandString<SandboxContainerId>(randomBytes(32).toString('hex')) }, services }; worlds.set(id, world) }
      return world.running
    }),
    status: async id => worlds.get(id)?.running ?? { state: 'closed' },
    close: vi.fn<WorkspaceSshRuntime['close']>(async (id: WorkspaceId) => { worlds.delete(id); return { state: 'closed' } }),
    pause: vi.fn(async (id: WorkspaceId) => worlds.get(id)?.services),
    files: vi.fn(async () => ({ root: '/remote', fs: services.fs, signal: services.ssh.signal, assertCurrent: () => {} })),
    binary: async () => new SshWorkspaceFiles(services.ssh),
    execute: vi.fn(async (_id: WorkspaceId, request: RunnerExecutionRequest) => ({ executionId: request.executionId,
      exitCode: 0, stdout: { text: 'remote', truncated: false }, stderr: { text: '', truncated: false } })),
    cancel: vi.fn<WorkspaceSshRuntime['cancel']>(async (_id: WorkspaceId, request: RunnerExecutionIdentity) => ({
      executionId: request.executionId,
      containerId: request.expectedContainerId, cancellation: 'requested' })),
  }
  return { runtime, worlds }
}

async function setup(existing?: { root: string; external: ReturnType<typeof cloud> }) {
  const root = existing?.root ?? await mkdtemp(join(tmpdir(), 'antfarm-vultr-'))
  if (existing === undefined) roots.push(root)
  const projectA = join(root, 'a')
  const projectB = join(root, 'b')
  await mkdir(projectA, { recursive: true }); await mkdir(projectB, { recursive: true })
  const settings = Config({ stateRoot: join(root, 'state'), apiKeyFile: join(root, 'key'), deploymentId: 'fixture',
    region: 'nrt', plan: 'vc2-1c-2gb', osId: 2284,
    sshKeyFile: join(root, 'ssh-key'), helperArchive: join(root, 'helper.tgz'), helperArchiveHash: 'a'.repeat(64),
    helperHash: 'b'.repeat(64), pollIntervalMs: 1, operationTimeoutMs: 30_000 })
  const store = new CloudWorkspaceStore(settings.stateRoot)
  await store.initialize()
  const external = existing?.external ?? cloud()
  const api = new VultrApi('fixture-key', 'https://api.invalid/v2', 5000, 10, 1024 * 1024, external.transport)
  const { runtime, worlds } = sshRuntime()
  const provisioning: VultrProvisioning = {
    flush: vi.fn(async () => {}), bootstrap: vi.fn(async () => '#!/bin/sh\n'),
    connect: vi.fn<VultrProvisioning['connect']>(async () => ({ host: 'fixture', workspace: '/remote', helper: '/helper',
      helperHash: 'a'.repeat(64), launch: { kind: 'executable' } })),
  }
  const report = vi.fn()
  const controller = new VultrWorkspaceController(settings, api, store, runtime, provisioning, report)
  controllers.push(controller)
  await controller.initialize()
  return { root, projectA, projectB, settings, store, external, runtime, worlds, provisioning, controller, report,
    a: WorkspaceId('workspace-a'), b: WorkspaceId('workspace-b') }
}

linuxTest('same-workspace concurrent opens share one VM while two workspaces use independent VM and execution identities', async () => {
  const f = await setup()
  const [a, again, b] = await Promise.all([f.controller.open(f.a, f.projectA), f.controller.open(f.a, f.projectA),
    f.controller.open(f.b, f.projectB)])
  expect(again.containerId).toBe(a.containerId)
  expect(b.containerId).not.toBe(a.containerId)
  expect(f.external.instances.size).toBe(2)
  expect(f.external.requests.filter(request => request.method === 'POST' && request.path === '/instances')).toHaveLength(2)
  await expect(f.controller.open(WorkspaceId('workspace-c'), join(f.root, 'c'))).rejects.toMatchObject({ code: 'sandbox_capacity' })
  const request = executionRequest.parse({ executionId: randomUUID(), expectedContainerId: a.containerId,
    command: 'echo remote', workdir: '.', timeoutMs: 1000 })
  expect(await f.controller.execute(f.a, request)).toMatchObject({ stdout: { text: 'remote' } })
  expect(() => f.controller.execute(f.b, request)).toThrow()
})

linuxTest('pending snapshot preserves the stopped source VM; complete snapshot and durable copy precede deletion', async () => {
  const f = await setup()
  const opened = await f.controller.open(f.a, f.projectA)
  f.external.pendingSnapshots()
  const closing = f.controller.close(f.a)
  await f.external.createdSnapshot.promise
  expect(f.external.instances.size).toBe(1)
  expect([...f.external.instances.values()][0]?.power_status).toBe('stopped')
  expect(f.controller.progress(f.a)).toMatchObject({ phase: 'saving_snapshot' })
  expect(() => f.controller.files(f.a, opened.containerId)).toThrow()
  f.external.completeSnapshots()
  expect(await closing).toEqual({ state: 'closed', reconciled: true })
  expect(f.external.instances.size).toBe(0)
  const record = (await f.store.load())[0]
  expect(record).toMatchObject({ state: 'closed', phase: 'closed' })
  expect(record?.snapshotId).toBeDefined(); expect(record?.cache).toBeDefined()
  expect(record?.instanceId).toBeUndefined()
  const reopened = await f.controller.open(f.a, f.projectA)
  expect(reopened.containerId).not.toBe(opened.containerId)
  const creation = f.external.requests.filter(request => request.method === 'POST' && request.path === '/instances').at(-1)
  expect(creation?.body).toHaveProperty('snapshot_id', record?.snapshotId)
  expect(creation?.body).not.toHaveProperty('os_id')
  expect(creation?.body).toHaveProperty('user_data', Buffer.from('#!/bin/sh\n').toString('base64'))
  expect(() => f.controller.files(f.a, opened.containerId)).toThrow()
  await expect(f.controller.cancel(f.a, executionRequest.parse({ executionId: randomUUID(),
    expectedContainerId: opened.containerId, command: 'true', workdir: '.', timeoutMs: 1000 })))
    .rejects.toMatchObject({ code: 'sandbox_workspace_conflict' })
  expect(f.runtime.cancel).not.toHaveBeenCalled()
})

linuxTest('lost snapshot acknowledgement retains source and recovers the original operation by description without a second snapshot', async () => {
  const f = await setup()
  await f.controller.open(f.a, f.projectA)
  f.external.setSnapshotLost()
  await expect(f.controller.close(f.a)).rejects.toMatchObject({ code: 'cloud_save_failed' })
  expect(f.external.instances.size).toBe(1)
  expect(f.controller.progress(f.a)).toMatchObject({ phase: 'failed', failure: 'save' })
  expect(await f.controller.close(f.a)).toMatchObject({ state: 'closed' })
  expect(f.external.requests.filter(request => request.method === 'POST' && request.path === '/snapshots')).toHaveLength(1)
  expect(f.external.instances.size).toBe(0)
})

linuxTest('lost instance acknowledgement never retries allocation and closure reconciles its original label', async () => {
  const f = await setup()
  f.settings.maxInstances = 1
  f.external.setCreateLost()
  await expect(f.controller.open(f.a, f.projectA)).rejects.toMatchObject({ code: 'cloud_open_failed', outcomeUnknown: true })
  await expect(f.controller.open(f.a, f.projectA)).rejects.toMatchObject({ code: 'sandbox_cleanup_required' })
  expect(f.external.instances.size).toBe(1)
  await expect(f.controller.open(f.b, f.projectB)).rejects.toMatchObject({ code: 'sandbox_capacity' })
  expect(await f.controller.close(f.a)).toMatchObject({ state: 'closed', reconciled: true })
  expect(f.external.requests.filter(request => request.method === 'POST' && request.path === '/instances')).toHaveLength(1)
  f.external.setCreateLost(false)
  await f.controller.open(f.b, f.projectB)
  expect(f.external.instances.size).toBe(1)
})

linuxTest('Harness restart reconnects its recorded VM without allocation or deletion and invalidates original execution receipts', async () => {
  const f = await setup()
  const original = await f.controller.open(f.a, f.projectA)
  await f.controller.dispose()
  expect(f.external.instances.size).toBe(1)
  const restarted = await setup(f)
  const connected = await restarted.controller.open(f.a, f.projectA)
  expect(connected.containerId).not.toBe(original.containerId)
  expect(f.external.requests.filter(request => request.method === 'POST' && request.path === '/instances')).toHaveLength(1)
  expect(() => restarted.controller.files(f.a, original.containerId)).toThrow()
})

linuxTest('unopened file access returns an empty view without persisting a cloud record', async () => {
  const f = await setup()
  const scope = { workspaceId: f.a, project: f.projectA, signal: new AbortController().signal, admit: vi.fn() }
  expect(await f.controller.list(scope, '', 100)).toEqual({ entries: [], truncated: false })
  expect(f.external.instances.size).toBe(0)
  expect(f.runtime.files).not.toHaveBeenCalled()
  expect(await f.store.load()).toEqual([])
  await expect(f.controller.list(scope, 'missing', 100)).rejects.toMatchObject({ reason: 'not-found' })
  await expect(f.controller.list(scope, '../escape', 100)).rejects.toMatchObject({ reason: 'invalid-path' })
  await expect(f.controller.download(scope, '', 10)).rejects.toMatchObject({ reason: 'not-regular' })
  await expect(f.controller.download(scope, 'missing', 10)).rejects.toMatchObject({ reason: 'not-found' })
})

linuxTest.each([
  { operation: 'list', cycle: false }, { operation: 'download', cycle: false },
  { operation: 'list', cycle: true }, { operation: 'download', cycle: true },
] as const)('initial $operation cannot overwrite the VM record after opening (close/reopen: $cycle)', async ({ operation, cycle }) => {
  const f = await setup()
  const save = f.store.save.bind(f.store)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  vi.spyOn(f.store, 'save').mockImplementation(async (record) => {
    if (record.state === 'closed' && record.cache !== undefined && record.snapshotId === undefined) {
      entered.resolve(undefined)
      await release.promise
    }
    return save(record)
  })
  const scope = { workspaceId: f.a, project: f.projectA, signal: new AbortController().signal, admit() {} }
  const reading = (operation === 'list' ? f.controller.list(scope, '', 20)
    : f.controller.download(scope, 'missing', 20)).then(() => undefined, () => undefined)
  // A read that writes metadata is held at publication; an empty view can finish without writing.
  await Promise.race([entered.promise, reading])
  let running: RunnerRunningSandbox
  try {
    running = await f.controller.open(f.a, f.projectA)
    if (cycle) { await f.controller.close(f.a); running = await f.controller.open(f.a, f.projectA) }
  } finally { release.resolve(undefined); await reading }
  expect(await f.controller.status(f.a)).toEqual(running)
  expect((await f.store.load())[0]).toMatchObject({ state: 'running', instanceId: [...f.external.instances.keys()][0] })
  const creates = f.external.requests.filter(request => request.method === 'POST' && request.path === '/instances').length
  expect(await f.controller.open(f.a, f.projectA)).toEqual(running)
  expect(f.external.requests.filter(request => request.method === 'POST' && request.path === '/instances')).toHaveLength(creates)
  expect(f.external.instances.size).toBe(1)
})

linuxTest('a pending status observation keeps state ownership until it finishes during disposal', async () => {
  const f = await setup()
  await f.controller.open(f.a, f.projectA)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const pausing = Promise.withResolvers<undefined>()
  vi.spyOn(f.runtime, 'status').mockImplementation(async () => {
    entered.resolve(undefined); await release.promise; return { state: 'closed' }
  })
  vi.spyOn(f.runtime, 'pause').mockImplementation(async () => { pausing.resolve(undefined); return undefined })
  const observing = f.controller.status(f.a)
  await entered.promise
  const closing = f.controller.dispose()
  await pausing.promise
  const other = new CloudWorkspaceStore(f.settings.stateRoot)
  try {
    await expect(other.initialize()).rejects.toThrow('Another Harness owns')
    expect(f.runtime.dispose).not.toHaveBeenCalled()
  } finally { release.resolve(undefined); await observing; await closing; await other.close() }
  await other.initialize()
  await other.close()
  const save = vi.spyOn(f.store, 'save')
  await expect(f.controller.status(f.a)).rejects.toThrow('Cloud provider stopped')
  await expect(f.controller.close(f.a)).rejects.toThrow('Cloud provider stopped')
  expect(save).not.toHaveBeenCalled()
})

linuxTest('an unconfirmed creation retains capacity across restart until its original VM is reclaimed', async () => {
  const f = await setup()
  f.external.setCreateLost()
  await expect(f.controller.open(f.a, f.projectA)).rejects.toMatchObject({ outcomeUnknown: true })
  await f.controller.dispose()
  const hidden = [...f.external.instances.values()]
  f.external.instances.clear()
  const restarted = await setup(f)
  restarted.settings.maxInstances = 1
  await expect(restarted.controller.open(restarted.b, restarted.projectB)).rejects.toMatchObject({ code: 'sandbox_capacity' })
  for (const instance of hidden) f.external.instances.set(instance.id, instance)
  await restarted.controller.close(restarted.a)
  f.external.setCreateLost(false)
  await restarted.controller.open(restarted.b, restarted.projectB)
  expect(f.external.instances.size).toBe(1)
})

linuxTest('a second Harness cannot mutate the same stateRoot until the first owner drains and releases its kernel lock', async () => {
  const f = await setup()
  const other = new CloudWorkspaceStore(f.settings.stateRoot)
  await expect(other.initialize()).rejects.toThrow('Another Harness owns this cloud stateRoot')
  await f.controller.dispose()
  await other.initialize()
  await other.close()
})

linuxTest('a cancelled upload waiter releases promptly while its original VM preparation remains visible as activity', async () => {
  const f = await setup()
  const entered = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  const connect = f.provisioning.connect.bind(f.provisioning)
  f.provisioning.connect = async (...args) => { entered.resolve(undefined); await released.promise; return connect(...args) }
  const cancelled = new AbortController()
  const scope = { workspaceId: f.a, project: f.projectA, signal: cancelled.signal, admit: () => {} }
  const bytes = (async function* () { yield Buffer.from('never published') })()
  const result = f.controller.upload(scope, 'cancelled.txt', bytes, 100)
  await entered.promise
  cancelled.abort(new Error('caller cancelled'))
  await expect(result).rejects.toThrow('caller cancelled')
  expect(f.controller.activity(f.a)).toMatchObject({ openings: 1 })
  const original = f.controller.open(f.a, f.projectA)
  released.resolve(undefined)
  await original
  expect(f.controller.activity(f.a)).toMatchObject({ openings: 0, closing: false })
  expect(f.external.requests.filter(request => request.method === 'POST' && request.path === '/instances')).toHaveLength(1)
})

linuxTest('missing persisted metadata never creates a second VM or reports an owned orphan as closed', async () => {
  const f = await setup()
  await f.controller.open(f.a, f.projectA)
  await f.controller.dispose()
  await rm(join(f.settings.stateRoot, f.a, 'state.json'))
  const restored = await setup(f)
  expect(await restored.controller.status(f.a)).toEqual({ state: 'cleanup_required' })
  expect(restored.controller.progress(f.a)).toMatchObject({ phase: 'failed', failure: 'ownership' })
  expect(() => restored.controller.open(f.a, f.projectA)).toThrow()
  await expect(restored.controller.close(f.a)).rejects.toMatchObject({ code: 'sandbox_cleanup_required' })
  expect(f.external.instances.size).toBe(1)
  expect(f.external.requests.filter(request => request.method === 'POST' && request.path === '/instances')).toHaveLength(1)
})

linuxTest('deployment secret files inside a registered project are refused before allocation or import', async () => {
  const f = await setup()
  f.settings.apiKeyFile = join(f.projectA, 'control.key')
  expect(() => f.controller.open(f.a, f.projectA)).toThrow()
  expect(f.external.instances.size).toBe(0)
})

linuxTest('a connected helper without binary file support never publishes a ready cloud workspace', async () => {
  const f = await setup()
  vi.spyOn(f.runtime, 'binary').mockImplementation(async () => new SshWorkspaceFiles({
    signal: new AbortController().signal,
    request: async () => { throw new Error('Unsupported workspace.list') },
  }))
  await expect(f.controller.open(f.a, f.projectA)).rejects.toMatchObject({ code: 'cloud_open_failed' })
  expect(f.controller.progress(f.a)).toMatchObject({ phase: 'failed', failure: 'connect' })
  expect(f.external.instances.size).toBe(1)
  expect(await f.controller.status(f.a)).toMatchObject({ state: 'cleanup_required' })
})
