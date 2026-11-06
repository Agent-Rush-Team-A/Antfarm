import { randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { expect, test } from 'vitest'
import type { RunnerExecutionRequest } from '../src/execution.ts'
import { bashFixture } from './fixtures/bash.ts'
import WorkspaceSandbox from '../src/index.ts'
import { running } from './fixtures/management.ts'

function cancelled(response: ServerResponse, request: RunnerExecutionRequest, cleanup = 'processes_cleaned') {
  response.writeHead(cleanup === 'unconfirmed' ? 503 : 409).end(JSON.stringify({
    error: cleanup === 'unconfirmed' ? 'execution_outcome_unknown' : 'execution_cancelled',
    executionId: request.executionId, containerId: request.expectedContainerId, reason: 'cancelled', cleanup,
  }))
}

test.each([200, 202])('cancel %s is an acknowledgement; the original exec is still drained', async (status) => {
  const f = await bashFixture()
  const started = Promise.withResolvers<{ response: ServerResponse; request: RunnerExecutionRequest }>()
  const accepted = Promise.withResolvers<undefined>()
  const respond = f.control.respond
  f.control.respond = (response, method, call) => {
    if (call.path?.endsWith('/exec')) started.resolve({ response, request: call.body as RunnerExecutionRequest })
    else if (call.path?.endsWith('/exec/cancel')) {
      const identity = call.body as { executionId: string; expectedContainerId: string }
      expect(Object.keys(identity).sort()).toEqual(['executionId', 'expectedContainerId'])
      response.writeHead(status).end(JSON.stringify({ executionId: identity.executionId,
        containerId: identity.expectedContainerId, cancellation: status === 202 ? 'requested' : 'settled' }))
      accepted.resolve(undefined)
    } else respond(response, method, call)
  }
  let settled = false
  const result = f.run().then((value) => { settled = true; return value })
  const original = await started.promise
  f.agent.cancel({ kind: 'user' }, { keepInbox: true })
  await accepted.promise
  expect(settled).toBe(false)
  expect(f.ctx.workspaceSandbox.activityForUser(f.alice.user.userId, f.alice.id)).toMatchObject({ busy: true, executions: 1 })
  cancelled(original.response, original.request)
  expect((await result).isError).toBe(true)
  expect(f.ctx.workspaceSandbox.activityForUser(f.alice.user.userId, f.alice.id)).toMatchObject({ busy: false, requests: 0, executions: 0 })
  expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(0)
  expect(f.calls.filter(call => call.path?.endsWith('/exec'))).toHaveLength(1)
})

test.each([false, true])('cancel 404 is retried once and does not authorize an exec replay; second acknowledgement=%s', async (acknowledged) => {
  const f = await bashFixture()
  const started = Promise.withResolvers<{ response: ServerResponse; request: RunnerExecutionRequest }>()
  let original: { response: ServerResponse; request: RunnerExecutionRequest }
  let cancellations = 0
  const respond = f.control.respond
  f.control.respond = (response, method, call) => {
    if (call.path?.endsWith('/exec')) { original = { response, request: call.body as RunnerExecutionRequest }; started.resolve(original) }
    else if (call.path?.endsWith('/exec/cancel')) {
      if (++cancellations === 2 && acknowledged) {
        response.writeHead(202).end(JSON.stringify({ executionId: original.request.executionId,
          containerId: original.request.expectedContainerId, cancellation: 'requested' }))
        cancelled(original.response, original.request)
      } else {
        response.writeHead(404).end(JSON.stringify({ error: 'execution_not_found' }))
        if (cancellations === 2) original.response.destroy()
      }
    } else respond(response, method, call)
  }
  const result = f.run()
  await started.promise
  f.agent.cancel({ kind: 'user' }, { keepInbox: true })
  expect((await result).isError).toBe(true)
  expect(cancellations).toBe(2)
  expect(f.calls.filter(call => call.path?.endsWith('/exec'))).toHaveLength(1)
  expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(acknowledged ? 0 : 1)
})

test('cancel acknowledgement permits one original-identity retrieval after the exec connection is lost', async () => {
  const f = await bashFixture()
  const started = Promise.withResolvers<undefined>()
  let original!: { response: ServerResponse; request: RunnerExecutionRequest }
  let executions = 0
  const respond = f.control.respond
  f.control.respond = (response, method, call) => {
    if (call.path?.endsWith('/exec')) {
      if (++executions === 1) {
        original = { response, request: call.body as RunnerExecutionRequest }
        started.resolve(undefined)
      } else {
        expect(call.body).toEqual(original.request)
        cancelled(response, original.request)
      }
    } else if (call.path?.endsWith('/exec/cancel')) {
      response.writeHead(202).end(JSON.stringify({ executionId: original.request.executionId,
        containerId: original.request.expectedContainerId, cancellation: 'requested' }))
      original.response.destroy()
    } else respond(response, method, call)
  }
  const result = f.run()
  await started.promise
  f.agent.cancel({ kind: 'user' })
  await result
  expect(executions).toBe(2)
  expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(0)
})

test('repeated transport loss has a finite retrieval budget and enters shared closure', async () => {
  const f = await bashFixture()
  const respond = f.control.respond
  f.control.respond = (response, method, call) => {
    if (call.path?.endsWith('/exec')) response.destroy()
    else respond(response, method, call)
  }
  expect((await f.run()).isError).toBe(true)
  const sent = f.calls.filter(call => call.path?.endsWith('/exec'))
  expect(sent).toHaveLength(2)
  expect(sent[0]?.body).toEqual(sent[1]?.body)
  expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(1)
})

test('cancellation during the recovery status query cannot use its running result to replay exec', async () => {
  const f = await bashFixture()
  const queried = Promise.withResolvers<ServerResponse>()
  const rejected = Promise.withResolvers<undefined>()
  const respond = f.control.respond
  let queries = 0
  let cancellations = 0
  f.control.respond = (response, method, call) => {
    if (call.path?.endsWith('/exec')) response.destroy()
    else if (method === 'GET' && ++queries === 1) queried.resolve(response)
    else if (call.path?.endsWith('/exec/cancel')) {
      response.writeHead(404).end(JSON.stringify({ error: 'execution_not_found' }))
      if (++cancellations === 2) rejected.resolve(undefined)
    } else respond(response, method, call)
  }
  const result = f.run()
  const status = await queried.promise
  f.agent.cancel({ kind: 'user' })
  await rejected.promise
  status.end(JSON.stringify(running))
  await result
  expect(f.calls.filter(call => call.path?.endsWith('/exec'))).toHaveLength(1)
})

test('different sessions dispatch concurrently into the same container and keep separate results', async () => {
  const f = await bashFixture()
  const sibling = await f.create()
  const first = Promise.withResolvers<undefined>()
  const executions: Array<{ response: ServerResponse; request: RunnerExecutionRequest }> = []
  const respond = f.control.respond
  f.control.respond = (response, method, call) => {
    if (call.path?.endsWith('/exec')) {
      executions.push({ response, request: call.body as RunnerExecutionRequest })
      if (executions.length === 1) first.resolve(undefined)
      if (executions.length === 2) for (const [index, execution] of executions.entries()) {
        execution.response.end(JSON.stringify({ executionId: execution.request.executionId, exitCode: index + 7,
          stdout: { text: `session-${index}`, truncated: false }, stderr: { text: '', truncated: false } }))
      }
    } else respond(response, method, call)
  }
  const run = f.run()
  await first.promise
  await f.prompt(randomUUID(), undefined, sibling)
  await Promise.all([run, sibling.whenIdle()])
  expect(executions).toHaveLength(2)
  expect(executions[0]?.request.executionId).not.toBe(executions[1]?.request.executionId)
  expect(executions.map(execution => execution.request.expectedContainerId)).toEqual([running.containerId, running.containerId])
  expect(f.results.find(record => record.exec.agent === f.agent)?.result).toMatchObject({ value: { stdout: { text: 'session-0' }, exitCode: 7 } })
  expect(f.results.find(record => record.exec.agent === sibling)?.result).toMatchObject({ value: { stdout: { text: 'session-1' }, exitCode: 8 } })
})

test('old unconfirmed cleanup cannot close a container reopened by a new message', async () => {
  const f = await bashFixture()
  const started = Promise.withResolvers<{ response: ServerResponse; request: RunnerExecutionRequest }>()
  let current = running.containerId
  let executions = 0
  f.control.respond = (response, method, call) => {
    const request = call.body as RunnerExecutionRequest
    if (call.path?.endsWith('/exec') && ++executions === 1) started.resolve({ response, request })
    else if (call.path?.endsWith('/exec')) response.end(JSON.stringify({ executionId: request.executionId, exitCode: 0,
      stdout: { text: 'new generation', truncated: false }, stderr: { text: '', truncated: false } }))
    else if (call.path?.endsWith('/exec/cancel')) response.writeHead(202).end(JSON.stringify({ executionId: request.executionId,
      containerId: request.expectedContainerId, cancellation: 'requested' }))
    else if (method === 'DELETE') response.end(JSON.stringify({ state: 'closed' }))
    else response.end(JSON.stringify({ state: 'running', containerId: current }))
  }
  const run = f.run()
  const original = await started.promise
  await f.ctx.workspaceSandbox.closeForUser(f.alice.user.userId, f.alice.id)
  current = 'b'.repeat(64)
  await f.prompt('fresh-after-close')
  cancelled(original.response, original.request, 'unconfirmed')
  await run
  expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(1)
  const execs = f.calls.filter(call => call.path?.endsWith('/exec'))
  expect(execs.map(call => (call.body as RunnerExecutionRequest).expectedContainerId)).toEqual([running.containerId, current])
  expect(f.results.at(-1)?.result).toMatchObject({ isError: false, value: { stdout: { text: 'new generation' } } })
})

test('plugin unload drains cancellation and removes the tool without a host fallback', async () => {
  const f = await bashFixture()
  const started = Promise.withResolvers<{ response: ServerResponse; request: RunnerExecutionRequest }>()
  const respond = f.control.respond
  let original!: { response: ServerResponse; request: RunnerExecutionRequest }
  f.control.respond = (response, method, call) => {
    if (call.path?.endsWith('/exec')) { original = { response, request: call.body as RunnerExecutionRequest }; started.resolve(original) }
    else if (call.path?.endsWith('/exec/cancel')) {
      response.writeHead(202).end(JSON.stringify({ executionId: original.request.executionId,
        containerId: original.request.expectedContainerId, cancellation: 'requested' }))
      cancelled(original.response, original.request)
    } else respond(response, method, call)
  }
  const run = f.run()
  await started.promise
  await f.fiber.dispose()
  expect((await run).isError).toBe(true)
  expect(f.ctx.tools.get('bash')).toBeUndefined()
  expect(f.calls.filter(call => call.path?.endsWith('/exec/cancel'))).toHaveLength(1)
})

test('abort before dispatch and oversized commands never submit an exec', async () => {
  const f = await bashFixture()
  expect((await f.run({ command: 'x'.repeat(65536), description: 'Too much input' })).isError).toBe(true)
  f.ctx.on('tools/pre-execute', (_exec, next) => { f.agent.cancel({ kind: 'user' }); return next() }, { global: true })
  await f.run({ command: 'echo unreachable', description: 'Must not run' })
  expect(f.calls.filter(call => call.path?.includes('/exec'))).toHaveLength(0)
})

test('manager unload with an unconfirmed command retains its barrier after reload', async () => {
  const f = await bashFixture(50)
  const started = Promise.withResolvers<undefined>()
  const respond = f.control.respond
  f.control.respond = (response, method, call) => {
    if (call.path?.includes('/exec')) started.resolve(undefined)
    else if (method === 'DELETE') response.writeHead(503).end(JSON.stringify({ error: 'docker_unavailable' }))
    else respond(response, method, call)
  }
  const run = f.run()
  await started.promise
  expect(await f.remove(f.alice.cookie, f.alice.id)).toMatchObject({ ok: false,
    error: { code: 'workspace/sandbox-active', details: { state: 'running' } } })
  await f.sandboxFiber.dispose()
  await run
  await f.ctx.plugin(WorkspaceSandbox, { socketPath: f.socketPath, workspaceRoot: f.workspaceRoot })
  expect(await f.ctx.workspaceSandbox.statusForUser(f.alice.user.userId, f.alice.id)).toEqual({ state: 'closing' })
  await expect(f.prompt('must-not-reopen')).rejects.toMatchObject({ code: 'gateway/cancelled' })
  expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(1)
})
