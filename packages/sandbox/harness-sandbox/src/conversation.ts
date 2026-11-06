/** Native authenticated prompt preparation and message-bound sandbox execution permission. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionPromptAdmission } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionPromptValue, SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { RemoteError, type UserId } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-api-multiuser'
import type {} from './index.ts'
import type { SandboxPermit } from './permits.ts'
import type { SandboxContainerId } from './runner-client.ts'

/** Trusted original message and container for one active turn; callers cannot select another generation. */
export interface SandboxExecutionPermit {
  readonly userId: UserId
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly requestId: SessionRequestId
  readonly messageId: UserMessage['id']
  readonly containerId: SandboxContainerId
  readonly version: number
  readonly signal: AbortSignal
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Native message admission and original-turn execution permission. */
    sandboxConversation: SandboxConversation
  }
}

/** Prepares owned workspaces before accepting messages; contributes no model tools. */
export default class SandboxConversation extends Service {
  static inject = ['agents', 'multiuser', 'sessionController', 'workspaceRegistry', 'workspaceSandboxState']
  private stopping = false
  private readonly owner = Symbol('sandbox-conversation')

  /** @param ctx - Native multiuser conversation services and application-owned sandbox barriers. */
  constructor(ctx: Context) {
    super(ctx, 'sandboxConversation')
    const state = ctx.workspaceSandboxState
    ctx.on('session/prompt-admission', (admission, next) => this.admit(admission, next))
    ctx.on('agent/inbox/inserted', ({ agent, message }) => { state.permits.inserted(agent, message) }, { global: true })
    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => { state.permits.claimed(agent, message, turn) }, { global: true })
    ctx.on('agent/inbox/discarded', ({ agent, message }) => { state.permits.discarded(agent, message) }, { global: true })
    ctx.on('agent/disposed', ({ agent }) => { state.permits.disposeAgent(agent) }, { global: true })
    ctx.on('agent/created', ({ agent }) => {
      if (this.managed(agent.id)) agent.cancel({ kind: 'hook', reason: 'sandbox-input-not-resumed' })
      return undefined
    }, { global: true })
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      const agent = ctx.agents.get(session.header.id)
      if (agent?.session === session) state.permits.finish(agent, event.data.turn)
    }, { global: true })
    for (const agent of ctx.agents.list()) if (this.managed(agent.id)) {
      agent.cancel({ kind: 'hook', reason: 'sandbox-input-not-resumed' })
    }
    ctx.effect(() => async () => {
      this.stopping = true
      await state.permits.revokeOwner(this.owner)
    })
  }

  /**
   * Resolve permission for the actual owning turn, rechecking current native ownership.
   * @param agent - Exact Agent executing the original turn.
   * @param turn - Captured original turn; never a latest-message lookup.
   * @returns Original message, generation and cancellation signal; no sandbox is opened here.
   */
  forTurn(agent: Agent, turn: number): SandboxExecutionPermit {
    const permit = this.ctx.workspaceSandboxState.permits.forTurn(agent, turn)
    this.check(permit)
    if (permit.agent !== agent || permit.messageId === undefined || permit.containerId === undefined) {
      throw new RemoteError('gateway/cancelled', 'Sandbox execution permission is unavailable', {})
    }
    return {
      userId: permit.userId, workspaceId: permit.workspaceId, sessionId: permit.sessionId,
      requestId: permit.requestId, messageId: permit.messageId, containerId: permit.containerId,
      version: permit.epoch.version, signal: AbortSignal.any([permit.controller.signal, permit.epoch.signal]),
    }
  }

  private admit(admission: SessionPromptAdmission, next: () => Promise<SessionPromptValue>): Promise<SessionPromptValue> {
    const principal = admission.source.kind === 'user' && 'principal' in admission.source ? admission.source.principal : undefined
    if (principal?.kind !== 'user') this.denied()
    const sessionId = admission.request.sessionId
    const workspace = this.ctx.workspaceRegistry.list().find(candidate => candidate.sessionIds.includes(sessionId))
    if (workspace === undefined) this.denied()
    this.authorize(principal.userId, workspace.id, sessionId)
    const state = this.ctx.workspaceSandboxState
    return state.permits.admit({
      userId: principal.userId, workspaceId: workspace.id, sessionId,
      requestId: admission.request.requestId, epoch: state.capture(workspace.id), owner: this.owner,
    }, admission.signal, async (permit) => {
      this.check(permit)
      admission.prepare(async (agent) => {
        this.check(permit)
        permit.agent = agent
        const manager = this.ctx.get('workspaceSandbox')
        if (manager === undefined) throw new RemoteError('sandbox/failed', 'Sandbox management is unavailable', { reason: 'runner_unavailable', outcomeUnknown: false })
        const running = await manager.openForUser(permit.userId, permit.workspaceId)
        this.check(permit)
        permit.containerId = running.containerId
      })
      admission.beforeEnqueue((agent, message) => {
        this.check(permit)
        state.permits.bind(permit, agent, message)
        return undefined
      })
      return next()
    })
  }

  private check(permit: SandboxPermit): void {
    if (this.stopping) throw new RemoteError('gateway/cancelled', 'Sandbox conversation is unloading', {})
    this.authorize(permit.userId, permit.workspaceId, permit.sessionId)
    this.ctx.workspaceSandboxState.permits.check(permit)
    this.ctx.workspaceSandboxState.check(permit.workspaceId, permit.epoch)
  }

  private authorize(userId: UserId, workspaceId: WorkspaceId, sessionId: SessionId): void {
    if (!this.ctx.multiuser.ownsSession(userId, sessionId) || !this.ctx.multiuser.ownsWorkspace(userId, workspaceId)
      || !this.ctx.workspaceRegistry.get(workspaceId)?.sessionIds.includes(sessionId)) this.denied()
  }

  private managed(sessionId: SessionId): boolean {
    return this.ctx.workspaceRegistry.list().some(workspace => workspace.sessionIds.includes(sessionId)
      && this.ctx.multiuser.ownerOfWorkspace(workspace.id) !== undefined)
  }

  private denied(): never {
    throw new RemoteError('remote-access/denied', 'Session is unavailable', { action: 'session/prompt', reason: 'not-found' })
  }
}
