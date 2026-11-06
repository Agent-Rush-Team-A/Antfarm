/** Executor-level deployment policy through native admissions and the real multiuser guard. */
import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { bashFixture } from './fixtures/bash.ts'
import { conversationFixture } from './fixtures/conversation.ts'
import { running } from './fixtures/management.ts'
import type { ServerResponse } from 'node:http'

function hostTool(onExecute: () => void) {
  return defineTool({ name: 'bash', description: 'Host replacement', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: () => { onExecute(); return Promise.resolve('host') },
  })
}

test('an admitted toolSet alone cannot grant a direct call an original message permit', async () => {
  const f = await bashFixture()
  const signal = new AbortController().signal
  const toolSet = await f.ctx.tools.resolve({ agent: f.agent, signal, modelSelection: { provider: 'fixture', model: 'fixture' } })
  const result = await f.ctx.tools.execute({ agent: f.agent, signal, toolSet,
    calls: [{ type: 'tool-call', id: ToolCallId(randomUUID()), name: 'bash', arguments: '{}' }] })
  toolSet.dispose()
  expect(result.results[0]?.result.isError).toBe(true)
  expect(f.calls).toEqual([])
})

test('same-name scoped host Bash is denied even with a valid message and step', async () => {
  const f = await bashFixture()
  let hostCalls = 0
  f.agent.ctx.tools.register(hostTool(() => { hostCalls++ }))
  expect((await f.run()).isError).toBe(true)
  expect(hostCalls).toBe(0)
  expect(f.calls.map(call => call.method)).toEqual(['PUT'])
})

test.each(['pre-execute', 'execute'] as const)('definition replacement during %s cannot redirect an admitted call to host', async (stage) => {
  const f = await bashFixture()
  let hostCalls = 0
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const wait = async () => {
    entered.resolve(undefined)
    await release.promise
  }
  if (stage === 'pre-execute') f.ctx.on('tools/pre-execute', async (_exec, next) => { await wait(); return next() }, { global: true })
  else f.ctx.on('tools/execute', async (_exec, next) => { await wait(); return next() }, { global: true })
  const pending = f.run()
  await entered.promise
  f.agent.ctx.tools.register(hostTool(() => { hostCalls++ }))
  release.resolve(undefined)
  expect((await pending).isError).toBe(true)
  expect(hostCalls).toBe(0)
  expect(f.calls.map(call => call.method)).toEqual(['PUT'])
})

test('unloading Bash during policy wait removes its exception and cannot fall through to host', async () => {
  const f = await bashFixture()
  let hostCalls = 0
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  f.ctx.on('tools/pre-execute', async (_exec, next) => { entered.resolve(undefined); await release.promise; return next() }, { global: true })
  const pending = f.run()
  await entered.promise
  await f.fiber.dispose()
  expect(f.ctx.tools.get('bash', f.agent)).toBeUndefined()
  f.ctx.tools.register(hostTool(() => { hostCalls++ }))
  release.resolve(undefined)
  expect((await pending).isError).toBe(true)
  expect(hostCalls).toBe(0)
  expect(f.calls.map(call => call.method)).toEqual(['PUT'])
})

test('isolated-tool registration belongs to its calling fiber, while other guards remain monotonic', async () => {
  const f = await bashFixture()
  await f.fiber.dispose()
  let calls = 0
  const definition = hostTool(() => { calls++ })
  f.ctx.tools.register(definition)
  const exception = f.ctx.plugin(Object.assign((ctx: Context) => {
    ctx.multiuser.registerIsolatedTool(definition, () => true)
  }, { inject: ['multiuser'] }))
  await exception
  const signal = new AbortController().signal
  const toolSet = await f.ctx.tools.resolve({ agent: f.agent, signal, modelSelection: { provider: 'fixture', model: 'fixture' } })
  const execute = () => f.ctx.tools.execute({ agent: f.agent, signal, toolSet,
    calls: [{ type: 'tool-call', id: ToolCallId(randomUUID()), name: 'bash', arguments: '{}' }] })
  expect((await execute()).results[0]?.result.isError).toBe(false)
  const guard = f.ctx.tools.guard(() => 'Additional deployment denial')
  expect((await execute()).results[0]?.result.isError).toBe(true)
  guard()
  await exception.dispose()
  expect((await execute()).results[0]?.result.isError).toBe(true)
  toolSet.dispose()
  expect(calls).toBe(1)
})

