/** Queries, user gestures and connection replacement use distinct lifetimes. */
import { afterEach, expect, test, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ConnectionGeneration } from '@deepseek-ai/dsh-client-connection/client'
import type { SandboxValue } from '@deepseek-ai/dsh-harness-sandbox/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { SandboxModel, type SandboxApi, type SandboxView } from '../src/client/model.ts'

const workspaceId = 'workspace-a' as WorkspaceId
const generation: ConnectionGeneration = { id: 1, host: { home: '/home/test' } }
const controllers: AbortController[] = []
const models: SandboxModel[] = []
const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const value = (state: SandboxValue['state']): RemoteResult<SandboxValue> => ({ ok: true, value: { workspaceId, state } })

afterEach(async () => {
  controllers.splice(0).forEach((controller) => { controller.abort() })
  await Promise.all(models.splice(0).map(model => model.dispose()))
  vi.useRealTimers()
})

function fixture() {
  vi.useFakeTimers()
  const generations = createSnapshotStore<ConnectionGeneration | undefined>(generation)
  const api = { open: vi.fn<SandboxApi['open']>().mockResolvedValue(value('running')),
    status: vi.fn<SandboxApi['status']>().mockResolvedValue(value('closed')),
    close: vi.fn<SandboxApi['close']>().mockResolvedValue(value('closed')) }
  const allowed = vi.fn(() => true)
  const model = new SandboxModel(api, generations, 100, allowed)
  models.push(model)
  const controller = new AbortController()
  controllers.push(controller)
  const seen: SandboxView[] = []
  const following = (async () => {
    for await (const frame of model.watch(workspaceId, controller.signal)) if (frame.ok) seen.push(frame.value)
  })()
  return { api, model, generations, controller, seen, following, allowed }
}

test('polls current status without opening and stops after its last holder leaves', async () => {
  const f = fixture()
  await flush()
  expect(f.seen.at(-1)?.state).toBe('closed')
  expect(f.api.open).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(100)
  expect(f.api.status).toHaveBeenCalledTimes(2)
  f.controller.abort()
  await f.following
  await vi.advanceTimersByTimeAsync(500)
  expect(f.api.status).toHaveBeenCalledTimes(2)
})

test('a failed query preserves the last state and never guesses closed', async () => {
  const f = fixture()
  f.api.status.mockResolvedValue(value('running'))
  f.model.refresh(workspaceId)
  await flush()
  f.api.status.mockRejectedValue(new Error('/private/runner/socket'))
  await vi.advanceTimersByTimeAsync(100)
  expect(f.seen.at(-1)).toMatchObject({ state: 'running', statusFailure: { operation: 'status', reason: 'request_failed' } })
  expect(JSON.stringify(f.seen)).not.toContain('/private')
  f.api.status.mockResolvedValue(value('closed'))
  await vi.advanceTimersByTimeAsync(100)
  expect(f.seen.at(-1)).toMatchObject({ state: 'closed', statusFailure: undefined })
})

test('one admitted opening publishes progress and refreshes after confirmation', async () => {
  const f = fixture()
  await flush()
  let complete!: (result: RemoteResult<SandboxValue>) => void
  f.api.open.mockImplementation(() => new Promise((resolve) => { complete = resolve }))
  const first = f.model.change(workspaceId, 'open')
  await flush()
  expect(f.seen.at(-1)?.pending).toBe('open')
  expect(await f.model.change(workspaceId, 'open')).toMatchObject({ reason: 'busy' })
  expect(f.api.open).toHaveBeenCalledTimes(1)
  f.api.status.mockResolvedValue(value('running'))
  complete(value('running'))
  expect(await first).toBeUndefined()
  await flush()
  expect(f.seen.at(-1)).toMatchObject({ state: 'running', pending: undefined })
})

test('capacity failure is retained through queries and never retries opening automatically', async () => {
  const f = fixture()
  await flush()
  f.api.open.mockResolvedValue({ ok: false, error: new RemoteError('sandbox/failed', 'internal', { reason: 'sandbox_capacity', outcomeUnknown: false }) })
  expect(await f.model.change(workspaceId, 'open')).toMatchObject({ reason: 'sandbox_capacity', outcomeUnknown: false })
  await vi.advanceTimersByTimeAsync(500)
  expect(f.api.open).toHaveBeenCalledTimes(1)
  expect(f.seen.at(-1)?.failure?.reason).toBe('sandbox_capacity')
})

test('a panel may close and reopen while its user mutation remains owned', async () => {
  const f = fixture()
  await flush()
  let complete!: (result: RemoteResult<SandboxValue>) => void
  f.api.close.mockImplementation((_id, signal) => {
    expect(signal.aborted).toBe(false)
    return new Promise((resolve) => { complete = resolve })
  })
  const operation = f.model.change(workspaceId, 'close')
  f.controller.abort()
  await f.following
  const replacement = new AbortController()
  controllers.push(replacement)
  const seen: SandboxView[] = []
  const following = (async () => {
    for await (const frame of f.model.watch(workspaceId, replacement.signal)) if (frame.ok) seen.push(frame.value)
  })()
  await flush()
  expect(seen.at(-1)?.pending).toBe('close')
  complete(value('closed'))
  await operation
  await vi.advanceTimersByTimeAsync(100)
  expect(seen.at(-1)?.state).toBe('closed')
  expect(f.api.status.mock.calls.length).toBeGreaterThan(1)
  replacement.abort()
  await following
})

