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
import { SandboxExecutionError, SandboxLifecycleError, type SandboxExecutionFailure } from '../src/errors.ts'
import SandboxRunner, { type SandboxExecutionId } from '../src/index.ts'
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
  const executed = {
    executionId: brandString<SandboxExecutionId>('run-1'), exitCode: 7,
    stdout: { text: 'out', truncated: false }, stderr: { text: 'err', truncated: false },
  }
  const runner = {
    open: vi.fn<SandboxRunner['open']>().mockResolvedValue(running),
    status: vi.fn<SandboxRunner['status']>().mockResolvedValue(running),
    close: vi.fn<SandboxRunner['close']>().mockResolvedValue({ state: 'closed' }),
    execute: vi.fn<SandboxRunner['execute']>().mockResolvedValue(executed),
    cancel: vi.fn<SandboxRunner['cancel']>().mockReturnValue({
      executionId: executed.executionId, containerId: running.containerId, cancellation: 'requested',
    }),
  }
  const report = vi.fn<(error: unknown) => void>()
  return { socketPath, root, parent, directory, runner, running, executed, report, servers }
}

const route = '/v1/workspaces/A/sandbox'
const execRoute = `${route}/exec`
const cancelRoute = `${execRoute}/cancel`
const execRequest = { executionId: 'run-1', expectedContainerId: 'a'.repeat(64), command: 'printf out; printf err >&2; exit 7' }

