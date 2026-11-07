/** Application-owned close barriers retained across manager and conversation plugin reloads. */

import { Context, Service } from '@deepseek-ai/cordis'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-agent'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { RunnerClosedSandbox, RunnerRunningSandbox } from './runner-client.ts'
import { SandboxPermits } from './permits.ts'
import type { SandboxActivity } from './types.ts'

/** One process-local admission generation, separate from the Runner container identity. */
export interface SandboxEpoch {
  readonly version: number
  readonly signal: AbortSignal
  readonly blocked: boolean
}

interface WorkspaceLifecycle {
  version: number
  closing: boolean
  uncertain: boolean
  revocation: AbortController
  readonly openings: Set<Promise<RunnerRunningSandbox>>
  executions: number
  close?: Promise<RunnerClosedSandbox>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Internal process-local barriers and revoked request receipts. */
    workspaceSandboxState: WorkspaceSandboxState
  }
}

/** Holds cancellation facts while reloadable providers are absent; it performs no Runner requests. */
export default class WorkspaceSandboxState extends Service {
  /** Message permits and cancellation receipts retained by this application. */
  readonly permits: SandboxPermits
  private readonly workspaces = new Map<WorkspaceId, WorkspaceLifecycle>()
  private manager: symbol | undefined

  /** @param ctx - Application lifetime owning reload-independent cancellation facts. */
  constructor(ctx: Context) {
    super(ctx, 'workspaceSandboxState')
    this.permits = new SandboxPermits()
    ctx.effect(() => () => {
      this.manager = undefined
      for (const id of this.workspaces.keys()) this.revoke(id)
      this.permits.dispose()
    })
  }

  /**
   * Attach management without clearing existing barriers.
   * @param owner - Current provider's stable token.
   */
  attach(owner: symbol): void { this.manager = owner }

  /**
   * Revoke departing management without affecting a replacement provider.
   * @param owner - Departing provider's stable token.
   */
  detach(owner: symbol): void {
    if (this.manager !== owner) return
    this.manager = undefined
    for (const [id, state] of this.workspaces) {
      if (this.activity(id).busy) state.closing = true
      this.revoke(id)
    }
  }

  /**
   * Check the active management provider.
   * @param owner - Calling provider's token.
   * @returns Whether it is still current.
   */
  current(owner: symbol): boolean { return this.manager === owner }

  /**
   * Capture admission before any asynchronous preparation.
   * @param id - Authorized workspace.
   * @returns A generation that cannot become valid again after closing.
   */
  capture(id: WorkspaceId): SandboxEpoch {
    const state = this.state(id)
    return { version: state.version, signal: state.revocation.signal, blocked: state.closing || this.manager === undefined }
  }

  /**
   * Observe the local close barrier.
   * @param id - Authorized workspace.
   * @returns Whether closure or uncertain mutations prohibit opening.
   */
  closing(id: WorkspaceId): boolean { return this.workspaces.get(id)?.closing ?? false }

  /**
   * Reject a revoked or blocked admission generation.
   * @param id - Workspace.
   * @param epoch - Original admission generation.
   */
  check(id: WorkspaceId, epoch: SandboxEpoch): void {
    if (epoch.blocked || epoch.signal.aborted || this.capture(id).version !== epoch.version
      || this.manager === undefined || this.closing(id)) {
      throw new RemoteError('gateway/cancelled', 'Workspace sandbox request was revoked', {})
    }
  }

  /**
   * Track an opening before any directory or transport await.
   * @param id - Authorized workspace.
   * @param operation - Directory validation and PUT, checking the captured generation before sending.
   * @returns The original result; no request is retried or compensated.
   */
  open(id: WorkspaceId, operation: (epoch: SandboxEpoch) => Promise<RunnerRunningSandbox>): Promise<RunnerRunningSandbox> {
    const state = this.state(id)
    if (state.closing) this.unavailable('sandbox_closing', false)
    const epoch = this.capture(id)
    const pending = Promise.resolve().then(() => operation(epoch)).catch((error: unknown) => {
      const remote = remoteErrorOf(error)
      if (remote?.code === 'sandbox/failed' && remote.details.outcomeUnknown) {
        state.uncertain = true
        state.closing = true
        this.revoke(id)
      }
      throw error
    }).finally(() => { state.openings.delete(pending) })
    state.openings.add(pending)
    return pending
  }

