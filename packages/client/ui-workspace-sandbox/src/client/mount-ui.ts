/** Optional workspace menu, conversation entry and their shared panel. */
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SandboxLauncher, SandboxOverlay, type SandboxActions, type SandboxOverlayInjected } from './Panel.tsx'
import { dictionaries } from './locales.ts'
import type { SandboxModel } from './model.ts'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { failureKey } from './failure-key.ts'
import { InlineEnvironment } from './InlineEnvironment.tsx'
import { sandboxAllowed, sandboxPermission, sandboxModeAllows } from './access.ts'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'

/**
 * Register the shared sandbox panel and permission-aware workspace entries.
 * @param ctx - Plugin-owned UI registries.
 * @param model - Workspace observations and explicit mutations.
 */
export function mountUi(ctx: Context, model: SandboxModel): void {
  const selection = createSnapshotStore<WorkspaceId | null>(null)
  ctx.effect(() => ctx.locale.register('workspaceSandbox', dictionaries), 'workspace sandbox: dictionaries')
  const t = ctx.locale.bind('workspaceSandbox')
  const menus = ctx.contextMenus
  const workspace = ctx.get('uiWorkspace') as UiWorkspace
  const workspaces = ctx.get('workspaces') as IWorkspaces
  const connection = ctx.get('connection') as ConnectionHandle
  let active = true
  let epoch = 0
  let leaveAccess: (() => void) | undefined
  const dismiss = (): void => { leaveAccess?.(); leaveAccess = undefined; selection.set(null) }
  ctx.effect(() => connection.generation.subscribe(() => { epoch++; dismiss() }), 'workspace sandbox: connection lifetime')
  ctx.effect(() => workspaces.list.subscribe(() => {
    const id = selection.getSnapshot()
    if (id !== null && !workspaces.list.getSnapshot().items.some(row => row.workspaceId === id)) dismiss()
  }), 'workspace sandbox: workspace removal')
  ctx.effect(() => () => { active = false; dismiss() }, 'workspace sandbox: panel lifetime')
  const actions: SandboxActions = {
    request: (workspaceId) => {
      if (!active || connection.generation.getSnapshot() === undefined || !sandboxAllowed(workspace, workspaceId, 'status')
        || !workspaces.list.getSnapshot().items.some(row => row.workspaceId === workspaceId)) return
      dismiss()
      selection.set(workspaceId)
      leaveAccess = workspace.whenAccess(workspaceId, 'workspaceSandbox/status', () => () => {
        if (selection.getSnapshot() === workspaceId) selection.set(null)
      })
    },
    dismiss,
    refresh: (workspaceId) => { model.refresh(workspaceId) },
    change: (workspaceId, operation) => {
      const row = workspaces.list.getSnapshot().items.find(row => row.workspaceId === workspaceId)
      if (!active || !sandboxAllowed(workspace, workspaceId, operation) || !sandboxModeAllows(row?.modeConfig, operation)) return
      const initiatingEpoch = epoch
      const name = workspaces.list.getSnapshot().items.find(row => row.workspaceId === workspaceId)?.title || t('untitled')
      void model.change(workspaceId, operation).then((problem) => {
        if (!active || epoch !== initiatingEpoch
          || !sandboxAllowed(workspace, workspaceId, operation)) return
        menus.notify(problem === undefined ? t(operation === 'open' ? 'opened' : 'closedNotice', { name })
          : t('operationFailed', { name, reason: t(failureKey(problem)) }), problem === undefined)
      })
    },
  }
  ctx.effect(() => ctx.contextMenus.register({ id: 'workspace.sandbox', target: 'workspace', order: 200,
    observe: ({ workspaceId }) => [sandboxPermission(workspace, workspaceId)],
    resolve: ({ workspaceId }) => sandboxAllowed(workspace, workspaceId, 'status')
      ? [{ id: 'manage', label: t('title'), run: () => { actions.request(workspaceId) } }] : [],
  }), 'workspace sandbox: menu entry')
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left',
    id: 'workspace.sandbox', order: 220, locale: 'workspaceSandbox', inject: () => actions }, SandboxLauncher))
  ctx.slots.inject('workspace.files.environment', () => ctx.slots.register({
    name: 'workspace.files.environment', locale: 'workspaceSandbox', inject: () => actions,
  }, InlineEnvironment))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'workspace.sandbox',
    locale: 'workspaceSandbox', inject: (): SandboxOverlayInjected => ({ ...actions, hooks: { selection } }) }, SandboxOverlay))
}
