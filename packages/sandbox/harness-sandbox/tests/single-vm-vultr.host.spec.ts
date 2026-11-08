/** Real Vultr HTTP parsing and allocation sequencing with a controlled account and helper. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { expect, test, vi } from 'vitest'
import { z } from 'zod'
import { executionIdentity, executionRequest } from '../src/execution.ts'
import { TaskSandboxLifecycle } from '../src/mode-reclamation.ts'
import WorkspaceSandboxState from '../src/lifecycle.ts'
import type { RunnerRunningSandbox, RunnerSandboxStatus, SandboxContainerId } from '../src/runner-client.ts'
import { SingleVmVultrBackend, singleVmAllocation, type SingleVmAllocation } from '../src/single-vm-vultr.ts'
import { VultrApi, vultrVolumeId, type VultrInstance } from '../src/vultr-api.ts'

const workspaceId = brandString<WorkspaceId>('original-workspace')
const secondId = brandString<WorkspaceId>('second-workspace')
const project = '/registered/ws-2de1'
const volumeId = vultrVolumeId.parse('128f8ca8-df10-4fde-a2cf-27c7816ba790')
const otherVolume = vultrVolumeId.parse('0b135e15-c3da-4843-9c2a-85cb36ff3c3c')
const instanceId = brandString<VultrInstance['id']>('e76abdcf-aeac-40c8-9e6e-bc2653402f93')
const freshInstanceId = brandString<VultrInstance['id']>('a60ccbd3-735c-4a1e-9038-f286361a4aaf')
const stale = brandString<SandboxContainerId>('0'.repeat(64))
const settings = { deploymentId: 'test', region: 'nrt', plan: 'vc2-1c-1gb', osId: 2284, volumeId,
  maxInstances: 1, operationTimeoutMs: 10_000, pollIntervalMs: 1 }

type Fault = 'region' | 'attachment' | 'wrong-instance' | 'guest-readiness' | 'mount' | 'permission' | 'handshake' | 'create-hidden'
  | 'create-rejected' | 'create-limited' | 'attach-rejected' | 'attach-limited' | 'attach-not-found' | 'attachment-timeout'
  | 'mount-tag' | 'helper-root' | 'helper-generation' | 'detach-timeout' | 'detach-applied' | 'delete-timeout' | 'delete-applied'

function fixture(fault?: Fault) {
  const disk = new Map<WorkspaceId, string>()
  const records = {
    load: vi.fn(() => Promise.resolve([...disk.values()].map(value => singleVmAllocation.parse(JSON.parse(value))))),
    save: vi.fn((record: SingleVmAllocation) => {
      disk.set(record.workspaceId, JSON.stringify(record))
      return Promise.resolve()
    }),
    remove: vi.fn((id: WorkspaceId) => { disk.delete(id); return Promise.resolve() }),
    outside: vi.fn(),
    close: vi.fn(() => Promise.resolve()),
  }
  const record = (): SingleVmAllocation => singleVmAllocation.parse(JSON.parse(disk.get(workspaceId) ?? 'null'))
  const requests: string[] = []
  let instance: VultrInstance | undefined
  let attached = false
  let mountTag = 113849250
  let visible = true
  let observedAttachment = 0
  let created = 0
  const transport: typeof fetch = async (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const path = url.pathname.replace('/v2', '')
    const method = options?.method ?? 'GET'
    requests.push(method + ' ' + path)
    const lifetime = options?.signal
    const loseResponse = () => new Promise<Response>((_resolve, reject) => {
      if (lifetime === undefined || lifetime === null) throw new Error('Fixture expected a bounded HTTP request')
      lifetime.addEventListener('abort', () => { reject(new Error('Request timed out')) }, { once: true })
    })
    if (path === '/vfs/' + volumeId) return Response.json({ id: volumeId, region: fault === 'region' ? 'ewr' : 'nrt', status: 'active' })
    if (path === '/instances' && method === 'POST') {
      expect(record()).toMatchObject({ phase: 'creating', attachment: { state: 'not-requested' } })
      if (fault === 'create-rejected') return new Response(null, { status: 400 })
      if (fault === 'create-limited') return new Response(null, { status: 429 })
      const body = z.object({ label: z.string(), tags: z.array(z.string()), region: z.literal('nrt'), plan: z.literal('vc2-1c-1gb'),
        os_id: z.literal(2284), user_data: z.string() }).parse(JSON.parse(z.string().parse(options?.body)))
      expect(Buffer.from(body.user_data, 'base64').toString()).toBe('cloud-init')
      instance = { ...body, id: created++ === 0 ? instanceId : freshInstanceId, main_ip: '192.0.2.10', status: 'active', power_status: 'running', server_status: 'ok',
        enable_memorybacking: fault === undefined ? 'none' : 'shared' }
      if (fault === 'create-hidden') { visible = false; return loseResponse() }
      return Response.json({ instance }, { status: 202 })
    }
    if (path === '/instances' && method === 'GET') return Response.json({
      instances: instance === undefined || !visible ? [] : [instance], meta: { links: { next: '' } },
    })
    if (path.startsWith('/instances/')) {
      if (instance === undefined || path !== '/instances/' + instance.id || !visible) return new Response(null, { status: 404 })
      if (method === 'PATCH') {
        expect(record().phase).toBe('sharing')
        expect(options?.body).toBe('{"enable_memorybacking":"shared"}')
        instance = { ...instance, enable_memorybacking: 'shared' }
        return Response.json({ instance }, { status: 202 })
      }
      if (method === 'DELETE') {
        expect(record().cleanup).toBe('deleting')
        expect(attached).toBe(false)
        if (fault === 'delete-timeout') return loseResponse()
        instance = undefined
        return fault === 'delete-applied' ? loseResponse() : new Response(null, { status: 204 })
      }
      return Response.json({ instance: { ...instance, region: fault === 'wrong-instance' ? 'ewr' : instance.region } })
    }
    if (path.startsWith('/vfs/' + volumeId + '/attachments/')) {
      if (method === 'PUT') {
        expect(record()).toMatchObject({ phase: 'attaching', instanceId: instance?.id, attachment: { state: 'requested' } })
        expect(instance?.enable_memorybacking).toBe('shared')
        expect(options?.body).toBeUndefined()
        if (fault === 'attach-rejected') return new Response(null, { status: 422 })
        if (fault === 'attach-limited') return new Response(null, { status: 429 })
        if (fault === 'attach-not-found') return new Response(null, { status: 404 })
        if (fault === 'attachment-timeout') return loseResponse()
        attached = true
      }
      if (method === 'DELETE') {
        expect(record().cleanup).toBe('detaching')
        if (fault === 'detach-timeout') return loseResponse()
        attached = false
        return fault === 'detach-applied' ? loseResponse() : new Response(null, { status: 204 })
      }
      if (!attached || method === 'GET' && record().state === 'starting' && ++observedAttachment === 1) return new Response(null, { status: 404 })
      return Response.json({ vfs_id: fault === 'attachment' ? otherVolume : volumeId, target_id: instance?.id,
        state: 'ATTACHED', mount_tag: fault === 'mount-tag' ? null : mountTag })
    }
    throw new Error('Unexpected request: ' + method + ' ' + path)
  }
  const api = new VultrApi('fixture', 'https://fixture.invalid/v2', 75, 1, 4096, transport)
  const directory = { root: '/volume/workspaces/ws-2de1', volumePath: '/workspaces/ws-2de1', uid: 11001, gid: 11001, assertCurrent: vi.fn() }
  const bootstrap = vi.fn(() => Promise.resolve('cloud-init'))
  const connect = vi.fn(async (_record: SingleVmAllocation, vm: VultrInstance, location: typeof directory, tag: number,
    _signal: AbortSignal, beforeMount: () => Promise<void>) => {
    expect(record()).toMatchObject({ phase: 'attaching', instanceId: vm.id, attachment: { state: 'attached', mountTag: 113849250 } })
    expect(location).toBe(directory)
    expect(tag).toBe(113849250)
    if (fault === 'guest-readiness') throw new Error('Guest readiness marker missing')
    await beforeMount()
    expect(record().phase).toBe('mounting')
    if (fault === 'mount') throw new Error('Wrong guest volume path')
    if (fault === 'permission') throw new Error('Task write probe denied')
    return { host: 'fixture', launch: { kind: 'executable' as const }, helper: '/helper', helperHash: 'a'.repeat(64),
      workspace: fault === 'helper-root' ? '/unexpected' : '/workspace' }
  })
  const retire = vi.fn(async () => { requests.push('SSH retire') })
  const entered = Promise.withResolvers<undefined>()
  const handshake = Promise.withResolvers<undefined>()
  if (fault !== undefined) handshake.resolve(undefined)
  let generation: SandboxContainerId
  const runtime = {
    bind: vi.fn((_id, _connection, reserved?: SandboxContainerId) => {
      if (reserved === undefined) throw new Error('Expected the durable generation')
      generation = reserved
      expect(record()).toMatchObject({ phase: 'handshake', generation })
    }),
    open: vi.fn(async (): Promise<RunnerRunningSandbox> => {
      entered.resolve(undefined)
      await handshake.promise
      if (fault === 'handshake') throw new Error('Helper handshake rejected')
      return { state: 'running', containerId: fault === 'helper-generation' ? stale : generation }
    }),
    status: vi.fn(async (): Promise<RunnerSandboxStatus> => ({ state: 'running', containerId: generation })),
    execute: vi.fn(), files: vi.fn(), cancel: vi.fn(), dispose: vi.fn(() => Promise.resolve()),
    close: vi.fn(async () => { requests.push('SSH close'); return { state: 'closed' as const } }),
    releaseStopped: vi.fn(async () => {}),
  }
  const report = vi.fn()
  const make = () =>
    new SingleVmVultrBackend(settings, api, records, { resolve: () => directory }, { bootstrap, connect, retire }, runtime, report)
  return { make, record, records, requests, directory, api, connect, retire, runtime, report, entered, handshake,
    setFault(value?: Fault) { fault = value },
    setMountTag(value: number) { mountTag = value },
    hideInstance() { visible = false },
    revealInstance() { visible = true },
    revealAttachment() { attached = true },
  }
}

test('reserves capacity and one durable generation through shared memory, VFS and helper readiness', async () => {
  const f = fixture()
  const backend = f.make()
  await expect(backend.open(workspaceId, project)).rejects.toMatchObject({ code: 'runner_unavailable' })
  await expect(backend.close(workspaceId)).resolves.toEqual({ state: 'closed' })
  await expect(backend.closeTask(workspaceId, stale)).resolves.toEqual({ state: 'closed' })
  await backend.initialize()
  const first = backend.open(workspaceId, project)
  const duplicate = backend.open(workspaceId, project)
  try {
    await f.entered.promise
    const { generation } = f.record()
    const identity = executionIdentity.parse({ executionId: 'task-one', expectedContainerId: generation })
    const execution = executionRequest.parse({ ...identity, command: 'pwd', workdir: '.', timeoutMs: 1000 })
    await expect(backend.status(workspaceId)).resolves.toEqual({ state: 'starting' })
    await expect(backend.closeTask(workspaceId, generation)).rejects.toMatchObject({ code: 'sandbox_closing' })
    await expect(backend.open(workspaceId, '/registered/replaced')).rejects.toMatchObject({ code: 'sandbox_workspace_conflict' })
    expect(() => { void backend.execute(workspaceId, execution) }).toThrow('sandbox_workspace_conflict')
    expect(() => { void backend.files(workspaceId, generation) }).toThrow('sandbox_workspace_conflict')
    await expect(backend.open(secondId, '/registered/ws-2')).rejects.toMatchObject({ code: 'sandbox_capacity' })
    f.handshake.resolve(undefined)
    const ready = { state: 'running', containerId: generation }
    await expect(first).resolves.toEqual(ready)
    await expect(duplicate).resolves.toEqual(ready)
    await expect(backend.open(workspaceId, project)).resolves.toEqual(ready)
    f.runtime.status.mockResolvedValueOnce({ state: 'running', containerId: stale })
    await expect(backend.status(workspaceId)).resolves.toEqual({ state: 'cleanup_required' })
    expect(f.requests.filter(request => request === 'POST /instances')).toHaveLength(1)
    expect(f.requests.filter(request => request.startsWith('PUT '))).toHaveLength(1)
    expect(() => { void backend.execute(workspaceId, { ...execution, expectedContainerId: stale }) }).toThrow('sandbox_workspace_conflict')
    await backend.execute(workspaceId, execution)
    await backend.cancel(workspaceId, identity)
    await backend.files(workspaceId, generation)
    expect(f.runtime.execute).toHaveBeenCalledWith(workspaceId, execution, undefined)
    expect(f.runtime.cancel).toHaveBeenCalledWith(workspaceId, identity)
    expect(f.runtime.files).toHaveBeenCalledWith(workspaceId, generation, undefined)
    await expect(backend.close(workspaceId)).rejects.toMatchObject({ code: 'sandbox_cleanup_required' })
  } finally {
    f.handshake.resolve(undefined)
    await backend.dispose()
  }
})

test('waits for pending instance and volume states before starting the pinned helper', async () => {
  const f = fixture()
  f.handshake.resolve(undefined)
  const getInstance = f.api.instance.bind(f.api)
  const observeInstance = vi.spyOn(f.api, 'instance').mockImplementationOnce(async (id, signal) => {
    const vm = await getInstance(id, signal)
    if (vm === undefined) throw new Error('Fixture instance was not created')
    return { ...vm, status: 'pending', main_ip: '0.0.0.0' }
  })
  const getAttachment = f.api.attachment.bind(f.api)
  const observeAttachment = vi.spyOn(f.api, 'attachment').mockImplementationOnce(async (volume, id, signal) => {
    await getAttachment(volume, id, signal)
    return { vfs_id: volume, target_id: id, state: 'PENDING' }
  })
  const backend = f.make()
  try {
    await backend.initialize()
    const ready = await backend.open(workspaceId, project)
    expect(observeInstance.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(observeAttachment).toHaveBeenCalledTimes(2)
    expect(f.runtime.open).toHaveBeenCalledOnce()
    await backend.closeTask(workspaceId, ready.containerId)
  } finally { await backend.dispose() }
})

test('retains an allocation if the VFS Mount Tag changes and reclaims it after the original tag returns', async () => {
  const f = fixture()
  f.handshake.resolve(undefined)
  const backend = f.make()
  try {
    await backend.initialize()
    const ready = await backend.open(workspaceId, project)
    f.setMountTag(113849251)
    await expect(backend.closeTask(workspaceId, ready.containerId)).rejects.toMatchObject({
      code: 'sandbox_cleanup_required', cause: { message: 'Original VFS Mount Tag has changed' },
    })
    expect(f.record().cleanup).toBe('unmounted')
    expect(f.requests.some(value => value.startsWith('DELETE '))).toBe(false)
    f.setMountTag(113849250)
    await backend.recoverTask(workspaceId)
    expect(f.retire).toHaveBeenCalledOnce()
    await expect(backend.status(workspaceId)).resolves.toEqual({ state: 'closed', reconciled: true })
  } finally { await backend.dispose() }
})

test('rejects an out-of-region volume before creating an allocation record or requesting an instance', async () => {
  const f = fixture('region')
  const backend = f.make()
  await backend.initialize()
  await expect(backend.open(workspaceId, project)).rejects.toMatchObject({ code: 'cloud_open_failed', outcomeUnknown: false })
  await expect(backend.status(workspaceId)).resolves.toEqual({ state: 'closed' })
  expect(f.records.save).not.toHaveBeenCalled()
  expect(f.requests).not.toContain('POST /instances')
  await backend.dispose()
})

test.each([
  ['wrong-instance', 'booting', 'not-requested', true], ['attachment', 'attaching', 'requested', true],
  ['guest-readiness', 'attaching', 'attached', false], ['mount-tag', 'attaching', 'requested', false],
  ['mount', 'mounting', 'attached', false], ['permission', 'mounting', 'attached', false], ['handshake', 'handshake', 'attached', false],
  ['helper-root', 'mounting', 'attached', false], ['helper-generation', 'handshake', 'attached', false],
  ['attachment-timeout', 'attaching', 'requested', true],
] as const)('handles %s startup failure without accepting commands', async (fault, phase, attachment, retained) => {
  const f = fixture(fault)
  const backend = f.make()
  await backend.initialize()
  await expect(backend.open(workspaceId, project)).rejects.toMatchObject({ code: 'cloud_open_failed', outcomeUnknown: retained })
  expect(f.report.mock.calls[0]?.[0]).toMatchObject({ phase, instanceId, attachment: { state: attachment } })
  await expect(backend.status(workspaceId)).resolves.toEqual(retained ? { state: 'cleanup_required' } : { state: 'closed', reconciled: true })
  expect(() => { void backend.files(workspaceId, stale) }).toThrow('sandbox_workspace_conflict')
  if (phase !== 'handshake') expect(f.runtime.open).not.toHaveBeenCalled()
  expect(f.requests.includes('DELETE /instances/' + instanceId)).toBe(!retained)
  if (fault === 'guest-readiness') {
    expect(f.retire).not.toHaveBeenCalled()
    expect(f.requests.filter(value => value.startsWith('DELETE '))).toEqual([
      'DELETE /vfs/' + volumeId + '/attachments/' + instanceId, 'DELETE /instances/' + instanceId,
    ])
  }
  if (fault === 'attachment-timeout') {
    f.revealAttachment()
    await backend.recoverTask(workspaceId)
    expect(f.requests.includes('DELETE /instances/' + instanceId)).toBe(true)
    expect(f.requests.filter(request => request.startsWith('PUT '))).toHaveLength(1)
  }
  await backend.dispose()
})

test('retains cleanup evidence when the original guest disappears before synchronization', async () => {
  const f = fixture()
  f.handshake.resolve(undefined)
  const backend = f.make()
  try {
    await backend.initialize()
    const ready = await backend.open(workspaceId, project)
    f.hideInstance()
    await expect(backend.closeTask(workspaceId, ready.containerId)).rejects.toMatchObject({
      code: 'sandbox_cleanup_required', cause: { message: 'Guest disappeared before workspace synchronization was confirmed' },
    })
    expect(f.record()).toMatchObject({ cleanup: 'draining', generation: ready.containerId })
    expect(f.requests.some(value => value.startsWith('DELETE '))).toBe(false)
    f.revealInstance()
    await backend.recoverTask(workspaceId)
    expect(f.retire).toHaveBeenCalledOnce()
  } finally { await backend.dispose() }
})

test('retains an unanswered create by unique label across restart and charges it against capacity', async () => {
  const f = fixture('create-hidden')
  const first = f.make()
  await first.initialize()
  await expect(first.open(workspaceId, project)).rejects.toMatchObject({ code: 'cloud_open_failed', outcomeUnknown: true })
  const retained = f.record()
  expect(retained).toMatchObject({ state: 'cleanup_required', phase: 'creating' })
  expect(retained.instanceId).toBeUndefined()
  await first.dispose()
  const restarted = f.make()
  await restarted.initialize()
  await expect(restarted.open(workspaceId, project)).rejects.toMatchObject({ code: 'sandbox_cleanup_required' })
  await expect(restarted.open(secondId, '/registered/ws-2')).rejects.toMatchObject({ code: 'sandbox_capacity' })
  expect(f.requests.filter(request => request === 'POST /instances')).toHaveLength(1)
  expect(f.connect).not.toHaveBeenCalled()
  f.revealInstance()
  await restarted.recoverTask(workspaceId)
  expect(f.requests).toContain('DELETE /instances/' + instanceId)
  await expect(restarted.status(workspaceId)).resolves.toEqual({ state: 'closed', reconciled: true })
  await restarted.dispose()
})

function task(backend: SingleVmVultrBackend): TaskSandboxLifecycle {
  return new TaskSandboxLifecycle({
    open: () => backend.open(workspaceId, project),
    close: async (target) => { await backend.closeTask(workspaceId, target.containerId) },
    recover: () => backend.recoverTask(workspaceId),
    failed: vi.fn(),
  })
}

test('task settlement fences a disconnected helper, waits for guest cleanup, and closes only the captured VM', async () => {
  const f = fixture()
  f.handshake.resolve(undefined)
  const backend = f.make()
  await backend.initialize()
  const lifecycle = task(backend)
  const signal = new AbortController().signal
  const first = await lifecycle.acquire(signal)
  const queued = await lifecycle.reserve(signal)
  const writing = await lifecycle.reserve(signal)
  await first.release()
  expect(await queued.ready()).toBe(first.target)
  await queued.release()
  expect(f.runtime.close).not.toHaveBeenCalled()

  const retired = Promise.withResolvers<undefined>()
  f.retire.mockImplementationOnce(async () => {
    f.requests.push('SSH retire')
    await retired.promise
  })
  f.runtime.close.mockRejectedValueOnce(new Error('helper disconnected'))
  f.runtime.status.mockResolvedValueOnce({ state: 'cleanup_required' })
  await expect(backend.status(workspaceId)).resolves.toEqual({ state: 'cleanup_required' })
  const closed = writing.release()
  const next = lifecycle.acquire(signal)
  await vi.waitFor(() => { expect(f.retire).toHaveBeenCalledOnce() })
  expect(f.runtime.close).toHaveBeenCalledOnce()
  await expect(backend.status(workspaceId)).resolves.toEqual({ state: 'closing' })
  expect(f.requests.some(value => value.startsWith('DELETE '))).toBe(false)
  retired.resolve(undefined)
  await closed
  const fresh = await next
  expect(fresh.target.containerId).not.toBe(first.target.containerId)
  expect(f.record().instanceId).toBe(freshInstanceId)
  const operations = f.requests.filter(value => value === 'SSH retire' || value.startsWith('DELETE '))
  expect(operations).toEqual(['SSH retire', 'DELETE /vfs/' + volumeId + '/attachments/' + instanceId, 'DELETE /instances/' + instanceId])
  await expect(backend.closeTask(workspaceId, first.target.containerId)).rejects.toMatchObject({ code: 'sandbox_workspace_conflict' })
  expect(f.record().instanceId).toBe(freshInstanceId)
  await fresh.release()
  await backend.dispose()
})

test.each(['create-rejected', 'create-limited', 'attach-rejected', 'attach-limited', 'attach-not-found', 'permission'] as const)('a confirmed %s failure allows the next task without restarting', async (fault) => {
  const f = fixture(fault)
  const backend = f.make()
  await backend.initialize()
  const lifecycle = task(backend)
  const signal = new AbortController().signal
  await expect(lifecycle.acquire(signal)).rejects.toMatchObject({ code: 'cloud_open_failed', outcomeUnknown: false })
  expect(lifecycle.status()).toBe('closed')
  if (fault === 'attach-limited' || fault === 'attach-not-found') {
    expect(f.requests.filter(value => value.startsWith('DELETE '))).toEqual(['DELETE /instances/' + instanceId])
    expect(f.connect).not.toHaveBeenCalled()
  }
  f.setFault()
  const fresh = await lifecycle.acquire(signal)
  await fresh.release()
  expect(f.requests.filter(value => value === 'POST /instances')).toHaveLength(2)
  await backend.dispose()
})

test.each(['detach-timeout', 'delete-timeout'] as const)('resumes %s after restart without another create or guest sync', async (fault) => {
  const f = fixture(fault)
  const backend = f.make()
  await backend.initialize()
  const ready = await backend.open(workspaceId, project)
  await expect(backend.closeTask(workspaceId, ready.containerId)).rejects.toMatchObject({ code: 'sandbox_cleanup_required' })
  expect(f.record()).toMatchObject({ state: 'cleanup_required', phase: 'running',
    cleanup: fault === 'detach-timeout' ? 'detaching' : 'deleting', generation: ready.containerId, instanceId })
  expect(f.requests.filter(value => value === 'DELETE /instances/' + instanceId)).toHaveLength(fault === 'detach-timeout' ? 0 : 1)
  await backend.dispose()
  f.setFault()
  const restarted = f.make()
  await restarted.initialize()
  await restarted.recoverTask(workspaceId)
  expect(f.retire).toHaveBeenCalledOnce()
  expect(f.requests.filter(value => value === 'POST /instances')).toHaveLength(1)
  await expect(restarted.status(workspaceId)).resolves.toEqual({ state: 'closed', reconciled: true })
  await restarted.dispose()
})

test.each(['detach-applied', 'delete-applied'] as const)('confirms %s after its response was lost without repeating it', async (fault) => {
  const f = fixture(fault)
  const backend = f.make()
  await backend.initialize()
  const ready = await backend.open(workspaceId, project)
  await expect(backend.closeTask(workspaceId, ready.containerId)).resolves.toEqual({ state: 'closed', reconciled: true })
  expect(f.requests.filter(value => value.startsWith('DELETE '))).toEqual([
    'DELETE /vfs/' + volumeId + '/attachments/' + instanceId, 'DELETE /instances/' + instanceId,
  ])
  await backend.dispose()
})

test('confirmed Single VM retry clears management quarantine and a new allocation withdraws that evidence', async () => {
  const f = fixture('delete-timeout')
  f.handshake.resolve(undefined)
  const backend = f.make()
  const ctx = new Context()
  await ctx.plugin(WorkspaceSandboxState)
  const state = ctx.workspaceSandboxState
  try {
    await backend.initialize()
    await expect(backend.status(secondId)).resolves.toEqual({ state: 'closed' })
    const ready = await backend.open(workspaceId, project)
    await expect(state.close(workspaceId, async () => {
      try { return await backend.closeTask(workspaceId, ready.containerId) }
      catch (cause) {
        throw new RemoteError('sandbox/failed', 'Original VM deletion is unconfirmed', {
          reason: 'runner_outcome_unknown', outcomeUnknown: true,
        }, { cause })
      }
    })).rejects.toMatchObject({ code: 'sandbox/failed' })
    expect(state.closing(workspaceId)).toBe('cleanup_required')
    f.setFault()
    await expect(state.close(workspaceId, async () => {
      await backend.recoverTask(workspaceId)
      const current = await backend.status(workspaceId)
      if (current.state !== 'closed') throw new Error('Original allocation remains')
      return current
    })).resolves.toEqual({ state: 'closed', reconciled: true })
    expect(state.closing(workspaceId)).toBeUndefined()
    expect(f.requests.filter(request => request === 'POST /instances')).toHaveLength(1)
    f.setFault('region')
    await expect(backend.open(workspaceId, project)).rejects.toMatchObject({ code: 'cloud_open_failed' })
    await expect(backend.status(workspaceId)).resolves.toEqual({ state: 'closed' })
    f.setFault()
    const fresh = await backend.open(workspaceId, project)
    expect(fresh.containerId).not.toBe(ready.containerId)
    await expect(backend.status(workspaceId)).resolves.toEqual(fresh)
    await backend.closeTask(workspaceId, fresh.containerId)
  } finally {
    f.setFault()
    await backend.dispose()
    await ctx.fiber.dispose()
  }
})

test('a failed guest sync blocks detach and the next task first reconciles the old VM', async () => {
  const f = fixture('delete-applied')
  f.retire.mockRejectedValueOnce(new Error('guest synchronization unconfirmed'))
  const backend = f.make()
  await backend.initialize()
  const lifecycle = task(backend)
  const signal = new AbortController().signal
  const old = await lifecycle.acquire(signal)
  await expect(old.release()).rejects.toMatchObject({ phase: 'close' })
  expect(lifecycle.status()).toBe('cleanup-required')
  expect(f.record()).toMatchObject({ state: 'cleanup_required', cleanup: 'draining', instanceId })
  expect(f.requests.some(value => value.startsWith('DELETE '))).toBe(false)
  f.setFault()
  const fresh = await lifecycle.acquire(signal)
  expect(fresh.target).not.toEqual(old.target)
  expect(f.record().instanceId).toBe(freshInstanceId)
  await fresh.release()
  await backend.dispose()
})

test('an interrupted caller waits for the late allocation to be reclaimed', async () => {
  const f = fixture()
  const backend = f.make()
  await backend.initialize()
  const lifecycle = task(backend)
  const controller = new AbortController()
  const request = lifecycle.acquire(controller.signal)
  await f.entered.promise
  controller.abort(new Error('task cancelled during startup'))
  f.handshake.resolve(undefined)
  await expect(request).rejects.toThrow('task cancelled during startup')
  expect(f.requests).toContain('DELETE /instances/' + instanceId)
  expect(lifecycle.status()).toBe('closed')
  await backend.dispose()
})
