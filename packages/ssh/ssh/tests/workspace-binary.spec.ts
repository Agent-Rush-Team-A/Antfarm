import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, symlink, rename, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, test } from 'vitest'
import { WorkspaceBinaryHandles } from '../src/helper-workspace-files.ts'

const owners: { root: string; handles: WorkspaceBinaryHandles; lifetime: AbortController }[] = []
afterEach(async () => {
  for (const owner of owners.splice(0)) {
    owner.lifetime.abort()
    await owner.handles.close()
    await rm(owner.root, { recursive: true, force: true })
  }
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'antfarm-binary-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const lifetime = new AbortController()
  const handles = new WorkspaceBinaryHandles(workspace, lifetime.signal)
  owners.push({ root, handles, lifetime })
  const call = (method: string, fields: object) => handles.dispatch('workspace.' + method, fields, lifetime.signal)
  return { root, workspace, lifetime, handles, call }
}

test.runIf(process.platform === 'linux')('binary download remains pinned after a symlink replacement and rejects traversal and symlink parents', async () => {
  const f = await setup()
  await writeFile(join(f.workspace, 'output.bin'), 'original')
  await writeFile(join(f.root, 'secret'), 'outside')
  const opened = await f.call('open', { path: 'output.bin', maxBytes: 100 }) as { id: string; bytes: number }
  await rename(join(f.workspace, 'output.bin'), join(f.workspace, 'saved'))
  await symlink(join(f.root, 'secret'), join(f.workspace, 'output.bin'))
  const result = await f.call('read', { id: opened.id, limit: 64 }) as { data: string; done: boolean }
  expect(Buffer.from(result.data, 'base64').toString()).toBe('original')
  expect(result.done).toBe(true)
  await f.call('readClose', { id: opened.id })
  await expect(f.call('open', { path: 'output.bin', maxBytes: 100 })).rejects.toMatchObject({ code: 'artifact:not-found' })
  await expect(f.call('open', { path: '../secret', maxBytes: 100 })).rejects.toMatchObject({ code: 'artifact:invalid-path' })
  await symlink(f.root, join(f.workspace, 'linked'))
  await expect(f.call('open', { path: 'linked/secret', maxBytes: 100 })).rejects.toMatchObject({ code: 'artifact:not-found' })
})

test.runIf(process.platform === 'linux')('streamed binary upload preserves all bytes, refuses overwrite, and lists the committed file', async () => {
  const f = await setup()
  const bytes = randomBytes(150_000)
  const id = await f.call('uploadOpen', { name: 'result.bin', maxBytes: bytes.length }) as string
  for (let offset = 0; offset < bytes.length; offset += 64 * 1024) await f.call('uploadChunk', { id, data: bytes.subarray(offset, offset + 64 * 1024).toString('base64') })
  expect(await f.call('uploadCommit', { id })).toEqual({ ok: true, value: { name: 'result.bin', bytes: bytes.length } })
  const opened = await f.call('open', { path: 'result.bin', maxBytes: bytes.length }) as { id: string }
  const parts: Buffer[] = []
  while (true) {
    const part = await f.call('read', { id: opened.id, limit: 64 * 1024 }) as { data: string; done: boolean }
    parts.push(Buffer.from(part.data, 'base64'))
    if (part.done) break
  }
  expect(Buffer.concat(parts)).toEqual(bytes)
  await f.call('readClose', { id: opened.id })
  const duplicate = await f.call('uploadOpen', { name: 'result.bin', maxBytes: 10 }) as string
  await f.call('uploadChunk', { id: duplicate, data: Buffer.from('replace').toString('base64') })
  expect(await f.call('uploadCommit', { id: duplicate })).toMatchObject({ ok: false, error: { reason: 'exists', stored: false } })
  expect(await f.call('list', { path: '', maxEntries: 100 })).toEqual({ entries: [{ name: 'result.bin', kind: 'file', bytes: bytes.length }], truncated: false })
})

test.runIf(process.platform === 'linux')('aborted and oversized uploads leave no published file or staging directory; helper cleanup settles idle uploads', async () => {
  const f = await setup()
  const id = await f.call('uploadOpen', { name: 'cancelled', maxBytes: 100 }) as string
  await f.call('uploadChunk', { id, data: Buffer.from('partial').toString('base64') })
  expect(await f.call('uploadAbort', { id })).toMatchObject({ ok: false, error: { stored: false } })
  const oversized = await f.call('uploadOpen', { name: 'too-large', maxBytes: 2 }) as string
  await f.call('uploadChunk', { id: oversized, data: Buffer.from('large').toString('base64') }).catch(() => {})
  expect(await f.call('uploadCommit', { id: oversized })).toMatchObject({ ok: false, error: { reason: 'too-large', stored: false } })
  await f.call('uploadOpen', { name: 'pending', maxBytes: 100 })
  f.lifetime.abort()
  await f.handles.close()
  expect(await readdir(f.workspace)).toEqual([])
  expect((await readdir(f.root)).filter(name => name.startsWith('.dsh-upload-'))).toEqual([])
})

test.runIf(process.platform === 'linux')('quiescence rejects unfinished upload publication while keeping pinned reads available', async () => {
  const f = await setup()
  await writeFile(join(f.workspace, 'saved'), 'preserved')
  const read = await f.call('open', { path: 'saved', maxBytes: 100 }) as { id: string }
  const upload = await f.call('uploadOpen', { name: 'unfinished', maxBytes: 100 }) as string
  await f.call('uploadChunk', { id: upload, data: Buffer.from('pending').toString('base64') })
  await f.handles.quiesce()
  expect(await f.call('uploadCommit', { id: upload })).toMatchObject({ ok: false, error: { stored: false } })
  const result = await f.call('read', { id: read.id, limit: 64 }) as { data: string }
  expect(Buffer.from(result.data, 'base64').toString()).toBe('preserved')
  await f.call('readClose', { id: read.id })
  expect(await readdir(f.workspace)).toEqual(['saved'])
})
