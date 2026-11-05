import { randomUUID } from 'node:crypto'
import { chmod, lstat, realpath, stat } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { afterEach, expect, test, vi, type TestContext } from 'vitest'
import { InvalidWorkspaceDirectoryError } from '../src/config.ts'
import { DockerEngine, DockerRequestError, type DockerContainerId } from '../src/docker.ts'
import { SandboxLifecycleError } from '../src/errors.ts'
import SandboxRunner from '../src/index.ts'
import { listenRunnerSocket } from '../src/server.ts'

const identity = vi.hoisted(() => ({ platform: 'linux', uid: 10001 }))
vi.mock('node:process', async (load) => {
  const original = await load<typeof import('node:process') & { default: NodeJS.Process }>()
  return {
    ...original,
    default: Object.create(original.default, {
      platform: { get: () => identity.platform },
      getuid: { get: () => identity.uid < 0 ? undefined : () => identity.uid },
    }) as NodeJS.Process,
  }
})
vi.mock('node:fs/promises', { spy: true })
vi.mock('node:http', { spy: true })

afterEach(() => {
  vi.resetAllMocks()
  vi.restoreAllMocks()
  identity.platform = 'linux'
  identity.uid = 10001
})

function stopServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve() })
    server.closeAllConnections()
  })
}

