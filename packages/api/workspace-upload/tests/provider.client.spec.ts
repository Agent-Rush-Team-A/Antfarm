/** Optional browser provider withdraws capability and settles active transfers. */
import { Context } from '@deepseek-ai/cordis'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { cancelledFailure } from '@deepseek-ai/dsh-api-gateway/client'
import type { WorkspaceUploadLimits, WorkspaceUploadScope } from '../src/types.ts'
import { afterEach, expect, it, vi } from 'vitest'
import * as provider from '../src/client/index.ts'
import type { WorkspaceUploads } from '../src/client/index.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllGlobals()
})

it('aborts and drains a pending transfer before removing the browser capability', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  const limits = vi.fn(async () => ({ ok: true as const, value: { maxBytes: 3 } }))
  ctx.provide('remote', { workspaceUpload: { limits } } as never)
  ctx.provide('remote.workspaceUpload', { limits } as never)
  const send = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
  }))
  vi.stubGlobal('fetch', send)
  const fiber = ctx.plugin(provider)
  await fiber.await()
  const service = ctx.get('workspaceUploads') as WorkspaceUploads
  const file = new File(['abc'], 'file')
  const controller = new AbortController()
  const id = 'owned' as WorkspaceId
  const operation = service.uploadFile(id, file, controller.signal)
  await expect.poll(() => send.mock.calls.length).toBe(1)
  await fiber.dispose()
  expect(await operation).toEqual({ ok: false, error: { reason: 'unknown', stored: false } })
  expect(ctx.get('workspaceUploads')).toBeUndefined()
  expect(await service.uploadFile(id, file, controller.signal)).toMatchObject({ error: { reason: 'cancelled', stored: false } })
  expect(limits).toHaveBeenCalledOnce()
  expect(send).toHaveBeenCalledOnce()
})

it('does not admit a caller whose signal is already cancelled', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  const limits = vi.fn()
  ctx.provide('remote', { workspaceUpload: { limits } } as never)
  ctx.provide('remote.workspaceUpload', { limits } as never)
  const fiber = ctx.plugin(provider)
  await fiber.await()
  const controller = new AbortController()
  controller.abort()
  expect(await ctx.workspaceUploads.uploadFile('owned' as WorkspaceId, new File([], 'file'), controller.signal))
    .toMatchObject({ error: { reason: 'cancelled', stored: false } })
  expect(limits).not.toHaveBeenCalled()
})

it.each([
  { owner: 'caller', response: 'throw' }, { owner: 'provider', response: 'throw' },
  { owner: 'caller', response: 'result' }, { owner: 'provider', response: 'result' },
])('cancels a parked limit read when the $owner ends with a $response response', async ({ owner, response }) => {
  const ctx = new Context()
  contexts.push(ctx)
  let release = (): void => {}
  const limits = vi.fn((_request: WorkspaceUploadScope, signal?: AbortSignal) =>
    new Promise<RemoteResult<WorkspaceUploadLimits>>((resolve, reject) => {
      release = () => { resolve({ ok: true, value: { maxBytes: 3 } }) }
      signal?.addEventListener('abort', () => {
        if (response === 'result') resolve(cancelledFailure('workspaceUpload/limits', signal.reason))
        else reject(new Error('aborted'))
      }, { once: true })
    }))
  ctx.provide('remote', { workspaceUpload: { limits } } as never)
  ctx.provide('remote.workspaceUpload', { limits } as never)
  const send = vi.fn()
  vi.stubGlobal('fetch', send)
  const fiber = ctx.plugin(provider)
  await fiber.await()
  const controller = new AbortController()
  const operation = ctx.workspaceUploads.uploadFile('owned' as WorkspaceId, new File(['abc'], 'file'), controller.signal)
  let settled = false
  void operation.then(() => { settled = true })
  let closing: Promise<void> | undefined
  try {
    await expect.poll(() => limits.mock.calls.length).toBe(1)
    expect(limits.mock.calls[0]![1]).toBeInstanceOf(AbortSignal)
    if (owner === 'caller') controller.abort()
    else closing = fiber.dispose()
    await expect.poll(() => settled).toBe(true)
    expect(await operation).toEqual({ ok: false, error: { reason: 'cancelled', stored: false } })
    await closing
    expect(send).not.toHaveBeenCalled()
  } finally {
    release()
    await operation
    await fiber.dispose()
  }
})
