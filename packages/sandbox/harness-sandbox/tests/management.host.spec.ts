import { randomUUID } from 'node:crypto'
import { readFile, rename, symlink, writeFile } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { basename, join } from 'node:path'
import { expect, test, vi } from 'vitest'
import WorkspaceSandbox, { Config } from '../src/index.ts'
import type {} from '../src/lifecycle.ts'
import { fixture, running } from './fixtures/management.ts'
test('two real logins manage their own allocated directories and cross-user operations never reach Runner', async () => {
  const f = await fixture()
  expect(basename(f.alice.workspace.path)).not.toBe(f.alice.id)
  await writeFile(join(f.alice.workspace.path, 'keep.txt'), 'persistent')
  for (const account of [f.alice, f.bob]) {
    for (const operation of ['open', 'status', 'close']) {
      const result = await f.rpc(account.cookie, operation, { workspaceId: account.id })
      expect(result).toEqual({ ok: true, value: { workspaceId: account.id, state: operation === 'close' ? 'closed' : 'running' } })
    }
  }
  expect(f.calls[0]).toEqual({ method: 'PUT', path: `/v1/workspaces/${f.alice.id}/sandbox`, body: { workspaceDir: f.alice.workspace.path } })
  expect(await readFile(join(f.alice.workspace.path, 'keep.txt'), 'utf8')).toBe('persistent')
  expect(f.ctx.workspaceRegistry.get(f.alice.id)).toBe(f.alice.workspace)
  f.calls.length = 0
  for (const operation of ['open', 'status', 'close']) {
    expect(await f.rpc(f.bob.cookie, operation, { workspaceId: f.alice.id })).toMatchObject({ ok: false, error: { code: 'remote-access/denied' } })
    expect(await f.rpc(f.alice.cookie, operation, { workspaceId: f.bob.id })).toMatchObject({ ok: false, error: { code: 'remote-access/denied' } })
  }
  expect(f.calls).toEqual([])
  const internal = await f.ctx.workspaceSandbox.openForUser(f.alice.user.userId, f.alice.id)
  expect(internal).toEqual(running)
  await expect(f.ctx.workspaceSandbox.close({ workspaceId: f.alice.id })).rejects.toMatchObject({ code: 'remote-access/denied' })
  await expect(f.ctx.workspaceSandbox.openForUser(f.bob.user.userId, f.alice.id)).rejects.toMatchObject({ code: 'remote-access/denied' })
})

test('missing login, forged origin, unknown fields and missing records stop before Runner', async () => {
  const f = await fixture()
  for (const operation of ['open', 'status', 'close']) {
    expect((await f.raw('', `workspaceSandbox/${operation}`, { request: { workspaceId: f.alice.id } })).status).toBe(401)
    expect((await f.raw(f.alice.cookie, `workspaceSandbox/${operation}`, { request: { workspaceId: f.alice.id } }, 'https://foreign.invalid')).status).toBe(403)
    for (const extra of [{ ownerId: f.alice.user.userId }, { workspaceDir: f.bob.workspace.path }, { containerId: running.containerId }, { image: 'unsafe' }, { command: 'pwd' }]) {
      expect(await f.rpc(f.alice.cookie, operation, { workspaceId: f.alice.id, ...extra })).toMatchObject({ ok: false, error: { code: 'gateway/bad-request' } })
    }
    expect((await f.rpc(f.alice.cookie, operation, { workspaceId: randomUUID() })).ok).toBe(false)
    expect((await f.rpc(f.alice.cookie, operation, { workspaceId: '../escape' })).ok).toBe(false)
  }
  expect(f.calls).toEqual([])
})

test('mismatched records, removed directories, root conflicts and symlinks stop before Runner', async () => {
  const f = await fixture()
  const get = f.ctx.workspaceRegistry.get.bind(f.ctx.workspaceRegistry)
  const mock = vi.spyOn(f.ctx.workspaceRegistry, 'get').mockImplementation(id => id === f.alice.id ? f.bob.workspace : get(id))
  await expect(f.ctx.workspaceSandbox.openForUser(f.alice.user.userId, f.alice.id)).rejects.toMatchObject({ code: 'remote-access/denied' })
  mock.mockRestore()
  await rename(f.alice.workspace.path, `${f.alice.workspace.path}-moved`)
  expect(await f.rpc(f.alice.cookie, 'open', { workspaceId: f.alice.id })).toMatchObject({ ok: false, error: { details: { reason: 'invalid_workspace_directory' } } })
  await symlink(f.bob.workspace.path, f.alice.workspace.path, process.platform === 'win32' ? 'junction' : 'dir')
  expect(await f.rpc(f.alice.cookie, 'open', { workspaceId: f.alice.id })).toMatchObject({ ok: false, error: { details: { reason: 'invalid_workspace_directory' } } })
  expect(f.calls).toEqual([])
})

