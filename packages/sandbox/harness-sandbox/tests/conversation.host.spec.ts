import { expect, test, vi } from 'vitest'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import WorkspaceSandbox from '../src/index.ts'
import Conversation from '../src/conversation.ts'
import { ApiSessionAgentController } from '../../../api/session-controller/src/agent.ts'
import { conversationFixture } from './fixtures/conversation.ts'
import { running } from './fixtures/management.ts'

test('authenticated HTTP prompt prepares its native workspace; accepted duplicates do not reopen or requeue', async () => {
  const f = await conversationFixture()
  const request = { sessionId: f.agent.id, requestId: 'http-prompt', mode: 'queue', content: [{ type: 'text', text: 'hello' }] }
  const response = await f.raw(f.alice.cookie, 'session/prompt', { request })
  expect(await response.json()).toMatchObject({ result: { ok: true, value: { accepted: true } } })
  const turn = (await f.entered.promise).turn
  expect(f.calls.map(call => call.method)).toEqual(['PUT'])
  expect(f.ctx.sandboxConversation.forTurn(f.agent, turn).requestId).toBe('http-prompt')
  expect(f.inserted[0]?.source).toMatchObject({ principal: { kind: 'user', userId: f.alice.user.userId } })
  await expect(f.prompt('http-prompt')).resolves.toEqual({ accepted: true })
  expect(f.calls).toHaveLength(1)
  expect(f.inserted).toHaveLength(1)
})

test('no principal, another owner, and cwd without membership never prepare a sandbox', async () => {
  const f = await conversationFixture()
  const request = { sessionId: f.agent.id, requestId: 'foreign' as SessionRequestId, mode: 'queue' as const, content: [{ type: 'text' as const, text: 'hello' }] }
  await expect(f.controller.prompt(request, { kind: 'user', rpcId: request.requestId })).rejects.toMatchObject({ code: 'remote-access/denied' })
  await expect(f.prompt('cross-owner', undefined, f.agent, f.bob)).rejects.toMatchObject({ code: 'remote-access/denied' })
  const other = await f.harness.create(f.agent.id + '-unowned' as typeof f.agent.id, {}, { cwd: f.alice.workspace.path })
  await expect(f.prompt('cwd-only', undefined, other)).rejects.toMatchObject({ code: 'remote-access/denied' })
  expect(f.calls).toEqual([])
})

test('duplicate pending prompts share one PUT; close cancels both and never admits the old ID again', async () => {
  const f = await conversationFixture()
  const received = Promise.withResolvers<() => void>()
  f.control.respond = (response, method) => {
    if (method === 'PUT') received.resolve(() => { response.end(JSON.stringify(running)) })
    else response.end(JSON.stringify({ state: 'closed' }))
  }
  const results = Promise.allSettled([f.prompt('pending'), f.prompt('pending')])
  const finishOpen = await received.promise
  const close = f.ctx.workspaceSandbox.closeForUser(f.alice.user.userId, f.alice.id)
  await expect(f.prompt('new-during-close')).rejects.toMatchObject({ code: 'gateway/cancelled' })
  expect(f.calls.map(call => call.method)).toEqual(['PUT'])
  finishOpen()
  expect((await results).map(result => result.status)).toEqual(['rejected', 'rejected'])
  await close
  expect([...f.agent.inbox.nextTurn, ...f.agent.inbox.nextStep]).toHaveLength(0)
  await expect(f.prompt('pending')).rejects.toMatchObject({ code: 'gateway/cancelled' })
  await expect(f.prompt('new-during-close')).rejects.toMatchObject({ code: 'gateway/cancelled' })
  expect(f.calls.map(call => call.method)).toEqual(['PUT', 'DELETE'])
})

test.each(['close', 'disconnect', 'ownership'] as const)('%s during attachment preparation prevents late insertion', async (cause) => {
  const f = await conversationFixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const admit = f.ctx.attachments.admitPromptContent.bind(f.ctx.attachments)
  vi.spyOn(f.ctx.attachments, 'admitPromptContent').mockImplementation(async (content) => { entered.resolve(undefined); await release.promise; return admit(content) })
  const caller = new AbortController()
  const result = Promise.allSettled([f.prompt('attachments', caller.signal)])
  await entered.promise
  if (cause === 'close') await f.ctx.workspaceSandbox.closeForUser(f.alice.user.userId, f.alice.id)
  if (cause === 'disconnect') caller.abort()
  if (cause === 'ownership') await f.ctx.multiuser.disableUser(f.alice.user.userId)
  release.resolve(undefined)
  expect((await result)[0]?.status).toBe('rejected')
  expect([...f.agent.inbox.nextTurn, ...f.agent.inbox.nextStep]).toHaveLength(0)
  expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(1)
  if (cause !== 'ownership') {
    await f.reloadConversation()
    await expect(f.prompt('attachments')).rejects.toMatchObject({ code: 'gateway/cancelled' })
    expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(1)
  }
})

