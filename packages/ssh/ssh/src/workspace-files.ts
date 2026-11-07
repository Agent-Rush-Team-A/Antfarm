/** Binary workspace client with bounded frames and original-connection cleanup. */
import { z } from 'zod'
import type { WorkspaceFileDownload, WorkspaceFileListing, WorkspaceFileUpload } from '@deepseek-ai/dsh-fs/workspace-access'
import { ArtifactFailure, artifactComponents } from '@deepseek-ai/dsh-fs-local/workspace-artifacts'
import { UploadFailure } from '@deepseek-ai/dsh-fs-local/workspace-upload'
import type { SshConnection } from './index.ts'
import { workspaceHandleIdSchema, type SshWorkspaceHandleId } from './schemas.ts'
import { RemoteOperationError } from './protocol.ts'

const leaf = z.string().refine((value) => {
  try { return artifactComponents(value).length === 1 } catch (_error) { return false }
}, 'expected one supported relative leaf')
const listing = (limit: number) => z.strictObject({ entries: z.array(z.strictObject({ name: leaf, kind: z.enum(['file', 'directory']), bytes: z.number().int().nonnegative().optional() })).max(limit), truncated: z.boolean() })
const uploadResult = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), value: z.strictObject({ name: z.string(), bytes: z.number().nonnegative() }) }),
  z.strictObject({ ok: z.literal(false), error: z.strictObject({ reason: z.enum(['invalid-request', 'invalid-name', 'too-large', 'exists', 'denied', 'unavailable', 'cancelled', 'io', 'cleanup']), stored: z.boolean() }) }),
])

/** Uses only the already negotiated workspace; callers retain authorization and generation. */
export class SshWorkspaceFiles {
  /** @param ssh - One original helper connection. */
  constructor(private readonly ssh: Pick<SshConnection, 'request' | 'signal'>) {}

  /**
   * Read bounded directory metadata without following symlinks.
   * @param path - Relative directory.
   * @param maxEntries - Inspection bound.
   * @param signal - Original authority lifetime.
   * @returns Bounded metadata.
   */
  async list(path: string, maxEntries: number, signal: AbortSignal): Promise<WorkspaceFileListing> {
    try { return await this.ssh.request('workspace.list', { path, maxEntries }, listing(maxEntries), signal) as WorkspaceFileListing }
    catch (error) { throw this.readFailure(error, signal) }
  }

  /**
   * Create a confined directory for initial Workspace import.
   * @param path - Relative directory.
   * @param signal - Original generation lifetime.
   */
  async mkdir(path: string, signal: AbortSignal): Promise<void> { await this.ssh.request('workspace.mkdir', { path }, z.null(), signal) }

  /**
   * Retain the remote file descriptor until the byte stream settles.
   * @param path - Relative regular file.
   * @param maxBytes - Extent bound.
   * @param signal - Original authority lifetime.
   * @param admit - Authority recheck.
   * @returns Pinned pull-driven bytes.
   */
  async download(path: string, maxBytes: number, signal: AbortSignal, admit: () => void): Promise<WorkspaceFileDownload> {
    let id: SshWorkspaceHandleId
    let bytes: number
    try { ({ id, bytes } = await this.ssh.request('workspace.open', { path, maxBytes }, z.strictObject({ id: workspaceHandleIdSchema, bytes: z.number().int().nonnegative().max(maxBytes) }), signal)) }
    catch (error) { throw this.readFailure(error, signal) }
    const settlement = Promise.withResolvers<void>()
    let closing: Promise<void> | undefined
    let received = 0
    let controller: ReadableStreamDefaultController<Uint8Array>
    const finish = (): Promise<void> => {
      closing ??= this.ssh.request('workspace.readClose', { id }, z.null()).then(() => {
        signal.removeEventListener('abort', abort)
        settlement.resolve()
      }, (error: unknown) => {
        signal.removeEventListener('abort', abort)
        settlement.reject(error)
        throw error
      })
      return closing
    }
    const abort = (): void => { controller.error(new ArtifactFailure('cancelled')); void finish().catch(() => {}) }
    const body = new ReadableStream<Uint8Array>({
      start(value) { controller = value; signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort() },
      pull: async (value) => {
        try {
          signal.throwIfAborted(); admit()
          if (received === bytes) { await finish(); value.close(); return }
          const result = await this.ssh.request('workspace.read', { id, limit: 64 * 1024 }, z.strictObject({ data: z.base64().max(90_000), done: z.boolean() }), signal)
          signal.throwIfAborted(); admit()
          const chunk = Buffer.from(result.data, 'base64')
          received += chunk.length
          if (chunk.length === 0 || chunk.length > 64 * 1024 || received > bytes || result.done !== (received === bytes)) throw new ArtifactFailure('io')
          value.enqueue(chunk)
        } catch (error) { value.error(this.readFailure(error, signal)); await finish() }
      },
      cancel: finish,
    }, { highWaterMark: 0 })
    // Settlement is also observed by the HTTP owner or cache copier.
    void settlement.promise.catch(() => {})
    return { bytes, body, settled: settlement.promise }
  }

