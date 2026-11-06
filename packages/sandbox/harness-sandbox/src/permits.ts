/** Message-specific execution permits and cancellation receipts for one Harness process. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import type { SessionPromptValue, SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { RemoteError, remoteErrorOf, type UserId } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { SandboxContainerId } from './runner-client.ts'
import type { SandboxEpoch } from './lifecycle.ts'

/** Original trusted identities and generation for exactly one admitted message. */
export interface SandboxPermit {
  readonly userId: UserId
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly requestId: SessionRequestId
  readonly epoch: SandboxEpoch
  readonly controller: AbortController
  readonly owner: symbol
  readonly result: Promise<SessionPromptValue>
  agent?: Agent
  messageId?: UserMessage['id']
  containerId?: SandboxContainerId
  accepted: boolean
  revoked: boolean
  released: boolean
  stopCaller: () => void
}

/** Owns active permits separately from cancelled, never-admitted request IDs. */
export class SandboxPermits {
  private readonly requests = new Map<SessionId, Map<SessionRequestId, SandboxPermit>>()
  private readonly cancelled = new Map<SessionId, Set<SessionRequestId>>()
  private readonly turns = new WeakMap<Agent, Map<number, SandboxPermit[]>>()

  /**
   * Count outstanding admissions and accepted input through turn settlement, including revoked work still draining.
   * @param id - Workspace whose original input is inspected.
   * @returns Outstanding request count across preparation, inbox and model/tool work.
   */
  active(id: WorkspaceId): number {
    let count = 0
    for (const requests of this.requests.values()) for (const permit of requests.values()) {
      if (permit.workspaceId === id) count++
    }
    return count
  }

  /**
   * Register before preparation, sharing the original in-flight operation for duplicate IDs.
   * @param input - Trusted identities, owner and captured workspace generation.
   * @param caller - Original caller lifetime, ignored after inbox insertion.
   * @param run - The complete admission attempt.
   * @returns The existing or newly registered admission result.
   */
  admit(
    input: Pick<SandboxPermit, 'userId' | 'workspaceId' | 'sessionId' | 'requestId' | 'epoch' | 'owner'>,
    caller: AbortSignal,
    run: (permit: SandboxPermit) => Promise<SessionPromptValue>,
  ): Promise<SessionPromptValue> {
    if (this.cancelled.get(input.sessionId)?.has(input.requestId)) return Promise.reject(this.revoked())
    const existing = this.requests.get(input.sessionId)?.get(input.requestId)
    if (existing !== undefined) return existing.result
    const permit: SandboxPermit = {
      ...input, controller: new AbortController(), accepted: false, revoked: false, released: false,
      stopCaller: () => { caller.removeEventListener('abort', disconnected) },
      result: Promise.resolve().then(() => run(permit)).catch((error: unknown) => {
        if (remoteErrorOf(error)?.code === 'gateway/cancelled') this.cancel(permit)
        throw error
      }).finally(() => {
        if (!permit.accepted || permit.revoked) this.release(permit)
      }),
    }
    const disconnected = () => { if (!permit.accepted) this.cancel(permit) }
    const requests = this.requests.get(input.sessionId) ?? new Map<SessionRequestId, SandboxPermit>()
    requests.set(input.requestId, permit)
    this.requests.set(input.sessionId, requests)
    caller.addEventListener('abort', disconnected, { once: true })
    if (caller.aborted) disconnected()
    return permit.result
  }

  /**
   * Bind the final message before its synchronous insertion.
   * @param permit - Original message permit.
   * @param agent - Exact recovered Agent.
   * @param message - Message about to enter its inbox.
   */
  bind(permit: SandboxPermit, agent: Agent, message: UserMessage): void {
    this.check(permit)
    permit.agent = agent
    permit.messageId = message.id
  }

  /**
   * Detach caller cancellation at durable inbox acceptance.
   * @param agent - Inbox owner.
   * @param message - Durably inserted message.
   */
  inserted(agent: Agent, message: UserMessage): void {
    const permit = this.messagePermit(agent, message)
    if (permit === undefined || permit.revoked) return
    permit.accepted = true
    permit.stopCaller()
  }

  /**
   * Associate a claimed input with its actual execution turn.
   * @param agent - Exact Agent claiming input.
   * @param message - Original input.
   * @param turn - Its owning turn.
   */
  claimed(agent: Agent, message: UserMessage, turn: number): void {
    const permit = this.messagePermit(agent, message)
    if (permit === undefined || permit.revoked) return
    const turns = this.turns.get(agent) ?? new Map<number, SandboxPermit[]>()
    const permits = turns.get(turn) ?? []
    if (!permits.includes(permit)) permits.push(permit)
    turns.set(turn, permits)
    this.turns.set(agent, turns)
  }

