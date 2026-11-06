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
import SandboxRunnerClient, { Config, RunnerExecutionError, RunnerRequestError, RunnerResponseError } from '../src/transport.ts'
import { RunnerClient } from '../src/runner-client.ts'
import type { RunnerExecutionRequest, RunnerExecutionId } from '../src/execution.ts'
import type { SandboxContainerId } from '../src/runner-client.ts'
import type { SandboxExecutionBackend } from '../src/backend.ts'

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
    await client.dispose()
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

function invoke(client: RunnerClient | SandboxExecutionBackend, operation: 'open' | 'status' | 'close') {
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
  t.onTestFinished(() => tiny.dispose())
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
  expect(Config({ socketPath: f.socketPath })).toMatchObject({
    queryTimeoutMs: 15_000, mutationTimeoutMs: 120_000, maxResponseBytes: 8192,
    execTimeoutMs: 120_000, cancelTimeoutMs: 15_000, maxExecResponseBytes: 1024 * 1024,
  })
  for (const invalid of [
    { queryTimeoutMs: 0 }, { mutationTimeoutMs: 2_147_483_648 }, { maxResponseBytes: 0 }, { queryTimeoutMs: 1.5 },
    { execTimeoutMs: 0 }, { execTimeoutMs: 2_147_483_648 }, { cancelTimeoutMs: 1.5 }, { maxExecResponseBytes: 0 },
  ]) {
    expect(() => Config({ socketPath: f.socketPath, ...invalid })).toThrow()
  }
  expect(() => new RunnerClient(Config({ socketPath: 'relative.sock' }))).toThrow('absolute')
  expect(() => new RunnerClient(Config({ socketPath: '/run/runner\0.sock' }))).toThrow('absolute')
  const config = Config({ socketPath: f.socketPath })
  const client = new RunnerClient(config)
  t.onTestFinished(() => client.dispose())
  config.socketPath = join(f.root, 'missing.sock')
  await expect(client.status(workspace)).resolves.toEqual(running)
})

const savedExecution: RunnerExecutionRequest = {
  executionId: brandString<RunnerExecutionId>('command-中文-1'),
  expectedContainerId: brandString<SandboxContainerId>(running.containerId),
  command: 'printf "中文"; exit 7', workdir: './src', timeoutMs: 30_000,
}
const savedIdentity = { executionId: savedExecution.executionId, expectedContainerId: savedExecution.expectedContainerId }
const commandResult = {
  executionId: savedExecution.executionId, exitCode: 7,
  stdout: { text: '中文\n', truncated: false }, stderr: { text: 'warning\n', truncated: true },
}
const cancellation = { executionId: savedExecution.executionId, containerId: running.containerId, cancellation: 'requested' }

test('the transport service submits an unchanged exec request and cancels using only the original identity', async (t) => {
  const f = await fixture(t)
  f.control.respond = (call, response) => {
    const cancel = call.path?.endsWith('/cancel')
    response.writeHead(cancel ? 202 : 200)
    response.end(JSON.stringify(cancel ? cancellation : commandResult))
  }
  const ctx = new Context()
  const fiber = ctx.plugin(SandboxRunnerClient, { socketPath: f.socketPath })
  t.onTestFinished(async () => { await ctx.fiber.dispose() })
  await fiber
  await expect(ctx.sandboxRunnerClient.execute(workspace, savedExecution)).resolves.toEqual(commandResult)
  await expect(ctx.sandboxRunnerClient.cancel(workspace, savedIdentity)).resolves.toEqual(cancellation)
  expect(f.calls).toEqual([
    { method: 'POST', path: '/v1/workspaces/A_b-9/sandbox/exec', body: JSON.stringify(savedExecution) },
    { method: 'POST', path: '/v1/workspaces/A_b-9/sandbox/exec/cancel', body: JSON.stringify(savedIdentity) },
  ])
})

test('a lost exec response is unknown and explicit result retrieval resends the saved request without generating identities', async (t) => {
  const f = await fixture(t)
  f.control.respond = (_call, response) => { response.destroy() }
  await expect(f.client.execute(workspace, savedExecution)).rejects.toMatchObject({ code: 'runner_outcome_unknown' })
  expect(f.calls).toHaveLength(1)
  f.control.respond = (_call, response) => { response.end(JSON.stringify(commandResult)) }
  await expect(f.client.execute(workspace, savedExecution)).resolves.toEqual(commandResult)
  expect(f.calls).toHaveLength(2)
  expect(f.calls[1]).toEqual(f.calls[0])
})

