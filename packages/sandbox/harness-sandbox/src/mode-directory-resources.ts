/** Durable mode checkpoints and same-filesystem publication beneath an exclusive workspace coordinator. */
import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { z } from 'zod'
import type { WorkspaceMode, WorkspaceModeChange, WorkspaceModeConfig } from '@deepseek-ai/dsh-workspace/types'
import type { WorkspaceModeResources, WorkspaceModeCheckpoint } from './mode-runtime.ts'
import type { WorkspaceModeTarget } from './mode-routing.ts'
import type { WorkspaceModeDirectory } from './mode-directory-files.ts'
import { copyWorkspaceDirectory, type WorkspaceModeCopyLimits } from './mode-copy.ts'

/** Explicit deployment roots, copy budgets and provider-specific VM preservation hooks. */
export interface WorkspaceModeDirectoryResourceConfig extends WorkspaceModeCopyLimits {
  readonly stateRoot: string
  readonly mode: WorkspaceMode
  readonly backend: WorkspaceModeTarget['execution']
  /** Resolve the immutable directory mapping and verify its parent/mount, including publication recovery. */
  directory(change: WorkspaceModeChange, signal: AbortSignal): Promise<WorkspaceModeDirectory>
  /** Prepare the destination before recording its ownership for the staged copy. */
  prepareDestination?(change: WorkspaceModeChange, directory: WorkspaceModeDirectory): void | Promise<void>
  /** Give copied files and directories access for the destination's task group. */
  readonly shareWithGroup?: true
  /** Omitted for bind directories; VM providers return their completed read-only file copy after closure. */
  checkpointRoot?(change: WorkspaceModeChange, signal: AbortSignal): Promise<string>
  /** Omitted for bind directories; VM providers replace their closed file view and obsolete snapshots. */
  published?(change: WorkspaceModeChange, signal: AbortSignal): Promise<void>
  /** Omitted when the source has no external saved resources; VM providers retire obsolete snapshots. */
  retired?(change: WorkspaceModeChange, signal: AbortSignal): Promise<void>
}

const journalSchema = z.strictObject({
  format: z.literal(1), changeId: z.string(), workspaceId: z.string(), project: z.string(), from: z.string(), to: z.string(),
  previousRevision: z.number().int().nonnegative(), root: z.string(),
  role: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('source'), phase: z.enum(['checkpointing', 'checkpointed', 'restored', 'retired']), wasRunning: z.boolean() }),
    z.strictObject({ kind: z.literal('target'), phase: z.enum(['staging', 'staged', 'publishing', 'published', 'discarded']),
      uid: z.number().int().nonnegative(), gid: z.number().int().nonnegative(), rootMode: z.number().int().min(0).max(0o3777),
      shareWithGroup: z.literal(true).optional() }),
  ]),
})
type Journal = z.infer<typeof journalSchema>

/** Retains checkpoints and journals until a confirmed ready coordinator revision permits collection. */
export class WorkspaceModeDirectoryResources implements WorkspaceModeResources {
  /** @param config - Verified directory mapping, explicit limits and independently owned provider. */
  constructor(private readonly config: WorkspaceModeDirectoryResourceConfig) {
    z.object({ stateRoot: z.string(), maxFiles: z.number().int().positive(), maxBytes: z.number().int().positive() }).parse(config)
    if (!isAbsolute(config.stateRoot)) throw new Error('Mode resource stateRoot must be absolute')
  }

  async checkpoint(change: WorkspaceModeChange, signal: AbortSignal): Promise<WorkspaceModeCheckpoint> {
    const directory = await this.directory(change, signal)
    let journal = await this.load(change)
    if (journal === undefined) {
      const status = await this.config.backend.status(change.workspaceId)
      if (status.state !== 'running' && status.state !== 'closed') throw new Error('Workspace source is not quiescent')
      journal = this.record(change, directory.root, { kind: 'source', phase: 'checkpointing', wasRunning: status.state === 'running' })
      await this.save(change, journal)
    }
    if (journal.root !== directory.root || journal.role.kind !== 'source') throw new Error('Mode checkpoint journal conflicts')
    const root = join(this.address(change), 'checkpoint')
    if (journal.role.phase !== 'checkpointing') return { root }
    await this.config.backend.close(change.workspaceId)
    directory.assertCurrent()
    const source = this.config.checkpointRoot === undefined ? directory.root : await this.config.checkpointRoot(change, signal)
    if (!await this.exists(root)) {
      const pending = root + '.pending'
      await rm(pending, { recursive: true, force: true })
      await copyWorkspaceDirectory(source, pending, this.config, signal)
      await rename(pending, root)
      await this.sync(this.address(change))
    }
    await this.save(change, { ...journal, role: { ...journal.role, phase: 'checkpointed' } })
    return { root }
  }

