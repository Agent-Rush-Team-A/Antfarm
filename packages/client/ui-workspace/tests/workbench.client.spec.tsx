// @vitest-environment jsdom
/** Workbench actions and file failures through the real slot renderer and scoped services. */
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceUploads } from '@deepseek-ai/dsh-api-workspace-upload/client'
import type { WorkspaceArtifactFiles } from '@deepseek-ai/dsh-api-workspace-artifacts/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import type { TabHookContext } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-info.ts'
import type { TabId } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { registerWorkbench } from '../src/client/register-workbench.ts'
import type { WorkbenchInjected } from '../src/client/Workbench.tsx'
import type { UiWorkspace } from '../src/client/navigation.ts'
import { en, zh } from '../src/client/workbench-copy.ts'
import { en as workspaceEn, zh as workspaceZh } from '../src/client/locales.ts'

afterEach(cleanup)

const workspaceId = 'workbench-workspace' as WorkspaceId
const sessionId = 'workbench-session' as SessionId
const row: WorkspaceView = {
  workspaceId, path: '/workbench', title: 'Sales review', sessionIds: [sessionId],
  createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z',
  modeConfig: { workspaceId, mode: 'multi-docker', revision: 2, operationState: 'ready',
    modeLocked: false, lockReason: null, firstSessionId: null },
}

async function bench(language: 'en' | 'zh' = 'en') {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const locale = new LocaleRuntime(runtime.ctx)
  locale.setLocale(language)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  locale.register('workspace', { en: workspaceEn, zh: workspaceZh })
  const create = vi.spyOn(runtime.workspaces, 'create').mockResolvedValue(row)
  const setMode = vi.spyOn(runtime.workspaces, 'setMode').mockResolvedValue(row.modeConfig)
  const selectPanel = vi.fn()
  runtime.ctx.provide('layout', { selectPanel } as never)
  const notify = vi.fn()
  runtime.ctx.provide('contextMenus', { notify } as never)
  const uploadFile = vi.fn<WorkspaceUploads['uploadFile']>(async (_id, file) => ({ ok: true,
    value: { name: file.name, bytes: file.size } }))
  runtime.ctx.provide('workspaceUploads', { uploadFile })
  const listFiles = vi.fn<WorkspaceArtifactFiles['listFiles']>(async () => ({ ok: true,
    value: { path: '', entries: [{ kind: 'file', name: 'report.md', bytes: 12 }], truncated: false, maxDownloadBytes: 1024 } }))
  const downloadFile = vi.fn<WorkspaceArtifactFiles['downloadFile']>(async () => ({ ok: true,
    value: undefined }))
  runtime.ctx.provide('workspaceArtifactFiles', { listFiles, downloadFile })
  const tabs = new SidebarRightTabRegistry(runtime.ctx)
  runtime.ctx.provide('sidebarRightTabs', tabs)
  runtime.ctx.provide('sidebarRight', {} as never)
  const connectWorkspace = vi.fn<UiWorkspace['connectWorkspace']>(async () => sessionId)
  const startSession = vi.fn<UiWorkspace['startSession']>()
  const navigation: Parameters<typeof registerWorkbench>[1] = {
    connectWorkspace, startSession, openWorkspace: vi.fn(async () => {}),
  }
  await runtime.workspaces.update((draft) => { draft.items = [row] })
  await runtime.sessions.add({ id: sessionId })
  await runtime.declare({
    main: { kind: 'keyed', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' },
    'sidebar.brand.name': { kind: 'single', scope: 'root' },
    'sidebar.brand.mark': { kind: 'single', scope: 'root' },
    'sidebar.footer.action': { kind: 'list', scope: 'root' },
    'conversation.hero.brand.name': { kind: 'single', scope: 'root' },
    'conversation.hero.brand.mark': { kind: 'single', scope: 'root' },
    'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session', inject: { hooks: {
      tabInfo: () => () => { throw new Error('Workspace files must not depend on tab presentation state') },
    } } },
  })
  const feature = await runtime.mount({
    inject: ['slots', 'locale', 'workspaces', 'layout', 'contextMenus', 'workspaceUploads', 'sidebarRightTabs', 'sidebarRight', 'workspaceArtifactFiles'],
    apply(ctx) { registerWorkbench(ctx, navigation) },
  })
  const dashboard = (): WorkbenchInjected => {
    const entry = runtime.slots.entries('main').find(entry => entry.options.key === 'antfarm')
    if (entry?.inject === undefined) throw new Error('Workbench dashboard is not registered')
    const face = entry.inject()
    if (!isDashboard(face)) throw new Error('Workbench commands are missing')
    return face
  }
  const files = () => {
    const reference = runtime.sessions.retain(sessionId)
    onTestFinished(() => { reference.release() })
    const lifetime = new AbortController()
    onTestFinished(() => { lifetime.abort() })
    const hookContext: TabHookContext = {
      shortcuts: [], tabId: 'tab1' as TabId, title: false, fullscreen: false, active: true, signal: lifetime.signal,
      actions: { bindCommands: () => () => {}, openResource: () => {}, openTab: () => {}, close: () => {} },
      useStore: () => { throw new Error('Workspace files must not read sidebar layout state') },
      useTabNavigation: () => { throw new Error('Workspace files must not read tab navigation state') },
    }
    return runtime.renderSlot('sidebar.right.pane.tab', {}, {
      entryKey: 'antfarm-workspace-files', session: reference, hookContext,
    })
  }
  return { runtime, locale, feature, tabs, create, setMode, uploadFile, listFiles, downloadFile, notify,
    selectPanel, connectWorkspace, startSession, dashboard, files }
}