test('exec limits the complete UTF-8 JSON request including identity, escaping and multibyte command text', async (t) => {
  const f = await fixture(t)
  const input = { ...savedExecution, executionId: brandString<RunnerExecutionId>('😀'.repeat(64)), command: '中文\n\t' }
  input.command += ' '.repeat(64 * 1024 - Buffer.byteLength(JSON.stringify(input)))
  f.control.respond = (_call, response) => { response.end(JSON.stringify({ ...commandResult, executionId: input.executionId })) }
  await expect(f.client.execute(workspace, input)).resolves.toHaveProperty('executionId', input.executionId)
  expect(Buffer.byteLength(f.calls[0]?.body ?? '')).toBe(64 * 1024)
  await expect(f.client.execute(workspace, { ...input, command: `${input.command} ` })).rejects.toThrow('64 KiB')
  expect(f.calls).toHaveLength(1)
})

test.for<Partial<RunnerExecutionRequest>>([
  { executionId: brandString<RunnerExecutionId>('') },
  { executionId: brandString<RunnerExecutionId>('x'.repeat(129)) },
  { executionId: brandString<RunnerExecutionId>('bad\0id') },
  { executionId: brandString<RunnerExecutionId>('\ud800') },
  { expectedContainerId: brandString<SandboxContainerId>('a'.repeat(12)) },
  { expectedContainerId: brandString<SandboxContainerId>('A'.repeat(64)) },
  { command: '' }, { command: ' \n' }, { command: 'bad\0command' }, { command: '\ud800' },
  { workdir: '' }, { workdir: '/workspace' }, { workdir: 'a/../b' }, { workdir: 'a\0b' },
  { timeoutMs: 0 }, { timeoutMs: 60_001 }, { timeoutMs: 1.5 },
])('rejects invalid exec wire fields %j before contacting the Runner', async (overrides, t) => {
  const f = await fixture(t)
  await expect(f.client.execute(workspace, { ...savedExecution, ...overrides })).rejects.toThrow()
  expect(f.calls).toEqual([])
})

test('cancel rejects a command or invalid identity instead of stripping fields or creating an exec', async (t) => {
  const f = await fixture(t)
  await expect(f.client.cancel(workspace, savedExecution)).rejects.toThrow()
  await expect(f.client.cancel(workspace, { ...savedIdentity, executionId: brandString<RunnerExecutionId>('x'.repeat(129)) })).rejects.toThrow()
  await expect(f.client.cancel(workspace, { ...savedIdentity, expectedContainerId: brandString<SandboxContainerId>('old') })).rejects.toThrow()
  expect(f.calls).toEqual([])
})

test('exec accepts both escaped 64 KiB output streams independently of the management response limit', async (t) => {
  const f = await fixture(t, { maxResponseBytes: 1024 })
  const text = `${'\0'.repeat(65_530)}中文`
  expect(Buffer.byteLength(text)).toBe(64 * 1024)
  const large = { ...commandResult, stdout: { text, truncated: true }, stderr: { text, truncated: false } }
  const body = JSON.stringify(large)
  expect(Buffer.byteLength(body)).toBeGreaterThan(768 * 1024)
  expect(Buffer.byteLength(body)).toBeLessThan(1024 * 1024)
  f.control.respond = (_call, response) => { response.end(body) }
  await expect(f.client.execute(workspace, savedExecution)).resolves.toEqual(large)
  await expect(f.client.status(workspace)).rejects.toMatchObject({ code: 'runner_unavailable' })
})

