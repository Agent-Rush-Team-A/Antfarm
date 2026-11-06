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
import { RunnerRequestError, RunnerResponseError, type RunnerRunningSandbox, type RunnerClosedSandbox, type RunnerSandboxStatus } from './runner-client.ts'
import type { SandboxRequest, SandboxValue, SandboxFailureReason } from './types.ts'

export type * from './types.ts'
export type { RunnerRunningSandbox, RunnerClosedSandbox, RunnerSandboxStatus, SandboxContainerId } from './runner-client.ts'

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
  private readonly opening = new Set<{ readonly workspaceId: WorkspaceId }>()

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
    await this.transportFiber
    const client = this.ctx.get('sandboxRunnerClient')
    if (!client) throw new Error('Sandbox Runner transport did not load')
    this.client = client
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
    const request = { workspaceId }
    this.opening.add(request)
    try {
      return await this.runner(async () => {
        const path = await this.directory(workspaceId)
        this.authorize(userId, workspaceId, 'open')
        return this.client.open(workspaceId, path)
      })
    } finally {
      this.opening.delete(request)
    }
  }

  /**
   * Observe a sandbox for an authenticated backend initiator.
   * @param userId - Authenticated initiating user.
   * @param workspaceId - Native workspace id.
   * @returns Fresh Runner state with internal container identity.
   */
  statusForUser(userId: UserId, workspaceId: WorkspaceId): Promise<RunnerSandboxStatus> {
    return this.perform(userId, workspaceId, 'status', () => this.client.status(workspaceId))
  }

  /**
   * Ends all commands in this container without deleting workspace files or sessions.
   * @param userId - Authenticated initiating user.
   * @param workspaceId - Native workspace id.
   * @returns Confirmed container absence.
   */
  closeForUser(userId: UserId, workspaceId: WorkspaceId): Promise<RunnerClosedSandbox> {
    return this.perform(userId, workspaceId, 'close', () => this.client.close(workspaceId))
  }

  private parse(request: SandboxRequest): WorkspaceId {
    const parsed = requestSchema.safeParse(request)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', 'Expected only a valid workspaceId', {})
    return WorkspaceId(parsed.data.workspaceId)
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
      if ([...this.opening].some(request => request.workspaceId === workspaceId)) this.activeSandbox(workspaceId, 'starting')
      const result = await this.runner(() => this.client.status(workspaceId))
      if (result.state !== 'closed') this.activeSandbox(workspaceId, result.state)
      return next()
    }).finally(() => { this.deleting.delete(workspaceId) })
    this.deleting.set(workspaceId, deletion)
    return deletion
  }

  private activeSandbox(workspaceId: WorkspaceId, state: Exclude<SandboxValue['state'], 'closed'>): never {
    throw new RemoteError('workspace/sandbox-active', 'Close the workspace sandbox before deleting the workspace', { workspaceId, state })
  }

  private async perform<T>(userId: UserId, workspaceId: WorkspaceId, operation: string, invoke: () => Promise<T>): Promise<T> {
    this.authorize(userId, workspaceId, operation)
    return this.runner(invoke)
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
