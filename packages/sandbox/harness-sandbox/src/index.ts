/** Authorized workspace sandbox management over the independent local Runner. */

import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService, principalOf, type UserId } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-multiuser'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { z } from 'zod'
import { RunnerConfig } from './config.ts'
import SandboxRunnerClient from './transport.ts'
import WorkspaceSandboxState, { type SandboxIdleActivity } from './lifecycle.ts'
import { RunnerRequestError, RunnerResponseError, type RunnerRunningSandbox, type RunnerClosedSandbox, type RunnerSandboxStatus } from './runner-client.ts'
import type { SandboxRequest, SandboxValue, SandboxFailureReason } from './types.ts'

export type * from './types.ts'
export type { SandboxIdleActivity, SandboxObservation } from './lifecycle.ts'
export type { RunnerRunningSandbox, RunnerClosedSandbox, RunnerSandboxStatus, SandboxContainerId } from './runner-client.ts'
export { RunnerExecutionError, RunnerRequestError, RunnerResponseError } from './runner-client.ts'
export type { default as SandboxRunnerClient } from './transport.ts'
export type { default as SandboxConversation, SandboxExecutionPermit } from './conversation.ts'

/** Original execution generation required when cleanup requests a workspace close. */
export interface SandboxCloseTarget {
  readonly containerId: import('./runner-client.ts').SandboxContainerId
  readonly version: number
}

/** Server-observed idle interval and original container, never supplied by a remote caller. */
export interface SandboxIdleCloseTarget extends SandboxCloseTarget {
  readonly revision: number
  readonly idleSince: number
}

/** Confirmed closure, or an idle condition that expired without revoking work or sending DELETE. */
export type SandboxIdleCloseResult = RunnerClosedSandbox | { readonly state: 'skipped' }

export type { RunnerCancellationResult, RunnerExecutionFailure, RunnerExecutionIdentity, RunnerExecutionRequest, RunnerExecutionResult, RunnerExecutionId } from './execution.ts'

/** Deployment-trusted Runner settings and the existing multiuser workspace root. */
export interface Config extends RunnerConfig {
  /** Absolute root shared with multiuser allocation and the independent Runner. */
  workspaceRoot: string
}

/** Validated management configuration; callers cannot override these fields. */
export const Config: Schema<Config, Required<Config>> = Schema.intersect([RunnerConfig, Schema.object({
  workspaceRoot: Schema.string().required(),
})])

const requestSchema = z.strictObject({ workspaceId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u) })
const reasons = {
  sandbox_not_ready: 'Sandbox service is starting',
  sandbox_capacity: 'Sandbox capacity is full',
  sandbox_closing: 'Sandbox is closing; query its status before opening',
  sandbox_cleanup_required: 'Sandbox cleanup must finish before opening',
  sandbox_workspace_conflict: 'Sandbox workspace configuration conflicts',
  sandbox_name_conflict: 'Sandbox ownership conflicts',
  sandbox_outcome_unknown: 'Sandbox operation outcome is unknown; query its status',
  invalid_workspace_directory: 'Workspace directory is unavailable or invalid',
  docker_unavailable: 'Sandbox engine is unavailable',
  runner_unavailable: 'Sandbox service is unavailable',
  runner_outcome_unknown: 'Sandbox operation outcome is unknown; query its status',
} satisfies Record<SandboxFailureReason, string>

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Authorized lifecycle operations; internal consumers must supply the authenticated user. */
    workspaceSandbox: WorkspaceSandbox
  }
}

/** Rechecks native ownership and directory records on every operation; owns no container state. */
export default class WorkspaceSandbox extends TypertRemoteService {
  static inject = ['multiuser', 'remoteAccess', 'typert', 'workspaceRegistry']
  static Config = Config
  private readonly root: string
  private readonly transportFiber
  private client!: SandboxRunnerClient
  private readonly deleting = new Map<WorkspaceId, Promise<boolean>>()
  private state!: WorkspaceSandboxState
  private accepting = false
  private readonly owner = Symbol('workspace-sandbox')

