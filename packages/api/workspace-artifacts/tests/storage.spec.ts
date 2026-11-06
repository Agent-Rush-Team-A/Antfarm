/** Descriptor containment and cancellation under deterministic filesystem replacement. */
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { artifactComponents, listArtifacts, openArtifact, streamArtifact } from '../src/storage.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, open: vi.fn(original.open) }
})
const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
afterEach(() => { vi.restoreAllMocks(); vi.mocked(fs.open).mockImplementation(real.open) })

async function fixture() {
  const home = await fs.mkdtemp(join(tmpdir(), 'workspace-artifacts-'))
  onTestFinished(() => fs.rm(home, { recursive: true, force: true }))
  const root = join(home, 'workspace')
  await fs.mkdir(root)
  return { home, root, signal: new AbortController().signal }
}

describe.skipIf(process.platform !== 'linux')('workspace artifact containment', () => {
  it.each(['/etc/passwd', '../secret', 'folder/../secret', 'folder//file', './file', 'file/', 'C:/secret', 'C:secret', 'folder\\file', 'a\0b', 'a\nb', 'x'.repeat(256), 'a/'.repeat(2100)])('refuses untrusted path %j', (path) => {
    expect(() => artifactComponents(path)).toThrow(expect.objectContaining({ reason: 'invalid-path' }))
  })

  it('preserves Unicode and literal percent characters without decoding', () => {
    expect(artifactComponents('目录/结果%2F.bin')).toEqual(['目录', '结果%2F.bin'])
    expect(artifactComponents('')).toEqual([])
  })

  it('lists nested ordinary files, omits symlinks, and returns no Host path', async () => {
    const { home, root, signal } = await fixture()
    await fs.mkdir(join(root, 'nested'))
    await fs.writeFile(join(root, 'result.bin'), Buffer.from([0, 255, 1]))
    await fs.writeFile(join(home, 'secret'), 'outside')
    await fs.symlink(join(home, 'secret'), join(root, 'escape'))
    await fs.symlink(join(root, 'result.bin'), join(root, 'inside-link'))
    expect(await listArtifacts(root, '', 10, signal)).toEqual({
      entries: [{ name: 'nested', kind: 'directory' }, { name: 'result.bin', kind: 'file', bytes: 3 }], truncated: false,
    })
    expect(await listArtifacts(root, 'nested', 10, signal)).toEqual({ entries: [], truncated: false })
  })

  it('bounds inspected directory entries and reports truncation', async () => {
    const { root, signal } = await fixture()
    for (const name of ['a', 'b', 'c']) await fs.writeFile(join(root, name), name)
    const listing = await listArtifacts(root, '', 2, signal)
    expect(listing.entries).toHaveLength(2)
    expect(listing.truncated).toBe(true)
  })

  it.each(['leaf', 'directory', 'root'])('refuses a symlink at the $0 position', async (position) => {
    const { home, root, signal } = await fixture()
    const outside = join(home, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(join(outside, 'secret'), 'outside')
    if (position === 'leaf') await fs.symlink(join(outside, 'secret'), join(root, 'file'))
    else if (position === 'directory') await fs.symlink(outside, join(root, 'nested'))
    else { await fs.rename(root, join(home, 'old-root')); await fs.symlink(outside, root) }
    await expect(openArtifact(root, position === 'directory' ? 'nested/secret' : position === 'root' ? 'secret' : 'file', false, signal))
      .rejects.toMatchObject({ reason: 'not-found' })
  })

  it('pins a directory before it is replaced with an outside symlink', async () => {
    const { home, root, signal } = await fixture()
    await fs.mkdir(join(root, 'nested'))
    await fs.writeFile(join(root, 'nested', 'file'), 'inside')
    await fs.mkdir(join(home, 'outside'))
    await fs.writeFile(join(home, 'outside', 'file'), 'SECRET')
    let replaced = false
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      const file = await real.open(path, flags, mode)
      if (!replaced && String(path).endsWith('/nested') && typeof flags === 'number' && (flags & constants.O_DIRECTORY) !== 0) {
        replaced = true
        await fs.rename(join(root, 'nested'), join(root, 'original'))
        await fs.symlink(join(home, 'outside'), join(root, 'nested'))
      }
      return file
    })
    const file = await openArtifact(root, 'nested/file', false, signal)
    try { expect(await file.readFile('utf8')).toBe('inside') } finally { await file.close() }
    expect(replaced).toBe(true)
  })

  it('rejects a leaf swapped to a symlink at the actual open', async () => {
    const { home, root, signal } = await fixture()
    await fs.writeFile(join(root, 'file'), 'inside')
    await fs.writeFile(join(home, 'secret'), 'SECRET')
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      if (String(path).startsWith('/proc/self/fd/') && String(path).endsWith('/file')) {
        await fs.rm(join(root, 'file'))
        await fs.symlink(join(home, 'secret'), join(root, 'file'))
      }
      return real.open(path, flags, mode)
    })
    await expect(openArtifact(root, 'file', false, signal)).rejects.toMatchObject({ reason: 'not-found' })
  })

  it('retains the opened file after its pathname is replaced', async () => {
    const { home, root, signal } = await fixture()
    await fs.writeFile(join(root, 'file'), 'inside')
    await fs.writeFile(join(home, 'secret'), 'SECRET')
    const file = await openArtifact(root, 'file', false, signal)
    await fs.rename(join(root, 'file'), join(root, 'old'))
    await fs.symlink(join(home, 'secret'), join(root, 'file'))
    const stream = streamArtifact(file, 6, signal, () => {})
    expect(await new Response(stream.body).text()).toBe('inside')
    await stream.settled
    expect(file.fd).toBe(-1)
  })

  it('closes an unconsumed body when the provider cancels', async () => {
    const { root, signal } = await fixture()
    await fs.writeFile(join(root, 'file'), 'inside')
    const file = await openArtifact(root, 'file', false, signal)
    const controller = new AbortController()
    const stream = streamArtifact(file, 6, controller.signal, () => {})
    controller.abort()
    await stream.settled
    expect(file.fd).toBe(-1)
    await expect(new Response(stream.body).text()).rejects.toMatchObject({ reason: 'cancelled' })
  })

  it('closes a consumer-cancelled body and refuses non-regular targets', async () => {
    const { root, signal } = await fixture()
    await fs.writeFile(join(root, 'file'), 'inside')
    const file = await openArtifact(root, 'file', false, signal)
    const stream = streamArtifact(file, 6, signal, () => {})
    await stream.body.cancel()
    await stream.settled
    expect(file.fd).toBe(-1)
    await expect(openArtifact(root, '', false, signal)).rejects.toMatchObject({ reason: 'not-regular' })
    await expect(openArtifact(root, '.', false, signal)).rejects.toMatchObject({ reason: 'invalid-path' })
  })
})