function isDashboard(value: object): value is WorkbenchInjected {
  return 'prepare' in value && typeof value.prepare === 'function'
    && 'open' in value && typeof value.open === 'function'
}

function text(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('Sample file did not produce text'))
    }
    reader.onerror = () => { reject(reader.error ?? new Error('Sample file read failed')) }
    reader.readAsText(file)
  })
}

it.each(['en', 'zh'] as const)('prepares a sample and starts its draft in %s', async (language) => {
  const b = await bench(language)
  await b.dashboard().prepare('spreadsheet', '', 'single-docker')
  const copy = language === 'en' ? en : zh
  expect(b.create).toHaveBeenCalledWith({ title: copy.spreadsheet })
  expect(b.setMode).toHaveBeenCalledWith(workspaceId, 'single-docker', 2)
  const file = b.uploadFile.mock.calls[0]?.[1]
  expect(file?.name).toBe('sales.csv')
  if (file === undefined) throw new Error('Sample upload was not called')
  expect(await text(file)).toContain('Notebook,12,18')
  expect(b.connectWorkspace).toHaveBeenCalledWith(workspaceId)
  expect(b.startSession).toHaveBeenCalledWith(workspaceId, { prompt: copy.spreadsheetPrompt, whenDraftExists: 'replace' })
})

it('keeps navigation closed when preparing the sample upload fails', async () => {
  const b = await bench()
  b.uploadFile.mockResolvedValueOnce({ ok: false, error: { reason: 'too-large', stored: false } })
  await expect(b.dashboard().prepare('notes', '', 'multi-docker')).rejects.toThrow('Example file upload failed')
  expect(b.connectWorkspace).not.toHaveBeenCalled()
  expect(b.startSession).not.toHaveBeenCalled()
})

it('removes the workbench views and file tab when its fiber is disposed', async () => {
  const b = await bench()
  expect(b.tabs.get('workspace-files')).toBeDefined()
  expect(b.runtime.slots.entries('main')).toHaveLength(1)
  await b.feature.dispose()
  expect(b.tabs.get('workspace-files')).toBeUndefined()
  for (const slot of ['main', 'sidebar.panellist', 'sidebar.brand.name', 'sidebar.brand.mark', 'sidebar.footer.action',
    'conversation.hero.brand.name', 'conversation.hero.brand.mark', 'sidebar.right.pane.tab'] as const) {
    expect(b.runtime.slots.entries(slot)).toHaveLength(0)
  }
})

