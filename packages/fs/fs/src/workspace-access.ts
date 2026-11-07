/** Binary workspace access selected by deployment, shared by HTTP and remote providers. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Caller-owned authority, cancellation, and registered project identity. */
export interface WorkspaceFileScope {
  readonly workspaceId: Branded<'WorkspaceId'>
  readonly project: string
  readonly signal: AbortSignal
  /** Recheck ownership and the original registration before each operation or publication. */
  admit(): void
}

/** One navigable directory or downloadable regular file. */
export interface WorkspaceFileEntry {
  readonly name: string
  readonly kind: 'file' | 'directory'
  readonly bytes?: number
}

/** Bounded directory metadata. */
export interface WorkspaceFileListing {
  readonly entries: readonly WorkspaceFileEntry[]
  readonly truncated: boolean
}

/** A pull-driven initial file extent and its resource settlement. */
export interface WorkspaceFileDownload {
  readonly bytes: number
  readonly body: ReadableStream<Uint8Array>
  readonly settled: Promise<void>
}

/** Exclusive upload publication result. */
export interface WorkspaceFileUpload {
  readonly name: string
  readonly bytes: number
}

/** Stable binary-read failures shared with HTTP consumers. */
export type WorkspaceFileReadFailure = 'invalid-path' | 'denied' | 'not-found' | 'not-regular' | 'too-large' | 'cancelled' | 'io'
/** Stable binary-write failures shared with HTTP consumers. */
export type WorkspaceFileWriteFailure = 'invalid-request' | 'invalid-name' | 'too-large' | 'exists' | 'denied' | 'unavailable' | 'cancelled' | 'io' | 'cleanup' | 'unknown'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Deployment-provided file access; an absent provider never means local fallback. */
    workspaceFileAccess: WorkspaceFileAccess
  }
}

/** Providers retain original authority and generation until all streams settle. */
export abstract class WorkspaceFileAccess extends Service {
  /** @param ctx - Provider owner. */
  constructor(ctx: Context) { super(ctx, 'workspaceFileAccess') }
  /**
   * Read a directory in the selected execution world or a completed read-only copy.
   * @param scope - Original authorized workspace.
   * @param path - Relative path; empty names the root.
   * @param maxEntries - Inclusive inspected-entry bound.
   * @returns Metadata only, without deployment coordinates.
   */
  abstract list(scope: WorkspaceFileScope, path: string, maxEntries: number): Promise<WorkspaceFileListing>
  /**
   * Open one regular file without following symlinks; transfer resources to the body.
   * @param scope - Original authorized workspace.
   * @param path - Relative file path.
   * @param maxBytes - Complete-file byte limit.
   * @returns Stream retaining its original file identity through settlement.
   */
  abstract download(scope: WorkspaceFileScope, path: string, maxBytes: number): Promise<WorkspaceFileDownload>
  /**
   * Exclusively publish one streamed file in the live execution workspace.
   * @param scope - Original authorized workspace.
   * @param name - Exact validated root leaf name.
   * @param chunks - Bounded-memory incoming bytes.
   * @param maxBytes - Complete-file byte limit.
   * @returns Published name and extent; failures retain their publication fact.
   */
  abstract upload(scope: WorkspaceFileScope, name: string,
    chunks: AsyncIterable<Uint8Array>, maxBytes: number): Promise<WorkspaceFileUpload>
}