test.each(['closed', 'starting', 'running', 'closing', 'cleanup_required'])('GET preserves current %s state without modifying the sandbox', async (state) => {
  const f = await fixture()
  f.control.respond = (response) => { response.end(JSON.stringify(state === 'running' ? running : { state })) }
  expect(await f.rpc(f.alice.cookie, 'status', { workspaceId: f.alice.id })).toEqual({ ok: true, value: { workspaceId: f.alice.id, state } })
  expect(f.calls.map(call => call.method)).toEqual(['GET'])
})

test.each(['sandbox_capacity', 'sandbox_not_ready', 'sandbox_closing', 'sandbox_cleanup_required', 'sandbox_workspace_conflict', 'sandbox_name_conflict', 'sandbox_outcome_unknown', 'docker_unavailable', 'invalid_workspace_directory'])('preserves %s without paths or container identifiers', async (reason) => {
  const f = await fixture()
  f.control.respond = (response) => { response.statusCode = reason === 'sandbox_capacity' ? 409 : 503; response.end(JSON.stringify({ error: reason })) }
  const result = await f.rpc(f.alice.cookie, 'open', { workspaceId: f.alice.id })
  expect(result).toMatchObject({ ok: false, error: { code: 'sandbox/failed', details: { reason } } })
  expect(JSON.stringify(result)).not.toContain(f.home)
  expect(JSON.stringify(result)).not.toContain(running.containerId)
  expect(f.calls).toHaveLength(1)
})

test.each(['timeout', 'invalid', 'incomplete'])('unconfirmed %s modification keeps reopening blocked without reconciliation evidence', async (kind) => {
  const f = await fixture(100)
  f.control.respond = (response) => {
    if (kind === 'invalid') response.end('{"state":"closed"}')
    if (kind === 'incomplete') { response.writeHead(200, { 'content-length': '999' }); response.write('{'); response.destroy() }
  }
  expect(await f.rpc(f.alice.cookie, 'open', { workspaceId: f.alice.id })).toMatchObject({ ok: false, error: { details: { outcomeUnknown: true } } })
  expect(f.calls.map(call => call.method)).toEqual(['PUT'])
  f.control.respond = (response) => { response.end(JSON.stringify(running)) }
  expect(await f.rpc(f.alice.cookie, 'status', { workspaceId: f.alice.id })).toEqual({ ok: true, value: { workspaceId: f.alice.id, state: 'cleanup_required' } })
  f.control.respond = (response) => { response.end(JSON.stringify({ state: 'closed' })) }
  expect(await f.rpc(f.alice.cookie, 'close', { workspaceId: f.alice.id })).toMatchObject({ ok: false, error: { details: { reason: 'sandbox_outcome_unknown', outcomeUnknown: true } } })
  expect(await f.rpc(f.alice.cookie, 'open', { workspaceId: f.alice.id })).toMatchObject({ ok: false, error: { details: { reason: 'sandbox_closing' } } })
  expect(f.calls.map(call => call.method)).toEqual(['PUT', 'DELETE'])
})

test('close drains the admitted PUT and refuses immediate reopening instead of queuing it', async () => {
  const f = await fixture()
  const received = Promise.withResolvers<undefined>()
  const pending: Array<{ response: ServerResponse; method: string | undefined }> = []
  f.control.respond = (response, method) => {
    pending.push({ response, method })
    if (method === 'PUT') received.resolve(undefined)
    else response.end(JSON.stringify({ state: 'closed' }))
  }
  const open = f.ctx.workspaceSandbox.openForUser(f.alice.user.userId, f.alice.id)
  await received.promise
  const close = f.ctx.workspaceSandbox.closeForUser(f.alice.user.userId, f.alice.id)
  await expect(f.ctx.workspaceSandbox.openForUser(f.alice.user.userId, f.alice.id)).rejects.toMatchObject({ details: { reason: 'sandbox_closing' } })
  expect(f.calls.map(call => call.method)).toEqual(['PUT'])
  pending[0]!.response.end(JSON.stringify(running))
  await expect(open).resolves.toEqual(running)
  await expect(close).resolves.toEqual({ state: 'closed' })
  expect(f.calls.map(call => call.method)).toEqual(['PUT', 'DELETE'])
})