  /**
   * Revoke synchronously, drain admitted openings, and preserve a barrier until closure is confirmed.
   * @param id - Already-authorized workspace.
   * @param remove - One DELETE owned by the current management provider.
   * @returns Closed only when no old mutation remains uncertain.
   */
  close(id: WorkspaceId, remove: () => Promise<RunnerClosedSandbox>): Promise<RunnerClosedSandbox> {
    const state = this.state(id)
    if (state.close !== undefined) return state.close
    state.closing = true
    this.revoke(id)
    const pending = Promise.resolve().then(async () => {
      await Promise.allSettled([...state.openings])
      let result: RunnerClosedSandbox
      try {
        result = await remove()
      } catch (error) {
        const remote = remoteErrorOf(error)
        if (remote?.code === 'sandbox/failed' && remote.details.outcomeUnknown) state.uncertain = true
        throw error
      }
      if (state.uncertain && result.reconciled !== true) this.unavailable('sandbox_outcome_unknown', true)
      if (result.reconciled === true) state.uncertain = false
      state.closing = false
      return result
    }).finally(() => { delete state.close })
    state.close = pending
    return pending
  }

  /**
   * Retain command activity until cancellation, result retrieval and cleanup finish.
   * @param id - Authorized execution workspace.
   * @returns One release callback owned by the admitted execution.
   */
  beginExecution(id: WorkspaceId): () => void {
    const state = this.state(id)
    state.executions++
    return () => { state.executions-- }
  }

  /**
   * Derive work from its owners without a separate idle cache or timer.
   * @param id - Workspace.
   * @returns Activity through command cancellation and cleanup; closing uncertainty is busy.
   */
  activity(id: WorkspaceId): SandboxActivity {
    const state = this.workspaces.get(id)
    const requests = this.permits.active(id)
    const openings = state?.openings.size ?? 0
    const executions = state?.executions ?? 0
    const closing = state?.closing ?? false
    return { busy: requests > 0 || openings > 0 || executions > 0 || closing, requests, openings, executions, closing }
  }

  /**
   * Protect registration while command or mutation settlement is outstanding.
   * @param id - Workspace.
   * @returns The local blocking activity, or undefined when a fresh Runner query may authorize deletion.
   */
  deletionBlock(id: WorkspaceId): 'closing' | 'starting' | 'running' | undefined {
    const state = this.workspaces.get(id)
    if (state === undefined) return undefined
    if (state.closing || state.uncertain) return 'closing'
    if (state.openings.size > 0) return 'starting'
    if (state.executions > 0 || this.permits.active(id) > 0) return 'running'
    return undefined
  }

  private revoke(id: WorkspaceId): void {
    const state = this.state(id)
    state.version++
    state.revocation.abort()
    state.revocation = new AbortController()
    this.permits.revokeWorkspace(id)
    const agents = this.ctx.get('agents')
    const workspace = this.ctx.get('workspaceRegistry')?.get(id)
    for (const sessionId of workspace?.sessionIds ?? []) agents?.get(sessionId)?.cancel({ kind: 'hook', reason: 'workspace-sandbox-revoked' })
  }

  private state(id: WorkspaceId): WorkspaceLifecycle {
    let state = this.workspaces.get(id)
    if (state === undefined) {
      state = { version: 0, closing: false, uncertain: false, revocation: new AbortController(), openings: new Set(), executions: 0 }
      this.workspaces.set(id, state)
    }
    return state
  }

  private unavailable(reason: 'sandbox_closing' | 'sandbox_outcome_unknown', outcomeUnknown: boolean): never {
    throw new RemoteError('sandbox/failed', 'Workspace sandbox closure is not confirmed', { reason, outcomeUnknown })
  }
}
