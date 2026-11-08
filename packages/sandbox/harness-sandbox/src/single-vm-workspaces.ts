/** Persistent directories and shared task identities for VFS workspace modes. */
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { WorkspaceFileScope } from '@deepseek-ai/dsh-fs/workspace-access'
import { WorkspaceModeError } from '@deepseek-ai/dsh-workspace'
import type { Workspace, WorkspaceId, WorkspaceModeChange, WorkspaceModeChangeId } from '@deepseek-ai/dsh-workspace/types'
import type { WorkspaceModeCopyLimits } from './mode-copy.ts'
import { WorkspaceModeDirectoryFiles, type WorkspaceModeDirectory } from './mode-directory-files.ts'
import { WorkspaceModeDirectoryResources } from './mode-directory-resources.ts'
import type { WorkspaceModeTarget } from './mode-routing.ts'

/** Trusted Linux deployment coordinates and reserved task user/group numbers. */
export interface SingleVmWorkspaceConfig {
  readonly projectRoot: string
  readonly mountPoint: string
  readonly mountTag: string
  readonly workspaceRoot: string
  readonly stateRoot: string
  /** Each number is both a task UID and GID. The Web process belongs to all listed groups. */
  readonly taskIds: readonly number[]
}

/** A verified host directory, its path inside the volume, and its stable task identity. */
export interface SingleVmWorkspaceDirectory extends WorkspaceModeDirectory {
  readonly volumePath: string
  readonly uid: number
  readonly gid: number
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith('../')
}

function directory(path: string) {
  const info = lstatSync(path, { throwIfNoEntry: false })
  if (info !== undefined && (!info.isDirectory() || realpathSync(path) !== path)) {
    throw new Error('Single VM workspace path is not a canonical directory: ' + path)
  }
  return info
}

function mountField(value: string): string {
  return value.replace(/\\([0-7]{3})/gu, (_, code: string) => String.fromCharCode(Number.parseInt(code, 8)))
}

/** Resolve only registered VFS directories and retain their identities across provider restarts. */
export class SingleVmWorkspaces {
  /** Serve Web uploads, listings and downloads from the verified VFS directory. */
  readonly files: WorkspaceModeDirectoryFiles
  private readonly webUid: number
  private readonly taskIds: readonly number[]

  /**
   * @param config - Volume, registration, and private identity storage coordinates.
   * @param getWorkspace - Authoritative registry lookup by workspace ID.
   */
  constructor(private readonly config: SingleVmWorkspaceConfig,
    private readonly getWorkspace: (id: WorkspaceId) => Pick<Workspace, 'path'> | undefined) {
    const uid = process.getuid?.()
    if (process.platform !== 'linux' || uid === undefined || uid === 0) throw new Error('Single VM workspaces require a non-root Linux Web process')
    this.webUid = uid
    for (const root of [config.projectRoot, config.mountPoint, config.workspaceRoot, config.stateRoot]) {
      if (!isAbsolute(root) || resolve(root) !== root) throw new Error('Single VM roots must be canonical absolute paths')
    }
    if (dirname(config.workspaceRoot) !== config.mountPoint || contains(config.mountPoint, config.projectRoot)
      || contains(config.projectRoot, config.mountPoint) || contains(config.mountPoint, config.stateRoot)
      || contains(config.projectRoot, config.stateRoot) || !/^[0-9]+$/u.test(config.mountTag)) {
      throw new Error('Single VM requires separate registration, VFS and private state paths')
    }
    const primaryGroup = process.getgid?.()
    const groups = new Set(process.getgroups?.())
    this.taskIds = [...new Set(config.taskIds)]
    if (this.taskIds.length === 0 || this.taskIds.some(id => !Number.isInteger(id) || id <= 0 || id >= 0xffff_ffff
      || id === uid || id === primaryGroup || !groups.has(id))) throw new Error('Single VM task IDs must be reserved supplementary groups')
    mkdirSync(config.stateRoot, { mode: 0o700, recursive: true })
    const state = directory(config.stateRoot)
    if (state === undefined || state.uid !== uid || (state.mode & 0o077) !== 0) {
      throw new Error('Single VM identity storage must be private to Web')
    }
    using db = this.database()
    db.exec(`
      CREATE TABLE IF NOT EXISTS identities (workspace TEXT PRIMARY KEY, project TEXT NOT NULL UNIQUE, task INTEGER NOT NULL UNIQUE) STRICT;
      CREATE TABLE IF NOT EXISTS identity_reservations (
        workspace TEXT PRIMARY KEY REFERENCES identities(workspace) ON DELETE CASCADE, change_id TEXT NOT NULL
      ) STRICT;
    `)
    this.files = new WorkspaceModeDirectoryFiles(scope => Promise.resolve(this.resolve(scope)))
  }