  /** @param ctx - Native multiuser Harness context. @param config - Trusted deployment configuration. */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'workspaceSandbox')
    const settings = Config(config)
    if (!isAbsolute(settings.workspaceRoot) || settings.workspaceRoot.includes('\0')) throw new Error('workspaceRoot must be an absolute directory')
    this.root = resolve(settings.workspaceRoot)
    this.transportFiber = ctx.plugin(SandboxRunnerClient, settings)
    ctx.workspaceRegistry.registerDeletionGuard('harness-sandbox', WorkspaceSandbox.guardDeletion)
    ctx.effect(() => async () => { await Promise.allSettled(this.deleting.values()) })
  }

  private static guardDeletion(this: void, scope: Context, workspaceId: WorkspaceId, next: () => Promise<boolean>): Promise<boolean> {
    const multiuser = scope.get('multiuser')
    if (multiuser && multiuser.ownerOfWorkspace(workspaceId) === undefined) return next()
    const manager = scope.get('workspaceSandbox')
    if (!multiuser || !manager) {
      throw new RemoteError('sandbox/failed', reasons.runner_unavailable, { reason: 'runner_unavailable', outcomeUnknown: false })
    }
    return manager.beforeDelete(workspaceId, next)
  }

  async [Service.init](): Promise<void> {
    let state = this.ctx.get('workspaceSandboxState')
    if (state === undefined) {
      await this.ctx.root.plugin(WorkspaceSandboxState)
      state = this.ctx.get('workspaceSandboxState')
    }
    if (state === undefined) throw new Error('Workspace sandbox state did not load')
    this.state = state
    await this.transportFiber
    const client = this.ctx.get('sandboxRunnerClient')
    if (!client) throw new Error('Sandbox Runner transport did not load')
    this.client = client
    this.state.attach(this.owner)
    this.accepting = true
    this.ctx.effect(() => () => {
      this.accepting = false
      this.state.detach(this.owner)
    })
  }

  /**
   * Open an owned workspace through the independent Runner.
   * @param request - Only the native workspace identity.
   * @returns Browser-safe confirmed running state.
   */
  @Remote({ resources: { workspace: (request: SandboxRequest) => request.workspaceId } })
  async open(request: SandboxRequest): Promise<SandboxValue> {
    const id = this.parse(request)
    const result = await this.openForUser(this.caller('open'), id)
    return { workspaceId: id, state: result.state }
  }

  /**
   * Observe an owned workspace without modifying its sandbox.
   * @param request - Only the native workspace identity.
   * @returns This query's browser-safe observation.
   */
  @Remote({ resources: { workspace: (request: SandboxRequest) => request.workspaceId } })
  async status(request: SandboxRequest): Promise<SandboxValue> {
    const id = this.parse(request)
    const result = await this.statusForUser(this.caller('status'), id)
    return { workspaceId: id, state: result.state }
  }

  /**
   * Remove an owned workspace's container while retaining its persistent data.
   * @param request - Only the native workspace identity.
   * @returns Closed only after Runner confirmation.
   */
  @Remote({ resources: { workspace: (request: SandboxRequest) => request.workspaceId } })
  async close(request: SandboxRequest): Promise<SandboxValue> {
    const id = this.parse(request)
    const result = await this.closeForUser(this.caller('close'), id)
    return { workspaceId: id, state: result.state }
  }

  /**
   * Open a sandbox for an authenticated backend initiator.
   * @param userId - Authenticated user from the initiating operation.
   * @param workspaceId - Native workspace id.
   * @returns Full running identity for trusted execution integration.
   */
  async openForUser(userId: UserId, workspaceId: WorkspaceId): Promise<RunnerRunningSandbox> {
    this.authorize(userId, workspaceId, 'open')
    this.available()
    return this.state.open(workspaceId, epoch => this.runner(async () => {
      this.state.check(workspaceId, epoch)
      const path = await this.directory(workspaceId)
      this.authorize(userId, workspaceId, 'open')
      this.available()
      this.state.check(workspaceId, epoch)
      return this.client.open(workspaceId, path)
    }))
  }

  /**
   * Observe a sandbox for an authenticated backend initiator.
   * @param userId - Authenticated initiating user.
   * @param workspaceId - Native workspace id.
   * @param signal - Optional observer lifetime; abort suppresses history updates without cancelling the bounded query.
   * Omitted queries record normally.
   * @returns Local closing barrier, or fresh Runner state with internal container identity.
   */
  async statusForUser(userId: UserId, workspaceId: WorkspaceId, signal?: AbortSignal): Promise<RunnerSandboxStatus> {
    this.authorize(userId, workspaceId, 'status')
    this.available()
    if (this.state.closing(workspaceId)) return Promise.resolve({ state: 'closing' })
    return this.state.query(workspaceId, async () => {
      const result = await this.runner(() => this.client.status(workspaceId))
      this.authorize(userId, workspaceId, 'status')
      this.available()
      return result
    }, signal)
  }

  /**
   * Inspect local work before an authorized idle-reclamation decision; does not query Runner or close anything.
   * @param userId - Authenticated initiating user.
   * @param workspaceId - Native workspace id.
   * @returns Work counts, activity revision, monotonic idle start and reliable container observation; unavailable management throws.
   */
  activityForUser(userId: UserId, workspaceId: WorkspaceId): SandboxIdleActivity {
    this.authorize(userId, workspaceId, 'status')
    this.available()
    return this.state.activity(workspaceId)
  }

  /**
   * Query the original container and synchronously admit closure only while the observed interval is still idle.
   * @param userId - Authenticated backend owner; native authorization failures are preserved.
   * @param workspaceId - Native workspace id.
   * @param target - Original running identity, close version, activity revision and non-null idle start.
   * @param idleTimeoutMs - Positive idle threshold from validated deployment configuration.
   * @param signal - Scan lifetime, synchronously aborted on unload; does not cancel an already admitted close.
   * @returns Skipped without revocation or DELETE, or confirmed closure; management and Runner failures reject.
   */
  async closeIfIdleForUser(
    userId: UserId, workspaceId: WorkspaceId, target: SandboxIdleCloseTarget,
    idleTimeoutMs: number, signal: AbortSignal,
  ): Promise<SandboxIdleCloseResult> {
    this.available()
    this.authorize(userId, workspaceId, 'close')
    if (!this.matchesIdle(workspaceId, target, idleTimeoutMs, signal)) return { state: 'skipped' }
    const observed = await this.statusForUser(userId, workspaceId, signal)
    this.available()
    this.authorize(userId, workspaceId, 'close')
    if (observed.state !== 'running' || observed.containerId !== target.containerId
      || !this.matchesIdle(workspaceId, target, idleTimeoutMs, signal)) return { state: 'skipped' }
    return this.closeForUser(userId, workspaceId, target)
  }

  /**
   * Ends all commands in this container without deleting workspace files or sessions.
   * @param userId - Authenticated initiating user.
   * @param workspaceId - Native workspace id.
   * @param target - Optional original execution generation; stale cleanup cannot close a newer generation.
   * @returns Confirmed container absence.
   */
  async closeForUser(userId: UserId, workspaceId: WorkspaceId, target?: SandboxCloseTarget): Promise<RunnerClosedSandbox> {
    this.authorize(userId, workspaceId, 'close')
    this.available()
    if (target !== undefined && this.state.capture(workspaceId).version !== target.version) {
      throw new RemoteError('gateway/cancelled', 'Original sandbox generation was revoked', {})
    }
    return this.state.close(workspaceId, async () => {
      this.available()
      if (target !== undefined) {
        const current = await this.runner(() => this.client.status(workspaceId))
        if (current.state === 'closed') return current
        if (current.state !== 'running' || current.containerId !== target.containerId) {
          throw new RemoteError('sandbox/failed', 'Original sandbox generation is unavailable', {
            reason: 'sandbox_workspace_conflict', outcomeUnknown: false,
          })
        }
      }
      return this.runner(() => this.client.close(workspaceId))
    })
  }

  private parse(request: SandboxRequest): WorkspaceId {
    const parsed = requestSchema.safeParse(request)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', 'Expected only a valid workspaceId', {})
    return WorkspaceId(parsed.data.workspaceId)
  }

  private matchesIdle(id: WorkspaceId, target: SandboxIdleCloseTarget, idleTimeoutMs: number, signal: AbortSignal): boolean {
    const current = this.state.activity(id)
    return !signal.aborted && !current.busy && current.sandbox.state === 'running'
      && current.sandbox.containerId === target.containerId && current.version === target.version
      && current.revision === target.revision && current.idleSince === target.idleSince
      && performance.now() - target.idleSince >= idleTimeoutMs
  }

  private caller(operation: string): UserId {
    const principal = principalOf(this.ctx.invocation)
    if (principal?.kind !== 'user') this.denied(operation)
    return principal.userId
  }

  private denied(operation: string): never {
    throw new RemoteError('remote-access/denied', 'Workspace is unavailable', { action: `workspaceSandbox/${operation}`, reason: 'not-found' })
  }

  private authorize(userId: UserId, workspaceId: WorkspaceId, operation: string): void {
    if (operation === 'open' && this.deleting.has(workspaceId)) this.denied(operation)
    if (!this.ctx.multiuser.ownsWorkspace(userId, workspaceId)) this.denied(operation)
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace?.id !== workspaceId) this.denied(operation)
  }

  private async directory(workspaceId: WorkspaceId): Promise<string> {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (!workspace) this.denied('open')
    try {
      const root = await realpath(this.root)
      const info = await lstat(workspace.path)
      const path = await realpath(workspace.path)
      if (!info.isDirectory() || info.isSymbolicLink() || dirname(path) !== root || path !== workspace.path) {
        throw new Error('Invalid workspace directory')
      }
      return path
    } catch {
      throw new RemoteError('sandbox/failed', reasons.invalid_workspace_directory, {
        reason: 'invalid_workspace_directory', outcomeUnknown: false,
      })
    }
  }

  private beforeDelete(workspaceId: WorkspaceId, next: () => Promise<boolean>): Promise<boolean> {
    if (this.ctx.multiuser.ownerOfWorkspace(workspaceId) === undefined) return next()
    const deletion = Promise.resolve().then(async () => {
      this.available()
      const blocked = this.state.deletionBlock(workspaceId)
      if (blocked !== undefined) this.activeSandbox(workspaceId, blocked)
      const result = await this.runner(() => this.client.status(workspaceId))
      if (result.state !== 'closed') this.activeSandbox(workspaceId, result.state)
      const changed = this.state.deletionBlock(workspaceId)
      if (changed !== undefined) this.activeSandbox(workspaceId, changed)
      return next()
    }).finally(() => { this.deleting.delete(workspaceId) })
    this.deleting.set(workspaceId, deletion)
    return deletion
  }

  private activeSandbox(workspaceId: WorkspaceId, state: Exclude<SandboxValue['state'], 'closed'>): never {
    throw new RemoteError('workspace/sandbox-active', 'Close the workspace sandbox before deleting the workspace', { workspaceId, state })
  }

  private available(): void {
    if (!this.accepting || !this.state.current(this.owner)) {
      throw new RemoteError('sandbox/failed', reasons.runner_unavailable, { reason: 'runner_unavailable', outcomeUnknown: false })
    }
  }

  private async runner<T>(invoke: () => Promise<T>): Promise<T> {
    try {
      return await invoke()
    } catch (error) {
      if (!(error instanceof RunnerRequestError || error instanceof RunnerResponseError)) throw error
      const reason: SandboxFailureReason = Object.hasOwn(reasons, error.code)
        ? error.code as SandboxFailureReason
        : error instanceof RunnerResponseError && error.outcomeUnknown ? 'runner_outcome_unknown' : 'runner_unavailable'
      const outcomeUnknown = error instanceof RunnerRequestError ? error.code === 'runner_outcome_unknown' : error.outcomeUnknown
      throw new RemoteError('sandbox/failed', reasons[reason], { reason, outcomeUnknown })
    }
  }
}
