/** Real filesystem guarantees for exclusive workspace upload publication. */
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { storeWorkspaceUpload, UploadFailure, validateUploadName } from '../src/storage.ts'

const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'workspace-upload-'))
  homes.push(home)
  const root = join(home, 'workspace')
  await mkdir(root)
  return { home, root }
}
async function* chunks(...values: Uint8Array[]) { yield* values }
const signal = () => new AbortController().signal
const admit = () => {}

describe.skipIf(process.platform !== 'linux')('Workspace upload storage', () => {
  it('preserves binary, multichunk, Unicode and empty files with the workspace group', async () => {
    const { home, root } = await fixture()
    const bytes = Buffer.from([0, 255, 1, 0, 8])
    expect(await storeWorkspaceUpload(root, '数据.bin', chunks(bytes.subarray(0, 2), bytes.subarray(2)), 5, signal(), admit))
      .toEqual({ name: '数据.bin', bytes: 5 })
    expect(await readFile(join(root, '数据.bin'))).toEqual(bytes)
    const info = await stat(join(root, '数据.bin'))
    expect(info.mode & 0o777).toBe(0o660)
    expect(info.gid).toBe((await stat(root)).gid)
    expect(await storeWorkspaceUpload(root, 'empty', chunks(), 5, signal(), admit)).toEqual({ name: 'empty', bytes: 0 })
    expect(await readFile(join(root, 'empty'))).toHaveLength(0)
    expect(await readdir(home)).toEqual(['workspace'])
  })

  it.each(['', ' ', '.', '..', '../escape', '/absolute', 'folder/file', 'folder\\file', 'C:escape', 'C:\\escape', 'a\0b', 'a\nb', 'a\u007fb', '界'.repeat(86)])(
    'refuses invalid leaf %j before any file write', async (name) => {
      const { home, root } = await fixture()
      expect(() => { validateUploadName(name) }).toThrow('invalid-name')
      await expect(storeWorkspaceUpload(root, name, chunks(Buffer.from('bad')), 5, signal(), admit))
        .rejects.toMatchObject({ reason: 'invalid-name', stored: false })
      expect(await readdir(root)).toEqual([])
      expect(await readdir(home)).toEqual(['workspace'])
    },
  )

  it('preserves existing files, directories and destination symlinks', async () => {
    const { home, root } = await fixture()
    const target = join(home, 'outside')
    await writeFile(target, 'original')
    await writeFile(join(root, 'existing'), 'original')
    await mkdir(join(root, 'directory'))
    await symlink(target, join(root, 'symlink'))
    for (const name of ['existing', 'directory', 'symlink']) {
      await expect(storeWorkspaceUpload(root, name, chunks(Buffer.from('replace')), 32, signal(), admit))
        .rejects.toMatchObject({ reason: 'exists', stored: false })
    }
    expect(await readFile(join(root, 'existing'), 'utf8')).toBe('original')
    expect(await readFile(target, 'utf8')).toBe('original')
    expect((await readdir(home)).sort()).toEqual(['outside', 'workspace'])
  })

  it('allows only one concurrent publication under the same name', async () => {
    const { root } = await fixture()
    const results = await Promise.allSettled(['first', 'other'].map(value =>
      storeWorkspaceUpload(root, 'same', chunks(Buffer.from(value)), 5, signal(), admit)))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { reason: 'exists', stored: false } })
    expect(['first', 'other']).toContain(await readFile(join(root, 'same'), 'utf8'))
  })

  it('cleans staging after an oversized chunk, cumulative overflow, cancellation and a stream error', async () => {
    const { home, root } = await fixture()
    for (const data of [chunks(Buffer.alloc(4)), chunks(Buffer.alloc(2), Buffer.alloc(2))]) {
      await expect(storeWorkspaceUpload(root, 'large', data, 3, signal(), admit))
        .rejects.toMatchObject({ reason: 'too-large', stored: false })
    }
    const controller = new AbortController()
    async function* cancelled() { yield Buffer.from('a'); controller.abort(); yield Buffer.from('b') }
    await expect(storeWorkspaceUpload(root, 'cancelled', cancelled(), 3, controller.signal, admit))
      .rejects.toMatchObject({ reason: 'cancelled', stored: false })
    await expect(storeWorkspaceUpload(root, 'pre-cancelled', chunks(), 3, controller.signal, admit))
      .rejects.toMatchObject({ reason: 'cancelled', stored: false })
    async function* broken() { yield Buffer.from('a'); throw new Error('stream disconnected') }
    await expect(storeWorkspaceUpload(root, 'broken', broken(), 3, signal(), admit))
      .rejects.toMatchObject({ reason: 'io', stored: false })
    expect(await readdir(root)).toEqual([])
    expect(await readdir(home)).toEqual(['workspace'])
  })

  it('rechecks permission after staging and keeps publication anchored to the opened directory', async () => {
    const { home, root } = await fixture()
    let checked = false
    await expect(storeWorkspaceUpload(root, 'denied', chunks(Buffer.from('a')), 3, signal(), () => {
      checked = true
      throw new UploadFailure('denied')
    })).rejects.toMatchObject({ reason: 'denied', stored: false })
    expect(checked).toBe(true)
    const original = join(home, 'original')
    const outside = join(home, 'outside')
    await mkdir(outside)
    async function* replaced() {
      yield Buffer.from('safe')
      await rename(root, original)
      await symlink(outside, root)
    }
    await storeWorkspaceUpload(root, 'anchored', replaced(), 4, signal(), admit)
    expect(await readFile(join(original, 'anchored'), 'utf8')).toBe('safe')
    expect(await readdir(outside)).toEqual([])
    await expect(storeWorkspaceUpload(root, 'new', chunks(), 4, signal(), admit))
      .rejects.toMatchObject({ reason: 'unavailable', stored: false })
    expect((await readdir(home)).sort()).toEqual(['original', 'outside', 'workspace'])
  })

  it('refuses missing roots and regular files as roots', async () => {
    const { home } = await fixture()
    const file = join(home, 'regular')
    await writeFile(file, 'original')
    for (const root of [join(home, 'absent'), file]) {
      await expect(storeWorkspaceUpload(root, 'new', chunks(), 3, signal(), admit))
        .rejects.toMatchObject({ reason: 'unavailable', stored: false })
    }
    expect(await readFile(file, 'utf8')).toBe('original')
  })
})