it.each(['en', 'zh'] as const)('reports an interrupted upload in %s and retries without refreshing a failed write', async (language) => {
  const b = await bench(language)
  const view = b.files()
  await view.view.findByText('report.md', { exact: true })
  const copy = language === 'en' ? en : zh
  const input = view.container.querySelector<HTMLInputElement>('input[type=file]')
  if (input === null) throw new Error('Workspace upload input is missing')
  b.uploadFile.mockRejectedValueOnce(new Error('Transport disconnected'))
  fireEvent.change(input, { target: { files: [new File(['file'], 'input.txt')] } })
  await waitFor(() => { expect(view.view.getByRole('alert').textContent).toBe(copy.uploadDisconnected) })
  expect(b.listFiles).toHaveBeenCalledTimes(1)
  expect(view.view.getByRole('button', { name: copy.upload }).hasAttribute('disabled')).toBe(false)
  fireEvent.change(input, { target: { files: [new File(['file'], 'input.txt')] } })
  await waitFor(() => { expect(b.listFiles).toHaveBeenCalledTimes(2) })
  expect(view.view.queryByRole('alert')).toBeNull()
  expect(b.uploadFile).toHaveBeenCalledTimes(2)
})

it('keeps files visible and reports a refused upload without refreshing the listing', async () => {
  const b = await bench()
  const view = b.files()
  await view.view.findByText('report.md', { exact: true })
  const input = view.container.querySelector<HTMLInputElement>('input[type=file]')
  if (input === null) throw new Error('Workspace upload input is missing')
  b.uploadFile.mockResolvedValueOnce({ ok: false, error: { reason: 'exists', stored: false } })
  fireEvent.change(input, { target: { files: [new File(['file'], 'report.md')] } })
  await waitFor(() => { expect(view.view.getByRole('alert').textContent).toBe(en.uploadFailed) })
  expect(view.view.getByText('report.md', { exact: true })).toBeTruthy()
  expect(b.listFiles).toHaveBeenCalledTimes(1)
})

it('uses the new locale for the live dashboard and the next prepared prompt', async () => {
  const b = await bench()
  b.runtime.renderSlot('main', {}, { entryKey: 'antfarm' })
  expect(screen.getByRole('heading', { name: en.headline })).toBeTruthy()
  act(() => { b.locale.setLocale('zh') })
  expect(screen.getByRole('heading', { name: zh.headline })).toBeTruthy()
  await b.dashboard().prepare('notes', '', 'multi-docker')
  expect(b.startSession.mock.lastCall?.[1]?.prompt).toBe(zh.notesPrompt)
})

it('reports a listing transport failure and recovers on refresh', async () => {
  const b = await bench()
  b.listFiles.mockRejectedValueOnce(new Error('Transport disconnected'))
  const view = b.files()
  await view.view.findByRole('alert')
  expect(view.view.getByRole('alert').textContent).toBe(workspaceEn['files.failed'])
  fireEvent.click(view.view.getByRole('button', { name: workspaceEn['files.refresh'] }))
  await view.view.findByText('report.md', { exact: true })
  expect(view.view.queryByRole('alert')).toBeNull()
})

it('reports a download transport failure and leaves the file available to retry', async () => {
  const b = await bench()
  const view = b.files()
  await view.view.findByText('report.md', { exact: true })
  b.downloadFile.mockRejectedValueOnce(new Error('Transport disconnected'))
  fireEvent.click(view.view.getByRole('button', { name: workspaceEn['files.download'].replace('{name}', 'report.md') }))
  await waitFor(() => { expect(b.notify).toHaveBeenCalledWith(workspaceEn['files.failed'], false) })
  expect(view.view.getByRole('button', { name: workspaceEn['files.download'].replace('{name}', 'report.md') }).hasAttribute('disabled')).toBe(false)
})
