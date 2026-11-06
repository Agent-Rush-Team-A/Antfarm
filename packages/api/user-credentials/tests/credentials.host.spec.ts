/** Authenticated personal credentials with real storage, Connection and Gateway. */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import Access from '@deepseek-ai/dsh-api-remote-access'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import Multiuser from '@deepseek-ai/dsh-api-multiuser'
import type { PeerScope, UserId } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { brandString } from '@deepseek-ai/dsh-brand'
import { afterEach, expect, it, vi } from 'vitest'
import UserCredentials from '../src/index.ts'
import { userCredentialsDomain } from '../src/spec.ts'
import type { UserCredentialView } from '../src/types.ts'

const fixtures: Array<{ ctx: Context; root: string }> = []
afterEach(async () => {
  vi.useRealTimers()
  for (const { ctx, root } of fixtures.splice(0)) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

async function setup(root?: string, config = {}) {
  const directory = root ?? await mkdtemp(join(tmpdir(), 'personal-credentials-'))
  const keyFile = join(directory, 'key')
  if (root === undefined) await writeFile(keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' })
  const ctx = new Context()
  fixtures.push({ ctx, root: directory })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(directory, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  ctx.provide('sessionPersistence', { list: async () => [] } as never)
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(Access)
  await ctx.plugin(Gateway)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(CredentialsLocal, { path: join(directory, 'global.credentials.yaml') })
  await ctx.plugin({ inject: Connection.inject, apply: Connection.apply }, { multiuser: true })
  await ctx.plugin(Multiuser, { workspaceRoot: join(directory, 'workspaces') })
  const fiber = ctx.plugin(UserCredentials, { encryptionKeyFile: keyFile, ...config })
  await fiber.await()
  async function login(username: string): Promise<PeerScope> {
    const password = randomUUID()
    await ctx.multiuser.provisionUser(username, password)
    const login = await ctx.multiuser.login(username, password, username)
    if (!login.ok) throw new Error('Test login failed')
    const admission = ctx.multiuser.admit({ headers: { cookie: 'dsh-login=' + login.token } }, false)
    if (!('peer' in admission)) throw new Error('Test admission failed')
    return admission.peer
  }
  function invoke<T>(peer: PeerScope, method: string, request?: object): Promise<T> {
    return ctx.typertGateway.invoke({ peer, namespace: 'userCredentials', method, args: request === undefined ? {} : { request } }) as Promise<T>
  }
  return { ctx, root: directory, keyFile, fiber, login, invoke }
}

it('isolates same-named credentials and rejects another user, owner and unscoped callers', async () => {
  const f = await setup()
  const [alice, bob] = await Promise.all([f.login('alice'), f.login('bob')])
  const secretA = 'private-alice-' + randomUUID()
  const a = await f.invoke<UserCredentialView>(alice, 'create', { name: 'Test key', value: secretA })
  const b = await f.invoke<UserCredentialView>(bob, 'create', { name: 'Test key', value: 'private-bob' })
  expect(await f.invoke(alice, 'list')).toEqual([a])
  expect(await f.invoke(bob, 'list')).toEqual([b])
  expect(await f.invoke(alice, 'check', { id: a.id })).toEqual({ readable: true })
  for (const [method, request] of [['replace', { id: a.id, value: 'stolen' }], ['delete', { id: a.id }], ['check', { id: a.id }]] as const) {
    await expect(f.invoke(bob, method, request)).rejects.toMatchObject({ code: 'user-credentials/not-found' })
  }
  await expect(f.invoke(bob, 'check', { id: randomUUID() })).rejects.toMatchObject({ code: 'user-credentials/not-found' })
  const owner = f.ctx.connection.createPeer({ principal: { kind: 'owner' } })
  await expect(f.invoke(owner, 'list')).rejects.toMatchObject({ code: 'user-credentials/unauthorized' })
  expect(() => f.ctx.userCredentials.list(new AbortController().signal)).toThrow(expect.objectContaining({ code: 'user-credentials/unauthorized' }))
  await expect(f.invoke(alice, 'create', { name: 'forged', value: secretA, userId: bob.principal.kind === 'user' ? bob.principal.userId : '' })).rejects.toMatchObject({ code: 'user-credentials/invalid-request' })
  await expect(f.invoke(alice, 'replace', { id: a.id, value: '' })).rejects.toMatchObject({ code: 'user-credentials/invalid-request' })
  await expect(f.invoke(alice, 'check', { id: '../key' })).rejects.toMatchObject({ code: 'user-credentials/invalid-request' })
  expect(await f.invoke(alice, 'list')).toEqual([a])
  await f.invoke(alice, 'replace', { id: a.id, value: 'rotated-secret' })
  expect(await f.invoke(alice, 'check', { id: a.id })).toEqual({ readable: true })
  await f.invoke(alice, 'delete', { id: a.id })
  expect(await f.invoke(alice, 'list')).toEqual([])
  expect(await f.invoke(bob, 'list')).toEqual([b])
})

it('stores and emits ciphertext only and preserves credentials across plugin reload', async () => {
  const f = await setup()
  const peer = await f.login('alice')
  const secret = 'canary-' + randomUUID()
  const changes: unknown[] = []
  f.ctx.on('domain/changed', (change) => { if (change.domain === 'user_credentials') changes.push(change) })
  const record = await f.invoke<UserCredentialView>(peer, 'create', { name: 'Demo key', value: secret })
  expect(JSON.stringify(changes)).not.toContain(secret)
  expect(JSON.stringify(record)).not.toContain(secret)
  async function contents(directory: string): Promise<string> {
    const items = await readdir(directory, { withFileTypes: true })
    return (await Promise.all(items.map(item => item.isDirectory() ? contents(join(directory, item.name)) : readFile(join(directory, item.name), 'utf8')))).join('')
  }
  expect(await contents(join(f.root, 'storage'))).not.toContain(secret)
  await f.fiber.dispose()
  const replacement = f.ctx.plugin(UserCredentials, { encryptionKeyFile: f.keyFile })
  await replacement.await()
  expect(await f.invoke(peer, 'list')).toEqual([record])
  expect(await f.invoke(peer, 'check', { id: record.id })).toEqual({ readable: true })
  await replacement.dispose()
  await writeFile(f.keyFile, randomBytes(32), { mode: 0o600 })
  const wrongKey = f.ctx.plugin(UserCredentials, { encryptionKeyFile: f.keyFile })
  await expect(wrongKey.await()).rejects.toThrow('cannot be decrypted')
})

it('enforces UTF-8 and per-account limits even for concurrent writes', async () => {
  const f = await setup(undefined, { maxCredentialBytes: 6, maxRecordsPerUser: 1 })
  const peer = await f.login('alice')
  await expect(f.invoke(peer, 'create', { name: 'Oversized', value: '中文文' })).rejects.toMatchObject({ code: 'user-credentials/invalid-request' })
  const results = await Promise.allSettled([f.invoke(peer, 'create', { name: 'One', value: '中文' }), f.invoke(peer, 'create', { name: 'Two', value: 'abc' })])
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
  expect(results[1]).toMatchObject({ reason: { code: 'user-credentials/limit' } })
  const bob = await f.login('bob')
  await expect(f.invoke(bob, 'create', { name: 'Independent', value: 'ok' })).resolves.toMatchObject({ name: 'Independent' })
})

it('refuses relative keys and keys reachable inside workspace mounts', async () => {
  const f = await setup()
  await f.fiber.dispose()
  const inside = join(f.root, 'workspaces', 'key')
  await writeFile(inside, randomBytes(32), { mode: 0o600, flag: 'wx' })
  const alias = join(f.root, 'workspace-alias')
  await symlink(join(f.root, 'workspaces'), alias, 'junction')
  for (const [encryptionKeyFile, message] of [
    ['relative-key', 'must be absolute'],
    [inside, 'outside the workspace root'],
    [join(alias, 'key'), 'Cannot load personal credential key'],
  ]) {
    const rejected = f.ctx.plugin(UserCredentials, { encryptionKeyFile: encryptionKeyFile! })
    await expect(rejected.await()).rejects.toThrow(message)
    await rejected.dispose()
  }
})

it('rejects tampered ownership and ciphertext without returning raw failures or secrets', async () => {
  const f = await setup()
  const alice = await f.login('alice')
  const bob = await f.login('bob')
  const secret = 'canary-secret'
  const record = await f.invoke<UserCredentialView>(alice, 'create', { name: 'One', value: secret })
  const domain = f.ctx.storageDomain.get(userCredentialsDomain.name)!
  const table = domain.table('credentials')
  const original = table.get(record.id)
  const changed = { ...original as object, ownerUserId: bob.principal.kind === 'user' ? bob.principal.userId : '' }
  await table.put(record.id, changed)
  await expect(f.invoke(bob, 'check', { id: record.id })).rejects.toMatchObject({ code: 'user-credentials/unavailable' })
  await table.put(record.id, { ...original as object, ciphertext: '00' })
  await expect(f.invoke(alice, 'check', { id: record.id })).rejects.toMatchObject({ code: 'user-credentials/unavailable', details: {} })
  const error = await f.invoke(alice, 'check', { id: record.id }).catch((error: unknown) => error)
  expect(JSON.stringify(error)).not.toContain(secret)
})

it('revokes credential access when the login is disabled', async () => {
  const f = await setup()
  const alice = await f.login('alice')
  if (alice.principal.kind !== 'user') throw new Error('Test requires an account')
  await f.ctx.multiuser.disableUser(brandString<UserId>(alice.principal.userId))
  await expect(f.invoke(alice, 'create', { name: 'Late', value: 'late' })).rejects.toMatchObject({ code: 'gateway/peer-disposed' })
})

it('contains a persistence failure and rejects canceled requests without changing records', async () => {
  const f = await setup()
  const alice = await f.login('alice')
  const table = f.ctx.storageDomain.get(userCredentialsDomain.name)!.table('credentials')
  const failure = vi.spyOn(table, 'put').mockRejectedValueOnce(new Error('SECRET-MUST-NOT-ESCAPE'))
  const error = await f.invoke(alice, 'create', { name: 'One', value: 'private' }).catch((error: unknown) => error)
  expect(error).toMatchObject({ code: 'user-credentials/unavailable', details: {} })
  expect(String(error)).not.toContain('SECRET-MUST-NOT-ESCAPE')
  failure.mockRejectedValueOnce(new RemoteError('user-credentials/not-found', 'SECRET-MUST-NOT-ESCAPE', {}))
  const remoteFailure = await f.invoke(alice, 'create', { name: 'Two', value: 'private' }).catch((error: unknown) => error)
  expect(remoteFailure).toMatchObject({ code: 'user-credentials/not-found', details: {} })
  expect(String(remoteFailure)).not.toContain('SECRET-MUST-NOT-ESCAPE')
  failure.mockRestore()
  expect(await f.invoke(alice, 'list')).toEqual([])
  const canceled = new AbortController()
  canceled.abort()
  await expect(f.ctx.typertGateway.invoke({ peer: alice, namespace: 'userCredentials', method: 'create',
    args: { request: { name: 'Canceled', value: 'secret' } }, signal: canceled.signal,
  })).rejects.toBeDefined()
  expect(await f.invoke(alice, 'list')).toEqual([])
})
