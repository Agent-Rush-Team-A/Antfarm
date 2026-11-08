// @vitest-environment jsdom
/** Mode choices follow permanent metadata and never overwrite a concurrent edit. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ModeForm, type ModeFormProps } from '../src/client/ModeDialog.tsx'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { en, zh } from '../src/client/locales.ts'
import { canCreateSession, multipleSessions, sessionWorkspace } from '../src/client/mode-policy.ts'

afterEach(cleanup)
const id = 'workspace-a' as WorkspaceId
const first = 'first-session' as SessionId
const row: WorkspaceView = { workspaceId: id, path: '/project', title: 'Project A', sessionIds: [],
  createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z',
  modeConfig: { workspaceId: id, mode: 'multi-vm', revision: 3, operationState: 'ready',
    modeLocked: false, lockReason: null, firstSessionId: null } }

function props(value = row): ModeFormProps {
  return { row: value, selection: { workspaceId: id, startsSession: true }, pending: false,
    t: makeTranslate(en, commonEn), useWorkspaceAccess: vi.fn().mockReturnValue(true), dismissMode: vi.fn(),
    refreshMode: vi.fn(), saveMode: vi.fn().mockResolvedValue(true), beginModeSession: vi.fn() }
}

it('offers four modes before the first Session and saves the captured revision', async () => {
  const p = props(); render(<ModeForm {...p} />)
  expect(screen.getAllByRole('radio')).toHaveLength(4)
  fireEvent.click(screen.getByRole('radio', { name: en['mode.single-docker'] }))
  expect(screen.getByRole('button', { name: en['mode.begin'] }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: en['mode.save'] }))
  await waitFor(() => { expect(p.saveMode).toHaveBeenCalledWith(id, 'single-docker', 3) })
  expect(p.beginModeSession).not.toHaveBeenCalled()
})

it('keeps a failed draft visible and blocks starting until the chosen mode is confirmed', async () => {
  const p = props(); vi.mocked(p.saveMode).mockResolvedValue(false)
  render(<ModeForm {...p} />)
  fireEvent.click(screen.getByRole('radio', { name: en['mode.single-vm'] }))
  fireEvent.click(screen.getByRole('button', { name: en['mode.save'] }))
  await waitFor(() => { expect(p.saveMode).toHaveBeenCalledOnce() })
  expect((screen.getByRole('radio', { name: en['mode.single-vm'] }) as HTMLInputElement).checked).toBe(true)
  expect(screen.getByRole('button', { name: en['mode.begin'] }).hasAttribute('disabled')).toBe(true)
})

it('rejects a stale draft after a pushed revision and requires an explicit refresh', () => {
  const p = props(); const f = render(<ModeForm {...p} />)
  fireEvent.click(screen.getByRole('radio', { name: en['mode.single-vm'] }))
  f.rerender(<ModeForm {...p} row={{ ...row, modeConfig: { ...row.modeConfig, revision: 4, mode: 'multi-docker' } }} />)
  expect(screen.getByRole('alert').textContent).toBe(en['mode.conflict'])
  fireEvent.click(screen.getByRole('button', { name: en['mode.save'] }))
  expect(p.saveMode).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en['mode.refresh'] }))
  expect(p.refreshMode).toHaveBeenCalledWith(id)
  expect((screen.getByRole('radio', { name: en['mode.multi-docker'] }) as HTMLInputElement).checked).toBe(true)
})

it('shows a permanent lock even when the first Session is filtered from membership', () => {
  const p = props({ ...row, modeConfig: { ...row.modeConfig, mode: 'single-vm', firstSessionId: first,
    modeLocked: true, lockReason: 'first-session-created' } })
  p.t = makeTranslate(zh, commonZh); render(<ModeForm {...p} />)
  expect(screen.getByText(zh['mode.locked'])).toBeTruthy()
  expect(screen.getByText(first)).toBeTruthy()
  expect(screen.queryByRole('button', { name: zh['mode.save'] })).toBeNull()
  expect(screen.getAllByRole('radio').every(r => (r as HTMLInputElement).disabled)).toBe(true)
  expect(screen.getAllByRole('button', { name: /^了解/ }).map(button => button.getAttribute('aria-label')))
    .toEqual(['了解单会话 · VM', '了解多会话 · VM', '了解单会话 · Docker', '了解多会话 · Docker'])
  expect(canCreateSession(p.row)).toBe(false)
  expect(sessionWorkspace([p.row], first)).toBe(p.row)
})

it.each(['switching', 'creating-session', 'recovery-required'] as const)('blocks changes and starting during %s', (state) => {
  const p = props({ ...row, modeConfig: { ...row.modeConfig, operationState: state } })
  render(<ModeForm {...p} />)
  expect(screen.getByRole('status').textContent).toBe(en[`mode.${state}`])
  fireEvent.click(screen.getByRole('button', { name: en['mode.save'] }))
  fireEvent.click(screen.getByRole('button', { name: en['mode.begin'] }))
  expect(p.saveMode).not.toHaveBeenCalled(); expect(p.beginModeSession).not.toHaveBeenCalled()
  expect(canCreateSession(p.row)).toBe(false)
})

it('keeps read-only mode information visible and dismisses without creating a Session', () => {
  const p = props(); p.useWorkspaceAccess = (_, action) => action === 'workspace/getMode'
  render(<ModeForm {...p} />)
  expect(screen.getAllByRole('radio')).toHaveLength(4)
  fireEvent.click(screen.getByRole('button', { name: commonEn.close }))
  expect(p.dismissMode).toHaveBeenCalledOnce(); expect(p.beginModeSession).not.toHaveBeenCalled()
})

it('shows help only for the modes offered by the deployment', () => {
  render(<ModeForm {...props()} visibleModes={['single-docker', 'multi-docker']} />)
  expect(screen.getAllByRole('button', { name: /^About / }).map(button => button.getAttribute('aria-label')))
    .toEqual(['About Single session · Docker', 'About Multiple sessions · Docker'])
})

it('removes the form when read access is revoked', () => {
  const p = props(); const f = render(<ModeForm {...p} />)
  f.rerender(<ModeForm {...p} useWorkspaceAccess={() => false} />)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each(['single-vm', 'single-docker', 'multi-vm', 'multi-docker'] as const)('derives ordinary Session actions for %s', (mode) => {
  const value = { ...row, modeConfig: { ...row.modeConfig, mode, firstSessionId: first } }
  expect(canCreateSession(value)).toBe(mode.startsWith('multi-'))
  expect(multipleSessions(value)).toBe(mode.startsWith('multi-'))
})


it('inherits a descendant Workspace from permanent first Session identity and terminates cyclic parent chains', () => {
  const locked = { ...row, modeConfig: { ...row.modeConfig, firstSessionId: first } }
  const child = 'child' as SessionId
  const summary = { id: child, parentId: first, blank: false, running: false, displayTitle: 'Child',
    updatedAt: 0, retainedBy: {} }
  expect(sessionWorkspace([locked], child, { [child]: summary })).toBe(locked)
  expect(sessionWorkspace([], child, { [child]: { ...summary, parentId: child } })).toBeUndefined()
})
