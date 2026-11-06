/** Route refusals and lifecycle settlement, with real Connection and filesystem. */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { id, setup } from './fixture.ts'

describe.skipIf(process.platform !== 'linux')('Workspace upload Host route', () => {
  it('fails load on an unsupported host platform', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
    await expect(setup()).rejects.toThrow('requires Linux')
  })

  it('publishes a bodyless file and preserves it on a duplicate upload', async () => {
    const fixture = await setup()
    const response = await fixture.send(fixture.request(undefined, { body: null }))
    expect(await response.json()).toMatchObject({ ok: true, value: { bytes: 0 } })
    expect((await fixture.send(fixture.request())).status).toBe(409)
    expect(await readFile(join(fixture.root, 'file'))).toHaveLength(0)
  })

  it('rechecks authority inside the mutation handler and rejects a retained handler after unload', async () => {
    const fixture = await setup()
    expect((await fixture.route.fetch(fixture.request('name=file'), fixture.peer)).status).toBe(403)
    fixture.revoke()
    expect((await fixture.route.fetch(fixture.request(), fixture.peer)).status).toBe(403)
    await fixture.fiber.dispose()
    expect((await fixture.route.fetch(fixture.request(), fixture.peer)).status).toBe(503)
    expect(await readdir(fixture.root)).toEqual([])
  })

  it.each([false, true])('contains an unexpected metadata failure with request cancellation %s', async (cancelled) => {
    const fixture = await setup()
    fixture.decide.mockImplementation(() => { throw new Error('access provider unavailable') })
    const controller = new AbortController()
    if (cancelled) controller.abort()
    const response = await fixture.route.fetch(fixture.request(undefined, { signal: controller.signal }), fixture.peer)
    expect(response.status).toBe(cancelled ? 400 : 500)
    expect(await response.json()).toMatchObject({ error: { reason: cancelled ? 'cancelled' : 'io', stored: false } })
    expect(await readdir(fixture.root)).toEqual([])
  })

  it('reports a body stream failure without publishing a partial file', async () => {
    const fixture = await setup()
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('connection lost')) } })
    const options: RequestInit & { duplex: 'half' } = { body, duplex: 'half' }
    const response = await fixture.send(fixture.request(undefined, options))
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: { reason: 'io', stored: false } })
    expect(await readdir(fixture.root)).toEqual([])
  })
  it('returns limits and publishes bytes under the authorized workspace root', async () => {
    const fixture = await setup()
    expect(fixture.service.limits({ workspaceId: id }, fixture.peer.signal)).toEqual({ maxBytes: 3 })
    expect(() => fixture.service.limits({ workspaceId: id }, AbortSignal.abort())).toThrow()
    const response = await fixture.send(fixture.request())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, value: { name: 'file', bytes: 3 } })
    expect(await readFile(join(fixture.root, 'file'), 'utf8')).toBe('abc')
    expect(fixture.decide).toHaveBeenCalledWith(expect.objectContaining({
      action: 'workspaceUpload/upload', resources: [{ kind: 'workspace', id }],
    }))
  })

  it.each([
    ['workspaceId=workspace-id&name=file', { headers: { 'content-type': 'text/plain' } }, 'invalid-request', 400],
    ['workspaceId=workspace-id', {}, 'invalid-name', 400],
    ['workspaceId=workspace-id&name=a&name=b', {}, 'invalid-name', 400],
    ['workspaceId=workspace-id&name=..%2Fescape', {}, 'invalid-name', 400],
    ['workspaceId=workspace-id&name=file', { headers: { 'content-type': 'application/octet-stream', 'content-length': 'bad' } }, 'invalid-request', 400],
    ['workspaceId=workspace-id&name=file', { headers: { 'content-type': 'application/octet-stream', 'content-length': '9007199254740992' } }, 'invalid-request', 400],
    ['workspaceId=workspace-id&name=file', { headers: { 'content-type': 'application/octet-stream', 'content-length': '4' } }, 'too-large', 413],
  ] as const)('rejects malformed intake %s with %s', async (query, options, reason, status) => {
    const fixture = await setup()
    const response = await fixture.send(fixture.request(query, options))
    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ ok: false, error: { reason, stored: false } })
    expect(await readdir(fixture.root)).toEqual([])
    expect(await readdir(fixture.home)).toEqual(['workspace'])
  })

  it.each(['name=file', 'workspaceId=&name=file', 'workspaceId=a&workspaceId=b&name=file'])('refuses missing or ambiguous workspace identity %s', async (query) => {
    const fixture = await setup()
    expect((await fixture.send(fixture.request(query))).status).toBe(403)
    expect(await readdir(fixture.root)).toEqual([])
  })

  it('reports a missing registry entry and refuses revoked authorization', async () => {
    const fixture = await setup()
    fixture.absent()
    expect(() => fixture.service.limits({ workspaceId: id }, fixture.peer.signal)).toThrow('Workspace not found')
    expect((await fixture.send(fixture.request())).status).toBe(404)
    fixture.revoke()
    expect((await fixture.send(fixture.request())).status).toBe(403)
    expect(await readdir(fixture.root)).toEqual([])
  })

  it.each(['permission', 'registration'])('refuses publication after %s changes during body intake', async (change) => {
    const fixture = await setup()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('a'))
      },
      pull(controller) {
        if (change === 'permission') fixture.revoke()
        else fixture.absent()
        controller.close()
      },
    })
    const options: RequestInit & { duplex: 'half' } = { body, duplex: 'half' }
    const response = await fixture.send(fixture.request(undefined, options))
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { reason: 'denied', stored: false } })
    expect(await readdir(fixture.root)).toEqual([])
  })

  it('unblocks a parked body and removes staging before unload completes', async () => {
    const fixture = await setup()
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from('a')) }, cancel })
    const options: RequestInit & { duplex: 'half' } = { body, duplex: 'half' }
    const response = fixture.send(fixture.request(undefined, options))
    await expect.poll(async () => (await readdir(fixture.home)).some(name => name.startsWith('.dsh-upload-'))).toBe(true)
    await fixture.fiber.dispose()
    expect((await response).status).toBe(400)
    expect(cancel).toHaveBeenCalledOnce()
    expect(await readdir(fixture.home)).toEqual(['workspace'])
    expect(await readdir(fixture.root)).toEqual([])
    expect((await fixture.send(fixture.request())).status).toBe(404)
  })
})
