/** Real login, durable ownership, workspace allocation, Gateway and local Runner HTTP. */

import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry, { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import WorkspaceController from '@deepseek-ai/dsh-api-workspace-controller'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import Multiuser from '@deepseek-ai/dsh-api-multiuser'
import { expect, test, vi, onTestFinished } from 'vitest'
import WorkspaceSandbox, { Config } from '../src/index.ts'

const running = { state: 'running', containerId: 'a'.repeat(64) }
interface Call { method: string | undefined; path: string | undefined; body: unknown }
interface RpcResult { ok: boolean; value?: unknown; error?: { code: string; message: string; details: unknown } }

async function fixture(mutationTimeoutMs = 1000) {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'dsh-management-'))
  const workspaceRoot = join(home, 'workspaces')
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\dsh-management-${randomUUID()}` : join(home, 'runner.sock')
  const ctx = new Context()
  const calls: Call[] = []
  const control = { respond: (response: ServerResponse, method: string | undefined) => { response.end(JSON.stringify(method === 'DELETE' ? { state: 'closed' } : running)) } }
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString()
      const parsed: unknown = body === '' ? undefined : JSON.parse(body)
      calls.push({ method: request.method, path: request.url, body: parsed })
      control.respond(response, request.method)
    })
  })
  onTestFinished(async () => {
    vi.restoreAllMocks()
    await ctx.fiber.dispose()
    if (server.listening) await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
      server.closeAllConnections()
    })
    await rm(home, { recursive: true, force: true })
  })
  await once(server.listen(socketPath), 'listening')
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(home, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  // Session event bodies and owner credentials are outside these account lifecycle operations.
  ctx.provide('sessionPersistence', { list: async () => [], open: () => { throw new Error('unused') }, stat: () => { throw new Error('unused') } } as never)
  let credentialRecord: unknown
  ctx.provide('credentials', { readRecord: async () => credentialRecord, modifyRecord: async (_key: unknown, mutate: (current: unknown) => Promise<unknown>) => { credentialRecord = await mutate(credentialRecord); return credentialRecord } } as never)
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(Gateway)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(Connection, { multiuser: true })
  await ctx.plugin(WorkspaceController, {})
  await ctx.plugin(Multiuser, { workspaceRoot })
  const sandboxFiber = ctx.plugin(WorkspaceSandbox, { socketPath, workspaceRoot, mutationTimeoutMs, queryTimeoutMs: 1000 })
  await sandboxFiber
  const base = `http://127.0.0.1:${String(ctx.webServer.port)}`
  async function raw(cookie: string, method: string, args: unknown, origin = base) {
    return fetch(`${base}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', origin, cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }) })
  }
  async function rpc(cookie: string, operation: string, request: unknown): Promise<RpcResult> {
    const response = await raw(cookie, `workspaceSandbox/${operation}`, { request })
    expect(response.status).toBe(200)
    return (await response.json() as { result: RpcResult }).result
  }
  async function remove(cookie: string, workspaceId: string): Promise<RpcResult> {
    const response = await raw(cookie, 'workspace/delete', { request: { workspaceId } })
    expect(response.status).toBe(200)
    return (await response.json() as { result: RpcResult }).result
  }
  async function account(username: string) {
    const password = randomUUID()
    const user = await ctx.multiuser.provisionUser(username, password)
    const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ username, password }) })
    expect(response.status).toBe(200)
    const cookie = response.headers.getSetCookie()[0]!.split(';', 1)[0]!
    const created = await raw(cookie, 'workspace/create', { request: { title: username } })
    const result = (await created.json() as { result: RpcResult }).result
    expect(result.ok).toBe(true)
    const id = WorkspaceId((result.value as { workspace: { workspaceId: string } }).workspace.workspaceId)
    return { user, cookie, id, workspace: ctx.workspaceRegistry.get(id)! }
  }
  const alice = await account('alice')
  const bob = await account('bob')
  return { ctx, home, workspaceRoot, socketPath, server, control, calls, sandboxFiber, base, raw, rpc, remove, alice, bob }
}

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

test.each(['timeout', 'invalid', 'incomplete'])('unconfirmed %s modification is never replayed or compensated and fresh GET can observe completion', async (kind) => {
  const f = await fixture(100)
  f.control.respond = (response) => {
    if (kind === 'invalid') response.end('{"state":"closed"}')
    if (kind === 'incomplete') { response.writeHead(200, { 'content-length': '999' }); response.write('{'); response.destroy() }
  }
  expect(await f.rpc(f.alice.cookie, 'open', { workspaceId: f.alice.id })).toMatchObject({ ok: false, error: { details: { outcomeUnknown: true } } })
  expect(f.calls.map(call => call.method)).toEqual(['PUT'])
  f.control.respond = (response) => { response.end(JSON.stringify(running)) }
  expect(await f.rpc(f.alice.cookie, 'status', { workspaceId: f.alice.id })).toEqual({ ok: true, value: { workspaceId: f.alice.id, state: 'running' } })
  expect(f.calls.map(call => call.method)).toEqual(['PUT', 'GET'])
})

test('concurrent open and close reach Runner immediately; Harness owns no operation queue or state cache', async () => {
  const f = await fixture()
  const received = Promise.withResolvers<undefined>()
  const pending: Array<{ response: ServerResponse; method: string | undefined }> = []
  f.control.respond = (response, method) => { pending.push({ response, method }); if (pending.length === 3) received.resolve(undefined) }
  const results = ['open', 'close', 'open'].map(operation => f.rpc(f.alice.cookie, operation, { workspaceId: f.alice.id }))
  await received.promise
  expect(f.calls.map(call => call.method).sort()).toEqual(['DELETE', 'PUT', 'PUT'])
  let opened = false
  for (const { response, method } of pending) {
    if (method === 'DELETE') response.end(JSON.stringify({ state: 'closed' }))
    else if (!opened) { opened = true; response.end(JSON.stringify(running)) }
    else response.writeHead(409).end(JSON.stringify({ error: 'sandbox_closing' }))
  }
  expect((await Promise.all(results)).filter(result => result.ok)).toHaveLength(2)
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

test.each(['starting', 'running', 'closing', 'cleanup_required'])('deletion refuses a %s sandbox and retains its registration and owner', async (state) => {
  const f = await fixture()
  f.control.respond = (response) => { response.end(JSON.stringify(state === 'running' ? running : { state })) }
  expect(await f.remove(f.alice.cookie, f.alice.id)).toMatchObject({ ok: false,
    error: { code: 'workspace/sandbox-active', details: { workspaceId: f.alice.id, state } } })
  expect(f.ctx.workspaceRegistry.get(f.alice.id)).toBe(f.alice.workspace)
  expect(f.ctx.multiuser.ownsWorkspace(f.alice.user.userId, f.alice.id)).toBe(true)
  expect(f.calls.map(call => call.method)).toEqual(['GET'])
})

test('close confirmation permits registration deletion while keeping the directory and blocking future opens', async () => {
  const f = await fixture()
  await writeFile(join(f.alice.workspace.path, 'keep.txt'), 'kept')
  let state: 'running' | 'closed' = 'running'
  f.control.respond = (response, method) => {
    if (method === 'DELETE') state = 'closed'
    response.end(JSON.stringify(state === 'running' ? running : { state }))
  }
  expect((await f.remove(f.alice.cookie, f.alice.id)).ok).toBe(false)
  expect((await f.rpc(f.alice.cookie, 'close', { workspaceId: f.alice.id })).ok).toBe(true)
  expect(await f.remove(f.alice.cookie, f.alice.id)).toEqual({ ok: true, value: { deleted: true } })
  expect(f.ctx.workspaceRegistry.get(f.alice.id)).toBeUndefined()
  expect(f.ctx.multiuser.ownerOfWorkspace(f.alice.id)).toBeUndefined()
  expect(await readFile(join(f.alice.workspace.path, 'keep.txt'), 'utf8')).toBe('kept')
  expect((await f.rpc(f.alice.cookie, 'open', { workspaceId: f.alice.id })).ok).toBe(false)
  expect(f.calls.map(call => call.method)).toEqual(['GET', 'DELETE', 'GET'])
})

test('deletion fails without changing ownership when Runner cannot confirm closed', async () => {
  const f = await fixture()
  f.control.respond = (response) => { response.writeHead(503).end(JSON.stringify({ error: 'docker_unavailable' })) }
  expect(await f.remove(f.alice.cookie, f.alice.id)).toMatchObject({ ok: false,
    error: { code: 'sandbox/failed', details: { reason: 'docker_unavailable' } } })
  expect(f.ctx.workspaceRegistry.get(f.alice.id)).toBe(f.alice.workspace)
  expect(f.ctx.multiuser.ownsWorkspace(f.alice.user.userId, f.alice.id)).toBe(true)
  f.control.respond = (response) => { response.end(JSON.stringify(running)) }
  expect((await f.rpc(f.alice.cookie, 'open', { workspaceId: f.alice.id })).ok).toBe(true)
})

test('an admitted opening prevents deletion even before the Runner reports its generation', async () => {
  const f = await fixture()
  const received = Promise.withResolvers<undefined>()
  let release: (() => void) | undefined
  f.control.respond = (response) => { release = () => { response.end(JSON.stringify(running)) }; received.resolve(undefined) }
  const opening = f.rpc(f.alice.cookie, 'open', { workspaceId: f.alice.id })
  await received.promise
  expect(await f.remove(f.alice.cookie, f.alice.id)).toMatchObject({ ok: false,
    error: { code: 'workspace/sandbox-active', details: { state: 'starting' } } })
  release!()
  expect((await opening).ok).toBe(true)
  expect(f.calls.map(call => call.method)).toEqual(['PUT'])
})

test('deletion blocks late opens through the registry commit', async () => {
  const f = await fixture()
  const checking = Promise.withResolvers<undefined>()
  let release: (() => void) | undefined
  f.control.respond = (response, method) => {
    if (method === 'GET') {
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
  expect(f.calls.map(call => call.method)).toEqual(['GET', 'PUT'])
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
  expect(await f.remove(f.alice.cookie, f.alice.id)).toMatchObject({ ok: false,
    error: { code: 'workspace/sandbox-active' } })
  expect((await f.rpc(f.alice.cookie, 'close', { workspaceId: f.alice.id })).ok).toBe(true)
  expect(await f.remove(f.alice.cookie, f.alice.id)).toEqual({ ok: true, value: { deleted: true } })
  expect(f.calls.map(call => call.method)).toEqual(['PUT', 'GET', 'DELETE', 'GET'])
})

test('deleting an unowned backend registration does not depend on Runner', async () => {
  const f = await fixture()
  const workspace = await f.ctx.workspaceRegistry.create(f.home)
  await expect(f.ctx.workspaceRegistry.delete(workspace.id)).resolves.toBe(true)
  expect(f.calls).toEqual([])
})
