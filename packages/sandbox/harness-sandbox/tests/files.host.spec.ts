import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { filesFixture } from './fixtures/files.ts'

test('native read preserves line windows, durable output and prompt guidance', async () => {
  const f = await filesFixture()
  const root = f.worlds[0]!.root
  await writeFile(join(root, 'text'), 'first\nsecond\nthird\n')
  const { result } = await f.run('read', { file_path: '/workspace/text', offset: 2, limit: 1 })
  expect(result).toMatchObject({ isError: false, value: { path: join(root, 'text'), offset: 2, lines: [{ number: 2, text: 'second' }], totalLines: 3 } })
  expect(result.content).toEqual([{ type: 'text', text: `<path>${join(root, 'text')}</path>\n<type>file</type>\n<content>\n2: second\n\n(Showing lines 2-2 of 3. Use offset=3 to continue.)\n</content>` }])
  expect(f.logged[0]?.data.message.content).toEqual(result.content)
  expect(f.model.requests[1]?.messages.some(message => message.role === 'tool' && JSON.stringify(message.content) === JSON.stringify(result.content))).toBe(true)
  const assembly = await f.ctx.systemPrompt.assemble({ scope: f.agent })
  expect(assembly.sections.some(section => section.text.includes('Use the read tool'))).toBe(true)
})

test('write creates and guarded overwrite preserves the native result and host files', async () => {
  const f = await filesFixture()
  const path = join(f.worlds[0]!.root, 'shared')
  const host = join(f.alice.workspace.path, 'shared')
  await writeFile(host, 'host unchanged')
  const created = await f.run('write', { file_path: 'shared', content: 'first' })
  expect(created.result).toMatchObject({ isError: false, value: { operation: 'create', path } })
  expect(created.result.content).toEqual([{ type: 'text', text: `<path>${path}</path>\n<type>file</type>\n<content>\nCreated file\n</content>` }])
  expect((await f.run('write', { file_path: '/workspace/shared', content: 'second' })).result).toMatchObject({ isError: false, value: { operation: 'update', before: 'first', after: 'second' } })
  expect(await readFile(path, 'utf8')).toBe('second')
  expect(await readFile(host, 'utf8')).toBe('host unchanged')
})

test('edit changes only the unique match and rejects mismatches without modifying bytes', async () => {
  const f = await filesFixture()
  const path = join(f.worlds[0]!.root, 'shared')
  await f.run('write', { file_path: 'shared', content: 'left target right' })
  const edited = await f.run('edit', { file_path: 'shared', old_string: 'target', new_string: 'changed' })
  expect(edited.result.content).toEqual([{ type: 'text', text: `The file ${path} has been updated successfully.` }])
  const missing = await f.run('edit', { file_path: 'shared', old_string: 'absent', new_string: 'bad' })
  expect(missing.result.isError).toBe(true)
  expect(await readFile(path, 'utf8')).toBe('left changed right')
})

test.each(['write', 'edit'])('%s keeps the observed version check when another writer changes the file', async (name) => {
  const f = await filesFixture()
  const path = join(f.worlds[0]!.root, 'shared')
  await f.run('write', { file_path: 'shared', content: 'original' })
  await writeFile(path, 'external replacement')
  const args = name === 'write' ? { file_path: 'shared', content: 'bad' } : { file_path: 'shared', old_string: 'external', new_string: 'bad' }
  const { result } = await f.run(name, args)
  expect(result).toMatchObject({ isError: true, error: { info: { code: 'FS_STALE_VERSION' } } })
  expect(await readFile(path, 'utf8')).toBe('external replacement')
})

