/** Optional provider drains cancelled reads and never saves an incomplete download. */
import { Context } from '@deepseek-ai/cordis'
import { cancelledFailure } from '@deepseek-ai/dsh-api-gateway/client'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { afterEach, expect, it, vi } from 'vitest'
import type { WorkspaceArtifactListing, WorkspaceArtifactScope } from '../src/types.ts'
import * as provider from '../src/client/index.ts'
import { downloadArtifact, saveArtifact } from '../src/client/transfer.ts'

vi.mock('../src/client/transfer.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/client/transfer.ts')>()
  return { ...original, downloadArtifact: vi.fn(original.downloadArtifact), saveArtifact: vi.fn() }
})

const contexts: Context[] = []
const id = 'owned' as WorkspaceId
const listing: WorkspaceArtifactListing = { path: '', entries: [], truncated: false, maxDownloadBytes: 3 }
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllGlobals()
  vi.mocked(saveArtifact).mockReset()
})

type List = (request: WorkspaceArtifactScope, path: string, signal?: AbortSignal) => Promise<RemoteResult<WorkspaceArtifactListing>>
async function setup(list: List
  = vi.fn(async (): Promise<RemoteResult<WorkspaceArtifactListing>> => ({ ok: true, value: listing }))) {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('remote', { workspaceArtifacts: { list } } as never)
  ctx.provide('remote.workspaceArtifacts', { list } as never)
  const fiber = ctx.plugin(provider)
  await fiber.await()
  return { ctx, fiber, list }
}

it('returns generated listing results and saves exact leaf names after complete receipt', async () => {
  const { ctx, list } = await setup()
  const signal = new AbortController().signal
  expect(await ctx.workspaceArtifactFiles.listFiles(id, '', signal)).toEqual({ ok: true, value: listing })
  expect(list).toHaveBeenCalledWith({ workspaceId: id }, '', expect.any(AbortSignal))
  vi.stubGlobal('fetch', vi.fn(async () => new Response('abc')))
  expect(await ctx.workspaceArtifactFiles.downloadFile(id, 'nested/结果.bin', 3, signal)).toEqual({ ok: true, value: undefined })
  expect(saveArtifact).toHaveBeenCalledWith(expect.any(Blob), '结果.bin')
})

it('retains a typed listing refusal and contains unexpected transport failure', async () => {
  const list = vi.fn(async (): Promise<RemoteResult<WorkspaceArtifactListing>> => ({ ok: false,
    error: new RemoteError('workspace-artifact/failed', 'not found', { reason: 'not-found' }),
  }))
  const { ctx } = await setup(list)
  expect(await ctx.workspaceArtifactFiles.listFiles(id, '', new AbortController().signal)).toMatchObject({ error: { reason: 'not-found' } })
  list.mockRejectedValueOnce(new Error('offline'))
  expect(await ctx.workspaceArtifactFiles.listFiles(id, '', new AbortController().signal)).toMatchObject({ error: { reason: 'io' } })
  list.mockResolvedValueOnce({ ok: false, error: new RemoteError('remote-access/denied', 'access denied',
    { action: 'workspaceArtifacts/list', reason: 'not-found' }) })
  expect(await ctx.workspaceArtifactFiles.listFiles(id, '', new AbortController().signal)).toMatchObject({ error: { reason: 'denied' } })
})

it('refuses saving when cancellation arrives after transport receipt', async () => {
  const { ctx } = await setup()
  const controller = new AbortController()
  vi.mocked(downloadArtifact).mockImplementationOnce(async () => {
    controller.abort()
    return { ok: true, value: new Blob(['abc']) }
  })
  expect(await ctx.workspaceArtifactFiles.downloadFile(id, 'file', 3, controller.signal)).toMatchObject({ error: { reason: 'cancelled' } })
  expect(saveArtifact).not.toHaveBeenCalled()
})

it.each(['caller', 'provider'] as const)('reports Gateway failure-result cancellation by the %s', async (owner) => {
  let release!: () => void
  let entered!: () => void
  const ready = new Promise<void>((resolve) => { entered = resolve })
  const list = vi.fn((_request: WorkspaceArtifactScope, _path: string, signal?: AbortSignal) =>
    new Promise<RemoteResult<WorkspaceArtifactListing>>((resolve) => {
      release = () => { resolve({ ok: true, value: listing }) }
      signal!.addEventListener('abort', () => { resolve(cancelledFailure('workspaceArtifacts/list', signal!.reason)) }, { once: true })
      entered()
    }))
  const { ctx, fiber } = await setup(list)
  const controller = new AbortController()
  const operation = ctx.workspaceArtifactFiles.listFiles(id, '', controller.signal)
  try {
    await ready
    if (owner === 'caller') controller.abort()
    else await fiber.dispose()
    expect(await operation).toMatchObject({ error: { reason: 'cancelled' } })
  } finally { release(); await operation }
})

it('withdraws browser capability and cancels an active download before returning', async () => {
  const { ctx, fiber } = await setup()
  let entered!: () => void
  const ready = new Promise<void>((resolve) => { entered = resolve })
  vi.stubGlobal('fetch', vi.fn((_path: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    options.signal!.addEventListener('abort', () => { reject(new Error('download aborted', { cause: options.signal!.reason })) }, { once: true })
    entered()
  })))
  const service = ctx.workspaceArtifactFiles
  const operation = service.downloadFile(id, 'file', 3, new AbortController().signal)
  await ready
  await fiber.dispose()
  expect(await operation).toMatchObject({ error: { reason: 'cancelled' } })
  expect(ctx.get('workspaceArtifactFiles')).toBeUndefined()
  expect(await service.listFiles(id, '', new AbortController().signal)).toMatchObject({ error: { reason: 'cancelled' } })
  expect(await service.downloadFile(id, 'file', 3, new AbortController().signal)).toMatchObject({ error: { reason: 'cancelled' } })
  expect(saveArtifact).not.toHaveBeenCalled()
})

it('reports a refused download or failed browser save without success', async () => {
  const { ctx } = await setup()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 403 })))
  expect(await ctx.workspaceArtifactFiles.downloadFile(id, 'file', 3, new AbortController().signal)).toMatchObject({ error: { reason: 'denied' } })
  expect(saveArtifact).not.toHaveBeenCalled()
  vi.stubGlobal('fetch', vi.fn(async () => new Response('abc')))
  vi.mocked(saveArtifact).mockImplementationOnce(() => { throw new Error('save failed') })
  expect(await ctx.workspaceArtifactFiles.downloadFile(id, 'file', 3, new AbortController().signal)).toMatchObject({ error: { reason: 'io' } })
})
