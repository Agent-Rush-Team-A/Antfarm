/** Real Connection route authorization, bounded binary results and provider teardown. */
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { setup, id } from './fixture.ts'

describe.skipIf(process.platform !== 'linux')('workspace artifact Host operations', () => {
  it('lists registered workspace files and downloads exact binary bytes', async () => {
    const fixture = await setup()
    const bytes = Buffer.from([0, 255, 128])
    await writeFile(join(fixture.root, '结果.bin'), bytes)
    const listing = await fixture.service.list({ workspaceId: id }, '', new AbortController().signal)
    expect(listing.entries).toContainEqual({ name: '结果.bin', kind: 'file', bytes: 3 })
    expect(listing).toMatchObject({ path: '', truncated: false, maxDownloadBytes: 3 })
    const response = await fixture.send(fixture.request('workspaceId=workspace-id&path=' + encodeURIComponent('结果.bin')))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''" + encodeURIComponent('结果.bin'))
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
  })

  it('downloads an empty file without changing any workspace data', async () => {
    const fixture = await setup()
    await writeFile(join(fixture.root, 'empty'), '')
    const response = await fixture.send(fixture.request('workspaceId=workspace-id&path=empty'))
    expect(response.headers.get('content-length')).toBe('0')
    expect((await response.arrayBuffer()).byteLength).toBe(0)
  })

  it('refuses metadata-only authorization before reading file content', async () => {
    const fixture = await setup()
    fixture.revoke()
    const response = await fixture.send(fixture.request())
    expect(response.status).toBe(403)
    await response.arrayBuffer()
    expect(fixture.decide).toHaveBeenCalledWith(expect.objectContaining({
      action: 'workspaceArtifacts/download', resources: [{ kind: 'workspace', id }],
    }))
  })

  it.each(['path=../outside', 'path=/etc/passwd', 'path=a%5Cb', 'path=file&path=file', ''])('refuses malformed file selector %s', async (selector) => {
    const fixture = await setup()
    const response = await fixture.send(fixture.request('workspaceId=workspace-id&' + selector))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { reason: 'invalid-path' } })
  })

  it('refuses oversized, missing, directory and symbolic-link downloads', async () => {
    const fixture = await setup()
    await writeFile(join(fixture.root, 'large'), 'abcd')
    await mkdir(join(fixture.root, 'directory'))
    await writeFile(join(fixture.home, 'secret'), 'SECRET')
    await symlink(join(fixture.home, 'secret'), join(fixture.root, 'escape'))
    for (const [path, status, reason] of [['large', 413, 'too-large'], ['missing', 404, 'not-found'],
      ['directory', 400, 'not-regular'], ['escape', 404, 'not-found']] as const) {
      const response = await fixture.send(fixture.request('workspaceId=workspace-id&path=' + path))
      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject({ error: { reason } })
    }
  })

  it('checks workspace existence for listing and downloading', async () => {
    const fixture = await setup()
    fixture.absent()
    await expect(fixture.service.list({ workspaceId: id }, '', new AbortController().signal))
      .rejects.toMatchObject({ code: 'workspace-artifact/failed', details: { reason: 'not-found' } })
    const response = await fixture.send(fixture.request())
    expect(response.status).toBe(404)
    await response.arrayBuffer()
  })

  it('rechecks access before consuming an opened download', async () => {
    const fixture = await setup()
    const response = await fixture.send(fixture.request())
    fixture.revoke()
    await expect(response.text()).rejects.toMatchObject({ reason: 'denied' })
  })

  it('cancels an unread body and withdraws its route before teardown completes', async () => {
    const fixture = await setup()
    const response = await fixture.send(fixture.request())
    await fixture.fiber.dispose()
    await expect(response.text()).rejects.toMatchObject({ reason: 'cancelled' })
    expect((await fixture.send(fixture.request())).status).toBe(404)
  })
})
