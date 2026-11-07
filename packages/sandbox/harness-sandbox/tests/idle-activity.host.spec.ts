/** Continuous idle history through native admission, execution settlement and Runner observations. */
import type { ServerResponse } from 'node:http'
import { expect, test, vi } from 'vitest'
import WorkspaceSandbox from '../src/index.ts'
import type { RunnerExecutionRequest } from '../src/execution.ts'
import { fixture, running } from './fixtures/management.ts'
import { bashFixture } from './fixtures/bash.ts'
import { conversationFixture } from './fixtures/conversation.ts'

function clock(initial = 100) {
  let now = initial
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  return (value: number) => { now = value }
}

function activity(f: Awaited<ReturnType<typeof fixture>>) {
  return f.ctx.workspaceSandbox.activityForUser(f.alice.user.userId, f.alice.id)
}

test('manual opening records its running container and starts idle only after settlement', async () => {
  const f = await fixture()
  const advance = clock()
  expect(activity(f)).toMatchObject({ revision: 0, idleSince: null, sandbox: { state: 'unconfirmed' } })
  const opened = f.ctx.workspaceSandbox.openForUser(f.alice.user.userId, f.alice.id)
  expect(activity(f)).toMatchObject({ busy: true, openings: 1, idleSince: null })
  expect(activity(f).revision).toBeGreaterThan(0)
  advance(250)
  await opened
  expect(activity(f)).toMatchObject({ busy: false, idleSince: 250, sandbox: running })
  const before = activity(f)
  advance(1_000)
  await f.ctx.workspaceSandbox.statusForUser(f.alice.user.userId, f.alice.id)
  expect(activity(f)).toEqual(before)
})

test('short requests between observations reset the full idle interval without changing the close version', async () => {
  const f = await bashFixture()
  const advance = clock()
  await f.run()
  const before = activity(f)
  const version = f.ctx.workspaceSandboxState.capture(f.alice.id).version
  advance(1_799_900)
  await f.run()
  const after = activity(f)
  expect(after).toMatchObject({ busy: false, idleSince: 1_799_900, sandbox: running })
  expect(after.revision).toBeGreaterThan(before.revision)
  expect(f.ctx.workspaceSandboxState.capture(f.alice.id).version).toBe(version)
  expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(0)
})

test('preparation and both sessions remain busy until the final model request settles', async () => {
  const f = await conversationFixture()
  const advance = clock()
  const other = await f.create()
  const started = Promise.withResolvers<ServerResponse>()
  const respond = f.control.respond
  f.control.respond = (response, method, call) => {
    if (method === 'PUT') started.resolve(response)
    else respond(response, method, call)
  }
  const first = f.prompt('first')
  const response = await started.promise
  expect(activity(f)).toMatchObject({ busy: true, requests: 1, openings: 1, idleSince: null })
  response.end(JSON.stringify(running))
  await first
  f.control.respond = respond
  await f.prompt('second', undefined, other)
  const queued = activity(f)
  await f.prompt('second', undefined, other)
  expect(activity(f)).toEqual(queued)
  expect(activity(f)).toMatchObject({ requests: 2, idleSince: null })
  f.release()
  await f.requested.promise
  advance(500)
  f.agent.cancel({ kind: 'user' })
  await f.agent.whenIdle()
  expect(activity(f)).toMatchObject({ busy: true, requests: 1, idleSince: null })
  advance(900)
  other.cancel({ kind: 'user' })
  await other.whenIdle()
  expect(activity(f)).toMatchObject({ busy: false, requests: 0, idleSince: 900 })
  const settled = activity(f)
  f.ctx.workspaceSandboxState.permits.disposeAgent(other)
  expect(activity(f)).toEqual(settled)
})

test('cancel acknowledgement does not start idle while the original execution is still cleaning', async () => {
  const f = await bashFixture()
  const advance = clock()
  const started = Promise.withResolvers<{ response: ServerResponse; request: RunnerExecutionRequest }>()
  const cancelled = Promise.withResolvers<undefined>()
  const respond = f.control.respond
  f.control.respond = (response, method, call) => {
    if (call.path?.endsWith('/exec')) started.resolve({ response, request: call.body as RunnerExecutionRequest })
    else if (call.path?.endsWith('/exec/cancel')) {
      const request = call.body as { executionId: string; expectedContainerId: string }
      response.writeHead(202).end(JSON.stringify({ executionId: request.executionId,
        containerId: request.expectedContainerId, cancellation: 'requested' }))
      cancelled.resolve(undefined)
    } else respond(response, method, call)
  }
  const pending = f.run()
  const original = await started.promise
  advance(500)
  f.agent.cancel({ kind: 'user' })
  await cancelled.promise
  expect(activity(f)).toMatchObject({ busy: true, executions: 1, idleSince: null })
  advance(900)
  original.response.writeHead(409).end(JSON.stringify({ error: 'execution_cancelled',
    executionId: original.request.executionId, containerId: original.request.expectedContainerId,
    reason: 'cancelled', cleanup: 'processes_cleaned' }))
  await pending
  expect(activity(f)).toMatchObject({ busy: false, executions: 0, idleSince: 900 })
})