  /**
   * Resolve the original input permission without consulting newer queued input.
   * @param agent - Requesting Agent.
   * @param turn - Original turn.
   * @returns Its original valid permit, or throws when unavailable.
   */
  forTurn(agent: Agent, turn: number): SandboxPermit {
    const permit = this.turns.get(agent)?.get(turn)?.[0]
    if (permit === undefined) throw this.revoked()
    this.check(permit)
    return permit
  }

  /**
   * Release permissions owned by a settled turn.
   * @param agent - Owning Agent.
   * @param turn - Settled turn only.
   */
  finish(agent: Agent, turn: number): void {
    const permits = this.turns.get(agent)?.get(turn) ?? []
    this.turns.get(agent)?.delete(turn)
    for (const permit of permits) this.release(permit)
  }

  /**
   * Revoke disposed input so a replacement Agent cannot inherit its permissions.
   * @param agent - Exact disposed Agent.
   */
  disposeAgent(agent: Agent): void {
    for (const permits of this.requests.values()) for (const permit of permits.values()) {
      if (permit.agent === agent) { this.cancel(permit); this.release(permit) }
    }
    this.turns.delete(agent)
  }

  /**
   * Revoke input removed before claim.
   * @param agent - Inbox owner.
   * @param message - Discarded pending input.
   */
  discarded(agent: Agent, message: UserMessage): void {
    const permit = this.messagePermit(agent, message)
    if (permit !== undefined) { this.cancel(permit); this.release(permit) }
  }

  /**
   * Cancel every earlier request in a closing workspace.
   * @param id - Workspace whose work is revoked.
   */
  revokeWorkspace(id: WorkspaceId): void {
    for (const permits of this.requests.values()) for (const permit of permits.values()) {
      if (permit.workspaceId === id) this.cancel(permit)
    }
  }

  /**
   * Cancel and release provider-owned input before its listeners disappear.
   * @param owner - Unloading conversation provider's token.
   * @returns Settlement of its already-started admission callbacks.
   */
  async revokeOwner(owner: symbol): Promise<void> {
    const owned: SandboxPermit[] = []
    const agents = new Set<Agent>()
    for (const permits of this.requests.values()) for (const permit of permits.values()) {
      if (permit.owner !== owner) continue
      this.cancel(permit)
      owned.push(permit)
      if (permit.agent !== undefined) agents.add(permit.agent)
    }
    for (const agent of agents) agent.cancel({ kind: 'hook', reason: 'sandbox-conversation-unloaded' })
    await Promise.allSettled(owned.map(permit => permit.result))
    for (const permit of owned) this.release(permit)
  }

  /**
   * Reject permanently revoked or released permission.
   * @param permit - Original message permit.
   */
  check(permit: SandboxPermit): void {
    if (permit.released || permit.revoked || permit.controller.signal.aborted || permit.epoch.signal.aborted || permit.epoch.blocked) {
      throw this.revoked()
    }
  }

  /** Revoke in-memory work when the application ends; no execution is reconstructed on reload. */
  dispose(): void {
    for (const permits of this.requests.values()) for (const permit of permits.values()) this.cancel(permit)
    this.requests.clear()
    this.cancelled.clear()
  }

  private messagePermit(agent: Agent, message: UserMessage): SandboxPermit | undefined {
    const source = message.source
    if (source.kind !== 'user' || !('rpcId' in source)) return undefined
    const permit = this.requests.get(agent.id)?.get(source.rpcId)
    return permit?.agent === agent && permit.messageId === message.id ? permit : undefined
  }

  private cancel(permit: SandboxPermit): void {
    if (permit.revoked) return
    permit.revoked = true
    permit.controller.abort()
    permit.stopCaller()
    if (!permit.accepted) {
      const cancelled = this.cancelled.get(permit.sessionId) ?? new Set<SessionRequestId>()
      cancelled.add(permit.requestId)
      this.cancelled.set(permit.sessionId, cancelled)
    }
  }

  private release(permit: SandboxPermit): void {
    permit.released = true
    permit.controller.abort()
    permit.stopCaller()
    const requests = this.requests.get(permit.sessionId)
    if (requests?.get(permit.requestId) === permit) requests.delete(permit.requestId)
    delete permit.agent
  }

  private revoked(): RemoteError<'gateway/cancelled'> {
    return new RemoteError('gateway/cancelled', 'Workspace sandbox request was revoked', {})
  }
}
