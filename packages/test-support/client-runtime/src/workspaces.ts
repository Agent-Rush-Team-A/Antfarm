/** Test-owned workspaces face: the renderer standard-kit observable plus recorded actions. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  IWorkspaces, WorkspaceId, WorkspaceModeOptionsValue, WorkspaceSnapshot, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { WorkspaceMode, WorkspaceModeConfig } from '@deepseek-ai/dsh-workspace/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { workspaceSnapshot } from './fixtures.ts'
import type { FixtureSnapshot, Stabilizer } from './fixtures.ts'

/** Writable test representation of the immutable Workspace Controller snapshot. */
type WorkspaceFixtureSnapshot = FixtureSnapshot<WorkspaceSnapshot>

/** Callable command names on the production Workspace Controller face. */
type WorkspaceAction = {
  [Key in keyof IWorkspaces]: IWorkspaces[Key] extends (...args: never[]) => unknown ? Key : never
}[keyof IWorkspaces]

/** Test replacement retaining one Controller command's parameters and result. */
type WorkspaceStub<Key extends WorkspaceAction> = (
  ...args: Parameters<IWorkspaces[Key]>
) => ReturnType<IWorkspaces[Key]>

/**
 * Workspaces test double. Implements the same IWorkspaces face features
 * receive as `ctx.workspaces`, so a production face change breaks this
 * double at compile time. Every action records into {@link
 * TestWorkspaces.calls}; defaults are inert echoes — feature tests needing
 * richer behavior replace them via {@link TestWorkspaces.stub}.
 */
export class TestWorkspaces implements IWorkspaces {
  /** The useWorkspaces standard feed. */
  readonly list: SnapshotStore<WorkspaceFixtureSnapshot>

  /** Calls observed on the action face, newest last. */
  readonly calls: { method: string; args: unknown[] }[] = []

  /** Replaceable action seat: feature tests may stub richer behavior. */
  private readonly stubs = new Map<WorkspaceAction, (...args: unknown[]) => unknown>()

  /**
   * @param stabilize - the owning runtime's act wrapper.
   */
  constructor(private readonly stabilize: Stabilizer) {
    this.list = createSnapshotStore<WorkspaceFixtureSnapshot>({ ...workspaceSnapshot() })
  }

  /**
   * Update the workspace list state through an immer draft.
   * @param mutate - draft mutator.
   */
  async update(mutate: (draft: WorkspaceFixtureSnapshot) => void): Promise<void> {
    await this.stabilize(() => { this.list.update(mutate) })
  }

  /**
   * Replace an action's behavior (the recorded call is still appended first).
   * @param method - Controller action name (e.g. 'create').
   * @param impl - replacement behavior.
   */
  stub<Key extends WorkspaceAction>(method: Key, impl: WorkspaceStub<Key>): void {
    this.stubs.set(method, impl as (...args: unknown[]) => unknown)
  }

  /**
   * @param workspaceId - Target Workspace.
   * @returns stubbed or fixture mode metadata.
   */
  async getMode(workspaceId: WorkspaceId): Promise<WorkspaceModeConfig & Pick<WorkspaceModeOptionsValue, 'availableModes'>> {
    this.calls.push({ method: 'getMode', args: [workspaceId] })
    const stub = this.stubs.get('getMode')
    if (stub !== undefined) return await (stub(workspaceId) as ReturnType<IWorkspaces['getMode']>)
    const config = this.list.getSnapshot().items.find(workspace => workspace.workspaceId === workspaceId)?.modeConfig
      ?? { workspaceId, mode: 'multi-vm', revision: 0, operationState: 'ready', modeLocked: false, lockReason: null, firstSessionId: null }
    return { ...config, availableModes: ['single-vm', 'multi-vm', 'single-docker', 'multi-docker'] }
  }

  /**
   * @param workspaceId - Target Workspace.
   * @param mode - Requested mode.
   * @param expectedRevision - Observed revision.
   * @param signal - Caller cancellation.
   * @returns stubbed or inert mode echo.
   */
  async setMode(
    workspaceId: WorkspaceId, mode: WorkspaceMode, expectedRevision: number, signal?: AbortSignal,
  ): Promise<WorkspaceModeConfig> {
    this.calls.push({ method: 'setMode', args: [workspaceId, mode, expectedRevision, signal] })
    const stub = this.stubs.get('setMode')
    if (stub !== undefined) return await (stub(workspaceId, mode, expectedRevision, signal) as Promise<WorkspaceModeConfig>)
    return { workspaceId, mode, revision: expectedRevision + 3, operationState: 'ready', modeLocked: false, lockReason: null, firstSessionId: null }
  }

  /**
   * Create a Workspace (recorded). The default echoes a view derived from
   * the input; stub for failure or list-coupled flows.
   * @param input - the Host create payload.
   * @returns the created Workspace view.
   */
  async create(input: { path: string }): Promise<WorkspaceView> {
    this.calls.push({ method: 'create', args: [input] })
    const stub = this.stubs.get('create')
    if (stub !== undefined) return await (stub(input) as Promise<WorkspaceView>)
    return {
      workspaceId: `ws-${input.path}` as WorkspaceId,
      title: input.path,
      path: input.path,
      sessionIds: [],
    } as unknown as WorkspaceView
  }

