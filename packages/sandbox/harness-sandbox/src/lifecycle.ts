/** Application-owned close barriers retained across manager and conversation plugin reloads. */

import { Context, Service } from '@deepseek-ai/cordis'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-agent'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { RunnerClosedSandbox, RunnerRunningSandbox, RunnerSandboxStatus } from './runner-client.ts'
import { SandboxPermits } from './permits.ts'
import type { SandboxActivity } from './types.ts'

/** One process-local admission generation, separate from the Runner container identity. */
export interface SandboxEpoch {
  readonly version: number
  readonly signal: AbortSignal
  readonly blocked: boolean
}

/** Reliable process-local observation, or a generation that must be queried again. */
export type SandboxObservation = RunnerClosedSandbox | RunnerRunningSandbox | { readonly state: 'unconfirmed' }

/** Internal idle history; monotonic timestamps are valid only within this application process. */
export interface SandboxIdleActivity extends SandboxActivity {
  /** Admission/close generation captured alongside this activity snapshot. */
  readonly version: number
  /** Actual activity, management or observation changes; distinct from the close version. */
  readonly revision: number
  /** Monotonic milliseconds at final work settlement, or null without reliable available running state. */
  readonly idleSince: number | null
  /** Last reliable generation; never substitutes for the final Runner query. */
  readonly sandbox: SandboxObservation
}

