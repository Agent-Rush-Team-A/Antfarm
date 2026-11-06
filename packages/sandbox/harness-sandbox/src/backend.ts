/** Workspace execution provider seam; authorization remains with the management and turn owners. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { RunnerResponseError } from './runner-client.ts'
import type { RunnerClosedSandbox, RunnerRunningSandbox, RunnerSandboxStatus, SandboxContainerId } from './runner-client.ts'
import type { RunnerCancellationResult, RunnerExecutionIdentity, RunnerExecutionRequest, RunnerExecutionResult } from './execution.ts'

/** Files and directory of one original execution generation, never the Harness project directory. */
export interface WorkspaceRuntimeFiles {
  readonly fs: FileSystem
  readonly root: string
  readonly signal: AbortSignal
  /** Reject access after closure, disconnect or generation replacement. */
  assertCurrent(): void
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