  /**
   * Initialize the default Workspace through a test stub; defaults to an ineligible first use.
   * @param signal - caller lifetime.
   * @returns the stubbed Workspace, or undefined when initialization is ineligible.
   */
  async initializeDefault(signal?: AbortSignal): Promise<WorkspaceView | undefined> {
    this.calls.push({ method: 'initializeDefault', args: [signal] })
    const stub = this.stubs.get('initializeDefault')
    return await (stub?.(signal) as Promise<WorkspaceView | undefined> | undefined)
  }

  /**
   * Rename a Workspace (recorded). The default echoes a minimal view.
   * @param workspaceId - target workspace.
   * @param title - new title.
   * @returns the updated view.
   */
  async rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView> {
    this.calls.push({ method: 'rename', args: [workspaceId, title] })
    const stub = this.stubs.get('rename')
    if (stub !== undefined) return await (stub(workspaceId, title) as Promise<WorkspaceView>)
    return { workspaceId, title, path: `/${title}`, sessionIds: [] } as unknown as WorkspaceView
  }

  /**
   * Delete a Workspace (recorded; default no-op).
   * @param workspaceId - target workspace.
   */
  async delete(workspaceId: WorkspaceId): Promise<void> {
    this.calls.push({ method: 'delete', args: [workspaceId] })
    await (this.stubs.get('delete')?.(workspaceId) as Promise<void> | undefined)
  }

  /**
   * Move a Workspace in display order (recorded; default no-op).
   * @param workspaceId - Workspace to move.
   * @param beforeWorkspaceId - Anchor; omitted appends.
   */
  async insertBefore(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<void> {
    this.calls.push({ method: 'insertBefore', args: [workspaceId, beforeWorkspaceId] })
    await (this.stubs.get('insertBefore')?.(workspaceId, beforeWorkspaceId) as Promise<void> | undefined)
  }

  /**
   * Move an accounted session (recorded). The default echoes a minimal view.
   * @param workspaceId - target workspace.
   * @param sessionId - session to move.
   * @param beforeSessionId - anchor; omitted appends.
   * @returns the updated view.
   */
  async insertSessionBefore(workspaceId: WorkspaceId, sessionId: SessionId, beforeSessionId?: SessionId): Promise<WorkspaceView> {
    this.calls.push({ method: 'insertSessionBefore', args: [workspaceId, sessionId, beforeSessionId] })
    const stub = this.stubs.get('insertSessionBefore')
    if (stub !== undefined) return await (stub(workspaceId, sessionId, beforeSessionId) as Promise<WorkspaceView>)
    return { workspaceId, title: '', path: '', sessionIds: [sessionId] } as unknown as WorkspaceView
  }

  /**
   * Archive a session (recorded). The default mirrors the production face's
   * observable effect: the id joins the list state's archive set.
   * @param sessionId - session to archive.
   */
  async archiveSession(sessionId: SessionId): Promise<void> {
    this.calls.push({ method: 'archiveSession', args: [sessionId] })
    const stub = this.stubs.get('archiveSession')
    if (stub !== undefined) {
      await (stub(sessionId) as Promise<void>)
      return
    }
    await this.update((draft) => {
      draft.archivedSessionIds = [...draft.archivedSessionIds, sessionId]
    })
  }

  /**
   * Unarchive a session (recorded). The default mirrors the production face's
   * observable effect: the id leaves the list state's archive set.
   * @param sessionId - session to unarchive.
   */
  async unarchiveSession(sessionId: SessionId): Promise<void> {
    this.calls.push({ method: 'unarchiveSession', args: [sessionId] })
    const stub = this.stubs.get('unarchiveSession')
    if (stub !== undefined) {
      await (stub(sessionId) as Promise<void>)
      return
    }
    await this.update((draft) => {
      draft.archivedSessionIds = draft.archivedSessionIds.filter(id => id !== sessionId)
    })
  }

  /**
   * Pin a session (recorded). The default mirrors the production face's
   * observable effect: the id leads the list state's pin set.
   * @param sessionId - session to pin.
   */
  async pinSession(sessionId: SessionId): Promise<void> {
    this.calls.push({ method: 'pinSession', args: [sessionId] })
    const stub = this.stubs.get('pinSession')
    if (stub !== undefined) {
      await (stub(sessionId) as Promise<void>)
      return
    }
    await this.update((draft) => {
      draft.pinnedSessionIds = [
        sessionId,
        ...draft.pinnedSessionIds.filter(id => id !== sessionId),
      ]
    })
  }

  /**
   * Unpin a session (recorded). The default mirrors the production face's
   * observable effect: the id leaves the list state's pin set.
   * @param sessionId - session to unpin.
   */
  async unpinSession(sessionId: SessionId): Promise<void> {
    this.calls.push({ method: 'unpinSession', args: [sessionId] })
    const stub = this.stubs.get('unpinSession')
    if (stub !== undefined) {
      await (stub(sessionId) as Promise<void>)
      return
    }
    await this.update((draft) => {
      draft.pinnedSessionIds = draft.pinnedSessionIds.filter(id => id !== sessionId)
    })
  }
}