test.each(['read', 'write', 'edit'])('%s refuses lexical and symlink escapes before touching outside bytes', async (name) => {
  const f = await filesFixture()
  const directory = join(f.home, 'outside-files')
  await mkdir(directory)
  const outside = join(directory, 'secret')
  await writeFile(outside, 'secret')
  // Windows directory junctions exercise the escape without requiring file-symlink privilege.
  const windows = process.platform === 'win32'
  await symlink(windows ? directory : outside, join(f.worlds[0]!.root, 'escape'), windows ? 'junction' : 'file')
  for (const file_path of ['../outside-files/secret', '/etc/passwd', windows ? '/workspace/escape/secret' : '/workspace/escape']) {
    const args = name === 'write' ? { file_path, content: 'bad' } : name === 'edit' ? { file_path, old_string: 'secret', new_string: 'bad' } : { file_path }
    expect((await f.run(name, args)).result).toMatchObject({ isError: true, error: { info: { code: 'SANDBOX_INVALID_PATH' } } })
  }
  expect(await readFile(outside, 'utf8')).toBe('secret')
})

test('write rechecks a symlink ancestor changed after its first path resolution', async () => {
  const f = await filesFixture(false)
  const root = f.worlds[0]!.root
  const outside = join(f.home, 'outside-directory')
  await mkdir(outside)
  await mkdir(join(root, 'sub'))
  await writeFile(join(outside, 'file'), 'outside original')
  f.ctx.on('fs/write-intent', async (_target, _actor, next) => {
    await rename(join(root, 'sub'), join(root, 'original-sub'))
    await symlink(outside, join(root, 'sub'), process.platform === 'win32' ? 'junction' : 'dir')
    return next()
  })
  expect((await f.run('write', { file_path: 'sub/file', content: 'bad' })).result)
    .toMatchObject({ isError: true, error: { info: { code: 'SANDBOX_INVALID_PATH' } } })
  expect(await readFile(join(outside, 'file'), 'utf8')).toBe('outside original')
})

test('native configured read caps apply to the remote stream', async () => {
  const f = await filesFixture(false, { readLimit: 2, readMaxLineLength: 4, readMaxBytes: 128 })
  await writeFile(join(f.worlds[0]!.root, 'text'), 'abcdefgh\nsecond\nthird\n')
  expect((await f.run('read', { file_path: 'text', limit: 3 })).result.isError).toBe(true)
  const { result } = await f.run('read', { file_path: 'text', limit: 1 })
  expect(result).toMatchObject({ isError: false, value: { offset: 1, totalLines: 3 } })
  expect(JSON.stringify(result.value)).toContain('abcd')
  expect(JSON.stringify(result.value)).not.toContain('efgh')
})

test('a closed original read cannot return as a successful call after reopening', async () => {
  const f = await filesFixture()
  await writeFile(join(f.worlds[0]!.root, 'shared'), 'remote')
  const accepted = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const stream = vi.spyOn(f.worlds[0]!.fs, 'streamText').mockImplementationOnce(async () => (async function* () {
    accepted.resolve(undefined)
    await release.promise
    yield 'old result'
  })())
  const pending = f.run('read', { file_path: 'shared' })
  try {
    await accepted.promise
    await f.ctx.workspaceSandbox.closeForUser(f.alice.user.userId, f.alice.workspace.id)
    await f.ctx.workspaceSandbox.openForUser(f.alice.user.userId, f.alice.workspace.id)
    release.resolve(undefined)
    expect((await pending).result.isError).toBe(true)
    expect((await f.run('read', { file_path: 'shared' })).result).toMatchObject({ isError: false, value: { lines: [{ text: 'remote' }] } })
  } finally { release.resolve(undefined); stream.mockRestore() }
})

test('two sessions share their Workspace files while another Workspace receives a separate directory', async () => {
  const f = await filesFixture()
  await f.run('write', { file_path: 'shared', content: 'alice only' })
  const second = await f.create()
  expect((await f.run('read', { file_path: 'shared' }, second)).result).toMatchObject({ isError: false, value: { lines: [{ text: 'alice only' }] } })
  const bob = await f.create(f.bob)
  expect((await f.run('read', { file_path: 'shared' }, bob, f.bob)).result.isError).toBe(true)
  expect((await f.run('write', { file_path: 'shared', content: 'bob only' }, bob, f.bob)).result.isError).toBe(false)
  expect(await readFile(join(f.worlds[0]!.root, 'shared'), 'utf8')).toBe('alice only')
  expect(await readFile(join(f.worlds[1]!.root, 'shared'), 'utf8')).toBe('bob only')
})

