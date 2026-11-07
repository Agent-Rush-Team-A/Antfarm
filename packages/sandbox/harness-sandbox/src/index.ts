/** Authorized workspace lifecycle with a deployment-selected execution backend. */

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
import type { SandboxExecutionBackend, SandboxExecutionAdmission } from './backend.ts'
import type { WorkspaceFileScope } from '@deepseek-ai/dsh-fs/workspace-access'
import type { SandboxExecutionPermit } from './conversation.ts'
import WorkspaceSandboxState, { type SandboxIdleActivity } from './lifecycle.ts'
import { RunnerRequestError, RunnerResponseError, type RunnerRunningSandbox, type RunnerClosedSandbox, type RunnerSandboxStatus } from './runner-client.ts'
import type { SandboxRequest, SandboxValue, SandboxFailureReason } from './types.ts'

export type * from './types.ts'
export type { SandboxIdleActivity, SandboxObservation } from './lifecycle.ts'
export type { RunnerRunningSandbox, RunnerClosedSandbox, RunnerSandboxStatus, SandboxContainerId } from './runner-client.ts'
export { RunnerExecutionError, RunnerRequestError, RunnerResponseError } from './runner-client.ts'
export type { default as SandboxRunnerClient } from './transport.ts'
export { SandboxExecutionBackend } from './backend.ts'
export type { WorkspaceRuntimeFiles } from './backend.ts'
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

/** Registered project root and deployment-selected local Runner or separately loaded backend. */
export type Config = {
  /** Absolute registered project root shared with multiuser allocation. Remote execution paths are supplied by the backend. */
  workspaceRoot: string
} & ((RunnerConfig & {
  /** Construct and own the independent local Runner transport. */
  backend?: 'runner'
}) | {
  /** Use a separately loaded sandboxRunnerClient; the Loader row injects that service before management. */
  backend: 'provided'
})

/** Validated management configuration; callers cannot override these fields. */
export const Config: Schema<Config> = Schema.intersect([Schema.union([
  Schema.intersect([RunnerConfig, Schema.object({ backend: Schema.const('runner').default('runner') })]),
  Schema.object({ backend: Schema.const('provided').required() }),
]), Schema.object({
  workspaceRoot: Schema.string().required(),
})])