interface WorkspaceLifecycle {
  version: number
  closing: boolean
  uncertain: boolean
  revocation: AbortController
  readonly openings: Set<Promise<RunnerRunningSandbox>>
  executions: number
  close?: Promise<RunnerClosedSandbox>
  revision: number
  idleSince: number | null
  sandbox: SandboxObservation
  observation: number
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
    this.permits = new SandboxPermits((id) => { this.changed(id) }, (id, error) => {
      ctx.logger.warn('workspace-sandbox: cleanup failed for workspace %s; dependent work remains blocked: %o', id, error)
    })
    ctx.on('workspace/before-delete', async (id, next) => {
      const removed = await next()
      if (removed) this.workspaces.delete(id)
      return removed
    })
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
  attach(owner: symbol): void {
    if (this.manager === owner) return
    this.manager = owner
    for (const id of this.workspaces.keys()) this.unobserve(id)
  }

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
   * @returns Whether closure is active or requires cleanup before opening.
   */
  closing(id: WorkspaceId): 'closing' | 'cleanup_required' | undefined {
    const state = this.workspaces.get(id)
    if (state?.closing) return state.close === undefined ? 'cleanup_required' : 'closing'
  }

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
    const owner = this.manager
    const observation = ++state.observation
    const current = () => this.workspaces.get(id) === state && this.manager === owner
      && state.version === epoch.version && state.observation === observation
    const pending = Promise.resolve().then(() => operation(epoch)).then((result) => {
      if (current()) this.record(id, result)
      return result
    }).catch((error: unknown) => {
      const remote = remoteErrorOf(error)
      if (remote?.code === 'sandbox/failed' && remote.details.outcomeUnknown) {
        state.uncertain = true
        state.closing = true
        this.revoke(id)
      } else if (current()) this.unobserve(id)
      throw error
    }).finally(() => { state.openings.delete(pending); this.changed(id) })
    state.openings.add(pending)
    this.changed(id)
    return pending
  }

  /**
   * Record a Runner observation only while its activity and manager remain current.
   * @param id - Authorized workspace.
   * @param operation - Fresh status query with authorization and availability rechecked on return.
   * @param signal - Optional observer lifetime; abort suppresses history updates, while omission records normally.
   * @returns The original query result; late results cannot replace current idle history.
   */
  async query(id: WorkspaceId, operation: () => Promise<RunnerSandboxStatus>, signal?: AbortSignal): Promise<RunnerSandboxStatus> {
    const state = this.state(id)
    // A query during PUT cannot establish the state after that mutation settles.
    if (state.openings.size > 0) return operation()
    const owner = this.manager
    const revision = state.revision
    const observation = ++state.observation
    const current = () => !signal?.aborted && this.workspaces.get(id) === state && this.manager === owner
      && state.revision === revision && state.observation === observation
    try {
      const result = await operation()
      if (current()) this.record(id, result.state === 'running' || result.state === 'closed' ? result : { state: 'unconfirmed' })
      return result
    } catch (error) {
      if (current()) this.unobserve(id)
      throw error
    }
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
      this.record(id, result)
      return result
    }).finally(() => { delete state.close })
    state.close = pending
    return pending
  }

  /**
   * Retain command or file activity until cancellation, result retrieval and cleanup finish.
   * A closed observation is invalidated because file access can restore a remote workspace.
   * @param id - Authorized execution workspace.
   * @returns One release callback owned by the admitted execution.
   */
  beginExecution(id: WorkspaceId): () => void {
    const state = this.state(id)
    if (state.sandbox.state === 'closed') this.unobserve(id)
    state.executions++
    this.changed(id)
    let released = false
    return () => {
      if (released) return
      released = true
      state.executions--
      this.changed(id)
    }
  }

  /**
   * Read work from its owners and continuous idle history without refreshing it.
   * @param id - Workspace.
   * @returns Activity through cleanup and a monotonic idle start only for a reliably running, available sandbox.
   */
  activity(id: WorkspaceId): SandboxIdleActivity {
    const state = this.workspaces.get(id)
    const requests = this.permits.active(id)
    const openings = state?.openings.size ?? 0
    const executions = state?.executions ?? 0
    const closing = state?.closing ?? false
    return {
      busy: requests > 0 || openings > 0 || executions > 0 || closing, requests, openings, executions, closing,
      version: state?.version ?? 0,
      revision: state?.revision ?? 0, idleSince: state?.idleSince ?? null, sandbox: state?.sandbox ?? { state: 'unconfirmed' },
    }
  }

  /**
   * Read candidate ids from actual activity and observations, including work awaiting confirmation.
   * @returns Known workspaces not confirmed closed; native ownership still requires management authorization.
   */
  candidateWorkspaces(): WorkspaceId[] {
    return [...this.workspaces].filter(([, state]) => state.sandbox.state !== 'closed').map(([id]) => id)
  }

  /**
   * Invalidate an unchanged observation when its native owner cannot currently be authorized.
   * @param id - Candidate inspected by the trusted background consumer.
   * @param revision - Original activity revision; a late failure cannot reset newer work.
   */
  invalidateObservation(id: WorkspaceId, revision: number): void {
    const state = this.workspaces.get(id)
    if (state?.revision === revision && state.sandbox.state !== 'unconfirmed') this.unobserve(id)
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
    this.unobserve(id)
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
      state = {
        version: 0, closing: false, uncertain: false, revocation: new AbortController(), openings: new Set(), executions: 0,
        revision: 0, idleSince: null, sandbox: { state: 'unconfirmed' }, observation: 0,
      }
      this.workspaces.set(id, state)
    }
    return state
  }

  private changed(id: WorkspaceId): void {
    const state = this.state(id)
    state.revision++
    state.idleSince = this.manager !== undefined && state.sandbox.state === 'running' && !this.activity(id).busy
      ? state.idleSince ?? performance.now() : null
  }

  private unobserve(id: WorkspaceId): void {
    const state = this.state(id)
    state.sandbox = { state: 'unconfirmed' }
    state.idleSince = null
    state.observation++
    this.changed(id)
  }

  private record(id: WorkspaceId, sandbox: SandboxObservation): void {
    const state = this.state(id)
    if (state.sandbox.state === sandbox.state
      && (sandbox.state !== 'running' || state.sandbox.state === 'running' && state.sandbox.containerId === sandbox.containerId)) return
    state.sandbox = sandbox
    state.idleSince = null
    this.changed(id)
  }

  private unavailable(reason: 'sandbox_closing' | 'sandbox_outcome_unknown', outcomeUnknown: boolean): never {
    throw new RemoteError('sandbox/failed', 'Workspace sandbox closure is not confirmed', { reason, outcomeUnknown })
  }
}
