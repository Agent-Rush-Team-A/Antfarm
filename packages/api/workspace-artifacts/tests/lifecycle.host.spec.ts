/** Authority changes and I/O failures across descriptor acquisition and response settlement. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import WorkspaceArtifacts from '../src/index.ts'
import * as storage from '../src/storage.ts'
import { setup, id } from './fixture.ts'

vi.mock('../src/storage.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/storage.ts')>()
  return { ...original, listArtifacts: vi.fn(original.listArtifacts), openArtifact: vi.fn(original.openArtifact) }
})
const real = await vi.importActual<typeof import('../src/storage.ts')>('../src/storage.ts')

describe.skipIf(process.platform !== 'linux')('workspace artifact request lifetimes', () => {
  it('refuses a non-Linux deployment at construction', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    const ctx = new Context()
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      expect(() => new WorkspaceArtifacts(ctx)).toThrow('require Linux')
    } finally { Object.defineProperty(process, 'platform', platform) }
  })

  it('checks Remote listing authority before and after the scan', async () => {
    const fixture = await setup()
    const signal = new AbortController().signal
    expect(await fixture.remote.list({ workspaceId: id }, '', signal)).toMatchObject({ path: '' })
    expect(fixture.decide).toHaveBeenCalledWith(expect.objectContaining({ action: 'workspaceArtifacts/list' }))
    vi.mocked(storage.listArtifacts).mockImplementationOnce(async (...args) => {
      fixture.revoke()
      return real.listArtifacts(...args)
    })
    await expect(fixture.remote.list({ workspaceId: id }, '', signal)).rejects.toMatchObject({ details: { reason: 'denied' } })
    const scan = vi.mocked(storage.listArtifacts).mock.calls.length
    await expect(fixture.remote.list({ workspaceId: id }, '', signal)).rejects.toMatchObject({ details: { reason: 'denied' } })
    expect(storage.listArtifacts).toHaveBeenCalledTimes(scan)
  })

  it('refuses registry withdrawal during listing and contains a scan I/O failure', async () => {
    const fixture = await setup()
    vi.mocked(storage.listArtifacts).mockImplementationOnce(async (...args) => {
      const result = await real.listArtifacts(...args)
      fixture.absent()
      return result
    })
    await expect(fixture.service.list({ workspaceId: id }, '', new AbortController().signal))
      .rejects.toMatchObject({ details: { reason: 'not-found' } })
    const other = await setup()
    vi.mocked(storage.listArtifacts).mockRejectedValueOnce(new Error('scan failure'))
    await expect(other.service.list({ workspaceId: id }, '', new AbortController().signal))
      .rejects.toMatchObject({ details: { reason: 'io' } })
  })

  it.each(['', 'workspaceId=', 'workspaceId=workspace-id&workspaceId=workspace-id'])('refuses ambiguous workspace identity %s', async (query) => {
    const fixture = await setup()
    expect((await fixture.send(fixture.request(query + '&path=file'))).status).toBe(403)
  })

  it('rechecks admission even when the Fetch handler invokes the admitted route directly', async () => {
    const fixture = await setup()
    fixture.revoke()
    const response = await fixture.route.fetch(fixture.request(), fixture.peer)
    expect(response.status).toBe(403)
  })

  it('contains acquisition I/O failure and encodes punctuation in attachment names', async () => {
    const fixture = await setup()
    vi.mocked(storage.openArtifact).mockRejectedValueOnce(new Error('open failure'))
    const response = await fixture.send(fixture.request())
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: { reason: 'io' } })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(fixture.root + "/!'()*", 'abc')
    const punctuation = await fixture.send(fixture.request('workspaceId=workspace-id&path=' + encodeURIComponent("!'()*")))
    expect(punctuation.headers.get('content-disposition')).toContain('%21%27%28%29%2a')
    await punctuation.text()
  })

  it('reports a descriptor close failure instead of completing the response', async () => {
    const fixture = await setup()
    vi.mocked(storage.openArtifact).mockImplementationOnce(async (...args) => {
      const handle = await real.openArtifact(...args)
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementationOnce(async () => { await close(); throw new Error('close failure') })
      return handle
    })
    const response = await fixture.send(fixture.request())
    await expect(response.text()).rejects.toMatchObject({ reason: 'io' })
  })
})
