/** Private atomic cloud metadata and complete read-only file copies. */
import { constants } from 'node:fs'
import { open, mkdir, readdir, rename, rm, realpath, stat, type FileHandle } from 'node:fs/promises'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'
import { isAbsolute, join, relative } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { z } from 'zod'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SandboxContainerId } from './runner-client.ts'
import type { VultrInstanceId, VultrSnapshotId } from './vultr-api.ts'
import type { SshWorkspaceFiles } from '@deepseek-ai/dsh-ssh/workspace-files'
import { listArtifacts, openArtifact, streamArtifact, artifactComponents } from '@deepseek-ai/dsh-fs-local/workspace-artifacts'
import { UploadFailure } from '@deepseek-ai/dsh-fs-local/workspace-upload'

/** Restart-safe ownership and disk-save facts; no API credentials or task content. */
export const cloudRecord = z.strictObject({
  format: z.literal(1),
  workspaceId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u).transform(WorkspaceId),
  project: z.string(), remoteRoot: z.string().startsWith('/'), deploymentId: z.string(), label: z.string(),
  generation: z.string().regex(/^[a-f0-9]{64}$/u).transform(value => brandString<SandboxContainerId>(value)),
  state: z.enum(['closed', 'starting', 'running', 'closing', 'cleanup_required']),
  phase: z.enum(['closed', 'creating', 'connecting', 'running', 'restoring', 'saving_files', 'stopping',
    'saving_snapshot', 'deleting', 'failed']),
  instanceId: z.uuid().transform(value => brandString<VultrInstanceId>(value)).optional(),
  snapshotId: z.uuid().transform(value => brandString<VultrSnapshotId>(value)).optional(),
  pendingSnapshotId: z.uuid().transform(value => brandString<VultrSnapshotId>(value)).optional(),
  snapshotDescription: z.string().optional(), oldSnapshotId: z.uuid().transform(value => brandString<VultrSnapshotId>(value)).optional(),
  cache: z.string().optional(), candidateCache: z.string().optional(),
  seeded: z.boolean().default(false),
  resumePhase: z.enum(['closed', 'creating', 'connecting', 'running', 'restoring', 'saving_files', 'stopping',
    'saving_snapshot', 'deleting']).optional(),
  mutation: z.enum(['create', 'snapshot']).optional(),
  failure: z.enum(['create', 'connect', 'save', 'restore', 'delete', 'resource_missing', 'ownership', 'interrupted']).optional(),
})

/** One persisted Workspace lifecycle record. */
export type CloudRecord = z.infer<typeof cloudRecord>

/** Atomic metadata writer; one Harness deployment exclusively owns the directory. */
export class CloudWorkspaceStore {
  private lock: FileHandle | undefined
  /** @param root - Private durable root. */
  constructor(readonly root: string) {}