test('an execution release changes history once and preserves another outstanding execution', async () => {
  const f = await fixture()
  const advance = clock()
  await f.ctx.workspaceSandbox.openForUser(f.alice.user.userId, f.alice.id)
  const first = f.ctx.workspaceSandboxState.beginExecution(f.alice.id)
  const second = f.ctx.workspaceSandboxState.beginExecution(f.alice.id)
  expect(activity(f)).toMatchObject({ executions: 2, idleSince: null })
  first()
  const remaining = activity(f)
  first()
  expect(activity(f)).toEqual(remaining)
  advance(800)
  second()
  expect(activity(f)).toMatchObject({ busy: false, executions: 0, idleSince: 800 })
  const settled = activity(f)
  second()
  expect(activity(f)).toEqual(settled)
})

test('state polling, rejected access and wall-clock adjustment do not keep a running sandbox alive', async () => {
  const f = await fixture()
  const advance = clock()
  await f.ctx.workspaceSandbox.openForUser(f.alice.user.userId, f.alice.id)
  const before = activity(f)
  vi.spyOn(Date, 'now').mockReturnValue(10)
  advance(1_800_100)
  expect(await f.rpc(f.alice.cookie, 'status', { workspaceId: f.alice.id })).toEqual({
    ok: true, value: { workspaceId: f.alice.id, state: 'running' },
  })
  const calls = f.calls.length
  await expect(f.ctx.workspaceSandbox.statusForUser(f.bob.user.userId, f.alice.id)).rejects.toMatchObject({ code: 'remote-access/denied' })
  expect(() => f.ctx.workspaceSandbox.activityForUser(f.bob.user.userId, f.alice.id)).toThrow()
  expect(f.calls).toHaveLength(calls)
  expect(activity(f)).toEqual(before)
})

test.each(['closed', 'starting', 'cleanup_required'] as const)('%s invalidates idle; a later running observation starts a new interval', async (state) => {
  const f = await fixture()
  const advance = clock()
  await f.ctx.workspaceSandbox.openForUser(f.alice.user.userId, f.alice.id)
  const respond = f.control.respond
  f.control.respond = (response) => { response.end(JSON.stringify({ state })) }
  advance(500)
  await f.ctx.workspaceSandbox.statusForUser(f.alice.user.userId, f.alice.id)
  expect(activity(f)).toMatchObject({ idleSince: null, sandbox: { state: state === 'closed' ? 'closed' : 'unconfirmed' } })
  f.control.respond = respond
  advance(900)
  await f.ctx.workspaceSandbox.statusForUser(f.alice.user.userId, f.alice.id)
  expect(activity(f)).toMatchObject({ idleSince: 900, sandbox: running })
})

test('query failure invalidates the observation and recovery does not count the unknown interval', async () => {
  const f = await fixture()
  const advance = clock()
  await f.ctx.workspaceSandbox.openForUser(f.alice.user.userId, f.alice.id)
  const respond = f.control.respond
  f.control.respond = (response) => { response.writeHead(503).end(JSON.stringify({ error: 'docker_unavailable' })) }
  await expect(f.ctx.workspaceSandbox.statusForUser(f.alice.user.userId, f.alice.id)).rejects.toMatchObject({ code: 'sandbox/failed' })
  expect(activity(f)).toMatchObject({ idleSince: null, sandbox: { state: 'unconfirmed' } })
  advance(900)
  f.control.respond = respond
  await f.ctx.workspaceSandbox.statusForUser(f.alice.user.userId, f.alice.id)
  expect(activity(f)).toMatchObject({ idleSince: 900, sandbox: running })
})

test('a failed opening settles its activity without assuming a running container or retrying', async () => {
  const f = await fixture()
  clock()
  f.control.respond = (response) => { response.writeHead(409).end(JSON.stringify({ error: 'sandbox_capacity' })) }
  await expect(f.ctx.workspaceSandbox.openForUser(f.alice.user.userId, f.alice.id)).rejects.toMatchObject({ code: 'sandbox/failed' })
  expect(activity(f)).toMatchObject({ busy: false, openings: 0, idleSince: null, sandbox: { state: 'unconfirmed' } })
  expect(f.calls.map(call => call.method)).toEqual(['PUT'])
})

test('a query rechecks account authorization before recording a running observation', async () => {
  const f = await fixture()
  clock()
  await f.ctx.workspaceSandbox.openForUser(f.alice.user.userId, f.alice.id)
  const started = Promise.withResolvers<ServerResponse>()
  f.control.respond = (response) => { started.resolve(response) }
  const query = f.ctx.workspaceSandbox.statusForUser(f.alice.user.userId, f.alice.id)
  const rejected = expect(query).rejects.toMatchObject({ code: 'remote-access/denied' })
  const response = await started.promise
  await f.ctx.multiuser.disableUser(f.alice.user.userId)
  response.end(JSON.stringify(running))
  await rejected
  expect(f.ctx.workspaceSandboxState.activity(f.alice.id)).toMatchObject({ idleSince: null, sandbox: { state: 'unconfirmed' } })
})

