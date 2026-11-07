/** Generation ownership across queued input, cleanup, cancellation, and late cloud responses. */
import { expect, test, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RunnerRunningSandbox, SandboxContainerId } from '../src/runner-client.ts'
import { TaskSandboxFailure, TaskSandboxLifecycle, type TaskSandboxDriver } from '../src/mode-reclamation.ts'

function fixture() {
  let sequence = 0
  const driver = {
    open: vi.fn(async () => ({ state: 'running' as const, containerId: brandString<SandboxContainerId>(`generation-${++sequence}`) })),
    close: vi.fn(async () => {}),
    failed: vi.fn(),
  } satisfies TaskSandboxDriver
  return { driver, lifecycle: new TaskSandboxLifecycle(driver), signal: new AbortController().signal }
}

test('validation reserves work without allocating a container', async () => {
  const f = fixture()
  const reservation = await f.lifecycle.reserve(f.signal)
  expect(f.lifecycle.status()).toBe('reserved')
  expect(f.driver.open).not.toHaveBeenCalled()
  await reservation.release()
  await f.lifecycle.dispose()
  expect(f.driver.close).not.toHaveBeenCalled()
})

test('input received before the final release retains the existing generation during preparation', async () => {
  const f = fixture()
  const current = await f.lifecycle.acquire(f.signal)
  const preparing = f.lifecycle.reserve(f.signal)
  await current.release()
  expect(f.driver.close).not.toHaveBeenCalled()
  const next = await preparing
  expect(await next.ready()).toBe(current.target)
  await next.release()
  expect(f.driver.open).toHaveBeenCalledOnce()
  expect(f.driver.close).toHaveBeenCalledOnce()
})

test('cancelled preparation releases its reservation without allocating resources', async () => {
  const f = fixture()
  const caller = new AbortController()
  const reservation = await f.lifecycle.reserve(caller.signal)
  const failure = new Error('validation cancelled')
  caller.abort(failure)
  await expect(reservation.ready()).rejects.toBe(failure)
  await reservation.release()
  expect(f.driver.open).not.toHaveBeenCalled()
  expect(f.lifecycle.status()).toBe('closed')
})

test('a released reservation cannot start a later generation', async () => {
  const f = fixture()
  const old = await f.lifecycle.reserve(f.signal)
  await old.release()
  const next = await f.lifecycle.acquire(f.signal)
  await expect(old.ready()).rejects.toThrow('reservation was released')
  expect(f.driver.open).toHaveBeenCalledOnce()
  await next.release()
})

test('queued input and writes share a generation until the final reservation settles', async () => {
  const f = fixture()
  const first = await f.lifecycle.acquire(f.signal)
  const queued = await f.lifecycle.acquire(f.signal)
  const write = await f.lifecycle.acquire(f.signal)
  expect(first.target).toBe(queued.target)
  await first.release()
  await queued.release()
  expect(f.driver.close).not.toHaveBeenCalled()
  await write.release()
  expect(f.driver.close).toHaveBeenCalledExactlyOnceWith(first.target)
  expect(f.lifecycle.status()).toBe('closed')
})

test('input arriving after closing starts waits for a fresh generation', async () => {
  const f = fixture()
  const deletion = Promise.withResolvers<undefined>()
  vi.mocked(f.driver.close).mockReturnValueOnce(deletion.promise)
  const old = await f.lifecycle.acquire(f.signal)
  const released = old.release()
  expect(f.lifecycle.status()).toBe('closing')
  const next = f.lifecycle.acquire(f.signal)
  expect(f.driver.open).toHaveBeenCalledOnce()
  deletion.resolve(undefined)
  await released
  const fresh = await next
  expect(fresh.target.containerId).not.toBe(old.target.containerId)
  expect(f.driver.open).toHaveBeenCalledTimes(2)
  await fresh.release()
})

test('concurrent input during creation shares one provider request', async () => {
  const f = fixture()
  const opening = Promise.withResolvers<RunnerRunningSandbox>()
  const started = Promise.withResolvers<undefined>()
  vi.mocked(f.driver.open).mockImplementationOnce(() => { started.resolve(undefined); return opening.promise })
  const first = f.lifecycle.acquire(f.signal)
  const second = f.lifecycle.acquire(f.signal)
  await started.promise
  expect(f.driver.open).toHaveBeenCalledOnce()
  opening.resolve({ state: 'running', containerId: brandString<SandboxContainerId>('shared') })
  const [a, b] = await Promise.all([first, second])
  await a.release()
  expect(f.driver.close).not.toHaveBeenCalled()
  await b.release()
  expect(f.driver.close).toHaveBeenCalledOnce()
})

test('cancelling one waiting message leaves the other reservation intact', async () => {
  const f = fixture()
  const opening = Promise.withResolvers<RunnerRunningSandbox>()
  vi.mocked(f.driver.open).mockReturnValueOnce(opening.promise)
  const caller = new AbortController()
  const cancelled = f.lifecycle.acquire(caller.signal)
  const surviving = f.lifecycle.acquire(f.signal)
  const reason = new Error('message cancelled')
  caller.abort(reason)
  await expect(cancelled).rejects.toBe(reason)
  opening.resolve({ state: 'running', containerId: brandString<SandboxContainerId>('survivor') })
  const active = await surviving
  expect(f.driver.close).not.toHaveBeenCalled()
  await active.release()
})