const requestSchema = z.strictObject({ workspaceId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u) })
const reasons = {
  cloud_open_failed: 'Cloud workspace could not start; query status before recovery',
  cloud_save_failed: 'Cloud workspace could not finish saving; the original disk is retained until preservation is confirmed',
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
  private client!: SandboxExecutionBackend
  private readonly deleting = new Map<WorkspaceId, Promise<boolean>>()
  private state!: WorkspaceSandboxState
  private accepting = false
  private readonly owner = Symbol('workspace-sandbox')

  /**
   * @param ctx - Native multiuser Harness context.
   * @param config - Trusted deployment configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'workspaceSandbox')
    const settings = Config(config)
    if (!isAbsolute(settings.workspaceRoot)
      || settings.workspaceRoot.includes('\0')) throw new Error('workspaceRoot must be an absolute directory')
    this.root = resolve(settings.workspaceRoot)
    this.transportFiber = settings.backend === 'provided' ? undefined : ctx.plugin(SandboxRunnerClient, settings)
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
    const progress = this.client.progress(id)
    return { workspaceId: id, state: result.state, ...progress === undefined ? {} : { progress } }
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
    const progress = this.client.progress(id)
    return { workspaceId: id, state: result.state, ...progress === undefined ? {} : { progress } }
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
    const progress = this.client.progress(id)
    return { workspaceId: id, state: result.state, ...progress === undefined ? {} : { progress } }
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
    if (this.state.closing(workspaceId)) throw new RemoteError('sandbox/failed', reasons.sandbox_closing,
      { reason: 'sandbox_closing', outcomeUnknown: false })
    const resources = await this.reserveForUser(userId, workspaceId, new AbortController().signal)
    try { this.manual(resources); return await resources.ready() }
    finally { await resources.release() }
  }

  /**
   * Count task preparation before allocating an environment and retain its original backend.
   * @param userId - Authenticated initiating user.
   * @param workspaceId - Original native workspace.
   * @param signal - Message permit lifetime, detached from HTTP cancellation after inbox insertion.
   * @param check - Optional original-session authority check; omitted for workspace-only operations.
   * @returns A lazy reservation; release after failed preparation or complete input/resource settlement.
   */
  async reserveForUser(userId: UserId, workspaceId: WorkspaceId,
    signal: AbortSignal, check?: () => void): Promise<SandboxExecutionAdmission> {
    const epoch = this.state.capture(workspaceId)
    const scope = this.scopeForUser(userId, workspaceId, 'open', AbortSignal.any([signal, epoch.signal]),
      () => { this.state.check(workspaceId, epoch); check?.() })
    const resources = await this.runner(() => Promise.resolve(this.client.admit(scope)))
    try { resources.scope.admit() }
    catch (error) { await resources.release(); throw error }
    return { ...resources, ready: () => this.state.open(workspaceId, epoch => this.runner(async () => {
      resources.scope.admit()
      this.state.check(workspaceId, epoch)
      const path = await this.directory(workspaceId)
      resources.scope.admit()
      this.state.check(workspaceId, epoch)
      if (path !== scope.project) throw new RemoteError('gateway/cancelled', 'Workspace registration changed', {})
      return resources.ready()
    })) }
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
    const barrier = this.client.barrier(workspaceId)
    if (barrier !== undefined) return barrier
    return this.withAdmission(userId, workspaceId, 'status', async resources => this.state.query(workspaceId, async () => {
      resources.scope.admit()
      const result = await this.runner(() => resources.backend.status(workspaceId))
      resources.scope.admit()
      return result
    }, signal), signal)
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
    return this.activity(workspaceId)
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
    return this.withAdmission(userId, workspaceId, 'close', async (resources) => {
      if (resources.taskManaged) return { state: 'skipped' as const }
      const observed = await this.state.query(workspaceId, () => this.runner(() => resources.backend.status(workspaceId)), signal)
      resources.scope.admit()
      if (observed.state !== 'running' || observed.containerId !== target.containerId
        || !this.matchesIdle(workspaceId, target, idleTimeoutMs, signal)) return { state: 'skipped' as const }
      return this.closeSelected(userId, workspaceId, resources.backend, target)
    }, signal)
  }

  /**
   * Ends all commands in this container without deleting workspace files or sessions.
   * @param userId - Authenticated initiating user.
   * @param workspaceId - Native workspace id.
   * @param target - Optional original execution generation; stale cleanup cannot close a newer generation.
   * @returns Confirmed container absence.
   */
  async closeForUser(userId: UserId, workspaceId: WorkspaceId, target?: SandboxCloseTarget): Promise<RunnerClosedSandbox> {
    return this.withAdmission(userId, workspaceId, 'close', (resources) => {
      if (target === undefined) this.manual(resources)
      return this.closeSelected(userId, workspaceId, resources.backend, target)
    })
  }

  /**
   * Close uncertain work through its retained backend without reacquiring mode admission.
   * @param permit - Original authenticated turn and execution generation.
   * @returns Confirmed closure; stale generations refuse before deleting a replacement.
   */
  async closeForExecution(permit: SandboxExecutionPermit): Promise<RunnerClosedSandbox> {
    this.authorize(permit.userId, permit.workspaceId, 'close')
    this.available()
    const current = await this.runner(() => permit.resources.backend.status(permit.workspaceId))
    this.authorize(permit.userId, permit.workspaceId, 'close')
    this.available()
    if (this.state.capture(permit.workspaceId).version !== permit.version) {
      throw new RemoteError('gateway/cancelled', 'Original sandbox generation was revoked', {})
    }
    if (current.state === 'closed') return current
    if (current.state !== 'running' || current.containerId !== permit.containerId) {
      throw new RemoteError('gateway/cancelled', 'Original sandbox generation was replaced', {})
    }
    return this.closeSelected(permit.userId, permit.workspaceId, permit.resources.backend,
      { containerId: permit.containerId, version: permit.version })
  }

  private closeSelected(userId: UserId, workspaceId: WorkspaceId,
    backend: SandboxExecutionAdmission['backend'], target?: SandboxCloseTarget): Promise<RunnerClosedSandbox> {
    this.authorize(userId, workspaceId, 'close')
    this.available()
    if (target !== undefined && this.state.capture(workspaceId).version !== target.version) {
      throw new RemoteError('gateway/cancelled', 'Original sandbox generation was revoked', {})
    }
    return this.state.close(workspaceId, async () => {
      this.available()
      if (target !== undefined) {
        const current = await this.runner(() => backend.status(workspaceId))
        if (current.state === 'closed') return current
        if (current.state !== 'running' || current.containerId !== target.containerId) {
          throw new RemoteError('sandbox/failed', 'Original sandbox generation is unavailable', {
            reason: 'sandbox_workspace_conflict', outcomeUnknown: false,
          })
        }
      }
      return this.runner(() => backend.close(workspaceId))
    })
  }

  private manual(resources: SandboxExecutionAdmission): void {
    if (resources.taskManaged) throw new RemoteError('sandbox/manual-operation-forbidden',
      'This workspace starts and destroys its sandbox automatically when tasks run', { workspaceId: resources.scope.workspaceId })
  }

  private scopeForUser(userId: UserId, workspaceId: WorkspaceId, operation: string,
    signal: AbortSignal, check?: () => void): WorkspaceFileScope {
    this.authorize(userId, workspaceId, operation)
    this.available()
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) this.denied(operation)
    const project = workspace.path
    const admit = () => {
      check?.()
      signal.throwIfAborted()
      this.authorize(userId, workspaceId, operation)
      this.available()
      if (this.ctx.workspaceRegistry.get(workspaceId)?.path !== project) this.denied(operation)
    }
    admit()
    return { workspaceId, project, signal, admit }
  }

  private withAdmission<T>(userId: UserId, workspaceId: WorkspaceId, operation: string,
    run: (resources: SandboxExecutionAdmission) => Promise<T>, signal = new AbortController().signal): Promise<T> {
    return this.runner(() => {
      const use = async (resources: SandboxExecutionAdmission): Promise<T> => {
        try { resources.scope.admit(); return await run(resources) }
        finally { await resources.release() }
      }
      const resources = this.client.admit(this.scopeForUser(userId, workspaceId, operation, signal))
      return resources instanceof Promise ? resources.then(use) : use(resources)
    })
  }

  private parse(request: SandboxRequest): WorkspaceId {
    const parsed = requestSchema.safeParse(request)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', 'Expected only a valid workspaceId', {})
    return WorkspaceId(parsed.data.workspaceId)
  }

  private matchesIdle(id: WorkspaceId, target: SandboxIdleCloseTarget, idleTimeoutMs: number, signal: AbortSignal): boolean {
    const current = this.activity(id)
    return !signal.aborted && !current.busy && current.sandbox.state === 'running'
      && current.sandbox.containerId === target.containerId && current.version === target.version
      && current.revision === target.revision && current.idleSince === target.idleSince
      && performance.now() - target.idleSince >= idleTimeoutMs
  }

  private activity(id: WorkspaceId): SandboxIdleActivity {
    let local = this.state.activity(id)
    const provider = this.client.activity(id)
    if (provider === undefined) return local
    if (provider.openings > 0 || provider.executions > 0 || provider.closing) {
      // Preparation can outlive its caller; a later running query must start a fresh idle interval.
      this.state.invalidateObservation(id, local.revision)
      local = this.state.activity(id)
    }
    const openings = local.openings + provider.openings
    const executions = local.executions + provider.executions
    const closing = local.closing || provider.closing
    return { ...local, openings, executions, closing,
      busy: local.requests > 0 || openings > 0 || executions > 0 || closing }
  }

  private caller(operation: string): UserId {
    const principal = principalOf(this.ctx.invocation)
    if (principal?.kind !== 'user') this.denied(operation)
    return principal.userId
  }

  private denied(operation: string): never {
    throw new RemoteError('remote-access/denied', 'Workspace is unavailable',
      { action: `workspaceSandbox/${operation}`, reason: 'not-found' })
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