test.each(['closed', 'failed'] as const)('a late %s query cannot overwrite a new short request and idle interval', async (result) => {
  const f = await bashFixture()
  const advance = clock()
  await f.run()
  const started = Promise.withResolvers<ServerResponse>()
  const respond = f.control.respond
  f.control.respond = (response, method, call) => {
    if (method === 'GET') started.resolve(response)
    else respond(response, method, call)
  }
  const query = f.ctx.workspaceSandbox.statusForUser(f.alice.user.userId, f.alice.id).catch(() => undefined)
  const response = await started.promise
  advance(900)
  await f.run()
  const current = activity(f)
  expect(current.idleSince).toBe(900)
  if (result === 'closed') response.end(JSON.stringify({ state: 'closed' }))
  else response.writeHead(503).end(JSON.stringify({ error: 'docker_unavailable' }))
  await query
  expect(activity(f)).toEqual(current)
})

test('a late running query cannot replace a newly observed container or restart its idle clock', async () => {
  const f = await fixture()
  const advance = clock()
  await f.ctx.workspaceSandbox.openForUser(f.alice.user.userId, f.alice.id)
  const started = Promise.withResolvers<ServerResponse>()
  f.control.respond = (response) => { started.resolve(response) }
  const query = f.ctx.workspaceSandbox.statusForUser(f.alice.user.userId, f.alice.id)
  const response = await started.promise
  const replacement = { state: 'running', containerId: 'b'.repeat(64) }
  f.control.respond = (next) => { next.end(JSON.stringify(replacement)) }
  advance(900)
  await f.ctx.workspaceSandbox.statusForUser(f.alice.user.userId, f.alice.id)
  const current = activity(f)
  expect(current).toMatchObject({ idleSince: 900, sandbox: replacement })
  advance(1_000)
  response.end(JSON.stringify(running))
  await query
  expect(activity(f)).toEqual(current)
})

test('polling during an outstanding PUT cannot displace its confirmed running generation', async () => {
  const f = await fixture()
  const advance = clock()
  const started = Promise.withResolvers<ServerResponse>()
  f.control.respond = (response, method) => {
    if (method === 'PUT') started.resolve(response)
    else response.end(JSON.stringify({ state: 'closed' }))
  }
  const opening = f.ctx.workspaceSandbox.openForUser(f.alice.user.userId, f.alice.id)
  const response = await started.promise
  await f.ctx.workspaceSandbox.statusForUser(f.alice.user.userId, f.alice.id)
  expect(activity(f)).toMatchObject({ openings: 1, idleSince: null, sandbox: { state: 'unconfirmed' } })
  advance(900)
  response.end(JSON.stringify(running))
  await opening
  expect(activity(f)).toMatchObject({ busy: false, idleSince: 900, sandbox: running })
})

test('manual close clears the generation and reopening starts a new interval', async () => {
  const f = await fixture()
  const advance = clock()
  await f.ctx.workspaceSandbox.openForUser(f.alice.user.userId, f.alice.id)
  const closed = f.ctx.workspaceSandbox.closeForUser(f.alice.user.userId, f.alice.id)
  expect(activity(f)).toMatchObject({ closing: true, idleSince: null, sandbox: { state: 'unconfirmed' } })
  await closed
  expect(activity(f)).toMatchObject({ busy: false, idleSince: null, sandbox: { state: 'closed' } })
  advance(900)
  await f.ctx.workspaceSandbox.openForUser(f.alice.user.userId, f.alice.id)
  expect(activity(f)).toMatchObject({ idleSince: 900, sandbox: running })
})

test('manager availability invalidates history while idle conversation reload preserves it', async () => {
  const f = await bashFixture()
  const advance = clock()
  await f.run()
  const original = activity(f)
  await f.reloadConversation()
  expect(activity(f)).toEqual(original)
  const manager = f.ctx.workspaceSandbox
  await f.sandboxFiber.dispose()
  expect(() => manager.activityForUser(f.alice.user.userId, f.alice.id)).toThrow()
  expect(f.ctx.workspaceSandboxState.activity(f.alice.id)).toMatchObject({ idleSince: null, sandbox: { state: 'unconfirmed' } })
  await f.ctx.plugin(WorkspaceSandbox, { socketPath: f.socketPath, workspaceRoot: f.workspaceRoot })
  expect(activity(f).idleSince).toBeNull()
  advance(900)
  await f.ctx.workspaceSandbox.statusForUser(f.alice.user.userId, f.alice.id)
  expect(activity(f)).toMatchObject({ idleSince: 900, sandbox: running })
})
