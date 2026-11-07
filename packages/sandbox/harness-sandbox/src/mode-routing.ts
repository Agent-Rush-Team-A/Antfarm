/** Execution and binary-file routing under a retained workspace mode lease. */
import type {
  IWorkspaceModes, WorkspaceId, WorkspaceMode, WorkspaceModeUseConfig, WorkspaceModeUseLease,
} from '@deepseek-ai/dsh-workspace/types'
import type {
  WorkspaceFileAccess, WorkspaceFileDownload, WorkspaceFileListing, WorkspaceFileScope, WorkspaceFileUpload,
} from '@deepseek-ai/dsh-fs/workspace-access'
import type { SandboxExecutionBackend } from './backend.ts'
import type { RunnerClosedSandbox, RunnerRunningSandbox } from './runner-client.ts'

/** One configured execution world and the file provider for its persistent workspace. */
export interface WorkspaceModeTarget {
  readonly execution: Pick<SandboxExecutionBackend, 'open' | 'close' | 'status' | 'execute' | 'cancel' | 'files'>
    & Partial<Pick<SandboxExecutionBackend, 'activity' | 'progress'>>
  readonly files: Pick<WorkspaceFileAccess, 'list' | 'download' | 'upload'>
}

/** An admitted backend selection; callers retain their original execution-generation permission. */
export interface WorkspaceModeExecution {
  readonly config: WorkspaceModeUseConfig
  readonly backend: WorkspaceModeTarget['execution']
  readonly scope: WorkspaceFileScope
}

/** Captured execution and file providers; the owner releases after all retained work settles. */
export interface WorkspaceModeExecutionLease extends WorkspaceModeExecution {
  readonly files: WorkspaceModeTarget['files']
  /** Idempotent mode admission release; does not itself close an execution environment. */
  release(): void
}

/** A mode has no configured target, or a manual operation is forbidden for that mode. */
export class WorkspaceModeRoutingError extends Error {
  /**
   * @param workspaceId - Affected workspace.
   * @param mode - Admitted mode that cannot perform the operation.
   * @param reason - Stable failure discriminator.
   */
  constructor(
    readonly workspaceId: WorkspaceId,
    readonly mode: WorkspaceMode,
    readonly reason: 'unsupported-mode' | 'manual-operation-forbidden',
  ) {
    super(reason === 'unsupported-mode' ? 'Workspace mode is unavailable' : 'This workspace manages its sandbox automatically')
    this.name = 'WorkspaceModeRoutingError'
  }
}

/**
 * Determine whether task completion owns this mode's sandbox lifetime.
 * @param mode - Persisted workspace mode.
 * @returns Whether the workspace has a single ordinary Session.
 */
export function isSingleSessionMode(mode: WorkspaceMode): boolean {
  return mode === 'single-vm' || mode === 'single-docker'
}

/** Routes only after admission; no deployment default or local-file fallback is inferred. */
export class WorkspaceModeRouting {
  private readonly targets: ReadonlyMap<WorkspaceMode, WorkspaceModeTarget>
  /** Explicit deployment modes captured at construction, without fallback providers. */
  readonly supportedModes: readonly WorkspaceMode[]

  /**
   * @param modes - Workspace-owned resource admission.
   * @param targets - Explicit deployment-supported modes and their providers.
   */
  constructor(
    private readonly modes: Pick<IWorkspaceModes, 'acquireUse'>,
    targets: ReadonlyMap<WorkspaceMode, WorkspaceModeTarget>,
  ) {
    this.targets = new Map(targets)
    this.supportedModes = Object.freeze([...targets.keys()])
  }

  /**
   * Retain one backend selection through execution, cancellation, and result cleanup.
   * Nested helpers consume the supplied backend and scope without acquiring another lease.
   * @param scope - Original authorized workspace and caller lifetime.
   * @param run - Operation that resolves only when its retained work has settled.
   * @returns The operation result; provider errors retain their original identity.
   */
  async withExecution<T>(scope: WorkspaceFileScope, run: (execution: WorkspaceModeExecution) => Promise<T>): Promise<T> {
    const execution = await this.acquireExecution(scope)
    try { return await run(execution) }
    finally { execution.release() }
  }

  /**
   * Retain the selected providers across an inbox message and its later resource operations.
   * @param scope - Original authorized workspace and operation lifetime.
   * @returns Stable selection; release only after all work using it settles.
   */
  async acquireExecution(scope: WorkspaceFileScope): Promise<WorkspaceModeExecutionLease> {
    const lease = await this.acquire(scope)
    try {
      const target = this.target(lease)
      return { config: lease.config, backend: target.execution, files: target.files,
        scope: this.scope(scope, lease), release: () => { lease.release() } }
    } catch (error) { lease.release(); throw error }
  }

