/** Descriptor-pinned binary access to the negotiated workspace, never an arbitrary root. */
import { PassThrough } from 'node:stream'
import { mkdir, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { workspaceHandleIdSchema, type SshWorkspaceHandleId } from './schemas.ts'
import { ArtifactFailure, artifactComponents, listArtifacts, openArtifact,
  artifactFailure } from '@deepseek-ai/dsh-fs-local/workspace-artifacts'
import { storeWorkspaceUpload, UploadFailure, validateUploadName } from '@deepseek-ai/dsh-fs-local/workspace-upload'
import type { WorkspaceFileUpload } from '@deepseek-ai/dsh-fs/workspace-access'
import { RemoteOperationError } from './protocol.ts'

const identity = z.strictObject({ id: workspaceHandleIdSchema })
const readLimit = z.number().int().positive().max(64 * 1024)
type UploadResult = { ok: true; value: WorkspaceFileUpload } | { ok: false; error: { reason: string; stored: boolean } }

/** One helper's open binary descriptors and bounded upload streams. */
export class WorkspaceBinaryHandles {
  private readonly writes = new AbortController()
  private readonly reads = new Map<SshWorkspaceHandleId, { file: FileHandle; offset: number; bytes: number }>()
  private readonly uploads = new Map<SshWorkspaceHandleId, { input: PassThrough; result: Promise<UploadResult> }>()

  /**
   * @param root - Negotiated workspace.
   * @param lifetime - Helper cleanup lifetime.
   * @param stagingRoot - Private helper directory on the workspace filesystem.
   */
  constructor(private readonly root: string, private readonly lifetime: AbortSignal,
    private readonly stagingRoot: string = dirname(root)) {}

  /**
   * Dispatch only bounded workspace-relative operations.
   * @param method - Private binary method.
   * @param raw - Untrusted wire fields.
   * @param signal - This request and helper lifetime.
   * @returns Validated metadata, bytes, or a publication result.
   */
  async dispatch(method: string, raw: unknown, signal: AbortSignal): Promise<unknown> {
    try {
      signal.throwIfAborted()
      if (method === 'workspace.list') {
        const input = z.strictObject({ path: z.string(), maxEntries: z.number().int().positive().max(100_000) }).parse(raw)
        return await listArtifacts(this.root, input.path, input.maxEntries, signal)
      }
      if (method === 'workspace.mkdir') {
        const { path } = z.strictObject({ path: z.string() }).parse(raw)
        const parts = artifactComponents(path)
        const name = parts.at(-1)
        if (name === undefined) return null
        const parent = await openArtifact(this.root, parts.slice(0, -1).join('/'), true, signal)
        try {
          try { await mkdir('/proc/self/fd/' + String(parent.fd) + '/' + name, { mode: 0o700 }) }
          catch (error) { if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw error }
          const directory = await openArtifact(this.root, path, true, signal)
          await directory.close()
          await parent.sync()
          return null
        } finally { await parent.close() }
      }
      if (method === 'workspace.open') {
        const input = z.strictObject({ path: z.string(), maxBytes: z.number().int().nonnegative() }).parse(raw)
        this.capacity()
        const file = await openArtifact(this.root, input.path, false, signal)
        try {
          const bytes = (await file.stat()).size
          if (bytes > input.maxBytes) throw new ArtifactFailure('too-large')
          signal.throwIfAborted()
          this.capacity()
          const id = brandString<SshWorkspaceHandleId>(randomUUID())
          this.reads.set(id, { file, bytes, offset: 0 })
          return { id, bytes }
        } catch (error) { await file.close(); throw error }
      }
      if (method === 'workspace.read') {
        const { id, limit } = identity.extend({ limit: readLimit }).parse(raw)
        const record = this.reads.get(id)
        if (record === undefined) throw new ArtifactFailure('not-found')
        const buffer = Buffer.alloc(Math.min(limit, record.bytes - record.offset))
        const { bytesRead } = await record.file.read(buffer, 0, buffer.length, record.offset)
        signal.throwIfAborted()
        if (bytesRead === 0 && record.offset !== record.bytes) throw new ArtifactFailure('io')
        record.offset += bytesRead
        return { data: buffer.subarray(0, bytesRead).toString('base64'), done: record.offset === record.bytes }
      }
      if (method === 'workspace.readClose') {
        const { id } = identity.parse(raw)
        const record = this.reads.get(id)
        if (record !== undefined) { this.reads.delete(id); await record.file.close() }
        return null
      }
      if (method === 'workspace.uploadOpen') {
        const { name, maxBytes, path } = z.strictObject(
          { name: z.string(), maxBytes: z.number().int().nonnegative(), path: z.string().default('') }).parse(raw)
        validateUploadName(name)
        this.capacity()
        const directory = await openArtifact(this.root, path, true, signal)
        const input = new PassThrough({ highWaterMark: 64 * 1024 })
        input.on('error', () => {}) // The retained storage result owns stream errors even before its iterator begins.
        const result: Promise<UploadResult> = storeWorkspaceUpload(join(this.root, path), name, input, maxBytes,
          AbortSignal.any([this.lifetime, this.writes.signal]),
          () => { this.lifetime.throwIfAborted(); this.writes.signal.throwIfAborted() }, { directory,
            stagingRoot: this.stagingRoot }).then(value => ({ ok: true, value }), (cause: unknown) => {
          input.destroy()
          const error = cause instanceof UploadFailure ? cause : new UploadFailure('io', false, { cause })
          return { ok: false, error: { reason: error.reason, stored: error.stored } }
        })
        const id = brandString<SshWorkspaceHandleId>(randomUUID())
        this.uploads.set(id, { input, result })
        return id
      }
      if (method === 'workspace.uploadChunk') {
        const { id, data } = identity.extend({ data: z.base64().max(90_000) }).parse(raw)
        const record = this.uploads.get(id)
        if (record === undefined) throw new UploadFailure('unavailable')
        const bytes = Buffer.from(data, 'base64')
        if (bytes.length > 64 * 1024) throw new UploadFailure('too-large')
        await new Promise<void>((resolve, reject) => record.input.write(bytes, (error) => { if (error) reject(error); else resolve() }))
        return null
      }
      if (method === 'workspace.uploadCommit' || method === 'workspace.uploadAbort') {
        const { id } = identity.parse(raw)
        const record = this.uploads.get(id)
        if (record === undefined) throw new UploadFailure('unavailable')
        if (method === 'workspace.uploadAbort') record.input.destroy(new Error('Upload abandoned'))
        else record.input.end()
        try { return await record.result } finally { this.uploads.delete(id) }
      }
      throw new Error('Unknown workspace binary method')
    } catch (error) {
      if (error instanceof UploadFailure) throw new RemoteOperationError('Workspace upload refused', 'upload:' + error.reason)
      const failure = artifactFailure(error, signal)
      throw new RemoteOperationError('Workspace file access refused', 'artifact:' + failure.reason)
    }
  }

  private capacity(): void {
    if (this.reads.size + this.uploads.size >= 128) throw new ArtifactFailure('io')
  }

  /** Revoke upload publication while retaining completed read descriptors for preservation. */
  async quiesce(): Promise<void> {
    this.writes.abort(new Error('Workspace writes were revoked'))
    for (const record of this.uploads.values()) record.input.destroy(new Error('Workspace writes were revoked'))
    await Promise.allSettled([...this.uploads.values()].map(record => record.result))
  }

  /** Close all binary resources after helper cancellation; wait for staging cleanup. */
  async close(): Promise<void> {
    for (const record of this.uploads.values()) record.input.destroy(new Error('SSH helper closed'))
    const results = await Promise.allSettled([
      ...[...this.reads.values()].map(record => record.file.close()),
      ...[...this.uploads.values()].map(record => record.result),
    ])
    this.reads.clear()
    this.uploads.clear()
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length > 0) throw new AggregateError(failures.map((result): unknown => result.reason), 'Workspace file cleanup failed')
  }
}
