/** Metadata and failures for files retained in an authorized workspace. */
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** Workspace identity; the browser never supplies a Host directory. */
export interface WorkspaceArtifactScope {
  /** Registered workspace whose files are requested. */
  readonly workspaceId: WorkspaceId
}

/** One regular file or directory; symlinks and special files are omitted. */
export interface WorkspaceArtifactEntry {
  /** Exact filesystem leaf name. */
  readonly name: string
  /** Whether navigation or download is available. */
  readonly kind: 'file' | 'directory'
  /** Byte length of a regular file at listing time. */
  readonly bytes?: number
}

/** Bounded, manually refreshed directory listing without Host paths. */
export interface WorkspaceArtifactListing {
  /** Validated, slash-separated workspace-relative directory; empty at the root. */
  readonly path: string
  /** Entries observed during this request, sorted by kind and name. */
  readonly entries: readonly WorkspaceArtifactEntry[]
  /** True when the scan reached its configured entry limit. */
  readonly truncated: boolean
  /** Inclusive download cap also enforced before buffering in the browser. */
  readonly maxDownloadBytes: number
}

/** Expected refusal; internal filesystem causes never cross the wire. */
export type WorkspaceArtifactFailureReason =
  | 'invalid-path' | 'denied' | 'not-found' | 'not-regular'
  | 'too-large' | 'cancelled' | 'io'

/** Browser operation outcome; cancellation never saves a partial download. */
export type WorkspaceArtifactResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly reason: WorkspaceArtifactFailureReason } }

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A refused listing with a browser-safe category. */
    'workspace-artifact/failed': { readonly reason: WorkspaceArtifactFailureReason }
  }
}
