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

/**
 * Register the shared sandbox panel and workspace entries.
 * @param ctx - Plugin-owned UI registries.
 * @param model - Workspace observations and explicit mutations.
 */
export function mountUi(ctx: Context, model: SandboxModel): void {
  const selection = createSnapshotStore<WorkspaceId | null>(null)
  ctx.effect(() => ctx.locale.register('workspaceSandbox', dictionaries), 'workspace sandbox: dictionaries')
  const t = ctx.locale.bind('workspaceSandbox')
  const actions: SandboxActions = {
    request: (workspaceId) => { selection.set(workspaceId) },
    dismiss: () => { selection.set(null) },
    refresh: (workspaceId) => { model.refresh(workspaceId) },
    change: (workspaceId, operation) => { void model.change(workspaceId, operation).then((problem) => {
      ctx.contextMenus.notify(t(problem === undefined ? (operation === 'open' ? 'opened' : 'closedNotice') : 'failed'),
        problem === undefined)
    }) },
  }
  ctx.effect(() => ctx.contextMenus.register({ id: 'workspace.sandbox', target: 'workspace', order: 200,
    observe: ({ workspaceId }) => [ctx.remoteAccess.source('workspace', workspaceId, 'workspaceSandbox/status')],
    resolve: ({ workspaceId }) => ctx.remoteAccess.source('workspace', workspaceId, 'workspaceSandbox/status').getSnapshot()
      ? [{ id: 'manage', label: t('title'), run: () => { actions.request(workspaceId) } }] : [],
  }), 'workspace sandbox: menu entry')
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left',
    id: 'workspace.sandbox', order: 220, locale: 'workspaceSandbox', inject: () => actions }, SandboxLauncher))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'workspace.sandbox',
    locale: 'workspaceSandbox', inject: (): SandboxOverlayInjected => ({ ...actions, hooks: { selection } }) }, SandboxOverlay))
}