function send(socketPath: string, method: string, path = route, body?: string | Buffer) {
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

test('Exec passes normalized directory and unchanged command as separate arguments', async (t) => {
  const f = await fixture(t)
  await listenRunnerSocket(f.socketPath, f.runner, f.report)
  await expect(send(f.socketPath, 'GET', execRoute)).resolves.toMatchObject({ status: 405, allow: 'POST' })
  const expected = { executionId: execRequest.executionId, expectedContainerId: f.running.containerId }
  const result = { status: 200, body: f.executed }
  await expect(send(f.socketPath, 'POST', execRoute, JSON.stringify(execRequest))).resolves.toMatchObject(result)
  const request = f.runner.execute.mock.calls[0]?.[1]
  expect(request?.argv.slice(0, 3)).toEqual(['/bin/bash', '-p', '-c'])
  expect(request?.argv.slice(4)).toEqual(['sandbox-exec', '.', execRequest.command])
  expect(request).toMatchObject({ ...expected, timeoutMs: 30_000 })

  const command = '  printf "%s" \'$(pwd)\'; exit 7\n'
  const custom = { ...execRequest, command, workdir: './foo//bar/./', timeoutMs: 60_000 }
  await expect(send(f.socketPath, 'POST', execRoute, JSON.stringify(custom))).resolves.toMatchObject(result)
  expect(f.runner.execute).toHaveBeenLastCalledWith('A', {
    ...expected, timeoutMs: 60_000, argv: [...(request?.argv.slice(0, 5) ?? []), 'foo/bar', command],
  })
})

test('Exec rejects invalid JSON fields and enforces the body limit in bytes before dispatch', async (t) => {
  const f = await fixture(t)
  await listenRunnerSocket(f.socketPath, f.runner, f.report)
  const fields = [
    { executionId: '' }, { executionId: 'x'.repeat(129) }, { executionId: 'a\0b' },
    { expectedContainerId: 'a'.repeat(12) }, { expectedContainerId: 'A'.repeat(64) },
    { command: '' }, { command: ' \t' }, { command: 'a\0b' }, { command: '\ud800' }, { command: null },
    { workdir: '' }, { workdir: '/workspace' }, { workdir: 'dir/../other' }, { workdir: 'a\0b' },
    { timeoutMs: 0 }, { timeoutMs: 1.5 }, { timeoutMs: 60_001 }, { timeoutMs: null },
    { env: { PATH: '/tmp' } },
  ]
  const command = 'x'.repeat(64 * 1024 - Buffer.byteLength(JSON.stringify({ ...execRequest, command: '' })))
  const invalidUtf8 = Buffer.from(JSON.stringify({ ...execRequest, command: 'é' }))
  invalidUtf8[invalidUtf8.indexOf(0xc3)] = 0xff
  const invalid = ['{', '{}', ...fields.map(values => JSON.stringify({ ...execRequest, ...values })), invalidUtf8,
    JSON.stringify({ ...execRequest, command: `${command.slice(1)}汉` })]
  for (const body of invalid) {
    await expect(send(f.socketPath, 'POST', execRoute, body)).resolves.toMatchObject({ status: 400, body: { error: 'invalid_request' } })
  }
  expect(f.runner.execute).not.toHaveBeenCalled()
  await expect(send(f.socketPath, 'POST', execRoute, JSON.stringify({ ...execRequest, command }))).resolves.toMatchObject({ status: 200 })
})

test('Exec distinguishes conflicts, unknown results, and timeouts', async (t) => {
  const f = await fixture(t)
  await listenRunnerSocket(f.socketPath, f.runner, f.report)
  const cases = [
    ['execution_generation_mismatch', 409], ['execution_id_conflict', 409],
    ['execution_limit', 409], ['sandbox_cleanup_required', 503],
    ['execution_outcome_unknown', 503], ['execution_container_recycled', 503], ['execution_timeout', 504],
  ] as const
  for (const [code, status] of cases) {
    f.runner.execute.mockRejectedValueOnce(new SandboxLifecycleError(code))
    await expect(send(f.socketPath, 'POST', execRoute, JSON.stringify(execRequest))).resolves.toMatchObject({ status, body: { error: code } })
  }
})

test('cancel acknowledges pending and settled records without dispatching Exec', async (t) => {
  const f = await fixture(t)
  await listenRunnerSocket(f.socketPath, f.runner, f.report)
  const request = { executionId: f.executed.executionId, expectedContainerId: f.running.containerId }
  const result = { executionId: request.executionId, containerId: request.expectedContainerId }
  for (let repeat = 0; repeat < 2; repeat++) {
    await expect(send(f.socketPath, 'POST', cancelRoute, JSON.stringify(request))).resolves.toMatchObject({
      status: 202, body: { ...result, cancellation: 'requested' },
    })
  }
  f.runner.cancel.mockReturnValueOnce({ ...result, cancellation: 'settled' })
  await expect(send(f.socketPath, 'POST', cancelRoute, JSON.stringify(request))).resolves.toMatchObject({
    status: 200, body: { ...result, cancellation: 'settled' },
  })
  expect(f.runner.cancel.mock.calls).toEqual([['A', request], ['A', request], ['A', request]])
  expect(f.runner.execute).not.toHaveBeenCalled()
  await expect(send(f.socketPath, 'GET', cancelRoute)).resolves.toMatchObject({ status: 405, allow: 'POST' })
  await expect(send(f.socketPath, 'POST', `${cancelRoute}/extra`)).resolves.toMatchObject({ status: 404 })
})

test('cancel validates both identities, strict fields and an 8 KiB byte limit before dispatch', async (t) => {
  const f = await fixture(t)
  await listenRunnerSocket(f.socketPath, f.runner, f.report)
  const request = { executionId: execRequest.executionId, expectedContainerId: f.running.containerId }
  const json = JSON.stringify(request)
  const utf8 = Buffer.from(JSON.stringify({ ...request, executionId: 'é' }))
  utf8[utf8.indexOf(0xc3)] = 0xff
  const fields = [
    { executionId: '' }, { executionId: 'x'.repeat(129) }, { executionId: '\ud800' }, { executionId: 'a\0b' },
    { executionId: null }, { expectedContainerId: 'a'.repeat(12) }, { expectedContainerId: 'A'.repeat(64) },
    { expectedContainerId: null }, { command: 'must not start' }, { timeoutMs: 1 },
  ]
  const invalid = ['{', '{}', JSON.stringify({ executionId: request.executionId }),
    JSON.stringify({ expectedContainerId: request.expectedContainerId }), 'null', utf8,
    `${json}${' '.repeat(8193 - Buffer.byteLength(json))}`,
    ...fields.map(field => JSON.stringify({ ...request, ...field })),
  ]
  for (const body of invalid) {
    await expect(send(f.socketPath, 'POST', cancelRoute, body)).resolves.toMatchObject({
      status: 400, body: { error: 'invalid_request' },
    })
  }
  expect(f.runner.cancel).not.toHaveBeenCalled()
  await expect(send(f.socketPath, 'POST', cancelRoute, `${json}${' '.repeat(8192 - Buffer.byteLength(json))}`))
    .resolves.toMatchObject({ status: 202 })
  expect(f.runner.cancel).toHaveBeenCalledOnce()
})

test('cancel preserves lookup errors without claiming cleanup', async (t) => {
  const f = await fixture(t)
  await listenRunnerSocket(f.socketPath, f.runner, f.report)
  const request = { executionId: execRequest.executionId, expectedContainerId: f.running.containerId }
  for (const [code, status] of [['execution_not_found', 404], ['execution_generation_mismatch', 409], ['sandbox_not_ready', 503]] as const) {
    f.runner.cancel.mockImplementationOnce(() => { throw new SandboxLifecycleError(code) })
    await expect(send(f.socketPath, 'POST', cancelRoute, JSON.stringify(request))).resolves.toMatchObject({
      status, body: { error: code },
    })
  }
  expect(f.runner.execute).not.toHaveBeenCalled()
})

test.for([
  { code: 'execution_timeout', status: 504, cleanup: 'not_started', reason: 'timeout', bash: null },
  { code: 'execution_timeout', status: 504, cleanup: 'processes_cleaned', reason: 'timeout', bash: { exitCode: 0, signal: null } },
  { code: 'execution_cancelled', status: 409, cleanup: 'not_started', reason: 'cancelled', bash: null },
  { code: 'execution_cancelled', status: 409, cleanup: 'processes_cleaned', reason: 'cancelled', bash: { exitCode: null, signal: 15 } },
  { code: 'execution_outcome_unknown', status: 503, cleanup: 'container_removed', reason: null },
  { code: 'execution_outcome_unknown', status: 503, cleanup: 'unconfirmed', reason: 'exited', bash: { exitCode: 7, signal: null } },
  { code: 'execution_container_recycled', status: 503, cleanup: 'container_removed', reason: null },
  { code: 'execution_container_recycled', status: 503, cleanup: 'unconfirmed', reason: null },
] as const)('Exec exposes $code/$cleanup independently of Bash status', async ({ code, status, ...facts }, t) => {
  const f = await fixture(t)
  await listenRunnerSocket(f.socketPath, f.runner, f.report)
  const execution: SandboxExecutionFailure = { executionId: f.executed.executionId, containerId: f.running.containerId, ...facts }
  const error = new SandboxExecutionError(code, execution, new Error('private internal path'))
  f.runner.execute.mockRejectedValue(error)
  for (let retry = 0; retry < 2; retry++) {
    const response = await send(f.socketPath, 'POST', execRoute, JSON.stringify(execRequest))
    expect(response).toMatchObject({ status })
    expect(response.body).toEqual({ error: code, ...execution })
  }
  expect(f.report).not.toHaveBeenCalled()
})

test('a detached Exec caller does not prevent the Runner from settling', async (t) => {
  const f = await fixture(t)
  await listenRunnerSocket(f.socketPath, f.runner, f.report)
  const entered = Promise.withResolvers<undefined>()
  const settle = Promise.withResolvers<typeof f.executed>()
  f.runner.execute.mockImplementationOnce(() => {
    entered.resolve(undefined)
    return settle.promise
  })
  const server = f.servers[0]
  if (!server) throw new Error('Expected a listening server')
  const closed = new Promise<void>((resolve) => {
    server.once('request', (_req, res) => { res.once('close', resolve) })
  })
  const req = request({ socketPath: f.socketPath, method: 'POST', path: execRoute, agent: false })
  req.on('error', () => { /* The client deliberately closes its socket. */ })
  req.end(JSON.stringify(execRequest))
  await entered.promise
  req.destroy()
  await closed
  settle.resolve(f.executed)
  await settle.promise
  expect(f.runner.cancel).not.toHaveBeenCalled()
  expect(f.report).not.toHaveBeenCalled()
})

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