test('permit exists before Agent recovery and revoked recovery does not issue a PUT', async () => {
  const f = await conversationFixture()
  const before = f.ctx.workspaceSandbox.activityForUser(f.alice.user.userId, f.alice.id)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const resolver = new ApiSessionAgentController(f.ctx)
  const resolve = resolver.resolveAgent.bind(resolver)
  vi.spyOn(ApiSessionAgentController.prototype, 'resolveAgent').mockImplementation(async (id) => {
    entered.resolve(undefined); await release.promise; return resolve(id)
  })
  const result = Promise.allSettled([f.prompt('recovery')])
  await entered.promise
  expect(f.ctx.workspaceSandbox.activityForUser(f.alice.user.userId, f.alice.id))
    .toMatchObject({ requests: 1, openings: 0, idleSince: null, revision: before.revision + 1 })
  await f.ctx.workspaceSandbox.closeForUser(f.alice.user.userId, f.alice.id)
  release.resolve(undefined)
  expect((await result)[0]?.status).toBe('rejected')
  await expect(f.prompt('recovery')).rejects.toMatchObject({ code: 'gateway/cancelled' })
  expect(f.calls.map(call => call.method)).toEqual(['DELETE'])
})

test('last synchronous validation catches closure while binding uploads', async () => {
  const f = await conversationFixture()
  let closed: Promise<unknown> | undefined
  const bind = f.ctx.fileUploads.bindPrompt.bind(f.ctx.fileUploads)
  vi.spyOn(f.ctx.fileUploads, 'bindPrompt').mockImplementation((...args) => {
    closed = f.ctx.workspaceSandbox.closeForUser(f.alice.user.userId, f.alice.id)
    return bind(...args)
  })
  await expect(f.prompt('final-check')).rejects.toMatchObject({ code: 'gateway/cancelled' })
  await closed
  expect([...f.agent.inbox.nextTurn, ...f.agent.inbox.nextStep]).toHaveLength(0)
})

test('accepted disconnect preserves work; authorized close cancels model and all queued inputs', async () => {
  const f = await conversationFixture()
  const caller = new AbortController()
  await f.prompt('active', caller.signal)
  f.release()
  const request = await f.requested.promise
  const original = f.ctx.sandboxConversation.forTurn(f.agent, request.turn)
  expect(original).toMatchObject({ requestId: 'active', containerId: running.containerId, userId: f.alice.user.userId })
  caller.abort()
  expect(original.signal.aborted).toBe(false)
  await f.prompt('queued')
  await f.prompt('steering', undefined, f.agent, f.alice, 'steer')
  expect(f.ctx.sandboxConversation.forTurn(f.agent, request.turn).requestId).toBe('active')
  await expect(f.ctx.workspaceSandbox.closeForUser(f.bob.user.userId, f.alice.id)).rejects.toMatchObject({ code: 'remote-access/denied' })
  expect(original.signal.aborted).toBe(false)
  expect([...f.agent.inbox.nextTurn, ...f.agent.inbox.nextStep]).not.toHaveLength(0)
  await f.ctx.workspaceSandbox.closeForUser(f.alice.user.userId, f.alice.id)
  await f.agent.whenIdle()
  expect(original.signal.aborted).toBe(true)
  expect(request.signal.aborted).toBe(true)
  expect([...f.agent.inbox.nextTurn, ...f.agent.inbox.nextStep]).toHaveLength(0)
  for (const id of ['active', 'queued', 'steering']) await f.prompt(id)
  expect(f.calls.map(call => call.method)).toEqual(['PUT', 'PUT', 'PUT', 'DELETE'])
  expect([...f.agent.inbox.nextTurn, ...f.agent.inbox.nextStep]).toHaveLength(0)
  f.hold()
  await f.prompt('fresh')
  expect(() => f.ctx.sandboxConversation.forTurn(f.agent, request.turn)).toThrow()
  expect(f.calls.map(call => call.method)).toEqual(['PUT', 'PUT', 'PUT', 'DELETE', 'PUT'])
})