test('unload cancels waits, unregisters endpoints and sends no DELETE', async () => {
  const f = await fixture()
  const received = Promise.withResolvers<undefined>()
  f.control.respond = () => { received.resolve(undefined) }
  const result = f.rpc(f.alice.cookie, 'open', { workspaceId: f.alice.id })
  await received.promise
  await f.sandboxFiber.dispose()
  expect(await result).toMatchObject({ ok: false })
  expect(f.calls.map(call => call.method)).toEqual(['PUT'])
  expect(f.ctx.get('workspaceSandbox')).toBeUndefined()
  expect((await f.raw(f.alice.cookie, 'workspaceSandbox/status', { request: { workspaceId: f.alice.id } })).status).toBe(404)
})

test('close revokes an opening before directory validation can issue its PUT', async () => {
  const f = await fixture()
  const open = f.ctx.workspaceSandbox.openForUser(f.alice.user.userId, f.alice.id)
  const result = Promise.allSettled([open])
  await f.ctx.workspaceSandbox.closeForUser(f.alice.user.userId, f.alice.id)
  expect((await result)[0]?.status).toBe('rejected')
  expect(f.calls.map(call => call.method)).toEqual(['DELETE'])
})

test('configuration has no implicit workspace root or Runner address', () => {
  expect(() => Config({} as never)).toThrow()
  expect(() => Config({ socketPath: '/run/runner.sock' } as never)).toThrow()
})

test('revoked login and disabled account cannot reuse browser or internal access', async () => {
  const f = await fixture()
  await f.ctx.multiuser.logout(f.alice.cookie.slice('dsh-login='.length))
  expect((await f.raw(f.alice.cookie, 'workspaceSandbox/open', { request: { workspaceId: f.alice.id } })).status).toBe(401)
  await f.ctx.multiuser.disableUser(f.bob.user.userId)
  await expect(f.ctx.workspaceSandbox.closeForUser(f.bob.user.userId, f.bob.id)).rejects.toMatchObject({ code: 'remote-access/denied' })
  expect(f.calls).toEqual([])
})

test('unknown Runner diagnostics are sanitized and query failures never synthesize closed', async () => {
  const f = await fixture()
  f.control.respond = (response) => { response.writeHead(503).end(JSON.stringify({ error: `${f.home}: private Docker diagnostic` })) }
  const result = await f.rpc(f.alice.cookie, 'status', { workspaceId: f.alice.id })
  expect(result).toMatchObject({ ok: false, error: { details: { reason: 'runner_unavailable', outcomeUnknown: false } } })
  expect(JSON.stringify(result)).not.toContain(f.home)
  await new Promise<void>((resolve, reject) => {
    f.server.close((error) => { if (error) reject(error); else resolve() })
    f.server.closeAllConnections()
  })
  expect(await f.rpc(f.alice.cookie, 'status', { workspaceId: f.alice.id })).toMatchObject({ ok: false, error: { details: { reason: 'runner_unavailable' } } })
})

test('an owned workspace with a moved directory can still be queried and closed, while opening remains refused', async () => {
  const f = await fixture()
  await f.rpc(f.alice.cookie, 'open', { workspaceId: f.alice.id })
  await rename(f.alice.workspace.path, `${f.alice.workspace.path}-moved`)
  expect(await f.rpc(f.alice.cookie, 'status', { workspaceId: f.alice.id })).toEqual({ ok: true,
    value: { workspaceId: f.alice.id, state: 'running' } })
  expect(await f.rpc(f.alice.cookie, 'close', { workspaceId: f.alice.id })).toEqual({ ok: true,
    value: { workspaceId: f.alice.id, state: 'closed' } })
  expect(await f.rpc(f.alice.cookie, 'open', { workspaceId: f.alice.id })).toMatchObject({ ok: false,
    error: { details: { reason: 'invalid_workspace_directory' } } })
  expect(f.calls.map(call => call.method)).toEqual(['PUT', 'GET', 'DELETE'])
})

