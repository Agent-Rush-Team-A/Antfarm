// @vitest-environment jsdom
/** Product controls follow observed states and require explicit close confirmation. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { SandboxPanel, type PanelProps } from '../src/client/Panel.tsx'
import type { SandboxView } from '../src/client/model.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)
const id = 'workspace-a' as WorkspaceId
const closed: SandboxView = { workspaceId: id, state: 'closed', pending: undefined,
  failure: undefined, statusFailure: undefined, connected: true }

function fixture(view: SandboxView = closed, dictionary = en) {
  const resource: ResourceSnapshot<SandboxView> = { status: 'live', value: view, failure: undefined }
  const props: PanelProps = {
    workspaceId: id, displayTitle: 'Project A', t: makeTranslate(dictionary),
    // This fixture serves only the panel's protocol; the framework hook is generic for all consumers.
    useResource: vi.fn(() => resource) as PanelProps['useResource'],
    useWorkspaceAccess: vi.fn<PanelProps['useWorkspaceAccess']>().mockReturnValue(true),
    dismiss: vi.fn(), refresh: vi.fn(), change: vi.fn(),
  }
  return { props, ...render(<SandboxPanel {...props} />) }
}

test('shows the workspace and its closed state without starting a sandbox', () => {
  const f = fixture()
  expect(screen.getByRole('dialog', { name: en.title })).toBeTruthy()
  expect(screen.getByText('Project A')).toBeTruthy()
  expect(screen.getByRole('status').textContent).toBe(en.closed)
  expect(f.props.change).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.open }))
  expect(f.props.change).toHaveBeenCalledWith(id, 'open')
})

test('requires confirmation to close and allows cancelling the confirmation', () => {
  const f = fixture({ ...closed, state: 'running' })
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  expect(screen.getByText(en.confirmNote)).toBeTruthy()
  expect(f.props.change).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  expect(screen.queryByText(en.confirmNote)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  fireEvent.click(screen.getByRole('button', { name: en.confirmClose }))
  expect(f.props.change).toHaveBeenCalledWith(id, 'close')
})

test.each([
  { state: 'starting', pending: 'open', copy: en.starting },
  { state: 'closing', pending: 'close', copy: en.closing },
] as const)('shows $state progress and disables duplicate operations', ({ state, pending, copy }) => {
  const f = fixture({ ...closed, state, pending })
  expect(screen.getByRole('status').textContent).toBe(copy)
  fireEvent.click(screen.getByRole('button', { name: state === 'closing' ? en.retryClose : en.close }))
  fireEvent.click(screen.getByRole('button', { name: en.refresh }))
  expect(f.props.change).not.toHaveBeenCalled()
  expect(f.props.refresh).not.toHaveBeenCalled()
})

test('refreshes explicitly and dismisses the panel without closing the container', () => {
  const f = fixture({ ...closed, state: 'running' })
  fireEvent.click(screen.getByRole('button', { name: en.refresh }))
  expect(f.props.refresh).toHaveBeenCalledWith(id)
  fireEvent.click(screen.getByRole('button', { name: en.dismiss }))
  expect(f.props.dismiss).toHaveBeenCalledOnce()
  expect(f.props.change).not.toHaveBeenCalled()
})

test('uses Chinese state and action labels', () => {
  fixture(closed, zh)
  expect(screen.getByRole('status').textContent).toBe('已关闭')
  expect(screen.getByRole('button', { name: '开启沙箱' })).toBeTruthy()
})

test('shows actionable capacity guidance in Chinese', () => {
  fixture({ ...closed, failure: { reason: 'sandbox_capacity', operation: 'open', outcomeUnknown: false } }, zh)
  expect(screen.getByRole('alert').textContent).toBe('沙箱已满，请关闭一个或稍后重试')
})

test('an unknown opening result cannot be presented as closed or allow another opening', () => {
  const f = fixture({ ...closed, failure: { reason: 'runner_outcome_unknown', operation: 'open', outcomeUnknown: true } })
  expect(screen.getByRole('status').textContent).toBe(en.unconfirmed)
  expect(screen.getByRole('alert').textContent).toBe(en.unknown)
  fireEvent.click(screen.getByRole('button', { name: en.open }))
  expect(f.props.change).not.toHaveBeenCalled()
})

test('a failed query labels retained state as stale and disables changes', () => {
  const f = fixture({ ...closed, statusFailure: { reason: 'runner_unavailable', operation: 'status', outcomeUnknown: false } })
  expect(screen.getByRole('status').textContent).toBe('Last known status: Closed')
  fireEvent.click(screen.getByRole('button', { name: en.open }))
  expect(f.props.change).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.refresh }))
  expect(f.props.refresh).toHaveBeenCalledWith(id)
})

test('withdrawn status permission unmounts the panel and its resource consumer', () => {
  const f = fixture()
  const access = vi.fn<PanelProps['useWorkspaceAccess']>().mockReturnValue(false)
  f.rerender(<SandboxPanel {...f.props} useWorkspaceAccess={access} />)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(f.props.useResource).toHaveBeenCalledTimes(1)
})

test.each([{ state: 'cleanup_required', copy: en.cleanup }, { state: 'closing', copy: en.retryClose }] as const)(
  'allows confirmed cleanup for $state', ({ state, copy }) => {
    const f = fixture({ ...closed, state })
    fireEvent.click(screen.getByRole('button', { name: copy }))
    fireEvent.click(screen.getByRole('button', { name: en.confirmClose }))
    expect(f.props.change).toHaveBeenCalledWith(id, 'close')
  },
)
