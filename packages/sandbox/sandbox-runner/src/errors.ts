/** Stable reasons for operations rejected by the Runner. */

import type { DockerContainerId } from './docker.ts'
import type { SandboxExecutionId } from './index.ts'
import type { SupervisorFinished } from './protocol.ts'

const failures = {
  sandbox_not_ready: 'Sandbox Runner has not completed startup cleanup',
  sandbox_capacity: 'Both workspace sandbox slots are occupied',
  sandbox_closing: 'The workspace sandbox is closing; retry after it closes',
  sandbox_cleanup_required: 'The old sandbox must be confirmed removed before opening another',
  sandbox_workspace_conflict: 'The workspace directory does not match the sandbox reservation or mount',
  sandbox_name_conflict: 'The sandbox name or container ID is not owned by this workspace',
  sandbox_outcome_unknown: 'Docker has not confirmed the outcome of a sandbox operation',
  sandbox_not_running: 'The current workspace sandbox is not running',
  execution_generation_mismatch: 'The expected container is not the current workspace sandbox',
  execution_id_conflict: 'This execution ID was already used with different arguments or a different timeout',
  execution_limit: 'This container has reached its execution ID limit',
  execution_not_found: 'This container has no record of the execution ID',
  execution_timeout: 'The execution deadline elapsed; the command was not started or its processes were confirmed cleaned',
  execution_cancelled: 'The execution was cancelled before Start or after confirmed process cleanup',
  execution_outcome_unknown: 'The execution result is unknown; check container cleanup before opening another sandbox',
  execution_container_recycled: 'The execution was interrupted by removal of its container generation',
}

/** Independent execution identity, observed reason and cleanup guarantees after an accepted command fails. */
export interface SandboxExecutionFailure {
  readonly executionId: SandboxExecutionId
  readonly containerId: DockerContainerId
  readonly reason: SupervisorFinished['reason'] | null
  readonly cleanup: 'not_started' | 'processes_cleaned' | 'container_removed' | 'unconfirmed'
  /** Present only when Bash admission/status is known; null confirms it never started. */
  readonly bash?: SupervisorFinished['bash']
}

/** A Runner decision that callers can classify without parsing an error message. */
export class SandboxLifecycleError extends Error {
  /**
   * @param code - Stable reason for the rejected operation.
   * @param cause - Docker rejection when it explains the decision.
   */
  constructor(readonly code: keyof typeof failures, cause?: unknown) {
    super(failures[code], { cause })
    this.name = 'SandboxLifecycleError'
  }
}

/** A cached execution failure, including what cleanup the Runner actually confirmed. */
export class SandboxExecutionError extends SandboxLifecycleError {
  /**
   * @param code - Command termination or loss of its generation/result.
   * @param execution - Original identity, confirmed reason and cleanup observation.
   * @param cause - Underlying operation failure, when available.
   */
  constructor(
    code: 'execution_timeout' | 'execution_cancelled' | 'execution_outcome_unknown' | 'execution_container_recycled',
    readonly execution: SandboxExecutionFailure,
    cause?: unknown,
  ) {
    super(code, cause)
    this.name = 'SandboxExecutionError'
  }
}
