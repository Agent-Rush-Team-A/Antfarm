/** Workspace text reads use the real helper and controlled filesystem replacements. */
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { createHelperHarness } from './fixtures/helper.ts'
import { targetSchema, textStreamIdSchema } from '../src/schemas.ts'

const nextSchema = z.object({ done: z.boolean(), value: z.string() }).strict()

async function setup() {
  const test = await createHelperHarness()
  onTestFinished(() => test.close())
  await fs.mkdir(`${test.root}/sub`)
  const outside = await fs.mkdtemp('/tmp/dsh-workspace-text-outside-')
  onTestFinished(() => fs.rm(outside, { recursive: true, force: true }))
  await fs.writeFile(`${test.root}/sub/file`, 'inside fixture')
  await fs.writeFile(`${outside}/file`, 'outside fixture')
  const target = await test.client.request('fs.resolve', { path: 'sub/file' }, targetSchema)
  const swap = async () => {
    await fs.rename(`${test.root}/sub`, `${test.root}/original-sub`)
    await fs.symlink(outside, `${test.root}/sub`)
  }
  return { ...test, target, outside, swap }
}

async function read(test: Awaited<ReturnType<typeof setup>>, method: 'fs.readText' | 'fs.stream') {
  if (method === 'fs.readText') return test.client.request(method, { target: test.target, workspaceOnly: true }, z.string())
  const id = await test.client.request(method, { target: test.target, workspaceOnly: true }, textStreamIdSchema)
  let text = ''
  while (true) {
    const next = await test.client.request('fs.next', { id }, nextSchema)
    text += next.value
    if (next.done) return text
  }
}