  /**
   * Open the selected environment after checking whether the initiator may open it.
   * @param scope - Original authorized workspace.
   * @param initiator - Manual controls are permitted only in multi-session modes.
   * @returns Confirmed running environment.
   */
  open(scope: WorkspaceFileScope, initiator: 'manual' | 'task'): Promise<RunnerRunningSandbox> {
    return this.withExecution(scope, async ({ config, backend, scope: admitted }) => {
      this.allowLifecycle(config, initiator)
      admitted.admit()
      return backend.open(admitted.workspaceId, admitted.project)
    })
  }

  /**
   * Close the selected environment; automatic callers must first own the task-reclamation barrier.
   * @param scope - Original authorized workspace.
   * @param initiator - Manual controls are permitted only in multi-session modes.
   * @returns Confirmed closure, preserving provider failures and uncertain outcomes.
   */
  close(scope: WorkspaceFileScope, initiator: 'manual' | 'task'): Promise<RunnerClosedSandbox> {
    return this.withExecution(scope, async ({ config, backend, scope: admitted }) => {
      this.allowLifecycle(config, initiator)
      admitted.admit()
      return backend.close(admitted.workspaceId)
    })
  }

  /**
   * Read entries through the mode's file provider without starting an execution environment here.
   * @param scope - Original authorized workspace.
   * @param path - Relative directory path.
   * @param maxEntries - Inclusive entry limit.
   * @returns Provider listing after its resources settle.
   */
  async list(scope: WorkspaceFileScope, path: string, maxEntries: number): Promise<WorkspaceFileListing> {
    const lease = await this.acquire(scope)
    try { return await this.target(lease).files.list(this.scope(scope, lease), path, maxEntries) }
    finally { lease.release() }
  }

  /**
   * Publish an uploaded file while retaining mode and authority through cancellation cleanup.
   * @param scope - Original authorized workspace.
   * @param name - Provider-validated leaf name.
   * @param chunks - Incoming file stream.
   * @param maxBytes - Complete upload limit.
   * @returns Confirmed provider publication result.
   */
  async upload(scope: WorkspaceFileScope, name: string, chunks: AsyncIterable<Uint8Array>, maxBytes: number): Promise<WorkspaceFileUpload> {
    const lease = await this.acquire(scope)
    try { return await this.target(lease).files.upload(this.scope(scope, lease), name, chunks, maxBytes) }
    finally { lease.release() }
  }

  /**
   * Transfer the lease to the download's settlement without delaying delivery of its body.
   * @param scope - Original authorized workspace.
   * @param path - Provider-validated relative file path.
   * @param maxBytes - Complete download limit.
   * @returns The original stream, releasing admission only after descriptor/transport cleanup.
   */
  async download(scope: WorkspaceFileScope, path: string, maxBytes: number): Promise<WorkspaceFileDownload> {
    const lease = await this.acquire(scope)
    let stream: WorkspaceFileDownload
    try { stream = await this.target(lease).files.download(this.scope(scope, lease), path, maxBytes) }
    catch (error) { lease.release(); throw error }
    const settled = stream.settled.finally(() => { lease.release() })
    // Consumers may start observing settlement only after receiving the response body.
    void settled.catch(() => {})
    return { ...stream, settled }
  }

  private async acquire(scope: WorkspaceFileScope): Promise<WorkspaceModeUseLease> {
    scope.signal.throwIfAborted()
    scope.admit()
    const lease = await this.modes.acquireUse(scope.workspaceId, { signal: scope.signal, admit: () => { scope.admit() } })
    try { this.scope(scope, lease).admit() }
    catch (error) { lease.release(); throw error }
    return lease
  }

  private scope(original: WorkspaceFileScope, lease: WorkspaceModeUseLease): WorkspaceFileScope {
    const signal = AbortSignal.any([original.signal, lease.signal])
    return {
      workspaceId: original.workspaceId, project: original.project, signal,
      admit() { signal.throwIfAborted(); lease.admit() },
    }
  }

  private target(lease: WorkspaceModeUseLease): WorkspaceModeTarget {
    const { workspaceId, mode } = lease.config
    const target = this.targets.get(mode)
    if (target === undefined) throw new WorkspaceModeRoutingError(workspaceId, mode, 'unsupported-mode')
    return target
  }

  private allowLifecycle(config: WorkspaceModeUseConfig, initiator: 'manual' | 'task'): void {
    if (initiator === 'manual' && isSingleSessionMode(config.mode)) {
      throw new WorkspaceModeRoutingError(config.workspaceId, config.mode, 'manual-operation-forbidden')
    }
  }
}