  /**
   * Keep cloud management files outside both roots that can contain workspace data.
   * @param path - Canonical deployment-owned file or directory.
   */
  assertOutside(path: string): void {
    if (contains(this.config.projectRoot, path) || contains(this.config.mountPoint, path)) {
      throw new Error('Single VM management files must be outside workspace mounts')
    }
  }

  /**
   * Verify the registered direct child and recover the task identity for this VM allocation or file request.
   * @param scope - Original workspace authority and operation lifetime.
   * @returns Current host directory and volume path with a reusable admission check.
   */
  resolve(scope: WorkspaceFileScope): SingleVmWorkspaceDirectory {
    const location = this.location(scope)
    const id = this.identity(scope.workspaceId, scope.project)
    const initial = this.ownedDirectory(location.root, id)
    if (initial === undefined) throw new Error('Single VM workspace directory is missing')
    const assertCurrent = (): void => {
      location.assertCurrent()
      const current = this.ownedDirectory(location.root, id)
      if (current === undefined || current.dev !== initial.dev || current.ino !== initial.ino) {
        throw new Error('Single VM workspace directory changed')
      }
    }
    assertCurrent()
    return { ...location, uid: id, gid: id, assertCurrent }
  }

  /**
   * Register VFS file preservation in the workspace mode transition runtime.
   * @param mode - VM mode using this shared identity store and volume directory.
   * @param backend - VM execution provider used for source quiescence.
   * @param limits - Deployment limits on complete directory copies.
   * @returns Resources for the selected VM mode. Switching VM modes retains the workspace identity.
   */
  resources(mode: 'single-vm' | 'multi-vm', backend: WorkspaceModeTarget['execution'], limits: WorkspaceModeCopyLimits): WorkspaceModeDirectoryResources {
    return new WorkspaceModeDirectoryResources({
      ...limits, backend, mode, stateRoot: join(this.config.stateRoot, 'modes'), shareWithGroup: true,
      directory: (change, signal) => {
        const scope = { workspaceId: change.workspaceId, project: change.project, signal, admit() {} }
        const location = this.location(scope)
        const assertCurrent = (): void => {
          location.assertCurrent()
          if (directory(location.root) !== undefined) {
            this.ownedDirectory(location.root, this.identity(change.workspaceId, change.project, change.changeId))
          } else if (change.from === mode) throw new Error('VFS source directory is missing')
        }
        return Promise.resolve({ ...location, assertCurrent })
      },
      prepareDestination: (change, destination) => {
        destination.assertCurrent()
        const id = this.identity(change.workspaceId, change.project, change.changeId, true)
        return this.ownedDirectory(destination.root, id) === undefined ? { uid: this.webUid, gid: id, rootMode: 0o2770 } : undefined
      },
      published: (change, signal) => {
        signal.throwIfAborted()
        using db = this.database()
        db.prepare('DELETE FROM identity_reservations WHERE workspace = ? AND change_id = ?').run(change.workspaceId, change.changeId)
      },
      discarded: (change, signal) => { this.discardReservation(change, signal) },
    })
  }

  private location(scope: WorkspaceFileScope): WorkspaceModeDirectory & { readonly volumePath: string } {
    scope.signal.throwIfAborted()
    scope.admit()
    const { projectRoot, workspaceRoot, mountPoint } = this.config
    const workspace = this.getWorkspace(scope.workspaceId)
    if (workspace === undefined || workspace.path !== scope.project || dirname(scope.project) !== projectRoot
      || resolve(scope.project) !== scope.project || directory(scope.project) === undefined) {
      throw new Error('Single VM workspace is not a registered direct child')
    }
    const root = join(workspaceRoot, basename(scope.project))
    const mount = this.mountId(root)
    const assertCurrent = (): void => {
      scope.signal.throwIfAborted()
      scope.admit()
      if (this.getWorkspace(scope.workspaceId) !== workspace) throw new Error('Single VM workspace registration changed')
      if (this.mountId(root) !== mount) throw new Error('Single VM VFS mount changed')
      const parent = directory(workspaceRoot)
      if (parent === undefined || parent.uid !== this.webUid || (parent.mode & 0o7777) !== 0o711) {
        throw new Error('Single VM VFS workspace parent must belong to Web with mode 0711')
      }
    }
    assertCurrent()
    return { root, volumePath: '/' + relative(mountPoint, root), assertCurrent }
  }

