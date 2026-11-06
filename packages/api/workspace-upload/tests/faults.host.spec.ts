/** Disk/descriptor failures preserve publication facts and still settle cleanup. */
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { setup } from './fixture.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return { ...real, open: vi.fn(real.open), rm: vi.fn(real.rm) }
})
const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

function injectFaults(options: { stage?: boolean; directory?: boolean; remove?: boolean; sync?: boolean }) {
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const handle = await real.open(path, flags, mode)
    const directory = typeof flags === 'number' && (flags & constants.O_DIRECTORY) !== 0
    if (directory ? options.directory : options.stage) {
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        await close()
        throw new Error('descriptor close failed')
      })
    }
    if (directory && options.sync) {
      vi.spyOn(handle, 'sync').mockRejectedValue(new Error('directory sync failed'))
    }
    return handle
  })
  if (options.remove) vi.mocked(fs.rm).mockRejectedValue(new Error('temporary directory cleanup failed'))
  return () => {
    vi.mocked(fs.open).mockImplementation(real.open)
    vi.mocked(fs.rm).mockImplementation(real.rm)
    vi.restoreAllMocks()
  }
}

describe.skipIf(process.platform !== 'linux')('Workspace upload filesystem failures', () => {
  it.each([
    { stage: true }, { directory: true }, { remove: true },
    { stage: true, directory: true, remove: true },
  ])('reports a published file when cleanup fails with %j', async (options) => {
    const fixture = await setup()
    const restore = injectFaults(options)
    try {
      const response = await fixture.send(fixture.request())
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ ok: false, error: { reason: 'cleanup', stored: true } })
      expect(await fs.readFile(join(fixture.root, 'file'), 'utf8')).toBe('abc')
    } finally {
      restore()
    }
  })

  it('reports unpublished cleanup failure when overflow precedes cleanup errors', async () => {
    const fixture = await setup()
    const restore = injectFaults({ stage: true, directory: true, remove: true })
    try {
      const response = await fixture.send(fixture.request(undefined, { body: 'abcd' }))
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ ok: false, error: { reason: 'cleanup', stored: false } })
      expect(await fs.readdir(fixture.root)).toEqual([])
    } finally {
      restore()
    }
  })

  it('retains a file published before directory sync fails', async () => {
    const fixture = await setup()
    const restore = injectFaults({ sync: true })
    try {
      const response = await fixture.send(fixture.request())
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ ok: false, error: { reason: 'io', stored: true } })
      expect(await fs.readFile(join(fixture.root, 'file'), 'utf8')).toBe('abc')
    } finally {
      restore()
    }
  })
})