test.each(['starting', 'running', 'closing', 'cleanup_required'])('deletion closes a %s sandbox before removing its registration', async (state) => {
  const f = await fixture()
  f.control.respond = (response, method) => { response.end(JSON.stringify(method === 'DELETE' ? { state: 'closed' } : state === 'running' ? running : { state })) }
  expect(await f.remove(f.alice.cookie, f.alice.id)).toEqual({ ok: true, value: { deleted: true } })
  expect(f.ctx.workspaceRegistry.get(f.alice.id)).toBeUndefined()
  expect(f.ctx.multiuser.ownsWorkspace(f.alice.user.userId, f.alice.id)).toBe(false)
  expect(f.calls.map(call => call.method)).toEqual(['DELETE'])
})

test('deletion releases the sandbox while keeping the directory and blocking future opens', async () => {
  const f = await fixture()
  await writeFile(join(f.alice.workspace.path, 'keep.txt'), 'kept')
  expect(await f.remove(f.alice.cookie, f.alice.id)).toEqual({ ok: true, value: { deleted: true } })
  expect(f.ctx.workspaceRegistry.get(f.alice.id)).toBeUndefined()
  expect(f.ctx.multiuser.ownerOfWorkspace(f.alice.id)).toBeUndefined()
  expect(await readFile(join(f.alice.workspace.path, 'keep.txt'), 'utf8')).toBe('kept')
  expect((await f.rpc(f.alice.cookie, 'open', { workspaceId: f.alice.id })).ok).toBe(false)
  expect(f.calls.map(call => call.method)).toEqual(['DELETE'])
})

test('deletion fails without changing ownership when Runner cannot confirm closed', async () => {
  const f = await fixture()
  f.control.respond = (response) => { response.writeHead(503).end(JSON.stringify({ error: 'docker_unavailable' })) }
  expect(await f.remove(f.alice.cookie, f.alice.id)).toMatchObject({ ok: false,
    error: { code: 'sandbox/failed', details: { reason: 'docker_unavailable' } } })
  expect(f.ctx.workspaceRegistry.get(f.alice.id)).toBe(f.alice.workspace)
  expect(f.ctx.multiuser.ownsWorkspace(f.alice.user.userId, f.alice.id)).toBe(true)
  f.control.respond = (response) => { response.end(JSON.stringify(running)) }
  expect((await f.rpc(f.alice.cookie, 'open', { workspaceId: f.alice.id })).ok).toBe(false)
  f.control.respond = (response, method) => { response.end(JSON.stringify(method === 'DELETE' ? { state: 'closed' } : running)) }
  expect(await f.remove(f.alice.cookie, f.alice.id)).toMatchObject({ ok: false, error: { details: { reason: 'sandbox_outcome_unknown' } } })
  expect(f.ctx.workspaceRegistry.get(f.alice.id)).toBe(f.alice.workspace)
})

test('deletion waits for an admitted opening before confirming resource release', async () => {
  const f = await fixture()
  const received = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  f.control.respond = (response, method) => {
    if (method === 'PUT') { received.resolve(undefined); void release.promise.then(() => response.end(JSON.stringify(running))) }
    else response.end(JSON.stringify({ state: 'closed' }))
  }
  const opening = f.rpc(f.alice.cookie, 'open', { workspaceId: f.alice.id })
  await received.promise
  const removing = f.remove(f.alice.cookie, f.alice.id)
  release.resolve(undefined)
  await opening
  expect(await removing).toEqual({ ok: true, value: { deleted: true } })
  expect(f.calls.map(call => call.method)).toEqual(['PUT', 'DELETE'])
})