test('direct calls without original step admission fail before remote file access', async () => {
  const f = await filesFixture()
  const results = await f.ctx.tools.execute({ agent: f.agent, signal: new AbortController().signal,
    calls: ['read', 'write', 'edit'].map(name => ({ type: 'tool-call', id: ToolCallId(randomUUID()), name, arguments: JSON.stringify({ file_path: 'shared', content: 'bad', old_string: 'old', new_string: 'new' }) })) })
  expect(results.results.every(result => result.result.isError)).toBe(true)
  expect(f.files).not.toHaveBeenCalled()
})

test('a read execution token cannot authorize the write definition', async () => {
  const f = await filesFixture()
  const path = join(f.worlds[0]!.root, 'shared')
  await writeFile(path, 'original')
  let checked = false
  f.ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'read') {
      const definition = f.ctx.tools.get('write', f.agent)
      if (definition === undefined) throw new Error('Write tool missing')
      await expect(definition.execute({ file_path: 'shared', content: 'bad' }, {
        ...exec, deferContext: () => {}, concludeTurn: () => {},
      })).rejects.toMatchObject({ code: 'SANDBOX_PERMISSION_REVOKED' })
      checked = true
    }
    return next()
  }, { global: true })
  expect((await f.run('read', { file_path: 'shared' })).result.isError).toBe(false)
  expect(checked).toBe(true)
  expect(await readFile(path, 'utf8')).toBe('original')
})

test.each(['read', 'write', 'edit'])('%s rejects a model-supplied Workspace override', async (name) => {
  const f = await filesFixture()
  const path = join(f.worlds[0]!.root, 'shared')
  await writeFile(path, 'original')
  const args = name === 'write' ? { content: 'bad' } : name === 'edit' ? { old_string: 'original', new_string: 'bad' } : {}
  expect((await f.run(name, { ...args, file_path: 'shared', workspaceId: f.bob.workspace.id })).result.isError).toBe(true)
  expect(await readFile(path, 'utf8')).toBe('original')
})

test('an interrupted remote provider reports failure and never reads the Harness copy', async () => {
  const f = await filesFixture()
  await writeFile(join(f.alice.workspace.path, 'shared'), 'host secret')
  f.files.mockRejectedValueOnce(new Error('Remote connection unavailable'))
  expect((await f.run('read', { file_path: 'shared' })).result).toMatchObject({ isError: true, error: { info: { code: 'SANDBOX_FILES_UNAVAILABLE' } } })
})

test('unload cancels an accepted read, waits for it and removes all three tools', async () => {
  const f = await filesFixture()
  await writeFile(join(f.worlds[0]!.root, 'shared'), 'remote')
  const accepted = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const read = vi.spyOn(f.worlds[0]!.fs, 'streamText').mockImplementationOnce(async () => (async function* () {
    accepted.resolve(undefined)
    await release.promise
    yield 'remote'
  })())
  const run = f.run('read', { file_path: 'shared' })
  try {
    await accepted.promise
    let unloaded = false
    const unload = f.fiber.dispose().then(() => { unloaded = true })
    await new Promise(resolve => setImmediate(resolve))
    expect(unloaded).toBe(false)
    release.resolve(undefined)
    await unload
    expect((await run).result.isError).toBe(true)
    for (const name of ['read', 'write', 'edit']) expect(f.ctx.tools.get(name, f.agent)).toBeUndefined()
  } finally { release.resolve(undefined); read.mockRestore() }
})
