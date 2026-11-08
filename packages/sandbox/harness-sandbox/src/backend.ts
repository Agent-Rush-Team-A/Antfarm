/** Workspace execution provider seam; authorization remains with the management and turn owners. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { WorkspaceFileScope, WorkspaceFileAccess } from '@deepseek-ai/dsh-fs/workspace-access'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { RunnerResponseError } from './runner-client.ts'
import type { RunnerClosedSandbox, RunnerRunningSandbox, RunnerSandboxStatus, SandboxContainerId } from './runner-client.ts'
import type { SandboxProgress, SandboxActivity } from './types.ts'
import type { RunnerCancellationResult, RunnerExecutionIdentity, RunnerExecutionRequest, RunnerExecutionResult } from './execution.ts'

/** Files and directory retained for one original execution generation. */
export interface WorkspaceRuntimeFiles {
  readonly fs: FileSystem
  readonly root: string
  readonly signal: AbortSignal
  /** Optional model-visible root; omission retains the filesystem provider's own display paths. */
  readonly displayRoot?: string
  /** Reject access after closure, disconnect or generation replacement. */
  assertCurrent(): void
}

/** One admitted selection, retained through preparation, inbox work and resource cleanup. */
export interface SandboxExecutionAdmission {
  readonly backend: Pick<SandboxExecutionBackend, 'open' | 'close' | 'status' | 'execute' | 'cancel' | 'files'>
  readonly scope: WorkspaceFileScope
  /** Mode facades include their captured binary provider; ordinary execution-only providers omit it. */
  readonly files?: Pick<WorkspaceFileAccess, 'list' | 'download' | 'upload'>
  /** Refuse user and idle lifecycle controls when task completion owns this environment. */
  readonly taskManaged: boolean
  /** Prepare the retained generation only after prompt and attachment validation. */
  ready(): Promise<RunnerRunningSandbox>
  /** Retain independent command/file cleanup; release it even when execution fails. */
  retain(): Promise<() => Promise<void>>
  /** Idempotent; release after the owning input or operation actually settles. */
  release(): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Deployment-trusted execution backend; callers must retain authorization and generation. */
    sandboxRunnerClient: SandboxExecutionBackend
  }
}

/** Providers share lifecycle and original-request semantics without choosing user permissions. */
export abstract class SandboxExecutionBackend extends Service {
  /** @param ctx - Provider owner; disposal must drain its accepted work. */
  constructor(ctx: Context) { super(ctx, 'sandboxRunnerClient') }

  /**
   * Capture execution before asynchronous preparation; ordinary providers need no mode coordinator.
   * @param scope - Original workspace registration, authority and caller cancellation.
   * @returns A lazy selection; mode providers override this to retain shared admission and task resources.
   */
  admit(scope: WorkspaceFileScope): SandboxExecutionAdmission | Promise<SandboxExecutionAdmission> {
    scope.admit()
    return {
      backend: this, scope, taskManaged: false,
      ready: async () => { scope.admit(); return this.open(scope.workspaceId, scope.project) },
      retain: () => Promise.resolve(() => Promise.resolve()),
      release: () => Promise.resolve(),
    }
  }

  /**
   * Open or reuse the authorized Workspace's execution generation.
   * @param workspaceId - Authorized identity.
   * @param workspaceDir - Registered project path, separate from execution coordinates.
   * @returns Confirmed execution generation.
   */
  abstract open(workspaceId: WorkspaceId, workspaceDir: string): Promise<RunnerRunningSandbox>
  /**
   * Observe this Workspace without inferring a result from an earlier request.
   * @param workspaceId - Authorized identity.
   * @returns Fresh provider observation.
   */
  abstract status(workspaceId: WorkspaceId): Promise<RunnerSandboxStatus>
  /**
   * Close the execution generation after confirming managed cleanup.
   * @param workspaceId - Authorized identity.
   * @returns Closure after managed work is quiescent; lost acknowledgement rejects.
   */
  abstract close(workspaceId: WorkspaceId): Promise<RunnerClosedSandbox>
  /**
   * Release resources while the registry holds exclusive Workspace admission.
   * Mode providers select the committed backend without acquiring a nested lease.
   * @param workspaceId - Registration being archived or deleted by its lifecycle owner.
   * @returns Confirmed absence; cleanup failures prevent the registry mutation.
   */
  closeWorkspace(workspaceId: WorkspaceId): Promise<RunnerClosedSandbox> { return this.close(workspaceId) }
  /**
   * Execute once or retrieve the unchanged original request's result.
   * @param workspaceId - Authorized identity.
   * @param request - Unchanged original request.
   * @param signal - Wait cancellation, without remote cancellation.
   * @returns Original command result; conflicting requests and unknown outcomes reject.
   */
  abstract execute(workspaceId: WorkspaceId, request: RunnerExecutionRequest, signal?: AbortSignal): Promise<RunnerExecutionResult>
  /**
   * Request cancellation in the original execution generation.
   * @param workspaceId - Authorized identity.
   * @param request - Original execution and generation.
   * @returns Cancellation receipt, not cleanup confirmation.
   */
  abstract cancel(workspaceId: WorkspaceId, request: RunnerExecutionIdentity): Promise<RunnerCancellationResult>

  /**
   * Observe work retained by backend preparation or cleanup.
   * @param _workspaceId - Authorized identity.
   * @returns Provider-owned work that survives a cancelled caller, or persistent cleanup barriers.
   */
  activity(_workspaceId: WorkspaceId): Pick<SandboxActivity, 'openings' | 'executions' | 'closing'> | undefined { return undefined }

  /**
   * Inspect a locally owned closure barrier without queuing behind that closure.
   * @param _workspaceId - Authorized workspace.
   * @returns Closing or cleanup-required when owned locally; omission requires a fresh provider query.
   */
  barrier(_workspaceId: WorkspaceId): Extract<RunnerSandboxStatus, { state: 'closing' | 'starting' | 'cleanup_required' }> | undefined { return undefined }

  /**
   * Observe deployment progress without exposing cloud identities.
   * @param _workspaceId - Authorized identity.
   * @returns Optional provider-specific cloud progress without deployment coordinates.
   */
  progress(_workspaceId: WorkspaceId): SandboxProgress | undefined { return undefined }

  /**
   * Access files only in the captured execution generation; unsupported backends refuse rather than using host files.
   * @param _workspaceId - Authorized identity.
   * @param _target - Captured execution generation.
   * @param _signal - Caller lifetime.
   * @returns Generation-bound remote files; the caller retains user and turn authorization.
   */
  files(_workspaceId: WorkspaceId, _target: SandboxContainerId, _signal?: AbortSignal): Promise<WorkspaceRuntimeFiles> {
    return Promise.reject(new RunnerResponseError('workspace_files_unavailable', 503, false))
  }
}
