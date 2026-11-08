/** Registers Antfarm views through the existing main, brand and sidebar extension points. */
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { UiWorkspace } from './navigation.ts'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { Workbench, WorkbenchAccountDock, WorkbenchBrand, WorkbenchFiles, WorkbenchHero, WorkbenchHeroMark, WorkbenchIcon, WorkbenchMark, type WorkbenchInjected, type WorkbenchFilesInjected } from './Workbench.tsx'
import { en, zh } from './workbench-copy.ts'
import { fileFailureKey } from './file-failures.ts'

type WorkbenchNavigation = Pick<UiWorkspace, 'openWorkspace' | 'connectWorkspace' | 'startSession'>

/**
 * Mount the opt-in dashboard and the real workspace file tab.
 * @param ctx - Workspace plugin services.
 * @param navigation - Existing Session creation and navigation.
 */
export function registerWorkbench(ctx: Context, navigation: WorkbenchNavigation): void {
  ctx.inject(['workspaceUploads'], (owner) => { registerWorkbenchViews(owner, navigation) })
}

function registerWorkbenchViews(ctx: Context, navigation: WorkbenchNavigation): void {
  ctx.effect(() => ctx.locale.register('antfarm', { en, zh }), 'Antfarm: copy')
  const t = ctx.locale.bind('antfarm')
  const panelId = 'antfarm' as MainPanelId
  ctx.slots.inject('main', () => {
    const dispose = ctx.slots.register({ name: 'main', key: panelId, locale: 'antfarm',
      inject: (): WorkbenchInjected => ({
        open: workspaceId => navigation.openWorkspace(workspaceId),
        prepare: async (example, title) => {
          const label = title.trim() || t(example === 'own' ? 'workspace' : example)
          const workspace = await ctx.workspaces.create({ title: label })
          if (example === 'own') {
            navigation.startSession(workspace.workspaceId, { prompt: t('ownPrompt'), whenDraftExists: 'replace' })
            return
          }
          if (workspace.modeConfig.mode !== 'single-docker') {
            await ctx.workspaces.setMode(workspace.workspaceId, 'single-docker', workspace.modeConfig.revision)
          }
          const content = example === 'spreadsheet'
            ? 'product,units,unit_price\nNotebook,12,18\nDesk lamp,8,35\nNotebook,6,18\nMonitor stand,5,42\n'
            : '# Project brief\nBuild a small customer feedback website. It needs a landing page, a feedback form, an admin review screen, and a weekly summary. The team has two developers and three weeks. Keep the first version focused and easy to use.\n'
          const file = new File([content], example === 'spreadsheet' ? 'sales.csv' : 'brief.md', { type: 'text/plain' })
          const uploaded = await ctx.workspaceUploads.uploadFile(workspace.workspaceId, file, new AbortController().signal)
          if (!uploaded.ok) throw new Error('Example file upload failed')
          await navigation.connectWorkspace(workspace.workspaceId)
          navigation.startSession(workspace.workspaceId, { prompt: t(example === 'spreadsheet' ? 'spreadsheetPrompt' : 'notesPrompt'), whenDraftExists: 'replace' })
        },
      }),
    }, Workbench)
    ctx.layout.selectPanel(panelId)
    return dispose
  })
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: panelId, order: -100, label: () => t('dashboard'), locale: 'antfarm',
  }, WorkbenchIcon))
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({ name: 'sidebar.brand.name', locale: 'antfarm' }, WorkbenchBrand))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'antfarm-account', order: 100,
  }, WorkbenchAccountDock))
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({ name: 'sidebar.brand.mark' }, WorkbenchMark))
  ctx.slots.inject('conversation.hero.brand.name', () => ctx.slots.register({ name: 'conversation.hero.brand.name', locale: 'antfarm' }, WorkbenchHero))
  ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({ name: 'conversation.hero.brand.mark' }, WorkbenchHeroMark))
  ctx.inject(['sidebarRightTabs', 'sidebarRight', 'workspaceArtifactFiles', 'workspaceUploads'], (owner) => {
    owner.effect(() => owner.sidebarRightTabs.register({ id: 'antfarm-workspace-files', kind: 'workspace-files',
      title: () => t('files'), guide: [{ id: 'workspace-files', order: -100, title: () => t('files'), description: () => t('filesHint') }],
    }), 'Antfarm: workspace tab type')
    owner.slots.inject('sidebar.right.pane.tab', () => owner.slots.register({
      name: 'sidebar.right.pane.tab', key: 'antfarm-workspace-files', locale: 'antfarm',
      children: { 'workspace.files.environment': { kind: 'single', scope: 'session' } },
      inject: (): WorkbenchFilesInjected => ({
        fileCopy: owner.locale.bind('workspace'),
        listFiles: async (workspaceId, path, signal) => {
          try {
            return await owner.workspaceArtifactFiles.listFiles(workspaceId, path, signal)
          } catch (_listingInterrupted) {
            return { ok: false, error: { reason: signal.aborted ? 'cancelled' : 'io' } }
          }
        },
        downloadFile: async (workspaceId, path, maxBytes, signal) => {
          const fileCopy = owner.locale.bind('workspace')
          try {
            const result = await owner.workspaceArtifactFiles.downloadFile(workspaceId, path, maxBytes, signal)
            if (!result.ok && !signal.aborted) owner.contextMenus.notify(fileCopy(fileFailureKey(result.error.reason)), false)
          } catch (_downloadInterrupted) {
            if (!signal.aborted) owner.contextMenus.notify(fileCopy('files.failed'), false)
          }
        },
        uploadFile: async (workspaceId, file, signal) => {
          try {
            const result = await owner.workspaceUploads.uploadFile(workspaceId, file, signal)
            return result.ok ? 'uploaded' : 'failed'
          } catch (_uploadInterrupted) {
            return 'disconnected'
          }
        },
      }),
    }, WorkbenchFiles))
  })
}