test('a late successful creation is destroyed after all waiting messages cancel', async () => {
  const f = fixture()
  const opening = Promise.withResolvers<RunnerRunningSandbox>()
  const deleted = Promise.withResolvers<undefined>()
  const started = Promise.withResolvers<undefined>()
  vi.mocked(f.driver.open).mockImplementationOnce(() => { started.resolve(undefined); return opening.promise })
  vi.mocked(f.driver.close).mockImplementationOnce(async () => { deleted.resolve(undefined) })
  const caller = new AbortController()
  const request = f.lifecycle.acquire(caller.signal)
  await started.promise
  const reason = new Error('cancelled before VM allocation completed')
  caller.abort(reason)
  expect(f.lifecycle.status()).toBe('opening')
  const target: RunnerRunningSandbox = { state: 'running', containerId: brandString<SandboxContainerId>('late') }
  opening.resolve(target)
  await deleted.promise
  await expect(request).rejects.toBe(reason)
  await f.lifecycle.dispose()
  expect(f.driver.close).toHaveBeenCalledExactlyOnceWith(target)
})

test('cancellation while waiting for deletion does not reopen an unused environment', async () => {
  const f = fixture()
  const deletion = Promise.withResolvers<undefined>()
  vi.mocked(f.driver.close).mockReturnValueOnce(deletion.promise)
  const active = await f.lifecycle.acquire(f.signal)
  const released = active.release()
  const caller = new AbortController()
  const waiting = f.lifecycle.acquire(caller.signal)
  const reason = new Error('no longer needed')
  caller.abort(reason)
  await expect(waiting).rejects.toBe(reason)
  deletion.resolve(undefined)
  await released
  expect(f.driver.open).toHaveBeenCalledOnce()
})

test('releasing an old reservation again cannot destroy a newer generation', async () => {
  const f = fixture()
  const old = await f.lifecycle.acquire(f.signal)
  const release = old.release()
  expect(old.release()).toBe(release)
  await release
  const fresh = await f.lifecycle.acquire(f.signal)
  await old.release()
  expect(f.driver.close).toHaveBeenCalledOnce()
  expect(f.lifecycle.status()).toBe('running')
  await fresh.release()
})

test('failed deletion is reported and prevents allocating another paid environment', async () => {
  const f = fixture()
  const cause = new Error('delete response lost')
  vi.mocked(f.driver.close).mockRejectedValueOnce(cause)
  const active = await f.lifecycle.acquire(f.signal)
  await expect(active.release()).rejects.toMatchObject({ phase: 'close', cause })
  expect(f.lifecycle.status()).toBe('cleanup-required')
  await expect(f.lifecycle.acquire(f.signal)).rejects.toBeInstanceOf(TaskSandboxFailure)
  expect(f.driver.open).toHaveBeenCalledOnce()
  expect(f.driver.failed).toHaveBeenCalledOnce()
  await expect(f.lifecycle.dispose()).rejects.toMatchObject({ phase: 'close' })
})

test('uncertain creation is reported and is never retried as another allocation', async () => {
  const f = fixture()
  const cause = new Error('create acknowledgement lost')
  vi.mocked(f.driver.open).mockRejectedValueOnce(cause)
  await expect(f.lifecycle.acquire(f.signal)).rejects.toMatchObject({ phase: 'open', cause })
  await expect(f.lifecycle.acquire(f.signal)).rejects.toMatchObject({ phase: 'open' })
  expect(f.driver.open).toHaveBeenCalledOnce()
  expect(f.driver.close).not.toHaveBeenCalled()
  expect(f.driver.failed).toHaveBeenCalledOnce()
})

test('disposal revokes users but waits for their work and cleanup to settle', async () => {
  const f = fixture()
  const active = await f.lifecycle.acquire(f.signal)
  const disposed = f.lifecycle.dispose()
  expect(active.signal.aborted).toBe(true)
  expect(f.driver.close).not.toHaveBeenCalled()
  await expect(f.lifecycle.acquire(f.signal)).rejects.toThrow('lifecycle stopped')
  await active.release()
  await disposed
  expect(f.lifecycle.dispose()).toBe(disposed)
})

test('disposal owns cleanup of a creation whose provider returns after cancellation', async () => {
  const f = fixture()
  const opening = Promise.withResolvers<RunnerRunningSandbox>()
  const started = Promise.withResolvers<undefined>()
  vi.mocked(f.driver.open).mockImplementationOnce(() => { started.resolve(undefined); return opening.promise })
  const waiting = f.lifecycle.acquire(f.signal)
  await started.promise
  const disposed = f.lifecycle.dispose()
  opening.resolve({ state: 'running', containerId: brandString<SandboxContainerId>('late-disposal') })
  await expect(waiting).rejects.toThrow('lifecycle stopped')
  await disposed
  expect(f.driver.close).toHaveBeenCalledOnce()
})

test('already cancelled input never allocates a sandbox', async () => {
  const f = fixture()
  const caller = new AbortController()
  caller.abort(new Error('cancelled'))
  await expect(f.lifecycle.acquire(caller.signal)).rejects.toThrow('cancelled')
  expect(f.driver.open).not.toHaveBeenCalled()
  await f.lifecycle.dispose()
})

test('failure reporting exceptions preserve the original cleanup failure', async () => {
  const f = fixture()
  const cause = new Error('cloud failure')
  vi.mocked(f.driver.open).mockRejectedValueOnce(cause)
  vi.mocked(f.driver.failed).mockImplementationOnce(() => { throw new Error('logger failed') })
  const failed: unknown = await f.lifecycle.acquire(f.signal).catch((error: unknown) => error)
  expect(failed).toBeInstanceOf(TaskSandboxFailure)
  if (!(failed instanceof TaskSandboxFailure)) throw new Error('Expected a task sandbox failure')
  expect(failed.phase).toBe('open')
  expect(failed.cause).toBeInstanceOf(AggregateError)
  expect(f.lifecycle.status()).toBe('cleanup-required')
})