test.for([
  { code: 'execution_timeout', status: 504, reason: 'timeout', cleanup: 'not_started', bash: null },
  { code: 'execution_timeout', status: 504, reason: 'timeout', cleanup: 'processes_cleaned', bash: { exitCode: 0, signal: null } },
  { code: 'execution_cancelled', status: 409, reason: 'cancelled', cleanup: 'processes_cleaned', bash: { exitCode: null, signal: 15 } },
  { code: 'execution_cancelled', status: 409, reason: 'shutdown', cleanup: 'not_started', bash: null },
  { code: 'execution_outcome_unknown', status: 503, reason: null, cleanup: 'container_removed' },
  { code: 'execution_container_recycled', status: 503, reason: 'exited', cleanup: 'unconfirmed', bash: { exitCode: 7, signal: null } },
])('exec preserves $code/$cleanup and independently known Bash status', async ({ code, status, ...observed }, t) => {
  const f = await fixture(t)
  const execution = { executionId: savedIdentity.executionId, containerId: savedIdentity.expectedContainerId, ...observed }
  f.control.respond = (_call, response) => { response.writeHead(status); response.end(JSON.stringify({ error: code, ...execution })) }
  const error: unknown = await f.client.execute(workspace, savedExecution).catch((cause: unknown) => cause)
  expect(error).toBeInstanceOf(RunnerExecutionError)
  expect(error).toMatchObject({ code, statusCode: status, outcomeUnknown: status === 503 })
  if (!(error instanceof RunnerExecutionError)) throw new Error('Expected Runner execution failure')
  expect(error.execution).toEqual(execution)
  expect(Object.hasOwn(error.execution, 'bash')).toBe(Object.hasOwn(observed, 'bash'))
  expect(f.calls).toHaveLength(1)
})

test.for([
  { status: 409, error: 'execution_generation_mismatch' },
  { status: 409, error: 'execution_id_conflict' },
  { status: 409, error: 'execution_limit' },
  { status: 503, error: 'sandbox_cleanup_required' },
])('exec retains preparation rejection $error without reopening, changing id or retrying', async ({ status, error }, t) => {
  const f = await fixture(t)
  f.control.respond = (_call, response) => { response.writeHead(status); response.end(JSON.stringify({ error })) }
  await expect(f.client.execute(workspace, savedExecution)).rejects.toMatchObject({ code: error, statusCode: status })
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0]?.path).toBe('/v1/workspaces/A_b-9/sandbox/exec')
})

test.for(['requested', 'settled'] as const)('cancel returns %s acknowledgement without claiming a final command result', async (state, t) => {
  const f = await fixture(t)
  const result = { ...cancellation, cancellation: state }
  f.control.respond = (_call, response) => { response.writeHead(state === 'requested' ? 202 : 200); response.end(JSON.stringify(result)) }
  await expect(f.client.cancel(workspace, savedIdentity)).resolves.toEqual(result)
  expect(f.calls).toHaveLength(1)
})

test.for([
  { status: 404, error: 'execution_not_found' },
  { status: 409, error: 'execution_generation_mismatch' },
])('cancel preserves $status/$error without sending an exec or claiming cleanup', async ({ status, error }, t) => {
  const f = await fixture(t)
  f.control.respond = (_call, response) => { response.writeHead(status); response.end(JSON.stringify({ error })) }
  await expect(f.client.cancel(workspace, savedIdentity)).rejects.toMatchObject({ code: error, statusCode: status, outcomeUnknown: false })
  expect(f.calls.map(call => call.path)).toEqual(['/v1/workspaces/A_b-9/sandbox/exec/cancel'])
})

test('an aborted exec wait does not send cancel; independent cancellation remains available', async (t) => {
  const f = await fixture(t)
  const control = new AbortController()
  f.control.respond = (call, response) => {
    if (call.path?.endsWith('/cancel')) { response.writeHead(202); response.end(JSON.stringify(cancellation)) }
  }
  const waiting = f.client.execute(workspace, savedExecution, control.signal).catch((cause: unknown) => cause)
  await f.received
  const reason = new Error('caller disconnected')
  control.abort(reason)
  expect(await waiting).toMatchObject({ code: 'runner_outcome_unknown', cause: { cause: reason } })
  await f.disconnected
  expect(f.calls).toHaveLength(1)
  await expect(f.client.cancel(workspace, savedIdentity)).resolves.toEqual(cancellation)
  expect(f.calls).toHaveLength(2)
})

test('an already aborted exec wait never dispatches the command', async (t) => {
  const f = await fixture(t)
  await expect(f.client.execute(workspace, savedExecution, AbortSignal.abort())).rejects.toMatchObject({ code: 'runner_unavailable' })
  expect(f.calls).toEqual([])
})

