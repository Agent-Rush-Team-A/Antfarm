/** Persistent files are independent of execution lifetimes and never cross workspace directories. */
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test, vi, type TestContext } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { WorkspaceFileScope } from '@deepseek-ai/dsh-fs/workspace-access'
import { WorkspaceModeDirectoryFiles } from '../src/mode-directory-files.ts'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'workspace-mode-files-'))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const a = join(root, 'a')
  const b = join(root, 'b')
  await Promise.all([mkdir(a), mkdir(b)])
  const workspaceId = brandString<WorkspaceId>('workspace-a')
  const controller = new AbortController()
  const scope: WorkspaceFileScope = { workspaceId, project: '/project/identity', signal: controller.signal, admit: vi.fn() }
  const assertCurrent = vi.fn()
  const resolve = vi.fn(async (value: WorkspaceFileScope) => {
    if (value.workspaceId !== workspaceId) throw new Error('unregistered workspace')
    return { root: a, assertCurrent }
  })
  return { files: new WorkspaceModeDirectoryFiles(resolve), resolve, root, a, b, scope, controller, assertCurrent }
}

async function* content(value: string) { yield new TextEncoder().encode(value) }

test.skipIf(process.platform !== 'linux')('uploads remain available through a new file-provider instance', async (t) => {
  const f = await fixture(t)
  const csv = 'product,total\na,42\n'
  await expect(f.files.upload(f.scope, 'result.csv', content(csv), 100)).resolves.toEqual({ name: 'result.csv', bytes: 19 })
  const replacement = new WorkspaceModeDirectoryFiles(f.resolve)
  const download = await replacement.download(f.scope, 'result.csv', 100)
  expect(await new Response(download.body).text()).toBe(csv)
  await download.settled
  expect(await readFile(join(f.a, 'result.csv'), 'utf8')).toBe(csv)
})

test.skipIf(process.platform !== 'linux')('lists only the admitted directory and refuses sibling traversal and symlinks', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.a, 'visible.csv'), 'visible')
  await writeFile(join(f.b, 'private.csv'), 'private')
  await symlink(f.b, join(f.a, 'sibling'))
  await expect(f.files.list(f.scope, '', 10)).resolves.toMatchObject({ entries: [{ name: 'visible.csv' }] })
  await expect(f.files.download(f.scope, '../b/private.csv', 100)).rejects.toMatchObject({ reason: 'invalid-path' })
  await expect(f.files.download(f.scope, 'sibling/private.csv', 100)).rejects.toMatchObject({ reason: 'not-found' })
  expect(await readFile(join(f.b, 'private.csv'), 'utf8')).toBe('private')
})

test.skipIf(process.platform !== 'linux')('failed mount verification never reads or writes the same local path', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.a, 'local.csv'), 'must not be returned')
  const failure = new Error('shared mount unavailable')
  f.assertCurrent.mockImplementation(() => { throw failure })
  await expect(f.files.list(f.scope, '', 10)).rejects.toBe(failure)
  await expect(f.files.download(f.scope, 'local.csv', 100)).rejects.toBe(failure)
  await expect(f.files.upload(f.scope, 'new.csv', content('new'), 100)).rejects.toBe(failure)
  await expect(readFile(join(f.a, 'new.csv'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test.skipIf(process.platform !== 'linux')('withdrawn mount authority before publication preserves existing files', async (t) => {
  const f = await fixture(t)
  async function* chunks() {
    yield new Uint8Array([42])
    f.assertCurrent.mockImplementation(() => { throw new Error('mount revoked') })
  }
  await expect(f.files.upload(f.scope, 'new.csv', chunks(), 100)).rejects.toMatchObject({ stored: false })
  await expect(readFile(join(f.a, 'new.csv'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test.skipIf(process.platform !== 'linux')('exclusive upload cannot overwrite a file and oversized downloads are refused', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.a, 'existing.csv'), 'original')
  await expect(f.files.upload(f.scope, 'existing.csv', content('replacement'), 100)).rejects.toMatchObject({ reason: 'exists', stored: false })
  await expect(f.files.download(f.scope, 'existing.csv', 2)).rejects.toMatchObject({ reason: 'too-large' })
  expect(await readFile(join(f.a, 'existing.csv'), 'utf8')).toBe('original')
})

test.skipIf(process.platform !== 'linux')('a download rechecks authority while consuming its retained descriptor', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.a, 'result.csv'), 'result')
  const stream = await f.files.download(f.scope, 'result.csv', 100)
  f.assertCurrent.mockImplementation(() => { throw new Error('mount revoked') })
  await expect(new Response(stream.body).text()).rejects.toThrow()
  await stream.settled
})