  private mountId(root: string): string {
    const { mountPoint, mountTag } = this.config
    const candidates = readFileSync('/proc/self/mountinfo', 'utf8').trimEnd().split('\n').filter((line) => {
      const target = mountField(line.split(' ', 6)[4] ?? '')
      return contains(mountPoint, target) && contains(target, root)
    })
    const fields = candidates[0]?.split(' ')
    const separator = fields?.indexOf('-') ?? -1
    const volume = directory(mountPoint)
    if (candidates.length !== 1 || fields === undefined || fields[0] === undefined || separator < 6
      || fields[3] !== '/' || mountField(fields[4] ?? '') !== mountPoint || fields[separator + 1] !== 'virtiofs'
      || fields[separator + 2] !== mountTag || volume === undefined) {
      throw new Error('Single VM VFS mount does not match the expected virtiofs volume')
    }
    if (volume.uid !== 0 && volume.uid !== this.webUid || (volume.mode & 0o022) !== 0) {
      throw new Error('Single VM VFS volume root must be protected by its administrator or Web owner')
    }
    return fields[0]
  }

  private ownedDirectory(root: string, task: number) {
    const info = directory(root)
    if (info !== undefined && (info.uid !== this.webUid || info.gid !== task || (info.mode & 0o7777) !== 0o2770)) {
      throw new Error('Single VM VFS directory has unexpected task ownership or permissions')
    }
    return info
  }

  private database(): DatabaseSync {
    return new DatabaseSync(join(this.config.stateRoot, 'identities.sqlite'), { timeout: 5000 })
  }

  private identity(id: WorkspaceId, project: string, changeId?: WorkspaceModeChangeId, allocate = false): number {
    using db = this.database()
    if (allocate) db.exec('BEGIN IMMEDIATE')
    const binding = db.prepare(`
      SELECT project, task, change_id FROM identities LEFT JOIN identity_reservations USING (workspace) WHERE workspace = ?
    `).get(id)
    if (binding !== undefined) {
      const task = binding.task
      if (binding.project !== project || typeof task !== 'number' || !this.taskIds.includes(task)) {
        throw new Error('Single VM task identity conflicts with the workspace registration or configured groups')
      }
      if (binding.change_id !== null && binding.change_id !== changeId) {
        throw new Error('Single VM task identity is reserved by another transition')
      }
      if (allocate) db.exec('COMMIT')
      return task
    }
    if (!allocate || changeId === undefined) throw new Error('Single VM workspace has no bound task identity')
    const occupied = new Set(db.prepare('SELECT task FROM identities').all().map(row => row.task))
    const task = this.taskIds.find(candidate => !occupied.has(candidate))
    if (task === undefined) throw new WorkspaceModeError('workspace/mode-single-vm-capacity', { workspaceId: id })
    db.prepare('INSERT INTO identities (workspace, project, task) VALUES (?, ?, ?)').run(id, project, task)
    db.prepare('INSERT INTO identity_reservations (workspace, change_id) VALUES (?, ?)').run(id, changeId)
    db.exec('COMMIT')
    return task
  }

  private discardReservation(change: WorkspaceModeChange, signal: AbortSignal): void {
    signal.throwIfAborted()
    using db = this.database()
    const reservation = db.prepare('SELECT change_id FROM identity_reservations WHERE workspace = ?').get(change.workspaceId)
    if (reservation?.change_id !== change.changeId) return
    const { root } = this.location({ workspaceId: change.workspaceId, project: change.project, signal, admit() {} })
    if (directory(root) !== undefined) throw new Error('Single VM task identity still has a published directory')
    db.prepare(`
      DELETE FROM identities WHERE workspace = ? AND project = ? AND EXISTS (
        SELECT 1 FROM identity_reservations WHERE workspace = identities.workspace AND change_id = ?
      )
    `).run(change.workspaceId, change.project, change.changeId)
  }
}