test('execution routes reject invalid workspace identities before dispatch', async (t) => {
  const f = await fixture(t)
  const invalid = brandString<WorkspaceId>('A/other')
  await expect(f.client.execute(invalid, savedExecution)).rejects.toThrow(TypeError)
  await expect(f.client.cancel(invalid, savedIdentity)).rejects.toThrow(TypeError)
  expect(f.calls).toEqual([])
})

test('parallel exec requests retain their own serialized identities while a caller object changes', async (t) => {
  const f = await fixture(t)
  const input = { ...savedExecution }
  const secondId = brandString<RunnerExecutionId>('second-command')
  let firstResponse: ServerResponse | undefined
  f.control.respond = (call, response) => {
    if (call.body === JSON.stringify(savedExecution)) firstResponse = response
    else response.end(JSON.stringify({ ...commandResult, executionId: secondId, exitCode: 19 }))
  }
  const first = f.client.execute(workspace, input)
  input.executionId = secondId
  await f.received
  await expect(f.client.execute(workspace, input)).resolves.toMatchObject({ executionId: secondId, exitCode: 19 })
  if (firstResponse === undefined) throw new Error('Expected the first request to remain pending')
  firstResponse.end(JSON.stringify(commandResult))
  await expect(first).resolves.toEqual(commandResult)
  expect(f.calls.map(call => call.body)).toEqual([JSON.stringify(savedExecution), JSON.stringify(input)])
})

test.for([
  { value: { ...commandResult, executionId: 'another-command' }, status: 200 },
  { value: { ...commandResult, exitCode: null }, status: 200 },
  { value: { ...commandResult, stdout: { text: 'lost flag' } }, status: 200 },
  { value: { ...commandResult, stderr: null }, status: 200 },
  { value: { ...commandResult, signal: 15 }, status: 200 },
  { value: commandResult, status: 202 },
  { value: { error: 'execution_cancelled' }, status: 409 },
  { value: { error: 'execution_timeout', ...savedIdentity, reason: 'timeout', cleanup: 'not_started', bash: null }, status: 504 },
  { value: { error: 'execution_outcome_unknown', executionId: savedIdentity.executionId, containerId: 'b'.repeat(64), reason: null, cleanup: 'unconfirmed' }, status: 503 },
  { value: { error: 'execution_cancelled', executionId: 'another-command', containerId: running.containerId, reason: 'cancelled', cleanup: 'processes_cleaned' }, status: 409 },
  { value: { error: 'execution_timeout', executionId: savedIdentity.executionId, containerId: running.containerId, reason: 'timeout', cleanup: 'unconfirmed' }, status: 504 },
  { value: { error: 'execution_cancelled', executionId: savedIdentity.executionId, containerId: running.containerId, reason: 'cancelled', cleanup: 'processes_cleaned', bash: { exitCode: null, signal: null } }, status: 409 },
])('exec rejects mismatched or invalid response $status/$value without accepting cleanup evidence', async ({ value, status }, t) => {
  const f = await fixture(t)
  f.control.respond = (_call, response) => { response.writeHead(status); response.end(JSON.stringify(value)) }
  await expect(f.client.execute(workspace, savedExecution)).rejects.toBeInstanceOf(RunnerRequestError)
  expect(f.calls).toHaveLength(1)
})

test.for([
  { value: { ...cancellation, executionId: 'another-command' }, status: 202 },
  { value: { ...cancellation, containerId: 'b'.repeat(64) }, status: 202 },
  { value: { ...cancellation, containerId: 'short' }, status: 202 },
  { value: { ...cancellation, cleanup: 'processes_cleaned' }, status: 202 },
  { value: { ...cancellation, cancellation: 'cleaned' }, status: 200 },
  { value: cancellation, status: 200 },
  { value: { ...cancellation, cancellation: 'settled' }, status: 202 },
])('cancel rejects mismatched identity or invalid acknowledgement $status/$value', async ({ value, status }, t) => {
  const f = await fixture(t)
  f.control.respond = (_call, response) => { response.writeHead(status); response.end(JSON.stringify(value)) }
  await expect(f.client.cancel(workspace, savedIdentity)).rejects.toMatchObject({ code: 'runner_outcome_unknown' })
  expect(f.calls).toHaveLength(1)
})

