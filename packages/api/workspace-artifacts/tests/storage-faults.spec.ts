/** Filesystem failures, concurrent changes and cancellation close every acquired descriptor. */
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { artifactFailure, ArtifactFailure, listArtifacts, openArtifact, streamArtifact } from '../src/storage.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, open: vi.fn(original.open), opendir: vi.fn(original.opendir) }
})
const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(fs.open).mockImplementation(real.open)
  vi.mocked(fs.opendir).mockImplementation(real.opendir)
})
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'artifact-fault-'))
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }))
  await fs.writeFile(join(root, 'file'), 'abc')
  return { root, signal: new AbortController().signal }
}

describe.skipIf(process.platform !== 'linux')('artifact descriptor failures', () => {
  it('classifies cancellation, filesystem refusals and opaque I/O without losing causes', () => {
    const controller = new AbortController()
    controller.abort()
    expect(artifactFailure(new Error('aborted'), controller.signal).reason).toBe('cancelled')
    const signal = new AbortController().signal
    for (const cause of [null, 'failure', { code: 'EACCES' }, new Error('failed')]) {
      expect(artifactFailure(cause, signal)).toMatchObject({ reason: 'io', cause })
    }
    const expected = new ArtifactFailure('denied')
    expect(artifactFailure(expected, signal)).toBe(expected)
  })

  it('closes a directory acquired concurrently with cancellation', async () => {
    const { root } = await fixture()
    const controller = new AbortController()
    const handles: fs.FileHandle[] = []
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await real.open(...args)
      handles.push(handle)
      controller.abort()
      return handle
    })
    await expect(openArtifact(root, 'file', false, controller.signal)).rejects.toMatchObject({ reason: 'cancelled' })
    expect(handles.every(handle => handle.fd === -1)).toBe(true)
  })

  it.each(['parent', 'acquisition'])('retains cleanup failure during %s failure and closes other handles', async (phase) => {
    const { root, signal } = await fixture()
    const handles: fs.FileHandle[] = []
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      if (handles.length === 1 && phase === 'acquisition') throw new Error('acquisition failure')
      const handle = await real.open(...args)
      handles.push(handle)
      if (handles.length === 1) {
        const close = handle.close.bind(handle)
        vi.spyOn(handle, 'close').mockImplementationOnce(async () => { await close(); throw new Error('close failure') })
      }
      return handle
    })
    const aggregate: unknown = expect.any(AggregateError)
    await expect(openArtifact(root, 'file', false, signal)).rejects.toMatchObject({ reason: 'io', cause: aggregate })
    expect(handles.every(handle => handle.fd === -1)).toBe(true)
  })

  it('omits unsupported names and sorts multiple ordinary directories before files', async () => {
    const { root, signal } = await fixture()
    await fs.writeFile(join(root, 'bad\nname'), 'bad')
    await fs.mkdir(join(root, 'z'))
    await fs.mkdir(join(root, 'a'))
    expect((await listArtifacts(root, '', 10, signal)).entries.map(entry => entry.name)).toEqual(['a', 'z', 'file'])
  })

  it.each(['symlink', 'directory', 'io'])('handles a listed file replaced at reopening: %s', async (replacement) => {
    const { root, signal } = await fixture()
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('/file')) {
        if (replacement === 'io') throw Object.assign(new Error('read denied'), { code: 'EACCES' })
        await fs.rm(join(root, 'file'))
        if (replacement === 'directory') await fs.mkdir(join(root, 'file'))
        else await fs.symlink('/outside', join(root, 'file'))
      }
      return real.open(...args)
    })
    if (replacement === 'io') await expect(listArtifacts(root, '', 10, signal)).rejects.toMatchObject({ reason: 'io' })
    else expect((await listArtifacts(root, '', 10, signal)).entries).toEqual([])
  })

  it('closes the pinned directory when enumeration cannot start', async () => {
    const { root, signal } = await fixture()
    let directory!: fs.FileHandle
    vi.mocked(fs.open).mockImplementation(async (...args) => { directory = await real.open(...args); return directory })
    vi.mocked(fs.opendir).mockRejectedValueOnce(new Error('enumeration failed'))
    await expect(listArtifacts(root, '', 10, signal)).rejects.toMatchObject({ reason: 'io' })
    expect(directory.fd).toBe(-1)
  })

  it('fails a truncated inode instead of completing a partial stream', async () => {
    const { root, signal } = await fixture()
    const file = await openArtifact(root, 'file', false, signal)
    await fs.truncate(join(root, 'file'), 0)
    const stream = streamArtifact(file, 3, signal, () => {})
    await expect(new Response(stream.body).text()).rejects.toMatchObject({ reason: 'io' })
    await stream.settled
    expect(file.fd).toBe(-1)
  })

  it.each([false, true])('settles a failed descriptor close for an already cancelled stream: %s', async (failed) => {
    const { root, signal } = await fixture()
    const file = await openArtifact(root, 'file', false, signal)
    if (failed) {
      const close = file.close.bind(file)
      vi.spyOn(file, 'close').mockImplementationOnce(async () => { await close(); throw new Error('close failure') })
    }
    const controller = new AbortController()
    controller.abort()
    const stream = streamArtifact(file, 3, controller.signal, () => {})
    if (failed) await expect(stream.settled).rejects.toThrow('close failure')
    else await stream.settled
    await expect(new Response(stream.body).text()).rejects.toMatchObject({ reason: 'cancelled' })
    expect(file.fd).toBe(-1)
  })
})
