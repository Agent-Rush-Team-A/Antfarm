/** Persistent directory access for Docker bind mounts and verified shared VFS directories. */
import type {
  WorkspaceFileAccess, WorkspaceFileDownload, WorkspaceFileListing, WorkspaceFileScope, WorkspaceFileUpload,
} from '@deepseek-ai/dsh-fs/workspace-access'
import { ArtifactFailure, listArtifacts, openArtifact, streamArtifact } from '@deepseek-ai/dsh-fs-local/workspace-artifacts'
import { storeWorkspaceUpload } from '@deepseek-ai/dsh-fs-local/workspace-upload'

/** Deployment-owned directory resolution; failed mounts never resolve to a local fallback directory. */
export interface WorkspaceModeDirectory {
  readonly root: string
  /** Reject if the captured mount or directory ownership is no longer usable. */
  assertCurrent(): void
}

/** Uses existing descriptor-anchored file operations without requiring a live execution VM or container. */
export class WorkspaceModeDirectoryFiles implements Pick<WorkspaceFileAccess, 'list' | 'download' | 'upload'> {
  /**
   * @param resolve - Resolve and verify the current workspace's directory through its deployment owner.
   */
  constructor(private readonly resolve: (scope: WorkspaceFileScope) => Promise<WorkspaceModeDirectory>) {}

  /**
   * List a verified persistent workspace directory.
   * @param scope - Original workspace authority and cancellation.
   * @param path - Relative directory path, validated by the filesystem provider.
   * @param maxEntries - Inclusive inspected-entry limit.
   * @returns Entries after traversal resources settle and authority is rechecked.
   */
  async list(scope: WorkspaceFileScope, path: string, maxEntries: number): Promise<WorkspaceFileListing> {
    scope.admit()
    const directory = await this.resolve(scope)
    const admit = this.admission(scope, directory)
    admit()
    const result = await listArtifacts(directory.root, path, maxEntries, scope.signal)
    admit()
    return result
  }

  /**
   * Download an original file extent while retaining its descriptor and mount authority.
   * @param scope - Original workspace authority and cancellation.
   * @param path - Relative regular-file path.
   * @param maxBytes - Complete-file limit.
   * @returns A stream whose settled promise includes descriptor cleanup.
   */
  async download(scope: WorkspaceFileScope, path: string, maxBytes: number): Promise<WorkspaceFileDownload> {
    scope.admit()
    const directory = await this.resolve(scope)
    const admit = this.admission(scope, directory)
    admit()
    const file = await openArtifact(directory.root, path, false, scope.signal)
    let bytes: number
    try {
      bytes = (await file.stat()).size
      admit()
      if (bytes > maxBytes) throw new ArtifactFailure('too-large')
    } catch (error) { await file.close(); throw error }
    return { bytes, ...streamArtifact(file, bytes, scope.signal, admit) }
  }

  /**
   * Exclusively publish an uploaded leaf in the verified persistent workspace.
   * @param scope - Original workspace authority and cancellation.
   * @param name - Untrusted upload leaf.
   * @param chunks - Incoming file content.
   * @param maxBytes - Complete-upload byte limit.
   * @returns Confirmed publication after staging and descriptor cleanup.
   */
  async upload(scope: WorkspaceFileScope, name: string, chunks: AsyncIterable<Uint8Array>, maxBytes: number): Promise<WorkspaceFileUpload> {
    scope.admit()
    const directory = await this.resolve(scope)
    const admit = this.admission(scope, directory)
    admit()
    return storeWorkspaceUpload(directory.root, name, chunks, maxBytes, scope.signal, admit)
  }

  private admission(scope: WorkspaceFileScope, directory: WorkspaceModeDirectory): () => void {
    return () => { scope.signal.throwIfAborted(); scope.admit(); directory.assertCurrent() }
  }
}