test('replacement connection discards a delayed old query and repulls', async () => {
  const f = fixture()
  await flush()
  let complete!: (result: RemoteResult<SandboxValue>) => void
  f.api.status.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
  f.model.refresh(workspaceId)
  f.generations.set(undefined)
  await flush()
  expect(f.seen.at(-1)).toMatchObject({ connected: false, state: undefined })
  f.api.status.mockResolvedValue(value('running'))
  f.generations.set({ ...generation, id: 2 })
  await flush()
  complete(value('closed'))
  await flush()
  expect(f.seen.at(-1)).toMatchObject({ state: 'running', connected: true })
})

test('permission withdrawal clears observations and prevents all management calls', async () => {
  const f = fixture()
  await flush()
  const queries = f.api.status.mock.calls.length
  f.allowed.mockReturnValue(false)
  f.model.refresh(workspaceId)
  expect(await f.model.change(workspaceId, 'open')).toMatchObject({ reason: 'denied', outcomeUnknown: false })
  expect(await f.model.change(workspaceId, 'close')).toMatchObject({ reason: 'denied', outcomeUnknown: false })
  await flush()
  expect(f.seen.at(-1)).toMatchObject({ state: undefined, statusFailure: { reason: 'denied' } })
  expect(f.api.status).toHaveBeenCalledTimes(queries)
  expect(f.api.open).not.toHaveBeenCalled()
  expect(f.api.close).not.toHaveBeenCalled()
})

test('a later query failure cannot erase an unknown mutation result', async () => {
  const f = fixture()
  await flush()
  f.api.open.mockResolvedValue({ ok: false, error: new RemoteError('sandbox/failed', 'private details',
    { reason: 'runner_outcome_unknown', outcomeUnknown: true }) })
  await f.model.change(workspaceId, 'open')
  f.api.status.mockRejectedValue(new Error('offline'))
  await vi.advanceTimersByTimeAsync(100)
  expect(f.seen.at(-1)).toMatchObject({ failure: { outcomeUnknown: true }, statusFailure: { operation: 'status' } })
  f.api.status.mockResolvedValue(value('closing'))
  await vi.advanceTimersByTimeAsync(100)
  expect(f.seen.at(-1)).toMatchObject({ state: 'closing', failure: { outcomeUnknown: true }, statusFailure: undefined })
  expect(f.api.open).toHaveBeenCalledTimes(1)
})

test('a failed close stays closing and permits an explicit retry', async () => {
  const f = fixture()
  await flush()
  f.api.status.mockResolvedValue(value('closing'))
  f.api.close.mockResolvedValueOnce({ ok: false, error: new RemoteError('sandbox/failed', 'private details',
    { reason: 'sandbox_cleanup_required', outcomeUnknown: false }) })
  expect(await f.model.change(workspaceId, 'close')).toMatchObject({ reason: 'sandbox_cleanup_required' })
  await flush()
  expect(f.seen.at(-1)?.state).toBe('closing')
  f.api.status.mockResolvedValue(value('closed'))
  expect(await f.model.change(workspaceId, 'close')).toBeUndefined()
  await flush()
  expect(f.seen.at(-1)).toMatchObject({ state: 'closed', failure: undefined })
})

test('an opening response from a lost connection cannot publish running or retry', async () => {
  const f = fixture()
  await flush()
  const completion = Promise.withResolvers<RemoteResult<SandboxValue>>()
  f.api.open.mockImplementation(() => completion.promise)
  const opening = f.model.change(workspaceId, 'open')
  f.generations.set(undefined)
  completion.resolve(value('running'))
  expect(await opening).toMatchObject({ reason: 'disconnected', outcomeUnknown: true })
  await flush()
  expect(f.seen.at(-1)).toMatchObject({ connected: false, state: undefined })
  expect(f.api.open).toHaveBeenCalledTimes(1)
})


test.each([
  { code: 'workspace/session-operation-forbidden', reason: 'mode_forbidden', details: {
    workspaceId, sessionId: 'single-session' as SessionId, operation: 'archive' } },
  { code: 'workspace/mode-recovery-required', reason: 'mode_recovery', details: { workspaceId } },
] as const)('preserves stable workspace admission guidance for $code', async ({ code, reason, details }) => {
  const f = fixture()
  f.api.open.mockResolvedValue({ ok: false, error: new RemoteError(code, 'private diagnostic', details) })
  expect(await f.model.change(workspaceId, 'open')).toEqual({ reason, operation: 'open', outcomeUnknown: false })
})