describe.skipIf(process.platform !== 'linux')('Workspace text containment', () => {
  it.each(['fs.readText', 'fs.stream'] as const)('rejects a directory replaced after resolve through %s', async (method) => {
    const test = await setup()
    await test.swap()
    await expect(read(test, method)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it.each(['fs.readText', 'fs.stream'] as const)('reads the pinned directory when it is replaced after acquisition through %s', async (method) => {
    const test = await setup()
    const open = fs.open.bind(fs)
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (String(args[0]).endsWith('/sub')) await test.swap()
      return handle
    })
    onTestFinished(() =>{  spy.mockRestore() })
    expect(await read(test, method)).toBe('inside fixture')
  })

  it.each(['fs.readText', 'fs.stream'] as const)('reads the pinned file when its original path is replaced through %s', async (method) => {
    const test = await setup()
    const spy = vi.spyOn(SandboxedFileSystem.prototype, 'streamText')
    spy.mockImplementationOnce(async function (this: SandboxedFileSystem, target, signal) {
      expect(String(target.targetKey)).toMatch(/^\/proc\/self\/fd\/\d+$/)
      await fs.rename(`${test.root}/sub/file`, `${test.root}/sub/original-file`)
      await fs.symlink(`${test.outside}/file`, `${test.root}/sub/file`)
      spy.mockRestore()
      return this.streamText(target, signal)
    })
    onTestFinished(() =>{  spy.mockRestore() })
    expect(await read(test, method)).toBe('inside fixture')
  })

  it.each(['outside', 'sibling', 'traversal', 'final-link', 'root-link'] as const)('rejects %s paths at the actual read entry', async (kind) => {
    const test = await setup()
    let target = test.target
    if (kind === 'outside') target = { ...target, targetKey: `${test.outside}/file` }
    if (kind === 'sibling') target = { ...target, targetKey: `${test.root}-other/file` }
    if (kind === 'traversal') target = { ...target, targetKey: `${test.root}/sub/../sub/file` }
    if (kind === 'final-link') {
      await fs.unlink(`${test.root}/sub/file`)
      await fs.symlink(`${test.outside}/file`, `${test.root}/sub/file`)
    }
    if (kind === 'root-link') {
      const moved = `${test.root}-original`
      await fs.rename(test.root, moved)
      onTestFinished(() => fs.rm(moved, { recursive: true, force: true }))
      await fs.symlink(test.outside, test.root)
    }
    await expect(test.client.request('fs.readText', { target, workspaceOnly: true }, z.string()))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it.each(['missing', 'directory', 'fifo'] as const)('reports %s without blocking or treating it as text', async (kind) => {
    const test = await setup()
    await fs.unlink(`${test.root}/sub/file`)
    if (kind === 'directory') await fs.mkdir(`${test.root}/sub/file`)
    if (kind === 'fifo') await promisify(execFile)('mkfifo', [`${test.root}/sub/file`], { timeout: 2000 })
    await expect(read(test, 'fs.readText')).rejects.toMatchObject({
      code: kind === 'missing' ? 'FS_NOT_FOUND' : 'FS_NOT_REGULAR_FILE',
    })
  })

  it.each([Buffer.from([0, 97]), Buffer.from([0xff, 0xfe])])('retains binary and invalid UTF-8 rejection for %j', async (content) => {
    const test = await setup()
    await fs.writeFile(`${test.root}/sub/file`, content)
    await expect(read(test, 'fs.stream')).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('streams UTF-8 beyond the whole-file frame budget and retains the bounded read rejection', async () => {
    const test = await setup()
    const content = '😀中文\n'.repeat(800000)
    expect(Buffer.byteLength(content)).toBeGreaterThan(8 * 1024 * 1024)
    await fs.writeFile(`${test.root}/sub/file`, content)
    expect(await read(test, 'fs.stream')).toBe(content)
    await expect(read(test, 'fs.readText')).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
  })

  it.each(['completion', 'early-close', 'helper-close', 'unstarted-close'] as const)('releases acquired handles after %s', async (ending) => {
    const test = await setup()
    const opened: Awaited<ReturnType<typeof fs.open>>[] = []
    const open = fs.open.bind(fs)
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      opened.push(handle)
      return handle
    })
    onTestFinished(() =>{  spy.mockRestore() })
    const id = await test.client.request('fs.stream', { target: test.target, workspaceOnly: true }, textStreamIdSchema)
    expect(opened).toHaveLength(0)
    if (ending !== 'unstarted-close') {
      expect(await test.client.request('fs.next', { id }, nextSchema)).toEqual({ done: false, value: 'inside fixture' })
      expect(opened.length).toBeGreaterThan(0)
    }
    if (ending === 'helper-close') await test.client.request('close', {}, z.null())
    else if (ending === 'completion') {
      while (!(await test.client.request('fs.next', { id }, nextSchema)).done) { /* Drain decoding completion. */ }
    } else await test.client.request('fs.streamClose', { id }, z.null())
    for (const handle of opened) await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' })
  })

  it('closes pinned handles when cancellation interrupts acquisition before streaming', async () => {
    const test = await setup()
    const acquired = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const opened: Awaited<ReturnType<typeof fs.open>>[] = []
    const open = fs.open.bind(fs)
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      opened.push(handle)
      if (typeof args[1] === 'number' && (args[1] & constants.O_DIRECTORY) === 0) {
        acquired.resolve(undefined)
        await release.promise
      }
      return handle
    })
    const controller = new AbortController()
    try {
      const id = await test.client.request('fs.stream', { target: test.target, workspaceOnly: true }, textStreamIdSchema)
      const result = test.client.request('fs.next', { id }, nextSchema, controller.signal)
        .then(value => ({ value }), (error: unknown) => ({ error }))
      await acquired.promise
      controller.abort(new Error('cancel read'))
      release.resolve(undefined)
      expect(await result).toHaveProperty('error')
      await vi.waitFor(async () => {
        for (const handle of opened) await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' })
      })
      await expect(test.client.request('fs.next', { id }, nextSchema)).rejects.toThrow('Unknown SSH text stream')
    } finally { release.resolve(undefined); spy.mockRestore() }
  })
})