test('ordinary session stop keeps queued input while sandbox close clears it', async () => {
  const f = await conversationFixture()
  await f.prompt('first')
  f.release()
  await f.requested.promise
  await f.prompt('queued')
  f.controller.cancel({ sessionId: f.agent.id })
  await f.agent.whenIdle()
  expect(f.agent.inbox.nextTurn).toHaveLength(1)
  await f.ctx.workspaceSandbox.closeForUser(f.alice.user.userId, f.alice.id)
  expect([...f.agent.inbox.nextTurn, ...f.agent.inbox.nextStep]).toHaveLength(0)
})

test('close revokes every session in its workspace while another workspace keeps running', async () => {
  const f = await conversationFixture()
  const sibling = await f.create()
  const other = await f.create(f.bob)
  await f.prompt('first-session')
  await f.prompt('second-session', undefined, sibling)
  await f.prompt('other-workspace', undefined, other, f.bob)
  f.release()
  const ready = Promise.withResolvers<undefined>()
  let requests = 0
  f.ctx.on('agent/request', (_payload, next) => { if (++requests === 3) ready.resolve(undefined); return next() }, { global: true })
  await ready.promise
  const first = f.ctx.sandboxConversation.forTurn(f.agent, 1)
  const second = f.ctx.sandboxConversation.forTurn(sibling, 1)
  const unaffected = f.ctx.sandboxConversation.forTurn(other, 1)
  expect(() => f.ctx.sandboxConversation.forTurn(other, 2)).toThrow()
  await f.ctx.workspaceSandbox.closeForUser(f.alice.user.userId, f.alice.id)
  await Promise.all([f.agent.whenIdle(), sibling.whenIdle()])
  expect(first.signal.aborted).toBe(true)
  expect(second.signal.aborted).toBe(true)
  expect(unaffected.signal.aborted).toBe(false)
  expect(f.ctx.sandboxConversation.forTurn(other, 1).requestId).toBe('other-workspace')
})

test('conversation unload revokes its permits and removes admission listener; reload retains cancelled receipts', async () => {
  const f = await conversationFixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const admit = f.ctx.attachments.admitPromptContent.bind(f.ctx.attachments)
  vi.spyOn(f.ctx.attachments, 'admitPromptContent').mockImplementation(async (content) => { entered.resolve(undefined); await release.promise; return admit(content) })
  const result = Promise.allSettled([f.prompt('unloaded')])
  await entered.promise
  const unloading = f.unloadConversation()
  release.resolve(undefined)
  await unloading
  expect((await result)[0]?.status).toBe('rejected')
  expect(f.ctx.get('sandboxConversation')).toBeUndefined()
  await f.ctx.plugin(Conversation)
  await expect(f.prompt('unloaded')).rejects.toMatchObject({ code: 'gateway/cancelled' })
  expect([...f.agent.inbox.nextTurn, ...f.agent.inbox.nextStep]).toHaveLength(0)
})

test('failed close and manager reload retain the barrier and workspace deletion protection', async () => {
  const f = await conversationFixture()
  f.control.respond = (response) => { response.writeHead(409).end(JSON.stringify({ error: 'sandbox_closing' })) }
  await expect(f.ctx.workspaceSandbox.closeForUser(f.alice.user.userId, f.alice.id)).rejects.toMatchObject({ code: 'sandbox/failed' })
  await f.sandboxFiber.dispose()
  await f.ctx.plugin(WorkspaceSandbox, { socketPath: f.socketPath, workspaceRoot: f.workspaceRoot })
  await expect(f.prompt('blocked')).rejects.toMatchObject({ code: 'gateway/cancelled' })
  expect(await f.remove(f.alice.cookie, f.alice.id)).toMatchObject({ ok: false, error: { code: 'workspace/sandbox-active' } })
  f.control.respond = (response) => { response.end(JSON.stringify({ state: 'closed' })) }
  await f.ctx.workspaceSandbox.closeForUser(f.alice.user.userId, f.alice.id)
  f.control.respond = (response) => { response.end(JSON.stringify(running)) }
  await f.prompt('fresh')
  expect(f.inserted).toHaveLength(1)
})

test('unloading active conversation revokes the old turn without reconstructing it after reload', async () => {
  const f = await conversationFixture()
  await f.prompt('before-reload')
  f.release()
  const request = await f.requested.promise
  const permit = f.ctx.sandboxConversation.forTurn(f.agent, request.turn)
  await f.reloadConversation()
  await f.agent.whenIdle()
  expect(permit.signal.aborted).toBe(true)
  expect(() => f.ctx.sandboxConversation.forTurn(f.agent, request.turn)).toThrow()
  await f.prompt('before-reload')
  expect(f.inserted).toHaveLength(1)
  expect(f.calls.map(call => call.method)).toEqual(['PUT'])
})