test.for(['execute', 'cancel'] as const)('%s rejects malformed JSON, invalid UTF-8 and incomplete bodies as unknown', async (operation, t) => {
  const f = await fixture(t)
  const send = () => operation === 'execute' ? f.client.execute(workspace, savedExecution) : f.client.cancel(workspace, savedIdentity)
  for (const body of [Buffer.from('{'), Buffer.from([0x22, 0xff, 0x22])]) {
    f.control.respond = (_call, response) => { response.end(body) }
    await expect(send()).rejects.toMatchObject({ code: 'runner_outcome_unknown' })
  }
  f.control.respond = (_call, response) => {
    const body = JSON.stringify(operation === 'execute' ? commandResult : cancellation)
    response.writeHead(operation === 'execute' ? 200 : 202, { 'Content-Length': Buffer.byteLength(body) + 10 })
    response.end(body)
    response.once('finish', () => { response.socket?.destroy() })
  }
  await expect(send()).rejects.toMatchObject({ code: 'runner_outcome_unknown' })
  expect(f.calls).toHaveLength(3)
})

test('exec enforces its own complete response byte limit for both results and failures', async (t) => {
  const body = JSON.stringify(commandResult)
  const f = await fixture(t, { maxExecResponseBytes: Buffer.byteLength(body) })
  f.control.respond = (_call, response) => { response.end(body) }
  await expect(f.client.execute(workspace, savedExecution)).resolves.toEqual(commandResult)
  for (const status of [200, 503]) {
    f.control.respond = (_call, response) => { response.writeHead(status); response.end(`${body} `) }
    await expect(f.client.execute(workspace, savedExecution)).rejects.toMatchObject({ code: 'runner_outcome_unknown' })
  }
  expect(f.calls).toHaveLength(3)
})

test.for([
  { operation: 'execute' as const, headers: false, deadline: 137 },
  { operation: 'execute' as const, headers: true, deadline: 137 },
  { operation: 'cancel' as const, headers: true, deadline: 53 },
])('$operation uses its independent total deadline across headers and body', async ({ operation, headers, deadline }, t) => {
  const f = await fixture(t, { execTimeoutMs: 137, cancelTimeoutMs: 53, mutationTimeoutMs: 1 })
  f.control.respond = (_call, response) => { if (headers) { response.writeHead(200); response.flushHeaders(); response.write('{') } }
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const settled = vi.fn()
  const waiting = (operation === 'execute'
    ? f.client.execute(workspace, { ...savedExecution, timeoutMs: 1 })
    : f.client.cancel(workspace, savedIdentity)).catch((cause: unknown) => { settled(); return cause })
  await f.received
  await vi.advanceTimersByTimeAsync(deadline - 1)
  expect(settled).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(await waiting).toMatchObject({ code: 'runner_outcome_unknown' })
  await f.disconnected
  expect(vi.getTimerCount()).toBe(0)
  expect(f.calls).toHaveLength(1)
})

test.for(['execute', 'cancel'] as const)('disposing the transport stops %s waits and future requests without remote cleanup claims', async (operation, t) => {
  const f = await fixture(t)
  const ctx = new Context()
  t.onTestFinished(async () => { await ctx.fiber.dispose() })
  const fiber = ctx.plugin(SandboxRunnerClient, { socketPath: f.socketPath })
  await fiber
  const client = ctx.sandboxRunnerClient
  f.control.respond = () => {}
  const waiting = (operation === 'execute' ? client.execute(workspace, savedExecution) : client.cancel(workspace, savedIdentity))
    .catch((cause: unknown) => cause)
  await f.received
  await fiber.dispose()
  expect(await waiting).toMatchObject({ code: 'runner_outcome_unknown' })
  await f.disconnected
  await expect(client.execute(workspace, savedExecution)).rejects.toMatchObject({ code: 'runner_unavailable' })
  await expect(client.cancel(workspace, savedIdentity)).rejects.toMatchObject({ code: 'runner_unavailable' })
  expect(f.calls).toHaveLength(1)
})