test('native run_code has no dispatch path and unsupported tools retain the default denial', async () => {
  const f = await bashFixture()
  for (const name of ['run_code', 'read', 'write', 'edit', 'pwsh', 'terminal', 'browser']) {
    const result = await f.ctx.tools.execute({ agent: f.agent, signal: new AbortController().signal,
      calls: [{ type: 'tool-call', id: ToolCallId(randomUUID()), name, arguments: '{}' }] })
    expect(result.results[0]?.result.isError).toBe(true)
  }
  expect(f.calls).toEqual([])
})

test('account revocation during policy wait is checked again before exec', async () => {
  const f = await bashFixture()
  f.ctx.on('tools/pre-execute', async (_exec, next) => {
    await f.ctx.multiuser.disableUser(f.alice.user.userId)
    return next()
  }, { global: true })
  expect((await f.run()).isError).toBe(true)
  expect(f.calls.map(call => call.method)).toEqual(['PUT'])
})

test('activity spans queued input, model work, cancellation and manager availability', async () => {
  const f = await conversationFixture()
  const activity = () => f.ctx.workspaceSandbox.activityForUser(f.alice.user.userId, f.alice.id)
  expect(activity()).toMatchObject({ busy: false, requests: 0, openings: 0, executions: 0, closing: false })
  await f.prompt('model-active')
  await f.entered.promise
  expect(activity()).toMatchObject({ busy: true, requests: 1 })
  await f.prompt('queued')
  expect(activity()).toMatchObject({ busy: true, requests: 2 })
  f.release()
  await f.requested.promise
  expect(activity().busy).toBe(true)
  await expect(Promise.resolve().then(() => f.ctx.workspaceSandbox.activityForUser(f.bob.user.userId, f.alice.id)))
    .rejects.toMatchObject({ code: 'remote-access/denied' })
  f.agent.cancel({ kind: 'user' }, { keepInbox: true })
  expect(activity().busy).toBe(true)
  await f.ctx.workspaceSandbox.closeForUser(f.alice.user.userId, f.alice.id)
  await f.agent.whenIdle()
  expect(activity()).toMatchObject({ busy: false, requests: 0, executions: 0, closing: false })
  await f.sandboxFiber.dispose()
  expect(activity).toThrow()
})

test('activity starts before PUT settles and remains busy after an unconfirmed close', async () => {
  const f = await conversationFixture()
  const started = Promise.withResolvers<ServerResponse>()
  f.control.respond = (response, method) => {
    if (method === 'PUT') started.resolve(response)
    else if (method === 'DELETE') response.writeHead(503).end(JSON.stringify({ error: 'docker_unavailable' }))
    else response.end(JSON.stringify({ state: 'closed' }))
  }
  const pending = f.prompt('preparing')
  const response = await started.promise
  const activity = () => f.ctx.workspaceSandbox.activityForUser(f.alice.user.userId, f.alice.id)
  expect(activity()).toMatchObject({ busy: true, requests: 1, openings: 1 })
  response.end(JSON.stringify(running))
  await pending
  await expect(f.ctx.workspaceSandbox.closeForUser(f.alice.user.userId, f.alice.id)).rejects.toMatchObject({ code: 'sandbox/failed' })
  await f.agent.whenIdle()
  expect(activity()).toMatchObject({ busy: true, requests: 0, openings: 0, executions: 0, closing: true })
  expect(await f.ctx.workspaceSandbox.statusForUser(f.alice.user.userId, f.alice.id)).toEqual({ state: 'closing' })
})