  async stage(change: WorkspaceModeChange, checkpoint: WorkspaceModeCheckpoint, signal: AbortSignal): Promise<void> {
    const directory = await this.directory(change, signal)
    let journal = await this.load(change)
    if (journal === undefined) {
      await this.config.prepareDestination?.(change, directory)
      const info = await lstat(directory.root)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Mode destination directory is unavailable')
      journal = this.record(change, directory.root, {
        kind: 'target', phase: 'staging', uid: info.uid, gid: info.gid, rootMode: info.mode & 0o3777,
        ...this.config.shareWithGroup === true ? { shareWithGroup: true } : {},
      })
      await this.save(change, journal)
    }
    if (journal.root !== directory.root || journal.role.kind !== 'target') throw new Error('Mode staging journal conflicts')
    if (journal.role.phase !== 'staging') return
    const path = this.stagePath(change, journal.root)
    await rm(path, { recursive: true, force: true })
    await copyWorkspaceDirectory(checkpoint.root, path, this.config, signal, journal.role)
    directory.assertCurrent()
    await this.sync(dirname(path))
    await this.save(change, { ...journal, role: { ...journal.role, phase: 'staged' } })
  }

  async publish(change: WorkspaceModeChange, signal: AbortSignal): Promise<void> {
    const journal = await this.required(change, 'target')
    const directory = await this.directory(change, signal)
    if (journal.root !== directory.root) throw new Error('Mode publication directory changed')
    if (journal.role.phase === 'discarded' || journal.role.phase === 'staging') throw new Error('Mode destination was not staged')
    if (journal.role.phase !== 'published') await this.save(change, { ...journal, role: { ...journal.role, phase: 'publishing' } })
    const stage = this.stagePath(change, journal.root)
    const backup = stage + '.previous'
    if (await this.exists(stage)) {
      if (!await this.exists(backup)) {
        await rename(journal.root, backup)
        await this.sync(dirname(stage))
      } else if (await this.exists(journal.root)) throw new Error('Mode publication conflicts with an existing destination')
      await rename(stage, journal.root)
      await this.sync(dirname(stage))
    } else if (!await this.exists(journal.root) || !await this.exists(backup) && journal.role.phase !== 'published') {
      throw new Error('Mode publication recovery data is missing')
    }
    directory.assertCurrent()
    await this.config.published?.(change, signal)
    await this.save(change, { ...journal, role: { ...journal.role, phase: 'published' } })
  }

  async retire(change: WorkspaceModeChange, signal: AbortSignal): Promise<void> {
    const journal = await this.required(change, 'source')
    signal.throwIfAborted()
    await this.config.retired?.(change, signal)
    await this.save(change, { ...journal, role: { ...journal.role, phase: 'retired' } })
  }

  async discard(change: WorkspaceModeChange, signal: AbortSignal): Promise<void> {
    const journal = await this.load(change)
    if (journal === undefined) return
    if (journal.role.kind !== 'target' || journal.role.phase === 'published' || journal.role.phase === 'publishing') throw new Error('Committed mode files cannot be discarded')
    signal.throwIfAborted()
    await rm(this.stagePath(change, journal.root), { recursive: true, force: true })
    await this.sync(dirname(journal.root))
    await this.save(change, { ...journal, role: { ...journal.role, phase: 'discarded' } })
  }

  async restore(change: WorkspaceModeChange, signal: AbortSignal): Promise<void> {
    const journal = await this.load(change)
    if (journal === undefined) return
    if (journal.role.kind !== 'source' || journal.role.phase === 'retired') throw new Error('Retired mode resources cannot be rolled back')
    signal.throwIfAborted()
    if (journal.role.wasRunning) await this.config.backend.open(change.workspaceId, change.project)
    await this.save(change, { ...journal, role: { ...journal.role, phase: 'restored' } })
  }

