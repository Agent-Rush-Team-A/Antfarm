import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { expect, test, type TestContext } from 'vitest'
import SandboxRunner from '../src/index.ts'
import { sandboxName } from '../src/config.ts'

const deployment = 'lifecycle-test'
const A = brandString<WorkspaceId>('A')
const B = brandString<WorkspaceId>('B')
const C = brandString<WorkspaceId>('C')

interface Call {
  method: string
  url: URL
  body: unknown
}

interface Reply {
  status: number
  body?: unknown
}

interface FakeContainer {
  Id: string
  Name: string
  State: { Running: boolean; Paused: boolean; Status?: string }
  Config: { Labels: Record<string, string> }
  Mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean }>
}

type Intercept = (call: Call, respond: () => Reply) => Reply | Promise<Reply>

function creation(call: Call, id?: WorkspaceId): boolean {
  return call.method === 'POST' && call.url.pathname === '/v1.51/containers/create'
    && (id === undefined || call.url.searchParams.get('name') === sandboxName(deployment, id))
}

async function fixture(t: TestContext, requestTimeoutMs = 5_000) {
  const temp = await mkdtemp(join(await realpath(tmpdir()), 'dsh-life-'))
  t.onTestFinished(() => rm(temp, { recursive: true, force: true }))
  const root = join(temp, 'workspaces')
  const directory = (id: WorkspaceId) => join(root, id)
  await Promise.all([A, B, C].map(id => mkdir(directory(id), { recursive: true })))
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\dsh-life-${randomUUID()}` : join(temp, 'engine.sock')
  const calls: Call[] = []
  const containers = new Map<string, FakeContainer>()
  let nextId = 0
  const id = () => (++nextId).toString(16).padStart(64, '0')
  const control: { intercept?: Intercept } = {}

  function seed(workspace: WorkspaceId, state: FakeContainer['State'], owner = deployment): FakeContainer {
    const container: FakeContainer = {
      Id: id(),
      Name: `/${sandboxName(owner, workspace)}`,
      State: state,
      Config: {
        Labels: {
          'org.agentrush.sandbox.project': 'agentrush',
          'org.agentrush.sandbox.deployment': owner,
          'org.agentrush.sandbox.workspace': workspace,
        },
      },
      Mounts: [{ Type: 'bind', Source: directory(workspace), Destination: '/workspace', RW: true }],
    }
    containers.set(container.Id, container)
    return container
  }

  function reply(call: Call): Reply {
    const { method, url } = call
    if (creation(call)) {
      const body = call.body as {
        Labels: Record<string, string>
        HostConfig: { Mounts: Array<{ Type: string; Source: string; Target: string; ReadOnly: boolean }> }
      }
      const name = `/${url.searchParams.get('name')}`
      if ([...containers.values()].some(container => container.Name === name)) return { status: 409 }
      const container: FakeContainer = {
        Id: id(), Name: name, State: { Running: false, Paused: false },
        Config: { Labels: body.Labels },
        Mounts: body.HostConfig.Mounts.map(mount => ({
          Type: mount.Type, Source: mount.Source, Destination: mount.Target, RW: !mount.ReadOnly,
        })),
      }
      containers.set(container.Id, container)
      return { status: 201, body: { Id: container.Id } }
    }
    if (method === 'GET' && url.pathname === '/v1.51/containers/json') {
      return { status: 200, body: [...containers.keys()].map(Id => ({ Id })) }
    }
    const [, version, collection, key, action] = url.pathname.split('/')
    if (version !== 'v1.51' || collection !== 'containers' || !key) return { status: 500 }
    const container = containers.get(key) ?? [...containers.values()].find(row => row.Name === `/${key}`)
    if (!container) return { status: 404 }
    if (method === 'GET' && action === 'json') return { status: 200, body: container }
    if (method === 'POST' && key === container.Id && action === 'start') {
      container.State = { Running: true, Paused: false }
      return { status: 204 }
    }
    if (method === 'DELETE' && key === container.Id && url.searchParams.get('force') === 'true') {
      containers.delete(key)
      return { status: 204 }
    }
    return { status: 500 }
  }

  const server = createServer((request, response) => {
    request.setEncoding('utf8')
    let body = ''
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      const parsed: unknown = body ? JSON.parse(body) : undefined
      const call = { method: request.method ?? '', url: new URL(request.url ?? '/', 'http://docker'), body: parsed }
      calls.push(call)
      const respond = () => reply(call)
      void Promise.resolve(control.intercept ? control.intercept(call, respond) : respond()).then(({ status, body: data }) => {
        response.writeHead(status, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(data))
      })
    })
  })
  server.listen(socket)
  await once(server, 'listening')
  t.onTestFinished(() => new Promise<void>((resolve) => {
    server.close(() => { resolve() })
    server.closeAllConnections()
  }))

  function mount(ctx: Context) {
    const fiber = ctx.plugin(SandboxRunner, {
      dockerSocket: socket, deploymentId: deployment, workspaceRoot: root, requestTimeoutMs,
      image: `debian@sha256:${'b'.repeat(64)}`, uid: 10001, gid: 10001,
    })
    t.onTestFinished(async () => { await fiber.dispose() })
    return fiber
  }

  async function boot(ctx = new Context()) {
    await mount(ctx)
    return ctx.sandboxRunner
  }

  return { boot, mount, calls, containers, control, directory, seed }
}

test('concurrent callers share one create and only two workspaces reserve capacity', async (t) => {
  const f = await fixture(t)
  const runner = await f.boot()
  const aArrived = Promise.withResolvers<undefined>()
  const bArrived = Promise.withResolvers<undefined>()
  const allow = Promise.withResolvers<undefined>()
  const before = f.calls.length
  await expect(runner.open(A, `${f.directory(A)}-missing`)).rejects.toMatchObject({ name: 'InvalidWorkspaceDirectoryError' })
  expect(f.calls).toHaveLength(before)
  f.control.intercept = async (call, respond) => {
    if (creation(call)) {
      if (creation(call, A)) aArrived.resolve(undefined)
      if (creation(call, B)) bArrived.resolve(undefined)
      await allow.promise
    }
    return respond()
  }
  const first = runner.open(A, f.directory(A))
  await aArrived.promise
  const joined = runner.open(A, f.directory(A))
  await expect(runner.status(A)).resolves.toEqual({ state: 'starting' })
  await expect(runner.open(A, f.directory(B))).rejects.toMatchObject({ code: 'sandbox_workspace_conflict' })
  const second = runner.open(B, f.directory(B))
  await bArrived.promise
  const callsBeforeDenial = f.calls.length
  await expect(runner.open(C, f.directory(C))).rejects.toMatchObject({ code: 'sandbox_capacity' })
  expect(f.calls).toHaveLength(callsBeforeDenial)
  allow.resolve(undefined)
  const result = await first
  await expect(second).resolves.toMatchObject({ state: 'running' })
  expect(await joined).toEqual(result)
  expect(await runner.open(A, f.directory(A))).toEqual(result)
  expect(await runner.status(A)).toEqual(result)
  expect(f.calls.filter(call => creation(call, A))).toHaveLength(1)

  const entry = f.containers.get(result.containerId)
  if (!entry?.Mounts[0]) throw new Error('Expected workspace mount')
  entry.Mounts[0].Source = f.directory(B)
  await expect(runner.open(A, f.directory(A))).rejects.toMatchObject({ code: 'sandbox_workspace_conflict' })
})

test('close during create blocks reopen, skips start and removes the acknowledged ID', async (t) => {
  const f = await fixture(t)
  const runner = await f.boot()
  const arrived = Promise.withResolvers<undefined>()
  const allow = Promise.withResolvers<undefined>()
  f.control.intercept = async (call, respond) => {
    if (creation(call, A)) {
      arrived.resolve(undefined)
      await allow.promise
    }
    return respond()
  }
  const opening = expect(runner.open(A, f.directory(A))).rejects.toMatchObject({ code: 'sandbox_closing' })
  await arrived.promise
  const closing = runner.close(A)
  const joined = runner.close(A)
  await expect(runner.status(A)).resolves.toEqual({ state: 'closing' })
  await expect(runner.open(A, f.directory(A))).rejects.toMatchObject({ code: 'sandbox_closing' })
  allow.resolve(undefined)
  await opening
  await expect(closing).resolves.toEqual({ state: 'closed' })
  await expect(joined).resolves.toEqual({ state: 'closed' })
  expect(f.calls.filter(call => call.url.pathname.endsWith('/start'))).toHaveLength(0)
  const oldId = '1'.padStart(64, '0')
  const deletion = f.calls.findIndex(call => call.method === 'DELETE' && call.url.pathname.endsWith(oldId))
  expect(deletion).toBeGreaterThan(-1)
  expect(f.calls[deletion + 1]?.url.pathname).toBe(`/v1.51/containers/${oldId}/json`)
  expect(f.containers.size).toBe(0)
  await expect(runner.open(A, f.directory(A))).resolves.toMatchObject({
    state: 'running', containerId: '2'.padStart(64, '0'),
  })
})

test('a timed-out create retains capacity through name misses and can close the late generation', async (t) => {
  const f = await fixture(t, 500)
  const runner = await f.boot()
  const allow = Promise.withResolvers<undefined>()
  const appeared = Promise.withResolvers<undefined>()
  f.control.intercept = async (call, respond) => {
    if (!creation(call, A)) return respond()
    await allow.promise
    const response = respond()
    appeared.resolve(undefined)
    return response
  }
  await expect(runner.open(A, f.directory(A))).rejects.toMatchObject({ kind: 'transport' })
  await expect(runner.status(A)).rejects.toMatchObject({ code: 'sandbox_outcome_unknown' })
  await expect(runner.close(A)).rejects.toMatchObject({ code: 'sandbox_outcome_unknown' })
  const stale = f.seed(A, { Running: false, Paused: false })
  await expect(runner.status(A)).rejects.toMatchObject({ code: 'sandbox_outcome_unknown' })
  await expect(runner.close(A)).rejects.toMatchObject({ code: 'sandbox_outcome_unknown' })
  expect(f.containers.delete(stale.Id)).toBe(true)
  await runner.open(B, f.directory(B))
  await expect(runner.open(C, f.directory(C))).rejects.toMatchObject({ code: 'sandbox_capacity' })
  await expect(runner.open(A, f.directory(A))).rejects.toMatchObject({ code: 'sandbox_cleanup_required' })
  expect(f.calls.filter(call => creation(call, A))).toHaveLength(1)
  allow.resolve(undefined)
  await appeared.promise
  await expect(runner.status(A)).resolves.toEqual({ state: 'cleanup_required' })
  await expect(runner.close(A)).resolves.toEqual({ state: 'closed' })
  await expect(runner.open(C, f.directory(C))).resolves.toMatchObject({ state: 'running' })
})

test('delete failure or a still-present ID preserves capacity; observed absence releases it', async (t) => {
  const f = await fixture(t)
  const runner = await f.boot()
  const first = await runner.open(A, f.directory(A))
  await runner.open(B, f.directory(B))
  const isDelete = (call: Call) => call.method === 'DELETE' && call.url.pathname.endsWith(first.containerId)
  f.control.intercept = (call, respond) => isDelete(call) ? { status: 503 } : respond()
  await expect(runner.close(A)).rejects.toMatchObject({ kind: 'engine', details: { status: 503 } })
  await expect(runner.status(A)).resolves.toEqual({ state: 'cleanup_required' })
  await expect(runner.open(C, f.directory(C))).rejects.toMatchObject({ code: 'sandbox_capacity' })
  f.control.intercept = (call, respond) => isDelete(call) ? { status: 204 } : respond()
  await expect(runner.close(A)).rejects.toMatchObject({ code: 'sandbox_cleanup_required' })
  await expect(runner.open(A, f.directory(A))).rejects.toMatchObject({ code: 'sandbox_cleanup_required' })
  f.control.intercept = (call, respond) => {
    const response = respond()
    return isDelete(call) ? { status: 503 } : response
  }
  await expect(runner.close(A)).resolves.toEqual({ state: 'closed' })
  expect(f.calls.filter(call => call.method === 'DELETE').map(call => call.url.pathname))
    .toEqual(Array.from({ length: 3 }, () => `/v1.51/containers/${first.containerId}`))
  await expect(runner.open(C, f.directory(C))).resolves.toMatchObject({ state: 'running' })
})

test('replaces a paused generation only after its full ID is confirmed absent', async (t) => {
  const f = await fixture(t)
  const runner = await f.boot()
  const first = await runner.open(A, f.directory(A))
  const container = f.containers.get(first.containerId)
  if (!container) throw new Error('Expected old container')
  container.State.Paused = true
  await expect(runner.status(A)).resolves.toEqual({ state: 'cleanup_required' })
  const before = f.calls.length
  const replacement = await runner.open(A, f.directory(A))
  expect(replacement.containerId).not.toBe(first.containerId)
  expect(f.calls.slice(before, before + 3).map(call => `${call.method} ${call.url.pathname}`)).toEqual([
    `GET /v1.51/containers/${first.containerId}/json`,
    `DELETE /v1.51/containers/${first.containerId}`,
    `GET /v1.51/containers/${first.containerId}/json`,
  ])
  expect(f.containers.has(first.containerId)).toBe(false)
})

test('startup waits for deployment cleanup and leaves other containers and workspace files intact', async (t) => {
  const f = await fixture(t)
  const a = f.seed(A, { Running: true, Paused: false, Status: 'running' })
  const b = f.seed(B, { Running: false, Paused: false, Status: 'exited' })
  const c = f.seed(C, { Running: false, Paused: false, Status: 'created' })
  const foreign = f.seed(A, { Running: true, Paused: false }, 'other-deployment')
  const unowned = f.seed(A, { Running: false, Paused: false, Status: 'created' })
  unowned.Name = '/unowned'
  delete unowned.Config.Labels['org.agentrush.sandbox.workspace']
  const keep = join(f.directory(A), 'keep.txt')
  await writeFile(keep, 'workspace data')
  const arrived = Promise.withResolvers<undefined>()
  const allow = Promise.withResolvers<undefined>()
  f.control.intercept = async (call, respond) => {
    if (call.method === 'DELETE' && call.url.pathname.endsWith(a.Id)) {
      arrived.resolve(undefined)
      await allow.promise
    }
    return respond()
  }
  const ctx = new Context()
  const boot = f.boot(ctx)
  await arrived.promise
  await expect(ctx.sandboxRunner.open(A, f.directory(A))).rejects.toMatchObject({ code: 'sandbox_not_ready' })
  allow.resolve(undefined)
  const runner = await boot
  expect(f.calls.filter(call => call.method === 'DELETE').map(call => call.url.pathname)).toEqual(
    [a, b, c].map(container => `/v1.51/containers/${container.Id}`),
  )
  expect([...f.containers.keys()]).toEqual([foreign.Id, unowned.Id])
  expect(await readFile(keep, 'utf8')).toBe('workspace data')

  const late = f.seed(A, { Running: false, Paused: false })
  await expect(runner.status(A)).resolves.toEqual({ state: 'cleanup_required' })
  const first = await runner.open(A, f.directory(A))
  expect(first.containerId).not.toBe(late.Id)
  expect(f.containers.has(late.Id)).toBe(false)
  expect(f.containers.has(foreign.Id)).toBe(true)
})

test('a stable name owned by another deployment is never started, reused or deleted', async (t) => {
  const f = await fixture(t)
  const runner = await f.boot()
  const foreign = f.seed(A, { Running: true, Paused: false }, 'other-deployment')
  foreign.Name = `/${sandboxName(deployment, A)}`
  await expect(runner.open(A, f.directory(A))).rejects.toMatchObject({ code: 'sandbox_name_conflict' })
  await expect(runner.close(A)).rejects.toMatchObject({ code: 'sandbox_name_conflict' })
  expect(f.calls.every(call => call.method === 'GET')).toBe(true)
  expect(f.containers.get(foreign.Id)).toBe(foreign)
})

test('startup fails closed when Docker acknowledges deletion but the old ID remains', async (t) => {
  const f = await fixture(t)
  const old = f.seed(A, { Running: true, Paused: false })
  f.control.intercept = (call, respond) => call.method === 'DELETE' ? { status: 204 } : respond()
  await expect(f.boot()).rejects.toMatchObject({ code: 'sandbox_cleanup_required' })
  expect(f.containers.get(old.Id)).toBe(old)
  expect(f.calls.at(-1)?.url.pathname).toBe(`/v1.51/containers/${old.Id}/json`)
})

test('disposal cancels a Docker startup request that has not received a reply', async (t) => {
  const f = await fixture(t, 30_000)
  const ctx = new Context()
  const requested = Promise.withResolvers<Call>()
  const reply = Promise.withResolvers<Reply>()
  f.control.intercept = (call) => {
    requested.resolve(call)
    return reply.promise
  }
  const fiber = f.mount(ctx)
  t.onTestFinished(() => { reply.resolve({ status: 200, body: [] }) })
  let loaded = false
  const loading = fiber.await().then(() => { loaded = true })
  expect((await requested.promise).url.pathname).toBe('/v1.51/containers/json')

  const sibling = await ctx.plugin(() => {})
  await sibling.dispose()
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(loaded).toBe(false)

  await fiber.dispose()
  await loading
  expect(f.calls).toHaveLength(1)
})

test('an orphan close reserves capacity once identified, and disposal waits for deletion', async (t) => {
  const f = await fixture(t)
  const ctx = new Context()
  const runner = await f.boot(ctx)
  const orphan = f.seed(A, { Running: false, Paused: false })
  const lookup = Promise.withResolvers<undefined>()
  const allowLookup = Promise.withResolvers<undefined>()
  const deletion = Promise.withResolvers<undefined>()
  const allowDeletion = Promise.withResolvers<undefined>()
  t.onTestFinished(() => {
    allowLookup.resolve(undefined)
    allowDeletion.resolve(undefined)
  })
  f.control.intercept = async (call, respond) => {
    if (call.url.pathname.endsWith(`/${sandboxName(deployment, A)}/json`)) {
      lookup.resolve(undefined)
      await allowLookup.promise
    }
    if (call.method === 'DELETE' && call.url.pathname.endsWith(orphan.Id)) {
      deletion.resolve(undefined)
      await allowDeletion.promise
    }
    return respond()
  }

  const closing = runner.close(A)
  await lookup.promise
  await expect(runner.open(B, f.directory(B))).resolves.toMatchObject({ state: 'running' })
  allowLookup.resolve(undefined)
  await deletion.promise
  await expect(runner.open(C, f.directory(C))).rejects.toMatchObject({ code: 'sandbox_capacity' })

  let disposed = false
  const disposal = Promise.resolve(ctx.fiber.dispose()).then(() => { disposed = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(disposed).toBe(false)
  allowDeletion.resolve(undefined)
  await expect(closing).resolves.toEqual({ state: 'closed' })
  await disposal
  expect(f.containers.has(orphan.Id)).toBe(false)
})

test('disposal waits for an in-flight status inspection', async (t) => {
  const f = await fixture(t)
  const ctx = new Context()
  const runner = await f.boot(ctx)
  const inspecting = Promise.withResolvers<undefined>()
  const allowInspection = Promise.withResolvers<undefined>()
  t.onTestFinished(() => { allowInspection.resolve(undefined) })
  f.control.intercept = async (_call, respond) => {
    inspecting.resolve(undefined)
    await allowInspection.promise
    return respond()
  }

  const status = expect(runner.status(A)).rejects.toMatchObject({ code: 'sandbox_not_ready' })
  await inspecting.promise
  let disposed = false
  const disposal = Promise.resolve(ctx.fiber.dispose()).then(() => { disposed = true })
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(disposed).toBe(false)
  } finally {
    allowInspection.resolve(undefined)
    await Promise.all([status, disposal])
  }
})

test('status rechecks a stale inspection during close and releases an externally removed slot', async (t) => {
  const f = await fixture(t)
  const runner = await f.boot()
  const first = await runner.open(A, f.directory(A))
  const inspection = Promise.withResolvers<undefined>()
  const allowInspection = Promise.withResolvers<undefined>()
  const deletion = Promise.withResolvers<undefined>()
  const allowDeletion = Promise.withResolvers<undefined>()
  t.onTestFinished(() => {
    allowInspection.resolve(undefined)
    allowDeletion.resolve(undefined)
  })
  let held = false
  f.control.intercept = async (call, respond) => {
    if (!held && call.url.pathname.endsWith(`/${first.containerId}/json`)) {
      held = true
      const stale = respond()
      inspection.resolve(undefined)
      await allowInspection.promise
      return stale
    }
    if (call.method === 'DELETE' && call.url.pathname.endsWith(first.containerId)) {
      deletion.resolve(undefined)
      await allowDeletion.promise
    }
    return respond()
  }

  const status = runner.status(A)
  await inspection.promise
  const closing = runner.close(A)
  await deletion.promise
  allowInspection.resolve(undefined)
  await expect(status).resolves.toEqual({ state: 'closing' })
  allowDeletion.resolve(undefined)
  await expect(closing).resolves.toEqual({ state: 'closed' })
  await expect(runner.status(A)).resolves.toEqual({ state: 'closed' })

  const replacement = await runner.open(A, f.directory(A))
  await runner.open(B, f.directory(B))
  expect(f.containers.delete(replacement.containerId)).toBe(true)
  await expect(runner.status(A)).resolves.toEqual({ state: 'closed' })
  await expect(runner.open(C, f.directory(C))).resolves.toMatchObject({ state: 'running' })
})

test('reopening replaces a vanished generation and closing an absent sandbox is idempotent', async (t) => {
  const f = await fixture(t)
  const runner = await f.boot()
  const first = await runner.open(A, f.directory(A))
  expect(f.containers.delete(first.containerId)).toBe(true)
  const replacement = await runner.open(A, f.directory(A))
  expect(replacement.containerId).not.toBe(first.containerId)

  expect(f.containers.delete(replacement.containerId)).toBe(true)
  await expect(runner.close(A)).resolves.toEqual({ state: 'closed' })
  await expect(runner.close(A)).resolves.toEqual({ state: 'closed' })
  expect(f.calls.some(call => call.method === 'DELETE')).toBe(false)
})

test.for([400, 404, 409, 500])('releases capacity only after a definite Docker create rejection (%s)', async (status, t) => {
  const f = await fixture(t)
  const runner = await f.boot()
  f.control.intercept = (call, respond) => creation(call, A) ? { status } : respond()

  const opening = runner.open(A, f.directory(A))
  if (status === 409) {
    await expect(opening).rejects.toMatchObject({ code: 'sandbox_name_conflict' })
  } else {
    await expect(opening).rejects.toMatchObject({ kind: 'engine', details: { status } })
  }
  await runner.open(B, f.directory(B))
  if (status === 500) {
    await expect(runner.open(C, f.directory(C))).rejects.toMatchObject({ code: 'sandbox_capacity' })
  } else {
    await expect(runner.open(C, f.directory(C))).resolves.toMatchObject({ state: 'running' })
  }
})

test.for(['before-start', 'after-start', 'not-running'])('rejects an unconfirmed running container (%s)', async (outcome, t) => {
  const f = await fixture(t)
  const runner = await f.boot()
  const id = '1'.padStart(64, '0')
  f.control.intercept = (call, respond) => {
    if (call.url.pathname.endsWith(`/${id}/json`)) {
      if (outcome === 'before-start' || (outcome === 'after-start' && f.containers.get(id)?.State.Running)) {
        f.containers.delete(id)
      }
    }
    if (outcome === 'not-running' && call.url.pathname.endsWith(`/${id}/start`)) return { status: 204 }
    return respond()
  }
  await expect(runner.open(A, f.directory(A))).rejects.toMatchObject({ code: 'sandbox_outcome_unknown' })
  expect(f.calls.some(call => call.url.pathname.endsWith('/start'))).toBe(outcome !== 'before-start')
  delete f.control.intercept

  if (outcome === 'not-running') {
    await expect(runner.status(A)).resolves.toEqual({ state: 'cleanup_required' })
    await expect(runner.open(A, f.directory(A))).rejects.toMatchObject({ code: 'sandbox_cleanup_required' })
    await expect(runner.close(A)).resolves.toEqual({ state: 'closed' })
  } else {
    await expect(runner.status(A)).resolves.toEqual({ state: 'closed' })
  }
  await expect(runner.open(A, f.directory(A))).resolves.toMatchObject({ state: 'running' })
})