  /**
   * Stage bounded chunks and report the known exclusive-publication outcome.
   * @param name - Root leaf.
   * @param chunks - Incoming bytes.
   * @param maxBytes - Complete bound.
   * @param signal - Original lifetime.
   * @param admit - Publication authorization.
   * @param path - Relative parent for trusted initial seeding.
   * @returns Exclusive publication.
   */
  async upload(name: string, chunks: AsyncIterable<Uint8Array>, maxBytes: number, signal: AbortSignal, admit: () => void, path: string = ''): Promise<WorkspaceFileUpload> {
    let id: SshWorkspaceHandleId | undefined
    let committed = false
    let commitStarted = false
    try {
      signal.throwIfAborted(); admit()
      id = await this.ssh.request('workspace.uploadOpen', { name, maxBytes, path }, workspaceHandleIdSchema, signal)
      let bytes = 0
      for await (const chunk of chunks) {
        bytes += chunk.length
        if (bytes > maxBytes) throw new UploadFailure('too-large')
        for (let offset = 0; offset < chunk.length; offset += 64 * 1024) {
          signal.throwIfAborted(); admit()
          await this.ssh.request('workspace.uploadChunk', { id, data: Buffer.from(chunk.subarray(offset, offset + 64 * 1024)).toString('base64') }, z.null(), signal)
        }
      }
      signal.throwIfAborted(); admit()
      commitStarted = true
      const result = await this.ssh.request('workspace.uploadCommit', { id }, uploadResult, signal)
      committed = true
      if (!result.ok) throw new UploadFailure(result.error.reason, result.error.stored)
      if (result.value.name !== name || result.value.bytes !== bytes) throw new UploadFailure('io', true)
      return result.value
    } catch (error) {
      if (error instanceof UploadFailure) throw error
      if (commitStarted) throw new UploadFailure('unknown', false, { cause: error })
      if (signal.aborted) throw new UploadFailure('cancelled', false, { cause: error })
      if (error instanceof RemoteOperationError && error.code === 'upload:exists') throw new UploadFailure('exists')
      throw new UploadFailure('io', false, { cause: error })
    } finally {
      if (id !== undefined && !committed) await this.ssh.request('workspace.uploadAbort', { id }, uploadResult).catch(() => {})
    }
  }

  private readFailure(error: unknown, signal: AbortSignal): ArtifactFailure {
    if (error instanceof ArtifactFailure) return error
    if (signal.aborted) return new ArtifactFailure('cancelled', { cause: error })
    if (error instanceof RemoteOperationError) {
      const parsed = z.enum(['invalid-path', 'denied', 'not-found', 'not-regular', 'too-large', 'cancelled', 'io']).safeParse(error.code?.replace(/^artifact:/u, ''))
      if (parsed.success) return new ArtifactFailure(parsed.data, { cause: error })
    }
    return new ArtifactFailure('io', { cause: error })
  }
}
