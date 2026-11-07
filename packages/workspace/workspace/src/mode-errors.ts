/** Typed workspace mode failures; controllers own Remote error mapping. */
import type { WorkspaceId } from './types.ts'
import type { WorkspaceModeErrorDetailsMap } from './mode-types.ts'

/** All mode-domain failures, including an absent registration. */
export type WorkspaceModeErrorDetails = WorkspaceModeErrorDetailsMap & {
  'workspace/not-found': { readonly workspaceId: WorkspaceId }
}

/** Business failure with machine-readable details and an optional diagnostic cause. */
export class WorkspaceModeError<Code extends keyof WorkspaceModeErrorDetails = keyof WorkspaceModeErrorDetails> extends Error {
  /**
   * @param code - Stable failure discriminator.
   * @param details - Handling-relevant fields.
   * @param options - Internal diagnostic cause.
   */
  constructor(readonly code: Code, readonly details: WorkspaceModeErrorDetails[Code], options?: ErrorOptions) {
    super(code, options)
    this.name = 'WorkspaceModeError'
  }
}