  /** Validate a private real directory before any key or state publication. */
  async initialize(): Promise<void> {
    if (!isAbsolute(this.root) || /[\r\n\0]/u.test(this.root)) throw new Error('Cloud stateRoot must be an absolute directory')
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    if (await realpath(this.root) !== this.root) throw new Error('Cloud stateRoot must not contain symlinks')
    const info = await stat(this.root)
    if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new Error('Cloud stateRoot must be private and owned by the Harness user')
    const lock = await open(join(this.root, '.owner.lock'), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    try { await tryLockExclusive(lock.fd); this.lock = lock }
    catch (error) { await lock.close(); throw new Error('Another Harness owns this cloud stateRoot', { cause: error }) }
  }

  /** Release single-writer ownership after all metadata and cloud operations settle; crashes release the kernel lock. */
  async close(): Promise<void> { const lock = this.lock; this.lock = undefined; await lock?.close() }

  /**
   * Load validated private ownership and save facts without accessing the cloud API.
   * @returns All validated persistent lifecycle records.
   */
  async load(): Promise<CloudRecord[]> {
    const records: CloudRecord[] = []
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]{1,128}$/u.test(entry.name)) continue
      const path = join(this.root, entry.name, 'state.json')
      let file: FileHandle
      try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
      catch (error) { if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') continue; throw error }
      try {
        const raw: unknown = JSON.parse(await file.readFile('utf8'))
        const record = cloudRecord.parse(raw)
        if (record.workspaceId !== entry.name) throw new Error('Cloud record does not match its directory')
        for (const copy of [record.cache, record.candidateCache]) if (copy !== undefined) this.copyPath(record.workspaceId, copy)
        records.push(record)
      } finally { await file.close() }
    }
    return records
  }

  /**
   * Publish the complete next record only after file and directory synchronization.
   * @param record - Complete next state. Publish only after fsync succeeds.
   */
  async save(record: CloudRecord): Promise<void> {
    const path = join(this.root, record.workspaceId)
    await mkdir(path, { recursive: true, mode: 0o700 })
    const temporary = join(path, '.state-' + randomUUID())
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    try { await file.writeFile(JSON.stringify(record) + '\n'); await file.sync() }
    finally { await file.close() }
    try {
      await rename(temporary, join(path, 'state.json'))
      const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { await directory.sync() } finally { await directory.close() }
    } finally { await rm(temporary, { force: true }) }
  }

  /**
   * Resolve a validated copy identity within its private Workspace directory.
   * @param id - Original workspace.
   * @param copy - Stored relative copy identity.
   * @returns Private validated copy directory.
   */
  copyPath(id: CloudRecord['workspaceId'], copy: string): string {
    if (!/^copy-[a-f0-9-]{36}$/u.test(copy)) throw new Error('Invalid workspace copy identity')
    return join(this.root, id, copy)
  }

  /**
   * Prepare an empty file view for a Workspace that has not opened a VM.
   * @param id - Original workspace.
   * @returns A private empty read-only copy before any VM has been created.
   */
  async emptyCopy(id: CloudRecord['workspaceId']): Promise<string> {
    const copy = 'copy-' + randomUUID()
    await mkdir(join(this.root, id), { recursive: true, mode: 0o700 })
    await mkdir(this.copyPath(id, copy), { mode: 0o700 })
    return copy
  }

  /**
   * Import pre-migration registered files once; interrupted matching uploads can be resumed.
   * @param record - Original new workspace, not a restored snapshot.
   * @param files - Verified new VM's binary service.
   * @param maxBytes - Aggregate byte limit.
   * @param maxFiles - Aggregate entry limit.
   * @param signal - Initial preparation lifetime.
   */
  async seed(record: CloudRecord, files: SshWorkspaceFiles, maxBytes: number, maxFiles: number, signal: AbortSignal): Promise<void> {
    let entries = 0
    let bytes = 0
    const scan = async (path: string): Promise<void> => {
      const listing = await listArtifacts(record.project, path, Math.min(maxFiles, 100_000), signal)
      if (listing.truncated) throw new Error('Initial workspace entry budget exceeded')
      for (const entry of listing.entries) {
        if (++entries > maxFiles) throw new Error('Initial workspace entry budget exceeded')
        if (artifactComponents(entry.name).length !== 1) throw new Error('Workspace copy received an invalid leaf name')
        const child = path === '' ? entry.name : path + '/' + entry.name
        if (entry.kind === 'directory') { await files.mkdir(child, signal); await scan(child); continue }
        const file = await openArtifact(record.project, child, false, signal)
        const size = (await file.stat()).size
        if (size > maxBytes - bytes) { await file.close(); throw new Error('Initial workspace byte budget exceeded') }
        const source = streamArtifact(file, size, signal, () => { signal.throwIfAborted() })
        const reader = source.body.getReader()
        const digest = createHash('sha256')
        const chunks = (async function* () {
          try {
            while (true) {
              const next = await reader.read()
              if (next.done) return
              digest.update(next.value)
              yield next.value
            }
          } finally { await reader.cancel(); reader.releaseLock(); await source.settled }
        })()
        try { await files.upload(entry.name, chunks, maxBytes - bytes, signal, () => { signal.throwIfAborted() }, path) }
        catch (error) {
          if (!(error instanceof UploadFailure && error.reason === 'exists')) throw error
          const remote = await files.download(child, size, signal, () => { signal.throwIfAborted() })
          const compare = createHash('sha256')
          const reader = remote.body.getReader()
          try { while (true) { const next = await reader.read(); if (next.done) break; compare.update(next.value) } }
          finally { await reader.cancel(); reader.releaseLock(); await remote.settled }
          if (remote.bytes !== size || compare.digest('hex') !== digest.digest('hex')) throw new Error('Interrupted initial upload conflicts with remote data')
        }
        bytes += size
      }
    }
    await scan('')
  }

  /**
   * Refuse state storage reachable from the registered execution project.
   * @param project - Registered project root. Refuse state storage reachable from that execution mount.
   */
  outside(project: string): void {
    const path = relative(project, this.root)
    if (path === '' || (!path.startsWith('../') && path !== '..'
      && !isAbsolute(path))) throw new Error('Cloud stateRoot must be outside workspace projects')
  }

  /**
   * Copy regular files from the quiescent original helper, without following symlinks.
   * @param record - Captured cloud generation.
   * @param files - Original connection's binary service.
   * @param maxBytes - Aggregate byte budget.
   * @param maxFiles - Aggregate file/directory budget.
   * @param signal - Close operation lifetime.
   * @returns Durable unpublished copy identity; publication belongs to completed snapshot metadata.
   */
  async copy(record: CloudRecord, files: SshWorkspaceFiles, maxBytes: number, maxFiles: number, signal: AbortSignal): Promise<string> {
    const copy = 'copy-' + randomUUID()
    const root = this.copyPath(record.workspaceId, copy)
    await mkdir(root, { mode: 0o700 })
    let bytes = 0
    let entries = 0
    const scan = async (path: string): Promise<void> => {
      const listing = await files.list(path, Math.min(maxFiles, 100_000), signal)
      if (listing.truncated) throw new Error('Workspace copy entry budget exceeded')
      for (const entry of listing.entries) {
        signal.throwIfAborted()
        if (++entries > maxFiles) throw new Error('Workspace copy entry budget exceeded')
        if (artifactComponents(entry.name).length !== 1) throw new Error('Workspace copy received an invalid leaf name')
        const child = path === '' ? entry.name : path + '/' + entry.name
        if (entry.kind === 'directory') { await mkdir(join(root, child), { mode: 0o700 }); await scan(child) }
        else {
          const stream = await files.download(child, Math.max(0, maxBytes - bytes), signal, () => { signal.throwIfAborted() })
          const reader = stream.body.getReader()
          let destination: FileHandle | undefined
          try {
            destination = await open(join(root, child),
              constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
            let copied = 0
            while (true) {
              signal.throwIfAborted()
              const next = await reader.read()
              if (next.done) break
              copied += next.value.byteLength
              if (copied > maxBytes - bytes) throw new Error('Workspace copy byte budget exceeded')
              await destination.writeFile(next.value)
            }
            if (copied !== stream.bytes) throw new Error('Workspace copy extent changed')
            await destination.sync()
            bytes += copied
          } finally {
            try { await destination?.close() }
            finally { await reader.cancel(); reader.releaseLock(); await stream.settled }
          }
        }
      }
      const directory = await open(join(root, path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { await directory.sync() } finally { await directory.close() }
    }
    try { await scan(''); return copy }
    catch (error) { await rm(root, { recursive: true, force: true }); throw error }
  }
}
