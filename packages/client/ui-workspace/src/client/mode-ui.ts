/** Registration-owned configuration gestures and settled Remote operations. */
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { IWorkspaces, WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { WorkspaceMode } from '@deepseek-ai/dsh-workspace/types'
import { modeFailureKey } from './mode-errors.ts'
import { ModeOverlay, type ModeDialogInjected, type ModeSelection } from './ModeDialog.tsx'

/** Configuration request capability consumed by Workspace navigation. */
export interface ModeControls {
  /** @param workspaceId - Captured Workspace. @param begin - Explicit first-Session continuation, when offered. */
  request(workspaceId: WorkspaceId, begin?: () => void): void
}

/**
 * Install the overlay and menu independently of optional execution providers.
 * @param ctx - Workspace plugin context.
 * @param workspaces - Authoritative client projection and mode commands.
 * @param preferredMode - Mode to preselect when the runtime offers it for a new Workspace.
 * @returns Configuration gestures for the Workspace row and first-Session flow.
 */
export function registerModeUi(ctx: Context, workspaces: IWorkspaces, preferredMode: WorkspaceMode): ModeControls {
  const selection = createSnapshotStore<ModeSelection | null>(null)
  const pending = createSnapshotStore<readonly WorkspaceId[]>([])
  const lifetime = new AbortController()
  const operations = new Set<Promise<unknown>>()
  let epoch = 0
  let continuation: (() => void) | undefined
  let leaveAccess: (() => void) | undefined
  const allowed = (id: WorkspaceId, action: 'workspace/getMode' | 'workspace/setMode' | 'session/create') =>
    !lifetime.signal.aborted && ctx.remoteAccess.source('workspace', id, action).getSnapshot()
  const dismiss = (): void => {
    epoch++
    leaveAccess?.(); leaveAccess = undefined
    continuation = undefined
    selection.set(null)
  }
  const track = <T>(operation: Promise<T>): Promise<T> => {
    operations.add(operation)
    void operation.then(() => { operations.delete(operation) }, () => { operations.delete(operation) })
    return operation
  }
  const actions: ModeDialogInjected = {
    preferredMode,
    hooks: { modeSelection: selection, modePending: pending },
    dismissMode: dismiss,
    refreshMode: (id) => {
      if (!allowed(id, 'workspace/getMode')) return
      const requestEpoch = epoch
      void track(workspaces.getMode(id).then(({ availableModes }) => {
        const current = selection.getSnapshot()
        if (epoch === requestEpoch && current?.workspaceId === id) {
          selection.set({ workspaceId: id, startsSession: current.startsSession, availableModes })
        }
      }).catch((error: unknown) => {
        const current = selection.getSnapshot()
        if (!lifetime.signal.aborted && epoch === requestEpoch && current?.workspaceId === id) {
          selection.set({ ...current, queryFailure: modeFailureKey(error) })
        }
      }))
    },
    saveMode: async (id, mode, revision) => {
      if (!allowed(id, 'workspace/setMode') || pending.getSnapshot().includes(id)) return false
      const requestEpoch = epoch
      const current = () => {
        const target = selection.getSnapshot()
        return requestEpoch === epoch && target?.workspaceId === id ? target : null
      }
      const active = current()
      if (active !== null) selection.set({ workspaceId: id, startsSession: active.startsSession,
        ...active.availableModes === undefined ? {} : { availableModes: active.availableModes } })
      pending.set([...pending.getSnapshot(), id])
      return track((async () => {
        try {
          await workspaces.setMode(id, mode, revision, lifetime.signal)
          if (!allowed(id, 'workspace/getMode')) return false
          ctx.contextMenus.notify(ctx.locale.bind('workspace')('mode.saved'), true)
          return true
        } catch (error: unknown) {
          if (!allowed(id, 'workspace/getMode')) return false
          const saveFailure = modeFailureKey(error)
          const target = current()
          if (target === null) {
            ctx.contextMenus.notify(ctx.locale.bind('workspace')(saveFailure), false)
            return false
          }
          selection.set({ ...target, saveFailure })
          if (saveFailure === 'mode.conflict') return false
          try {
            const { availableModes } = await workspaces.getMode(id)
            const refreshed = current()
            if (refreshed !== null) selection.set({ ...refreshed, availableModes })
            return saveFailure === 'mode.singleVmCapacity'
          } catch (refreshError) {
            const refreshed = current()
            if (refreshed !== null) selection.set({ ...refreshed, queryFailure: modeFailureKey(refreshError) })
            return false
          }
        } finally {
          if (!lifetime.signal.aborted) pending.set(pending.getSnapshot().filter(value => value !== id))
        }
      })())
    },
    beginModeSession: () => {
      const current = selection.getSnapshot()
      if (current === null || pending.getSnapshot().includes(current.workspaceId)
        || current.availableModes === undefined || current.queryFailure !== undefined || !allowed(current.workspaceId, 'session/create')) return
      const row = workspaces.list.getSnapshot().items.find(item => item.workspaceId === current.workspaceId)
      if (row?.modeConfig.operationState !== 'ready') return
      const begin = continuation
      dismiss()
      begin?.()
    },
  }
  const controls: ModeControls = {
    request: (id, begin) => {
      if (!allowed(id, 'workspace/getMode') || !workspaces.list.getSnapshot().items.some(row => row.workspaceId === id)) return
      dismiss()
      continuation = begin
      selection.set({ workspaceId: id, startsSession: begin !== undefined })
      leaveAccess = ctx.remoteAccess.whenResourceAccess('workspace', id, 'workspace/getMode', () => dismiss)
      actions.refreshMode(id)
    },
  }
  ctx.effect(() => workspaces.list.subscribe(() => {
    const current = selection.getSnapshot()
    if (current !== null && !workspaces.list.getSnapshot().items.some(row => row.workspaceId === current.workspaceId)) dismiss()
  }), 'workspace modes: selection lifetime')
  ctx.effect(() => async () => {
    lifetime.abort(); dismiss()
    while (operations.size > 0) await Promise.allSettled([...operations])
  }, 'workspace modes: operations')
  ctx.effect(() => ctx.contextMenus.register({ id: 'workspace.mode', target: 'workspace', order: 180,
    observe: ({ workspaceId }) => [workspaces.list, ctx.remoteAccess.source('workspace', workspaceId, 'workspace/getMode')],
    resolve: ({ workspaceId }) => allowed(workspaceId, 'workspace/getMode')
      ? [{ id: 'configure', label: ctx.locale.bind('workspace')('mode.title'), run: () => { controls.request(workspaceId) } }] : [],
  }), 'workspace modes: menu')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'workspace.mode',
    locale: 'workspace', inject: () => actions }, ModeOverlay))
  return controls
}
