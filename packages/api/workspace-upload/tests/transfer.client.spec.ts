/** Upload transport preserves bytes and visibly distinguishes unconfirmed writes. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { uploadWorkspaceFile } from '../src/client/transfer.ts'

const id = 'owned' as WorkspaceId
const file = new File([new Uint8Array([0, 255, 1])], '数据.bin')
const limits = async () => ({ ok: true as const, value: { maxBytes: 3 } })
afterEach(() => vi.unstubAllGlobals())

describe('Workspace upload browser transport', () => {
  it('sends the original binary file with workspace identity and preserved filename', async () => {
    const send = vi.fn(async (_url: string, _options: RequestInit) =>
      Response.json({ ok: true, value: { name: file.name, bytes: file.size } }))
    vi.stubGlobal('fetch', send)
    expect(await uploadWorkspaceFile(limits, id, file, new AbortController().signal))
      .toEqual({ ok: true, value: { name: file.name, bytes: file.size } })
    const [url, options] = send.mock.calls[0]!
    expect(new URL(url, 'http://host').searchParams.get('workspaceId')).toBe(id)
    expect(new URL(url, 'http://host').searchParams.get('name')).toBe(file.name)
    expect(options.body).toBe(file)
    expect(options.credentials).toBe('same-origin')
  })

  it('does not send bytes after a limit-read refusal, a failed read, pre-cancellation or local overflow', async () => {
    const send = vi.fn()
    vi.stubGlobal('fetch', send)
    const controller = new AbortController()
    const refused = async () => ({ ok: false as const, error: new RemoteError('workspace/not-found', 'Workspace not found', { workspaceId: id }) })
    expect(await uploadWorkspaceFile(refused, id, file, controller.signal)).toMatchObject({ error: { reason: 'denied', stored: false } })
    expect(await uploadWorkspaceFile(async () => { throw new Error('offline') }, id, file, controller.signal))
      .toMatchObject({ error: { reason: 'denied', stored: false } })
    const small = async () => ({ ok: true as const, value: { maxBytes: 2 } })
    expect(await uploadWorkspaceFile(small, id, file, controller.signal)).toMatchObject({ error: { reason: 'too-large', stored: false } })
    controller.abort()
    expect(await uploadWorkspaceFile(limits, id, file, controller.signal)).toMatchObject({ error: { reason: 'cancelled', stored: false } })
    expect(send).not.toHaveBeenCalled()
  })

  it.each([401, 403])('reports an HTTP %i admission refusal without parsing an error page', async (status) => {
    vi.stubGlobal('fetch', async () => new Response('forbidden', { status }))
    expect(await uploadWorkspaceFile(limits, id, file, new AbortController().signal))
      .toEqual({ ok: false, error: { reason: 'denied', stored: false } })
  })

  it('does not send bytes when cancellation races a completed limit read', async () => {
    const send = vi.fn()
    vi.stubGlobal('fetch', send)
    const controller = new AbortController()
    const read = async () => {
      controller.abort()
      return limits()
    }
    expect(await uploadWorkspaceFile(read, id, file, controller.signal))
      .toEqual({ ok: false, error: { reason: 'cancelled', stored: false } })
    expect(send).not.toHaveBeenCalled()
  })

  it.each(['/', '/tools/dsh/'])('preserves the document deployment prefix %s', async (prefix) => {
    const base = new URL(prefix, 'https://host.example')
    const send = vi.fn(async (_url: string) => Response.json({ ok: true, value: { name: file.name, bytes: file.size } }))
    vi.stubGlobal('fetch', send)
    expect(await uploadWorkspaceFile(limits, id, file, new AbortController().signal)).toMatchObject({ ok: true })
    expect(send).toHaveBeenCalledOnce()
    const target = new URL(send.mock.calls[0]![0], base)
    expect(target.pathname).toBe(prefix + 'api/workspace/uploadFileBinary')
    expect(target.searchParams.get('workspaceId')).toBe(id)
  })

  it.each([
    { reason: 'exists', stored: false, status: 409 },
    { reason: 'too-large', stored: false, status: 413 },
    { reason: 'cleanup', stored: true, status: 500 },
  ])('retains the server publication fact for $reason', async ({ reason, stored, status }) => {
    vi.stubGlobal('fetch', async () => Response.json({ ok: false, error: { reason, stored } }, { status }))
    expect(await uploadWorkspaceFile(limits, id, file, new AbortController().signal))
      .toEqual({ ok: false, error: { reason, stored } })
  })

  it.each([
    () => Promise.reject(new Error('response disconnected')),
    async () => new Response('not JSON'),
    async () => Response.json({ ok: false, error: { reason: 'unexpected', stored: false } }, { status: 500 }),
    async () => Response.json({ ok: true, value: { name: file.name, bytes: 3 } }, { status: 500 }),
    async () => Response.json({ ok: false, error: { reason: 'exists', stored: false } }),
  ])('reports a lost or inconsistent confirmation as unknown', async (send) => {
    vi.stubGlobal('fetch', send)
    expect(await uploadWorkspaceFile(limits, id, file, new AbortController().signal))
      .toEqual({ ok: false, error: { reason: 'unknown', stored: false } })
  })
})
