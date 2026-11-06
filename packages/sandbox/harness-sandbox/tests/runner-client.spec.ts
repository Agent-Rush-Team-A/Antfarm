import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { expect, test, vi, type TestContext } from 'vitest'
import SandboxRunnerClient, { Config, RunnerRequestError, RunnerResponseError } from '../src/transport.ts'
import { RunnerClient } from '../src/runner-client.ts'

const workspace = brandString<WorkspaceId>('A_b-9')
const running = { state: 'running', containerId: 'a'.repeat(64) }
interface Call { method: string | undefined; path: string | undefined; body: string }

async function fixture(t: TestContext, overrides: Partial<Config> = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'dsh-client-'))
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\dsh-client-${randomUUID()}` : join(root, 'runner.sock')
  const calls: Call[] = []
  const received = Promise.withResolvers<Call>()
  const disconnected = Promise.withResolvers<undefined>()
  const control = { respond: (_call: Call, response: ServerResponse) => { response.end(JSON.stringify(running)) } }
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      const call = { method: request.method, path: request.url, body }
      calls.push(call)
      received.resolve(call)
      control.respond(call, response)
    })
  })
  server.on('connection', (socket) => { socket.once('close', () => { disconnected.resolve(undefined) }) })
  const client = new RunnerClient(Config({ socketPath, ...overrides }))
  t.onTestFinished(async () => {
    vi.useRealTimers()
    client.dispose()
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve() })
        server.closeAllConnections()
      })
    }
    await rm(root, { recursive: true, force: true })
  })
  await once(server.listen(socketPath), 'listening')
  return { root, socketPath, server, client, control, calls, received: received.promise, disconnected: disconnected.promise }
}

function invoke(client: RunnerClient | SandboxRunnerClient, operation: 'open' | 'status' | 'close') {
  return operation === 'open' ? client.open(workspace, '/srv/workspaces/A_b-9')
    : operation === 'close' ? client.close(workspace) : client.status(workspace)
}

test('sends exactly PUT, GET and DELETE to the configured local Runner with only PUT carrying a directory', async (t) => {
  const f = await fixture(t)
  f.control.respond = (call, response) => { response.end(JSON.stringify(call.method === 'DELETE' ? { state: 'closed' } : running)) }
  await expect(f.client.open(workspace, '/srv/workspaces/中文')).resolves.toEqual(running)
  await expect(f.client.status(workspace)).resolves.toEqual(running)
  await expect(f.client.close(workspace)).resolves.toEqual({ state: 'closed' })
  expect(f.calls).toEqual([
    { method: 'PUT', path: '/v1/workspaces/A_b-9/sandbox', body: JSON.stringify({ workspaceDir: '/srv/workspaces/中文' }) },
    { method: 'GET', path: '/v1/workspaces/A_b-9/sandbox', body: '' },
    { method: 'DELETE', path: '/v1/workspaces/A_b-9/sandbox', body: '' },
  ])
})

test.for(['closed', 'starting', 'running', 'closing', 'cleanup_required'])('GET validates state %s without mutation', async (state, t) => {
  const f = await fixture(t)
  const result = state === 'running' ? running : { state }
  f.control.respond = (_call, response) => { response.end(JSON.stringify(result)) }
  await expect(f.client.status(workspace)).resolves.toEqual(result)
  expect(f.calls.map(call => call.method)).toEqual(['GET'])
})

test.for(['', 'a/b', '..', 'A?x=1', 'A#frag', '%41', '中文', 'x'.repeat(129), 'A\0'])('rejects workspace ID %j before dispatch', async (id, t) => {
  const f = await fixture(t)
  for (const operation of ['open', 'status', 'close'] as const) {
    const invalid = brandString<WorkspaceId>(id)
    const result = operation === 'open' ? f.client.open(invalid, '/srv/workspaces/A')
      : operation === 'close' ? f.client.close(invalid) : f.client.status(invalid)
    await expect(result).rejects.toThrow(TypeError)
  }
  expect(f.calls).toEqual([])
})

test('accepts the maximum Runner ID without escaping or changing the route', async (t) => {
  const f = await fixture(t)
  await f.client.status(brandString<WorkspaceId>('a'.repeat(128)))
  expect(f.calls[0]?.path).toBe(`/v1/workspaces/${'a'.repeat(128)}/sandbox`)
})

test.for([
  { status: 409, error: 'sandbox_capacity' }, { status: 409, error: 'sandbox_closing' },
  { status: 409, error: 'sandbox_workspace_conflict' }, { status: 409, error: 'sandbox_name_conflict' },
  { status: 503, error: 'sandbox_cleanup_required' }, { status: 503, error: 'sandbox_not_ready' },
  { status: 503, error: 'sandbox_outcome_unknown' }, { status: 503, error: 'docker_unavailable' },
  { status: 400, error: 'invalid_workspace_directory' }, { status: 500, error: 'internal_error' },
])('retains Runner failure $status/$error without retrying a modification', async (failure, t) => {
  const f = await fixture(t)
  f.control.respond = (_call, response) => { response.writeHead(failure.status); response.end(JSON.stringify({ error: failure.error })) }
  for (const operation of ['open', 'close'] as const) {
    const error: unknown = await invoke(f.client, operation).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(RunnerResponseError)
    expect(error).toMatchObject({ code: failure.error, statusCode: failure.status, outcomeUnknown: failure.status >= 500 })
  }
  expect(f.calls.map(call => call.method)).toEqual(['PUT', 'DELETE'])
})

test.for([
  { operation: 'open' as const, value: { state: 'closed' } },
  { operation: 'open' as const, value: { state: 'running' } },
  { operation: 'open' as const, value: { state: 'running', containerId: 'a'.repeat(12) } },
  { operation: 'open' as const, value: { state: 'running', containerId: 'A'.repeat(64) } },
  { operation: 'close' as const, value: running },
  { operation: 'status' as const, value: { state: 'stopped' } },
  { operation: 'status' as const, value: { state: 'running' } },
  { operation: 'status' as const, value: { state: 'closed', containerId: running.containerId } },
  { operation: 'status' as const, value: null },
])('rejects invalid $operation success fields as unconfirmed', async ({ operation, value }, t) => {
  const f = await fixture(t)
  f.control.respond = (_call, response) => { response.end(JSON.stringify(value)) }
  await expect(invoke(f.client, operation)).rejects.toMatchObject({ code: operation === 'status' ? 'runner_unavailable' : 'runner_outcome_unknown' })
  expect(f.calls).toHaveLength(1)
})

test.for(['open', 'close', 'status'] as const)('%s rejects malformed JSON, invalid UTF-8 and unexpected HTTP status without retry', async (operation, t) => {
  const f = await fixture(t)
  const payloads = [Buffer.from('{'), Buffer.from([0x22, 0xff, 0x22]), Buffer.from('{}')]
  for (const [index, payload] of payloads.entries()) {
    f.control.respond = (_call, response) => { response.writeHead(index === 2 ? 502 : 200); response.end(payload) }
    await expect(invoke(f.client, operation)).rejects.toBeInstanceOf(RunnerRequestError)
  }
  f.control.respond = (_call, response) => { response.writeHead(201); response.end(JSON.stringify(running)) }
  await expect(invoke(f.client, operation)).rejects.toMatchObject({ code: operation === 'status' ? 'runner_unavailable' : 'runner_outcome_unknown' })
  expect(f.calls).toHaveLength(4)
})

test.for(['open', 'close', 'status'] as const)('%s rejects a truncated response even if its received bytes form valid JSON', async (operation, t) => {
  const f = await fixture(t)
  f.control.respond = (_call, response) => {
    const body = JSON.stringify(operation === 'close' ? { state: 'closed' } : running)
    response.writeHead(200, { 'Content-Length': Buffer.byteLength(body) + 10 })
    response.end(body)
    response.once('finish', () => { response.socket?.destroy() })
  }
  await expect(invoke(f.client, operation)).rejects.toMatchObject({ code: operation === 'status' ? 'runner_unavailable' : 'runner_outcome_unknown' })
  expect(f.calls).toHaveLength(1)
})

test('limits the complete body in bytes for success and error responses, including a single oversized chunk', async (t) => {
  const body = JSON.stringify(running)
  const f = await fixture(t, { maxResponseBytes: Buffer.byteLength(body) })
  await expect(f.client.open(workspace, '/srv/workspaces/A')).resolves.toEqual(running)
  for (const status of [200, 503]) {
    f.control.respond = (_call, response) => { response.writeHead(status); response.end(`${body} `) }
    await expect(f.client.open(workspace, '/srv/workspaces/A')).rejects.toMatchObject({ code: 'runner_outcome_unknown' })
  }
  const tiny = new RunnerClient(Config({ socketPath: f.socketPath, maxResponseBytes: 1 }))
  t.onTestFinished(() => { tiny.dispose() })
  f.control.respond = (_call, response) => { response.end('"中"') }
  await expect(tiny.status(workspace)).rejects.toMatchObject({ code: 'runner_unavailable' })
  expect(f.calls).toHaveLength(4)
})

test.for([
  { operation: 'open' as const, headers: false, deadline: 120_000 },
  { operation: 'close' as const, headers: true, deadline: 120_000 },
  { operation: 'status' as const, headers: true, deadline: 15_000 },
])('$operation deadline spans waiting for headers and the unfinished body, closes the socket and clears its timer', async ({ operation, headers, deadline }, t) => {
  const f = await fixture(t)
  f.control.respond = (_call, response) => { if (headers) { response.writeHead(200); response.flushHeaders(); response.write('{') } }
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const settled = vi.fn()
  const result = invoke(f.client, operation).catch((cause: unknown) => { settled(); return cause })
  await f.received
  await vi.advanceTimersByTimeAsync(deadline - 1)
  expect(settled).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(await result).toMatchObject({ code: operation === 'status' ? 'runner_unavailable' : 'runner_outcome_unknown' })
  await f.disconnected
  expect(vi.getTimerCount()).toBe(0)
  expect(f.calls).toHaveLength(1)
})

test('a lost mutation response permits a later status query without replay or compensation', async (t) => {
  const f = await fixture(t)
  f.control.respond = (call, response) => { if (call.method === 'PUT') response.destroy(); else response.end(JSON.stringify(running)) }
  await expect(invoke(f.client, 'open')).rejects.toMatchObject({ code: 'runner_outcome_unknown' })
  await expect(f.client.status(workspace)).resolves.toEqual(running)
  expect(f.calls.map(call => call.method)).toEqual(['PUT', 'GET'])
})

test('connection failure before dispatch is unavailable for queries and modifications', async (t) => {
  const f = await fixture(t)
  await new Promise<void>((resolve) => { f.server.close(() => { resolve() }) })
  for (const operation of ['status', 'open', 'close'] as const) {
    await expect(invoke(f.client, operation)).rejects.toMatchObject({ code: 'runner_unavailable' })
  }
  expect(f.calls).toEqual([])
})

test('the configured total deadline also cancels an unfinished socket connection', async (t) => {
  const f = await fixture(t, { queryTimeoutMs: 73 })
  const attempted = Promise.withResolvers<undefined>()
  const closed = Promise.withResolvers<undefined>()
  const connect = vi.spyOn(Socket.prototype, 'connect').mockImplementation(function (this: Socket) {
    Object.defineProperty(this, 'connecting', { value: true, configurable: true, writable: true })
    this.once('close', () => { closed.resolve(undefined) })
    attempted.resolve(undefined)
    return this
  })
  t.onTestFinished(() => { connect.mockRestore() })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const result = f.client.status(workspace).catch((cause: unknown) => cause)
  await attempted.promise
  await vi.advanceTimersByTimeAsync(73)
  expect(await result).toMatchObject({ code: 'runner_unavailable' })
  await closed.promise
  expect(vi.getTimerCount()).toBe(0)
  expect(f.calls).toEqual([])
})

test('unloading the service cancels pending transport and future calls without closing the sandbox', async (t) => {
  const f = await fixture(t)
  f.control.respond = () => {}
  const ctx = new Context()
  const fiber = ctx.plugin(SandboxRunnerClient, { socketPath: f.socketPath })
  t.onTestFinished(async () => { await fiber.dispose() })
  await fiber
  const client = ctx.sandboxRunnerClient
  const result = invoke(client, 'open').catch((cause: unknown) => cause)
  await f.received
  await fiber.dispose()
  expect(await result).toMatchObject({ code: 'runner_outcome_unknown' })
  await f.disconnected
  await expect(client.close(workspace)).rejects.toMatchObject({ code: 'runner_unavailable' })
  expect(f.calls.map(call => call.method)).toEqual(['PUT'])
})

test('validates trusted configuration and captures its values before callers can mutate them', async (t) => {
  const f = await fixture(t)
  expect(Config({ socketPath: f.socketPath })).toMatchObject({ queryTimeoutMs: 15_000, mutationTimeoutMs: 120_000, maxResponseBytes: 8192 })
  for (const invalid of [{ queryTimeoutMs: 0 }, { mutationTimeoutMs: 2_147_483_648 }, { maxResponseBytes: 0 }, { queryTimeoutMs: 1.5 }]) {
    expect(() => Config({ socketPath: f.socketPath, ...invalid })).toThrow()
  }
  expect(() => new RunnerClient(Config({ socketPath: 'relative.sock' }))).toThrow('absolute')
  expect(() => new RunnerClient(Config({ socketPath: '/run/runner\0.sock' }))).toThrow('absolute')
  const config = Config({ socketPath: f.socketPath })
  const client = new RunnerClient(config)
  t.onTestFinished(() => { client.dispose() })
  config.socketPath = join(f.root, 'missing.sock')
  await expect(client.status(workspace)).resolves.toEqual(running)
})
