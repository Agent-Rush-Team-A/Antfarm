import { randomUUID } from 'node:crypto'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import Commands from '@deepseek-ai/dsh-commands'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { SessionCommandController } from '../../../../api/session-controller/src/commands.ts'
import { ApiSessionAgentController } from '../../../../api/session-controller/src/agent.ts'
import Conversation from '../../src/conversation.ts'
import { fixture } from './management.ts'

class LiveQuery extends SessionQuery {
  override searchSessions(): Promise<never> { throw new Error('search unused') }
  override searchEvents(): Promise<never> { throw new Error('search unused') }
}

class ControlledModel extends LlmAdapter {
  override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model }) }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) resolve()
      else options.signal?.addEventListener('abort', () => { resolve() }, { once: true })
    })
    options.signal?.throwIfAborted()
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export async function conversationFixture(adapter: LlmAdapter = new ControlledModel(), execTimeoutMs?: number) {
  const f = await fixture(1000, true, execTimeoutMs ?? 1000)
  const { ctx } = f
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  ctx.llm.registerAdapter(['fixture'], adapter)
  await ctx.plugin(Commands)
  await ctx.plugin(AttachmentLocal, { dshHome: f.home })
  await ctx.plugin(FileUploads)
  await ctx.plugin(LiveQuery)
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }), saveSelection: async () => {} } as never)
  const harness = await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(SessionController, { nativeOpen: false })
  let conversationFiber = ctx.plugin(Conversation)
  await conversationFiber
  const controller = new SessionCommandController(ctx, new ApiSessionAgentController(ctx), f.home)
  async function create(account = f.alice): Promise<Agent> {
    const agent = await harness.create(SessionId(randomUUID()), { provider: 'fixture', model: 'fixture' }, { cwd: account.workspace.path })
    await account.workspace.attachSession(agent.id)
    return agent
  }
  const agent = await create()
  const prompt = (requestId: string, signal?: AbortSignal, target = agent, account = f.alice, mode: 'queue' | 'steer' = 'queue') =>
    controller.prompt({ sessionId: target.id, requestId: requestId as SessionRequestId, content: [{ type: 'text', text: requestId }], mode },
      { kind: 'user', rpcId: requestId as SessionRequestId, principal: { kind: 'user', userId: account.user.userId } }, signal)
  const inserted: UserMessage[] = []
  ctx.on('agent/inbox/inserted', ({ message }) => { inserted.push(message) }, { global: true })
  // Hold the real driver after claim but before preparing a model request.
  const entered = Promise.withResolvers<{ agent: Agent; turn: number; signal: AbortSignal }>()
  const requested = Promise.withResolvers<{ agent: Agent; turn: number; signal: AbortSignal }>()
  ctx.on('agent/request', (payload, next) => { requested.resolve(payload); return next() }, { global: true })
  let release = Promise.withResolvers<undefined>()
  ctx.on('agent/pre-step', async (payload, next) => {
    entered.resolve(payload)
    await Promise.race([release.promise, new Promise<void>((resolve) => {
      if (payload.signal.aborted) resolve()
      else payload.signal.addEventListener('abort', () => { resolve() }, { once: true })
    })])
    return next()
  }, { global: true })
  return { ...f, agent, create, controller, prompt, entered, requested, harness, inserted,
    release: () => { release.resolve(undefined) },
    hold: () => { release = Promise.withResolvers<undefined>() },
    reloadConversation: async () => {
      await conversationFiber.dispose()
      conversationFiber = ctx.plugin(Conversation)
      await conversationFiber
    },
    unloadConversation: () => conversationFiber.dispose(),
  }
}
