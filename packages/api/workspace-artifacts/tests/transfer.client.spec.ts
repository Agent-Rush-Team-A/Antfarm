/** Complete binary receipt, byte caps, cancellation and temporary browser download ownership. */
import { afterEach, expect, it, vi } from 'vitest'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { downloadArtifact } from '../src/client/transfer.ts'

const id = 'owned' as WorkspaceId
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('preserves binary content and uses a deployment-relative URL', async () => {
  const bytes = new Uint8Array([0, 255, 128])
  const fetch = vi.fn(async () => new Response(bytes, { headers: { 'content-length': '3' } }))
  vi.stubGlobal('fetch', fetch)
  const signal = new AbortController().signal
  const result = await downloadArtifact(id, '目录/结果.bin', 3, signal)
  expect(result.ok).toBe(true)
  if (result.ok) expect(new Uint8Array(await result.value.arrayBuffer())).toEqual(bytes)
  expect(fetch).toHaveBeenCalledWith('api/workspace/downloadFileBinary?'
    + new URLSearchParams({ workspaceId: id, path: '目录/结果.bin' }).toString(),
  { credentials: 'same-origin', signal })
})

it.each([401, 403])('reports HTTP %s as a permission refusal', async (status) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status })))
  expect(await downloadArtifact(id, 'file', 3, new AbortController().signal)).toEqual({ ok: false, error: { reason: 'denied' } })
})

it.each(['not-found', 'invalid-path', 'too-large'])('retains the Host refusal %s', async (reason) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: false, error: { reason } }, { status: 400 })))
  expect(await downloadArtifact(id, 'file', 3, new AbortController().signal)).toMatchObject({ error: { reason } })
})

it.each([true, false])('refuses excessive bytes with advertised size %s', async (advertised) => {
  const cancel = vi.fn()
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4)) }, cancel })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, advertised ? { headers: { 'content-length': '4' } } : {})))
  expect(await downloadArtifact(id, 'file', 3, new AbortController().signal)).toMatchObject({ error: { reason: 'too-large' } })
  expect(cancel).toHaveBeenCalledOnce()
})

it('rejects a truncated response without creating a download', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('ab', { headers: { 'content-length': '3' } })))
  expect(await downloadArtifact(id, 'file', 3, new AbortController().signal)).toMatchObject({ error: { reason: 'io' } })
})

it('cancels and drains a parked body read', async () => {
  let read!: () => void
  const requested = new Promise<void>((resolve) => { read = resolve })
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({ pull() { read() }, cancel }, { highWaterMark: 0 })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
  const controller = new AbortController()
  const operation = downloadArtifact(id, 'file', 3, controller.signal)
  await requested
  controller.abort()
  expect(await operation).toMatchObject({ error: { reason: 'cancelled' } })
  expect(cancel).toHaveBeenCalledOnce()
})

it('does not send a request for an already cancelled caller', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const controller = new AbortController()
  controller.abort()
  expect(await downloadArtifact(id, 'file', 3, controller.signal)).toMatchObject({ error: { reason: 'cancelled' } })
  expect(fetch).not.toHaveBeenCalled()
})

it.each([true, false])('contains an absent successful body with an advertised excessive length: %s', async (excessive) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, excessive ? { headers: { 'content-length': '4' } } : {})))
  expect(await downloadArtifact(id, 'file', 3, new AbortController().signal))
    .toMatchObject({ error: { reason: excessive ? 'too-large' : 'io' } })
})

it('contains malformed failure data and a body read error', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ unexpected: 'response' }, { status: 500 })))
  expect(await downloadArtifact(id, 'file', 3, new AbortController().signal)).toMatchObject({ error: { reason: 'io' } })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('broken stream')) } }))))
  expect(await downloadArtifact(id, 'file', 3, new AbortController().signal)).toMatchObject({ error: { reason: 'io' } })
})

it('drains a stream cancelled while its reader is being acquired', async () => {
  const controller = new AbortController()
  const response = new Response(new ReadableStream({ pull() {} }, { highWaterMark: 0 }))
  const getReader = response.body!.getReader.bind(response.body)
  vi.spyOn(response.body!, 'getReader').mockImplementationOnce(() => { controller.abort(); return getReader() })
  vi.stubGlobal('fetch', vi.fn(async () => response))
  expect(await downloadArtifact(id, 'file', 3, controller.signal)).toMatchObject({ error: { reason: 'cancelled' } })
  expect(response.body!.locked).toBe(false)
})