async function fixture(t: TestContext) {
  const originalFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const root = await originalFs.mkdtemp(join(await originalFs.realpath(tmpdir()), 'dsh-api-'))
  t.onTestFinished(() => originalFs.rm(root, { recursive: true, force: true }))
  const parent = join(root, 'api')
  await originalFs.mkdir(parent)
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\dsh-api-${randomUUID()}` : join(parent, 'runner.sock')
  const posixPath = dirname(socketPath)
  const directory = Object.assign(await originalFs.stat(parent), { uid: identity.uid, mode: 0o40750 })
  // Windows supplies the same HTTP stream over a named pipe. Model the POSIX
  // metadata at the filesystem boundary and exercise the real listener.
  vi.mocked(stat).mockResolvedValue(directory)
  vi.mocked(realpath).mockResolvedValue(posixPath)
  vi.mocked(chmod).mockImplementation(async (path, mode) => {
    if (process.platform !== 'win32') await originalFs.chmod(path, mode)
  })
  const originalHttp = await vi.importActual<typeof import('node:http')>('node:http')
  const servers: ReturnType<typeof createServer>[] = []
  vi.mocked(createServer).mockImplementation((options, handler) => {
    const server = originalHttp.createServer(options, handler)
    servers.push(server)
    t.onTestFinished(async () => { if (server.listening) await stopServer(server) })
    return server
  })
  const running = { state: 'running' as const, containerId: brandString<DockerContainerId>('a'.repeat(64)) }
  const runner = {
    open: vi.fn<SandboxRunner['open']>().mockResolvedValue(running),
    status: vi.fn<SandboxRunner['status']>().mockResolvedValue(running),
    close: vi.fn<SandboxRunner['close']>().mockResolvedValue({ state: 'closed' }),
  }
  const report = vi.fn<(error: unknown) => void>()
  return { socketPath, root, parent, directory, runner, running, report, servers }
}

const route = '/v1/workspaces/A/sandbox'

function send(socketPath: string, method: string, path = route, body?: string) {
  return new Promise<{ status: number | undefined; body: unknown; allow: string | undefined }>((resolve, reject) => {
    const req = request({ socketPath, method, path, agent: false, signal: AbortSignal.timeout(2_000) }, (res) => {
      res.setEncoding('utf8')
      let raw = ''
      res.on('data', (chunk: string) => { raw += chunk })
      res.on('error', reject)
      res.on('end', () => {
        const body: unknown = JSON.parse(raw)
        resolve({ status: res.statusCode, body, allow: res.headers.allow })
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

test('the socket routes the three operations and rejects invalid requests before dispatch', async (t) => {
  const f = await fixture(t)
  const stop = await listenRunnerSocket(f.socketPath, f.runner, f.report)
  expect(chmod).toHaveBeenCalledWith(f.socketPath, 0o660)
  await expect(send(f.socketPath, 'GET', '/missing')).resolves.toMatchObject({ status: 404, body: { error: 'not_found' } })
  await expect(send(f.socketPath, 'GET', '/v1/workspaces/A%2FB/sandbox')).resolves.toMatchObject({ status: 400 })
  await expect(send(f.socketPath, 'POST')).resolves.toMatchObject({ status: 405, allow: 'PUT, GET, DELETE' })
  for (const invalid of ['{', '{"workspaceDir":"","unexpected":true}', ' '.repeat(8193)]) {
    await expect(send(f.socketPath, 'PUT', route, invalid)).resolves.toMatchObject({
      status: 400, body: { error: 'invalid_request' },
    })
  }
  expect(f.runner.open).not.toHaveBeenCalled()
  expect(f.runner.status).not.toHaveBeenCalled()
  await expect(send(f.socketPath, 'PUT', route, JSON.stringify({ workspaceDir: f.root }))).resolves.toMatchObject({
    status: 200, body: f.running,
  })
  expect(f.runner.open).toHaveBeenCalledWith('A', f.root)
  await expect(send(f.socketPath, 'GET')).resolves.toMatchObject({ status: 200, body: f.running })
  expect(f.runner.status).toHaveBeenCalledWith('A')
  await expect(send(f.socketPath, 'DELETE')).resolves.toMatchObject({ status: 200, body: { state: 'closed' } })
  expect(f.runner.close).toHaveBeenCalledWith('A')
  await stop()
  await expect(send(f.socketPath, 'GET')).rejects.toThrow()
  await expect(stop()).rejects.toMatchObject({ code: 'ERR_SERVER_NOT_RUNNING' })
})

test('the socket preserves Runner error codes without leaking internal errors', async (t) => {
  const f = await fixture(t)
  await listenRunnerSocket(f.socketPath, f.runner, f.report)
  const unexpected = new Error('internal socket path')
  const cases: Array<[Error, number, string]> = [
    [new InvalidWorkspaceDirectoryError(), 400, 'invalid_workspace_directory'],
    [new SandboxLifecycleError('sandbox_capacity'), 409, 'sandbox_capacity'],
    [new SandboxLifecycleError('sandbox_not_ready'), 503, 'sandbox_not_ready'],
    [new SandboxLifecycleError('sandbox_outcome_unknown'), 503, 'sandbox_outcome_unknown'],
    [new DockerRequestError('inspect', 'transport', {}), 503, 'docker_unavailable'],
    [unexpected, 500, 'internal_error'],
  ]
  for (const [error, status, code] of cases) {
    f.runner.open.mockRejectedValueOnce(error)
    await expect(send(f.socketPath, 'PUT', route, JSON.stringify({ workspaceDir: f.root }))).resolves.toMatchObject({
      status, body: { error: code },
    })
  }
  expect(f.report.mock.calls).toEqual([[unexpected]])
})

test('a disconnected client does not turn a later operation failure into a server error', async (t) => {
  const f = await fixture(t)
  await listenRunnerSocket(f.socketPath, f.runner, f.report)
  const entered = Promise.withResolvers<undefined>()
  const settle = Promise.withResolvers<Awaited<ReturnType<SandboxRunner['status']>>>()
  f.runner.status.mockImplementationOnce(() => {
    entered.resolve(undefined)
    return settle.promise
  })
  const req = request({ socketPath: f.socketPath, path: route, agent: false })
  req.on('error', () => { /* The client deliberately closes its socket. */ })
  const server = f.servers[0]
  if (!server) throw new Error('Expected a listening server')
  const closed = new Promise<void>((resolve) => {
    server.once('request', (_req, res) => { res.once('close', resolve) })
  })
  req.end()
  await entered.promise
  req.destroy()
  await closed
  settle.reject(new Error('operation after disconnect'))
  await settle.promise.catch(() => undefined)
  expect(f.report).not.toHaveBeenCalled()
  await expect(send(f.socketPath, 'GET')).resolves.toMatchObject({ status: 200 })
})

test('validates the socket path, directory ownership and directory permissions before binding', async (t) => {
  const f = await fixture(t)
  identity.platform = 'win32'
  await expect(listenRunnerSocket(f.socketPath, f.runner, f.report)).rejects.toThrow('absolute Linux')
  identity.platform = 'linux'
  for (const path of ['relative.sock', join(f.root, 'a'.repeat(108))]) {
    await expect(listenRunnerSocket(path, f.runner, f.report)).rejects.toThrow('absolute Linux')
  }
  const notDirectory = vi.spyOn(f.directory, 'isDirectory').mockReturnValueOnce(false)
  await expect(listenRunnerSocket(f.socketPath, f.runner, f.report)).rejects.toThrow('socket directory')
  notDirectory.mockRestore()
  vi.mocked(realpath).mockResolvedValueOnce(join(f.parent, 'different'))
  await expect(listenRunnerSocket(f.socketPath, f.runner, f.report)).rejects.toThrow('socket directory')
  identity.uid = 10002
  await expect(listenRunnerSocket(f.socketPath, f.runner, f.report)).rejects.toThrow('socket directory')
  identity.uid = -1
  await expect(listenRunnerSocket(f.socketPath, f.runner, f.report)).rejects.toThrow('socket directory')
  identity.uid = 10001
  f.directory.mode = 0o40770
  await expect(listenRunnerSocket(f.socketPath, f.runner, f.report)).rejects.toThrow('socket directory')
  expect(f.servers).toHaveLength(0)
})

test('an occupied socket survives a failed bind and chmod failure releases a newly bound socket', async (t) => {
  const f = await fixture(t)
  const stop = await listenRunnerSocket(f.socketPath, f.runner, f.report)
  await expect(listenRunnerSocket(f.socketPath, f.runner, f.report)).rejects.toMatchObject({ code: 'EADDRINUSE' })
  await expect(send(f.socketPath, 'GET')).resolves.toMatchObject({ status: 200 })
  await stop()
  vi.mocked(chmod).mockRejectedValueOnce(new Error('permission change failed'))
  await expect(listenRunnerSocket(f.socketPath, f.runner, f.report)).rejects.toThrow('permission change failed')
  await expect(send(f.socketPath, 'GET')).rejects.toThrow()
})

test('unloading during socket acquisition releases the listener before disposal settles', async (t) => {
  const f = await fixture(t)
  const entered = Promise.withResolvers<undefined>()
  const allow = Promise.withResolvers<undefined>()
  t.onTestFinished(() => { allow.resolve(undefined) })
  vi.mocked(chmod).mockImplementationOnce(async () => {
    entered.resolve(undefined)
    await allow.promise
  })
  const list = vi.spyOn(DockerEngine.prototype, 'list').mockResolvedValue([])
  const ctx = new Context()
  const fiber = ctx.plugin(SandboxRunner, {
    runnerSocket: f.socketPath, dockerSocket: join(f.root, 'docker.sock'),
    workspaceRoot: f.root, deploymentId: 'review-test', image: `debian@sha256:${'a'.repeat(64)}`, uid: 10001, gid: 10001,
  })
  await entered.promise
  if (process.platform !== 'win32') expect((await lstat(f.socketPath)).isSocket()).toBe(true)
  await expect(send(f.socketPath, 'GET')).resolves.toMatchObject({ status: 503, body: { error: 'sandbox_not_ready' } })
  const disposal = fiber.dispose()
  allow.resolve(undefined)
  await disposal
  await expect(send(f.socketPath, 'GET')).rejects.toMatchObject({ code: 'ENOENT' })
  if (process.platform !== 'win32') await expect(lstat(f.socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(list).not.toHaveBeenCalled()
})

test('Runner owns listener errors and releases the socket on startup failure', async (t) => {
  const f = await fixture(t)
  const failed = new DockerRequestError('list', 'engine', { status: 503 })
  const started = Promise.withResolvers<undefined>()
  const engine = Promise.withResolvers<DockerContainerId[]>()
  const ctx = new Context()
  const logged = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  vi.spyOn(DockerEngine.prototype, 'list').mockImplementationOnce(() => {
    started.resolve(undefined)
    return engine.promise
  })
  const loading = expect(ctx.plugin(SandboxRunner, {
    runnerSocket: f.socketPath, dockerSocket: join(f.root, 'docker.sock'),
    workspaceRoot: f.root, deploymentId: 'review-test', image: `debian@sha256:${'a'.repeat(64)}`, uid: 10001, gid: 10001,
  })).rejects.toBe(failed)
  await started.promise
  const server = f.servers[0]
  if (!server) throw new Error('Expected a listening server')
  const error = new Error('listener failure')
  server.emit('error', error)
  expect(logged).toHaveBeenCalledWith(error)
  engine.reject(failed)
  await loading
  await expect(send(f.socketPath, 'GET')).rejects.toThrow()
})