  /**
   * Remove completed private evidence only after the coordinator has cleared its durable intent.
   * @param change - Original resource transition.
   * @param current - Trusted current coordinator metadata; ready and a later revision are required.
   * @returns Completed journal and backup collection; pending recovery always refuses.
   */
  async collect(change: WorkspaceModeChange, current: WorkspaceModeConfig): Promise<void> {
    if (current.workspaceId !== change.workspaceId || current.operationState !== 'ready' || current.revision <= change.previousRevision) {
      throw new Error('Mode recovery evidence is still retained by the coordinator')
    }
    const journal = await this.load(change)
    if (journal !== undefined && journal.role.kind === 'target') {
      await rm(this.stagePath(change, journal.root) + '.previous', { recursive: true, force: true })
      await this.sync(dirname(journal.root))
    }
    await rm(this.address(change), { recursive: true, force: true })
    await this.sync(this.config.stateRoot)
  }

  private async directory(change: WorkspaceModeChange, signal: AbortSignal): Promise<WorkspaceModeDirectory> {
    signal.throwIfAborted()
    const directory = await this.config.directory(change, signal)
    directory.assertCurrent()
    if (!isAbsolute(directory.root) || await realpath(dirname(directory.root)) !== dirname(directory.root)) throw new Error('Mode directory parent is not canonical')
    const child = relative(directory.root, this.config.stateRoot)
    if (child === '' || child !== '..' && !child.startsWith('../') && !isAbsolute(child)) throw new Error('Mode journals must be outside workspace files')
    return directory
  }
  private address(change: WorkspaceModeChange): string {
    return join(this.config.stateRoot, createHash('sha256').update(this.config.mode + ':' + change.changeId).digest('hex'))
  }
  private stagePath(change: WorkspaceModeChange, root: string): string {
    return join(dirname(root), '.' + basename(root) + '.mode-' + basename(this.address(change)))
  }
  private record(change: WorkspaceModeChange, root: string, role: Journal['role']): Journal {
    return { format: 1, ...change, root, role }
  }
  private async load(change: WorkspaceModeChange): Promise<Journal | undefined> {
    const path = join(this.address(change), 'state.json')
    let raw: string
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { raw = await file.readFile('utf8') } finally { await file.close() }
    }
    catch (error) { if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined; throw error }
    const journal = journalSchema.parse(JSON.parse(raw))
    for (const key of ['changeId', 'workspaceId', 'project', 'from', 'to', 'previousRevision'] as const) {
      if (journal[key] !== change[key]) throw new Error('Mode resource journal identity conflicts')
    }
    const directory = await this.config.directory(change, new AbortController().signal)
    directory.assertCurrent()
    if (journal.root !== directory.root) throw new Error('Mode resource journal directory conflicts')
    return journal
  }
  private async required<K extends Journal['role']['kind']>(change: WorkspaceModeChange, kind: K): Promise<Journal & { role: Extract<Journal['role'], { kind: K }> }> {
    const journal = await this.load(change)
    if (journal === undefined || journal.role.kind !== kind) throw new Error('Mode resource journal is unavailable')
    return { ...journal, role: journal.role as Extract<Journal['role'], { kind: K }> }
  }
  private async save(change: WorkspaceModeChange, journal: Journal): Promise<void> {
    await mkdir(this.config.stateRoot, { recursive: true, mode: 0o700 })
    if (await realpath(this.config.stateRoot) !== this.config.stateRoot) throw new Error('Mode journal root must not contain symlinks')
    const info = await lstat(this.config.stateRoot)
    if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error('Mode journal root must be private to its owner')
    await this.sync(dirname(this.config.stateRoot))
    const directory = this.address(change)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = join(directory, '.state-' + randomUUID())
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { await file.writeFile(JSON.stringify(journal) + '\n'); await file.sync() }
    finally { await file.close() }
    try { await rename(temporary, join(directory, 'state.json')); await this.sync(directory); await this.sync(this.config.stateRoot) }
    finally { await rm(temporary, { force: true }) }
  }
  private async exists(path: string): Promise<boolean> {
    try { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Mode staging path is not a real directory'); return true }
    catch (error) { if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false; throw error }
  }
  private async sync(path: string): Promise<void> {
    const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await file.sync() } finally { await file.close() }
  }
}
