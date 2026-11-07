// @vitest-environment jsdom
/** Personal credential forms clear secret inputs and contain late or failed requests. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime/src/translate.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { UserCredentialId, UserCredentialView } from '@deepseek-ai/dsh-api-user-credentials/types'
import { CredentialsPanel, type CredentialActions } from '../src/client/Credentials.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const t = makeTranslate(en)
const saved: UserCredentialView = { id: brandString<UserCredentialId>('a'), name: 'Test key',
  configured: true, createdAt: '', updatedAt: '' }

function actions(overrides: Partial<CredentialActions> = {}): CredentialActions {
  return { list: async () => [], create: async () => saved, replace: async () => saved,
    remove: async () => {}, check: async () => {}, refreshModels: async () => ({ status: 'unsupported', modelCount: 0 }), ...overrides }
}

it('clears submitted values immediately and keeps failed requests out of visible copy', async () => {
  const result = Promise.withResolvers<UserCredentialView>()
  const create = vi.fn(() => result.promise)
  render(<CredentialsPanel {...actions({ create })} t={t} report={() => {}} onClose={() => {}} />)
  await screen.findByText(en.empty)
  fireEvent.change(screen.getByLabelText(en.name), { target: { value: 'Test key' } })
  fireEvent.change(screen.getByLabelText(en.value), { target: { value: 'CANARY-SECRET' } })
  fireEvent.click(screen.getByRole('button', { name: en.save }))
  expect(screen.getByLabelText<HTMLInputElement>(en.value).value).toBe('')
  expect(create).toHaveBeenCalledWith({ name: 'Test key', value: 'CANARY-SECRET' }, expect.any(AbortSignal))
  result.reject(new Error('CANARY-SECRET'))
  await screen.findByRole('alert')
  expect(screen.getByRole('alert').textContent).toBe(en.failed)
  expect(document.body.textContent).not.toContain('CANARY-SECRET')
})

it('checks storage, replaces without reading old secrets, and requires deletion confirmation', async () => {
  let rows = [saved]
  const replace = vi.fn(async () => saved)
  const remove = vi.fn(async () => { rows = [] })
  const check = vi.fn(async () => {})
  const report = vi.fn()
  render(<CredentialsPanel {...actions({ list: async () => rows, replace, remove, check })} t={t} report={report} onClose={() => {}} />)
  await screen.findByText(saved.name)
  fireEvent.click(screen.getByRole('button', { name: en.check }))
  await waitFor(() => { expect(report).toHaveBeenCalledWith('checked', true) })
  expect(check).toHaveBeenCalledWith(saved.id, expect.any(AbortSignal))
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: en.replace }).disabled).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: en.replace }))
  expect(screen.getByLabelText<HTMLInputElement>(en.value).value).toBe('')
  fireEvent.change(screen.getByLabelText(en.value), { target: { value: 'NEW-SECRET' } })
  fireEvent.submit(screen.getByLabelText(en.value).closest('form')!)
  await waitFor(() => { expect(replace).toHaveBeenCalledWith({ id: saved.id, value: 'NEW-SECRET' }, expect.any(AbortSignal)) })
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: en.remove }).disabled).toBe(false) })
  const row = within(screen.getByText(saved.name).closest('li')!)
  fireEvent.click(row.getByRole('button', { name: en.remove }))
  expect(remove).not.toHaveBeenCalled()
  fireEvent.click(row.getByRole('button', { name: en.confirmRemove }))
  await screen.findByText(en.empty)
  expect(remove).toHaveBeenCalledOnce()
})

it('aborts dialog-owned work and discards a response that arrives after closing', async () => {
  const pending = Promise.withResolvers<UserCredentialView[]>()
  let signal: AbortSignal | undefined
  const list = vi.fn((current: AbortSignal) => { signal = current; return pending.promise })
  const view = render(<CredentialsPanel {...actions({ list })} t={t} report={() => {}} onClose={() => {}} />)
  expect(signal?.aborted).toBe(false)
  view.unmount()
  expect(signal?.aborted).toBe(true)
  pending.resolve([saved])
  await pending.promise
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('loads models after saving, displays their count and allows an explicit refresh', async () => {
  let rows: UserCredentialView[] = []
  const refreshModels = vi.fn(async () => ({ status: 'ready' as const, modelCount: 12 }))
  const report = vi.fn()
  render(<CredentialsPanel {...actions({ list: async () => rows, create: async () => { rows = [saved]; return saved }, refreshModels })}
    t={t} report={report} onClose={() => {}} />)
  await screen.findByText(en.empty)
  fireEvent.change(screen.getByLabelText(en.name), { target: { value: saved.name } })
  fireEvent.change(screen.getByLabelText(en.value), { target: { value: 'PRIVATE-CANARY' } })
  fireEvent.click(screen.getByRole('button', { name: en.save }))
  await screen.findByText(t('modelsLoaded', { count: 12 }))
  expect(refreshModels).toHaveBeenCalledWith(saved.id, false, expect.any(AbortSignal))
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: en.modelsRefresh }).disabled).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: en.modelsRefresh }))
  await waitFor(() => { expect(refreshModels).toHaveBeenCalledWith(saved.id, true, expect.any(AbortSignal)) })
  expect(document.body.textContent).not.toContain('PRIVATE-CANARY')
  expect(report).toHaveBeenCalledWith('saved', true)
})

it('keeps the saved credential visible when model loading fails and supports retry', async () => {
  let status: 'failed' | 'ready' = 'failed'
  const refreshModels = vi.fn(async () => ({ status, modelCount: status === 'ready' ? 2 : 0 }))
  render(<CredentialsPanel {...actions({ list: async () => [saved], refreshModels })} t={t} report={() => {}} onClose={() => {}} />)
  await screen.findByText(en.modelsFailed)
  expect(screen.getByText(saved.name)).toBeTruthy()
  status = 'ready'
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: en.modelsRetry }).disabled).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: en.modelsRetry }))
  await screen.findByText(t('modelsLoaded', { count: 2 }))
  expect(screen.queryByText(en.modelsFailed)).toBeNull()
})
