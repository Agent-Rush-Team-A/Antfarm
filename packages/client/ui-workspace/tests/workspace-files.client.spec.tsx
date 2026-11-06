// @vitest-environment jsdom
/** Workspace file navigation, retained listings, cancelled work and localized outcomes. */
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceArtifactListing, WorkspaceArtifactResult } from '@deepseek-ai/dsh-api-workspace-artifacts/types'
import { WorkspaceFilesButton } from '../src/client/WorkspaceFilesButton.tsx'
import { fileFailureKey } from '../src/client/file-failures.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
const id = 'workspace' as WorkspaceId
const session = 'session' as SessionId
const root: WorkspaceArtifactListing = { path: '', entries: [{ name: 'outputs', kind: 'directory' },
  { name: 'file.bin', kind: 'file', bytes: 3 }], truncated: false, maxDownloadBytes: 3 }

function setup(options: { assigned?: boolean; allowed?: boolean } = {}) {
  const listFiles = vi.fn(async (_id: WorkspaceId, _path: string, _signal: AbortSignal):
  Promise<WorkspaceArtifactResult<WorkspaceArtifactListing>> => ({ ok: true, value: root }))
  const downloadFile = vi.fn(async (_id: WorkspaceId, _path: string, _cap: number, _signal: AbortSignal): Promise<void> => {})
  const access = vi.fn(() => options.allowed !== false)
  type Props = Parameters<typeof WorkspaceFilesButton>[0]
  const props: Props = {
    sessionId: session,
    useWorkspaces: (select: (value: { items: Array<{ workspaceId: WorkspaceId; sessionIds: SessionId[] }> }) => unknown) =>
      select({ items: options.assigned === false ? [] : [{ workspaceId: id, sessionIds: [session] }] }),
    useWorkspaceAccess: access,
    listFiles, downloadFile,
    t: makeTranslate(zh, commonZh),
  } as never
  const view = render(<WorkspaceFilesButton {...props} />)
  const open = async () => {
    fireEvent.click(view.getByRole('button', { name: '工作区文件' }))
    const dialog = await view.findByRole('dialog', { name: '工作区文件' })
    await within(dialog).findByText('file.bin', { exact: true })
    return within(dialog)
  }
  return { ...view, listFiles, downloadFile, access, open }
}

it.each([{ assigned: false }, { allowed: false }])('hides file operations without an assigned authorized workspace: %j', (options) => {
  const fixture = setup(options)
  expect(fixture.queryByRole('button', { name: '工作区文件' })).toBeNull()
  expect(fixture.listFiles).not.toHaveBeenCalled()
})

it('navigates exact relative folders, goes back and downloads the selected file', async () => {
  const fixture = setup()
  const dialog = await fixture.open()
  expect(fixture.access).toHaveBeenCalledWith(id, 'workspaceArtifacts/list')
  expect(fixture.listFiles).toHaveBeenCalledWith(id, '', expect.any(AbortSignal))
  expect(dialog.getByText('3 字节')).toBeTruthy()
  fixture.listFiles.mockResolvedValueOnce({ ok: true, value: { ...root, path: 'outputs', entries: [{ name: 'result.bin', kind: 'file' }] } })
  fireEvent.click(dialog.getByRole('button', { name: '打开文件夹“outputs”' }))
  await dialog.findByText('result.bin', { exact: true })
  fireEvent.click(dialog.getByRole('button', { name: '下载“result.bin”' }))
  await waitFor(() =>{  expect(fixture.downloadFile).toHaveBeenCalledWith(id, 'outputs/result.bin', 3, expect.any(AbortSignal)) })
  fireEvent.click(dialog.getByRole('button', { name: '上一级' }))
  await dialog.findByText('file.bin', { exact: true })
  expect(fixture.listFiles.mock.lastCall?.[1]).toBe('')
})

it('keeps the previous listing visible when a refresh fails', async () => {
  const fixture = setup()
  const dialog = await fixture.open()
  fixture.listFiles.mockResolvedValueOnce({ ok: false, error: { reason: 'io' } })
  fireEvent.click(dialog.getByRole('button', { name: '刷新' }))
  await dialog.findByRole('alert')
  expect(dialog.getByRole('alert').textContent).toBe(zh['files.failed'])
  expect(dialog.getByText('file.bin', { exact: true })).toBeTruthy()
})

it('shows empty and truncated directory states without losing refresh', async () => {
  const fixture = setup()
  const dialog = await fixture.open()
  fixture.listFiles.mockResolvedValueOnce({ ok: true, value: { ...root, entries: [], truncated: true } })
  fireEvent.click(dialog.getByRole('button', { name: '刷新' }))
  await dialog.findByText(zh['files.empty'], { exact: true })
  expect(dialog.getByText(zh['files.truncated'], { exact: true })).toBeTruthy()
  expect(dialog.getByRole('button', { name: '刷新' }).hasAttribute('disabled')).toBe(false)
})

it('cancels a pending download when its dialog closes', async () => {
  const fixture = setup()
  const dialog = await fixture.open()
  let signal!: AbortSignal
  fixture.downloadFile.mockImplementationOnce((_id, _path, _cap, lifetime) => new Promise((resolve) => {
    signal = lifetime
    lifetime.addEventListener('abort', () => { resolve() }, { once: true })
  }))
  fireEvent.click(dialog.getByRole('button', { name: '下载“file.bin”' }))
  expect(dialog.getByRole('button', { name: '下载“file.bin”' }).getAttribute('aria-busy')).toBe('true')
  fireEvent.click(dialog.getByRole('button', { name: '关闭' }))
  await waitFor(() =>{  expect(signal.aborted).toBe(true) })
  await waitFor(() =>{  expect(fixture.queryByRole('dialog')).toBeNull() })
})

it('ignores a late directory result after returning to the workspace root', async () => {
  const fixture = setup()
  const dialog = await fixture.open()
  let release!: (result: WorkspaceArtifactResult<WorkspaceArtifactListing>) => void
  let lifetime!: AbortSignal
  fixture.listFiles.mockImplementationOnce((_id, _path, signal) => new Promise((resolve) => { release = resolve; lifetime = signal }))
  fireEvent.click(dialog.getByRole('button', { name: '打开文件夹“outputs”' }))
  await waitFor(() =>{  expect(fixture.listFiles).toHaveBeenCalledTimes(2) })
  fireEvent.click(dialog.getByRole('button', { name: '上一级' }))
  await dialog.findByText('file.bin', { exact: true })
  expect(lifetime.aborted).toBe(true)
  await act(async () => {
    release({ ok: true, value: { ...root, path: 'outputs', entries: [{ name: 'stale.bin', kind: 'file' }] } })
  })
  await waitFor(() =>{  expect(dialog.queryByText('stale.bin', { exact: true })).toBeNull() })
})

it('uses localized actionable copy for every file refusal category', () => {
  for (const reason of ['invalid-path', 'denied', 'not-found', 'not-regular', 'too-large', 'cancelled', 'io'] as const) {
    expect(zh[fileFailureKey(reason)]).toBeTruthy()
  }
})