test('deletion blocks late opens through the registry commit', async () => {
  const f = await fixture()
  const checking = Promise.withResolvers<undefined>()
  let release: (() => void) | undefined
  f.control.respond = (response, method) => {
    if (method === 'DELETE') {
      release = () => { response.end(JSON.stringify({ state: 'closed' })) }
      checking.resolve(undefined)
    } else response.end(JSON.stringify(running))
  }
  const committing = Promise.withResolvers<undefined>()
  const finish = Promise.withResolvers<undefined>()
  const dispose = f.ctx.on('workspace/before-delete', async (_id, next) => {
    committing.resolve(undefined)
    await finish.promise
    return next()
  })
  const remove = f.remove(f.alice.cookie, f.alice.id)
  await checking.promise
  expect((await f.rpc(f.alice.cookie, 'open', { workspaceId: f.alice.id })).ok).toBe(false)
  expect((await f.rpc(f.bob.cookie, 'open', { workspaceId: f.bob.id })).ok).toBe(true)
  release!()
  await committing.promise
  expect(f.ctx.workspaceRegistry.get(f.alice.id)).toBe(f.alice.workspace)
  expect((await f.rpc(f.alice.cookie, 'open', { workspaceId: f.alice.id })).ok).toBe(false)
  finish.resolve(undefined)
  expect(await remove).toEqual({ ok: true, value: { deleted: true } })
  dispose()
  expect(f.calls.map(call => call.method)).toEqual(['DELETE', 'PUT'])
})

test('a refused deletion releases admission and preserves the existing workspace', async () => {
  const f = await fixture()
  f.control.respond = (response) => { response.end(JSON.stringify({ state: 'closed' })) }
  const dispose = f.ctx.on('workspace/before-delete', () => { throw new Error('test provider refusal') })
  expect((await f.remove(f.alice.cookie, f.alice.id)).ok).toBe(false)
  expect(f.ctx.workspaceRegistry.get(f.alice.id)).toBe(f.alice.workspace)
  dispose()
  f.control.respond = (response) => { response.end(JSON.stringify(running)) }
  expect((await f.rpc(f.alice.cookie, 'open', { workspaceId: f.alice.id })).ok).toBe(true)
})

test('deletion remains guarded while the sandbox plugin is offline and uses the current provider after reload', async () => {
  const f = await fixture()
  let state: 'running' | 'closed' = 'running'
  f.control.respond = (response, method) => {
    if (method === 'DELETE') state = 'closed'
    response.end(JSON.stringify(state === 'running' ? running : { state }))
  }
  expect((await f.rpc(f.alice.cookie, 'open', { workspaceId: f.alice.id })).ok).toBe(true)
  await f.sandboxFiber.dispose()
  expect(await f.remove(f.alice.cookie, f.alice.id)).toMatchObject({ ok: false,
    error: { code: 'sandbox/failed', details: { reason: 'runner_unavailable' } } })
  expect(f.ctx.workspaceRegistry.get(f.alice.id)).toBe(f.alice.workspace)
  expect(f.ctx.multiuser.ownsWorkspace(f.alice.user.userId, f.alice.id)).toBe(true)
  expect(f.calls.map(call => call.method)).toEqual(['PUT'])
  await f.ctx.plugin(WorkspaceSandbox, { socketPath: f.socketPath, workspaceRoot: f.workspaceRoot })
  expect(await f.remove(f.alice.cookie, f.alice.id)).toEqual({ ok: true, value: { deleted: true } })
  expect(f.calls.map(call => call.method)).toEqual(['PUT', 'DELETE'])
})

test('deleting an unowned backend registration does not depend on Runner', async () => {
  const f = await fixture()
  const workspace = await f.ctx.workspaceRegistry.create(f.home)
  await expect(f.ctx.workspaceRegistry.delete(workspace.id)).resolves.toBe(true)
  expect(f.calls).toEqual([])
})

test.each(['replaced', 'starting', 'cleanup_required'])('execution cleanup refuses an unproven original generation: %s', async (state) => {
  const f = await fixture()
  const original = await f.ctx.workspaceSandbox.openForUser(f.alice.user.userId, f.alice.id)
  const version = f.ctx.workspaceSandboxState.capture(f.alice.id).version
  f.control.respond = (response) => {
    response.end(JSON.stringify(state === 'replaced' ? { state: 'running', containerId: 'b'.repeat(64) } : { state }))
  }
  await expect(f.ctx.workspaceSandbox.closeForUser(f.alice.user.userId, f.alice.id, { containerId: original.containerId, version }))
    .rejects.toMatchObject({ code: 'sandbox/failed', details: { reason: 'sandbox_workspace_conflict' } })
  expect(f.calls.map(call => call.method)).toEqual(['PUT', 'GET'])
  expect(await f.ctx.workspaceSandbox.statusForUser(f.alice.user.userId, f.alice.id)).toEqual({ state: 'cleanup_required' })
})
