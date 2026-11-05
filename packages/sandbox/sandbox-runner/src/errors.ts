/** Stable reasons for operations rejected by the Runner. */

const failures = {
  sandbox_not_ready: 'Sandbox Runner has not completed startup cleanup',
  sandbox_capacity: 'Both workspace sandbox slots are occupied',
  sandbox_closing: 'The workspace sandbox is closing; retry after it closes',
  sandbox_cleanup_required: 'The old sandbox must be confirmed removed before opening another',
  sandbox_workspace_conflict: 'The workspace directory does not match the sandbox reservation or mount',
  sandbox_name_conflict: 'The sandbox name or container ID is not owned by this workspace',
  sandbox_outcome_unknown: 'Docker has not confirmed the outcome of a sandbox operation',
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
