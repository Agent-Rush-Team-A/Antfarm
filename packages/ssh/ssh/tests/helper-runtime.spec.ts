/** Real helper dispatch over private in-memory transport, without changing the Harness process cwd. */
import { chmod, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { FsError } from '@deepseek-ai/dsh-fs'
import { z } from 'zod'
import { createHelperHarness as helper } from './fixtures/helper.ts'
import { RemoteProcesses } from '../src/helper-processes.ts'
import { hunkSchema, moveOptionsSchema, moveResultSchema, deleteResultSchema, targetSchema, writeResultSchema, editResultSchema, infoSchema, entriesSchema } from '../src/schemas.ts'


const policy = (workspaceRoot: string) => ({ mode: 'workspace-write', workspaceRoot })

describe.skipIf(process.platform === 'win32')('SSH helper runtime', () => {
  it.each(['success', 'failure'] as const)('waits for an accepted file write to settle with %s before acknowledging close', async (outcome) => {
    const test = await helper()
    const accepted = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const write = vi.spyOn(SandboxedFileSystem.prototype, 'writeText').mockImplementationOnce(async () => {
      accepted.resolve(undefined)
      // The provider deliberately ignores cancellation during its commit, as a real filesystem may do.
      await release.promise
      if (outcome === 'failure') throw new FsError('File commit failed', 'FS_IO_ERROR')
      await writeFile(`${test.root}/committed`, 'committed')
      return { operation: 'create', before: null, after: 'committed', version: 'committed' as import('@deepseek-ai/dsh-fs').FsVersion }
    })
    const terminate = vi.spyOn(RemoteProcesses.prototype, 'close')
    try {
      const target = await test.client.request('fs.resolve', { path: 'committed' }, targetSchema)
      const result = test.client.request('fs.write', { target, content: 'committed', policy: policy(test.root) }, writeResultSchema)
        .then(value => ({ value }), (error: unknown) => ({ error }))
      await accepted.promise
      let acknowledged = false
      const close = test.client.request('close', {}, z.null()).then(() => { acknowledged = true })
      await vi.waitFor(() => { expect(terminate).toHaveBeenCalled() })
      await new Promise(resolve => setImmediate(resolve))
      expect(acknowledged).toBe(false)
      await expect(test.client.request('fs.resolve', { path: '.' }, targetSchema)).rejects.toThrow('not accepting')
      release.resolve(undefined)
      await close
      if (outcome === 'success') {
        expect(await result).toMatchObject({ value: { after: 'committed' } })
        expect(await readFile(`${test.root}/committed`, 'utf8')).toBe('committed')
      } else expect(await result).toMatchObject({ error: { code: 'FS_IO_ERROR' } })
    } finally {
      release.resolve(undefined)
      write.mockRestore()
      terminate.mockRestore()
      await test.close()
    }
  })

  it('binds relative filesystem operations to the negotiated workspace without chdir', async () => {
    const before = process.cwd()
    const test = await helper(false)
    try {
      await expect(test.client.request('heartbeat', {}, z.null())).rejects.toThrow('not accepting')
      const facts = await test.hello()
      expect(facts.workspace).toBe(test.root)
      expect(process.cwd()).toBe(before)
      await expect(test.hello()).rejects.toThrow('already completed')
      await expect(test.client.request('unrecognized', {}, z.unknown())).rejects.toThrow('Unknown SSH helper operation')
      await test.client.request('heartbeat', {}, z.null())
      expect(await test.client.request('fs.resolve', { path: '.' }, targetSchema)).toMatchObject({ targetKey: test.root })
      await test.client.request('close', {}, z.null())
      await expect(test.client.request('fs.stat', {}, z.unknown())).rejects.toThrow('not accepting')
    } finally { await test.close() }
  })

  it('preserves guarded write/edit outcomes and filesystem error codes across RPC', async () => {
    const test = await helper()
    try {
      const target = await test.client.request('fs.resolve', { path: 'file.txt' }, targetSchema)
      const created = await test.client.request('fs.write', { target, content: 'first text', policy: policy(test.root), expected: { kind: 'createIfAbsent' } }, writeResultSchema)
      expect(created).toMatchObject({ operation: 'create', before: null, after: 'first text' })
      expect((await stat(target.targetKey)).mode & 0o777).toBe(0o600)
      await expect(test.client.request('fs.write', { target, content: 'stale', policy: policy(test.root), expected: { kind: 'replaceIfVersion', version: 'stale' } }, writeResultSchema)).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
      const updated = await test.client.request('fs.write', { target, content: 'second text', policy: policy(test.root), expected: { kind: 'replaceIfVersion', version: created.version } }, writeResultSchema)
      const edited = await test.client.request('fs.edit', { target, edit: { oldString: 'second', newString: 'third', replaceAll: false }, expected: { version: updated.version }, policy: policy(test.root) }, editResultSchema)
      expect(edited.after).toBe('third text')
      await test.client.request('fs.edit', { target, edit: { oldString: 'third', newString: 'fourth', replaceAll: false }, policy: policy(test.root) }, editResultSchema)
      expect(await test.client.request('fs.readText', { target }, z.string())).toBe('fourth text')
      await expect(test.client.request('fs.write', { target, content: 'denied', policy: { mode: 'read-only', workspaceRoot: test.root } }, writeResultSchema)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    } finally { await test.close() }
  })

  it.skipIf(process.platform !== 'linux')('publishes new VFS text to the group and retains existing file permissions', async () => {
    const test = await helper(false, 30_000, 'node-script', true)
    try {
      await expect(test.client.request('hello', { protocol: 3, workspace: '/tmp', leaseMs: 30_000 }, z.unknown()))
        .rejects.toThrow('differs from its launch directory')
      await test.hello()
      const create = await test.client.request('fs.resolve', { path: 'new.txt' }, targetSchema)
      const write = (target: typeof create, content: string) => test.client.request('fs.write', {
        target, content, policy: policy(test.root),
      }, writeResultSchema)
      await expect(write(create, 'first')).resolves.toMatchObject({ operation: 'create' })
      expect((await stat(create.targetKey)).mode & 0o777).toBe(0o660)

      const existing = await test.client.request('fs.resolve', { path: 'published.txt' }, targetSchema)
      await writeFile(existing.targetKey, 'old')
      await chmod(existing.targetKey, 0o640)
      await expect(write(existing, 'updated')).resolves.toMatchObject({ operation: 'update' })
      expect((await stat(existing.targetKey)).mode & 0o777).toBe(0o640)
      expect(await readFile(existing.targetKey, 'utf8')).toBe('updated')

      const privateFile = await test.client.request('fs.resolve', { path: 'private.txt' }, targetSchema)
      await writeFile(privateFile.targetKey, 'private', { mode: 0o600 })
      await write(privateFile, 'still private')
      expect((await stat(privateFile.targetKey)).mode & 0o777).toBe(0o600)
    } finally { await test.close() }
  })

  it('returns metadata, byte ranges and canonical symlink observations', async () => {
    const test = await helper()
    try {
      await writeFile(`${test.root}/bytes`, 'abcdef')
      await symlink(`${test.root}/bytes`, `${test.root}/link`)
      const target = await test.client.request('fs.resolve', { path: 'link', cwd: test.root }, targetSchema)
      expect(target.targetKey).toBe(`${test.root}/bytes`)
      expect(await test.client.request('fs.lstat', { path: 'link', cwd: test.root }, z.unknown())).toMatchObject({ type: 'symlink' })
      expect(await test.client.request('fs.lstat', { path: 'absent' }, z.null())).toBeNull()
      expect(await test.client.request('fs.stat', { target }, infoSchema)).toMatchObject({ type: 'file', size: 6 })
      const missing = await test.client.request('fs.resolve', { path: 'absent' }, targetSchema)
      expect(await test.client.request('fs.stat', { target: missing }, z.null())).toBeNull()
      expect(Buffer.from(await test.client.request('fs.readBytes', { target, maxBytes: 16 }, z.string()), 'base64').toString()).toBe('abcdef')
      expect(Buffer.from(await test.client.request('fs.readRange', { target, offset: 1, length: 3 }, z.string()), 'base64').toString()).toBe('bcd')
      const directory = await test.client.request('fs.resolve', { path: '.' }, targetSchema)
      expect((await test.client.request('fs.list', { target: directory }, entriesSchema)).map(entry => entry.name)).toContain('bytes')
      await expect(test.client.request('fs.readRange', { target, offset: -1, length: 3 }, z.string())).rejects.toThrow()
    } finally { await test.close() }
  })

  it('closes remote text iterators after completion and explicit early return', async () => {
    const test = await helper()
    try {
      await writeFile(`${test.root}/text`, 'streamed')
      const target = await test.client.request('fs.resolve', { path: 'text' }, targetSchema)
      const nextSchema = z.object({ done: z.boolean(), value: z.string() })
      const id = await test.client.request('fs.stream', { target }, z.string())
      expect(await test.client.request('fs.next', { id }, nextSchema)).toEqual({ done: false, value: 'streamed' })
      let next = await test.client.request('fs.next', { id }, nextSchema)
      while (!next.done) {
        expect(next.value).toBe('')
        next = await test.client.request('fs.next', { id }, nextSchema)
      }
      expect(next.value).toBe('')
      await expect(test.client.request('fs.next', { id }, nextSchema)).rejects.toThrow('Unknown SSH text stream')
      const early = await test.client.request('fs.stream', { target }, z.string())
      await test.client.request('fs.streamClose', { id: early }, z.null())
      await expect(test.client.request('fs.next', { id: early }, nextSchema)).rejects.toThrow('Unknown SSH text stream')
    } finally { await test.close() }
  })

  it('refuses unconfined sandbox requests and resolves executables in the helper world', async () => {
    const test = await helper()
    const confine = vi.spyOn(LocalSandboxProvider.prototype, 'confine').mockImplementation(async argv => ({
      argv: ['confined', ...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [],
    }))
    const resolveExecutable = vi.spyOn(LocalSubprocessRuntime.prototype, 'resolveExecutable')
    try {
      await expect(test.client.request('sandbox', { argv: ['true'], policy: { mode: 'danger-full-access', workspaceRoot: test.root } }, z.unknown())).rejects.toThrow('does not need')
      expect(await test.client.request('executable', { command: process.execPath, env: { REMOVED: null } }, z.string())).toBe(process.execPath)
      expect(await test.client.request('executable', { command: process.execPath }, z.string())).toBe(process.execPath)
      expect(await test.client.request('terminal.environment', {}, z.unknown())).toMatchObject({ platform: 'posix' })
      await expect(test.client.request('executable', { command: `${test.root}/absent` }, z.string())).rejects.toMatchObject({ code: 'SUBPROCESS_EXECUTABLE_NOT_FOUND' })
      await expect(test.client.request('executable', { command: './relative' }, z.string())).rejects.toThrow('relative')
      const missing = Object.assign(new Error('absent module copy'), { name: 'SubprocessExecutableNotFoundError' })
      expect(missing).not.toBeInstanceOf(SubprocessExecutableNotFoundError)
      resolveExecutable.mockRejectedValueOnce(missing)
      await expect(test.client.request('executable', { command: 'foreign-missing' }, z.string()))
        .rejects.toMatchObject({ code: 'SUBPROCESS_EXECUTABLE_NOT_FOUND', message: 'absent module copy' })
      const wrapped = await test.client.request('sandbox', { argv: ['true'], policy: policy(test.root) }, z.looseObject({ argv: z.array(z.string()), enforcement: z.enum(['full', 'partial']) }))
      expect(wrapped.argv).toEqual(['confined', 'true'])
      expect(confine).toHaveBeenCalledWith(['true'], policy(test.root), expect.any(AbortSignal))
    } finally { resolveExecutable.mockRestore(); confine.mockRestore(); await test.close() }
  })
})

describe.skipIf(process.platform === 'win32')('guarded patch helper dispatch', () => {
  it.each([false, true])('executes patch, move, and delete with guards %s through the sandbox provider', async (guarded) => {
    const test = await helper()
    try {
      await writeFile(`${test.root}/a`, 'old\r\n')
      const target = await test.client.request('fs.resolve', { path: 'a' }, targetSchema)
      const destination = await test.client.request('fs.resolve', { path: 'b' }, targetSchema)
      const info = await test.client.request('fs.stat', { target }, infoSchema)
      const hunks = [{ lineNumber: 3, oldLines: ['old'], newLines: ['new'], isEndOfFile: false }]
      const patched = await test.client.request('fs.patch', { target, hunks, expected: guarded ? { version: info.version } : undefined, policy: policy(test.root) }, editResultSchema)
      expect(patched).toMatchObject({ before: 'old\n', after: 'new\n' })
      expect(await readFile(`${test.root}/a`, 'utf8')).toBe('new\r\n')
      const options = guarded ? { hunks: [{ ...hunks[0], context: 'new', oldLines: [], newLines: ['tail'] }], expectedSource: { version: patched.version }, expectedDestination: { kind: 'createIfAbsent' } } : {}
      const moved = await test.client.request('fs.move', { source: target, destination, options, policy: policy(test.root) }, moveResultSchema)
      expect(moved).toMatchObject({ sourceBefore: 'new\n', sourceDeleted: true, destination: { operation: 'create', before: null, after: guarded ? 'new\ntail\n' : 'new\n' } })
      await expect(readFile(`${test.root}/a`)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(`${test.root}/b`, 'utf8')).toBe(guarded ? 'new\r\ntail\r\n' : 'new\r\n')
      expect(await test.client.request('fs.delete', { target: destination, expected: guarded ? { version: moved.destination.version } : undefined, policy: policy(test.root) }, deleteResultSchema)).toEqual({ before: guarded ? 'new\ntail\n' : 'new\n' })
      await expect(readFile(`${test.root}/b`)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await test.close() }
  })

  it('rejects malformed hunks and read-only mutations without changing source bytes', async () => {
    const test = await helper()
    try {
      await writeFile(`${test.root}/a`, 'old')
      const target = await test.client.request('fs.resolve', { path: 'a' }, targetSchema)
      await expect(test.client.request('fs.patch', { target, hunks: [{ lineNumber: 0 }], policy: policy(test.root) }, editResultSchema)).rejects.toThrow()
      const denied = { mode: 'read-only', workspaceRoot: test.root }
      for (const [method, params] of [
        ['fs.patch', { target, hunks: [], policy: denied }],
        ['fs.delete', { target, policy: denied }],
        ['fs.move', { source: target, destination: target, options: {}, policy: denied }],
      ] as const) await expect(test.client.request(method, params, z.unknown())).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      expect(await readFile(`${test.root}/a`, 'utf8')).toBe('old')
    } finally { await test.close() }
  })
})

it.each([
  { lineNumber: 0 }, { lineNumber: 1.5 }, { context: 1 }, { oldLines: [1] }, { newLines: [false] },
  { isEndOfFile: 'true' }, { extra: true },
])('rejects invalid hunk fields %j', (fields) => {
  const valid = { lineNumber: 3, oldLines: ['old'], newLines: ['new'], isEndOfFile: false }
  expect(hunkSchema.safeParse({ ...valid, ...fields }).success).toBe(false)
  expect(moveOptionsSchema.safeParse({ hunks: [{ ...valid, ...fields }] }).success).toBe(false)
})
