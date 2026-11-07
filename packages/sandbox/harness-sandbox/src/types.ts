/** Browser-safe sandbox management vocabulary, without deployment paths or container identities. */

import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** The only business input accepted by each workspaceSandbox operation. */
export interface SandboxRequest {
  readonly workspaceId: WorkspaceId
}

/** An authorized workspace and its current Runner state. */
export interface SandboxValue {
  readonly workspaceId: WorkspaceId
  readonly state: 'closed' | 'starting' | 'running' | 'closing' | 'cleanup_required'
}

/** Local work that an idle-reclamation consumer must allow to settle before closing. */
export interface SandboxActivity {
  readonly busy: boolean
  readonly requests: number
  readonly openings: number
  readonly executions: number
  readonly closing: boolean
}

/** Stable management failures; unknown modifications retain the local closing barrier and require maintenance. */
export type SandboxFailureReason = 'sandbox_not_ready' | 'sandbox_capacity' | 'sandbox_closing' | 'sandbox_cleanup_required'
  | 'sandbox_workspace_conflict' | 'sandbox_name_conflict' | 'sandbox_outcome_unknown' | 'invalid_workspace_directory'
  | 'docker_unavailable' | 'runner_unavailable' | 'runner_outcome_unknown'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Close the workspace sandbox before removing its registration. */
    'workspace/sandbox-active': { readonly workspaceId: WorkspaceId; readonly state: Exclude<SandboxValue['state'], 'closed'> }
    /** Sanitized Runner failure, preserving whether a modification may have taken effect. */
    'sandbox/failed': { readonly reason: SandboxFailureReason; readonly outcomeUnknown: boolean }
  }
}
