/** Browser-safe workspace upload metadata and settled HTTP results. */
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** Workspace identity whose upload policy is requested. */
export interface WorkspaceUploadScope {
  /** Registered workspace, never a host directory supplied by the browser. */
  readonly workspaceId: WorkspaceId
}

/** Deployment limit checked before the browser starts sending file bytes. */
export interface WorkspaceUploadLimits {
  /** Inclusive maximum bytes in one uploaded file. */
  readonly maxBytes: number
}

/** A file published under its exact leaf name in the workspace root. */
export interface WorkspaceUploadValue {
  /** Preserved leaf name, without any directory components. */
  readonly name: string
  /** Number of bytes persisted before publication. */
  readonly bytes: number
}

/** Stable failure categories; browser copy never exposes host paths or causes. */
export type WorkspaceUploadFailureReason =
  | 'invalid-request' | 'invalid-name' | 'too-large' | 'exists'
  | 'denied' | 'unavailable' | 'cancelled' | 'io' | 'cleanup' | 'unknown'

/** One settled upload; failed or lost confirmations retain the known publication fact. */
export type WorkspaceUploadResult =
  | { readonly ok: true; readonly value: WorkspaceUploadValue }
  | {
    readonly ok: false
    readonly error: {
      readonly reason: WorkspaceUploadFailureReason
      /** True only after confirmed publication; false with unknown does not establish absence. */
      readonly stored: boolean
    }
  }

/** Browser result; a lost confirmation cannot establish whether a file was published. */
export type WorkspaceUploadBrowserResult = WorkspaceUploadResult
  | { readonly ok: false; readonly error: { readonly reason: 'unknown'; readonly stored: false } }
