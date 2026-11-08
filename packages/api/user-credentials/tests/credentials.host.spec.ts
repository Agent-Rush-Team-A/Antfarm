/** Authenticated personal credentials with real storage, Connection and Gateway. */
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
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
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
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

async function setup(root?: string, config = {}, provisionKey = true, guestAccess = false) {
  const directory = root ?? await mkdtemp(join(tmpdir(), 'personal-credentials-'))
  const keyFile = join(directory, 'key')
  if (root === undefined && provisionKey) await writeFile(keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' })
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
  await ctx.plugin(Multiuser, { workspaceRoot: join(directory, 'workspaces'), guestAccess })
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

async function agentForAccount(ctx: Context, userId: UserId): Promise<Agent> {
  const workspace = await ctx.multiuser.createUserWorkspace(userId)
  const session = ctx.sessions.create(undefined, { meta: { cwd: workspace.path } })
  await workspace.attachSession(session.id)
  return { id: session.id, session, ctx, status: 'running' } as Agent
}

it('initializes an empty deployment once and preserves the key and credentials across reloads', async () => {
  const f = await setup(undefined, { initializeKeyIfEmpty: true }, false)
  const firstKey = await readFile(f.keyFile)
  expect(firstKey).toHaveLength(32)
  if (process.platform !== 'win32') expect((await stat(f.keyFile)).mode & 0o077).toBe(0)
  const alice = await f.login('alice')
  const record = await f.invoke<UserCredentialView>(alice, 'create', { name: 'Vultr API Key', value: 'personal-key' })
  await f.fiber.dispose()
  const reloaded = f.ctx.plugin(UserCredentials, { encryptionKeyFile: f.keyFile, initializeKeyIfEmpty: true })
  await reloaded.await()
  expect(await readFile(f.keyFile)).toEqual(firstKey)
  expect(await f.invoke(alice, 'list')).toEqual([record])
  expect(await f.invoke(alice, 'check', { id: record.id })).toEqual({ readable: true })
})

it('refuses to generate a replacement key when the encrypted store is nonempty', async () => {
  const f = await setup(undefined, { initializeKeyIfEmpty: true }, false)
  const alice = await f.login('alice')
  await f.invoke(alice, 'create', { name: 'Vultr API Key', value: 'personal-key' })
  await f.fiber.dispose()
  await rm(f.keyFile)
  const rejected = f.ctx.plugin(UserCredentials, { encryptionKeyFile: f.keyFile, initializeKeyIfEmpty: true })
  await expect(rejected.await()).rejects.toThrow('restore the original private 32-byte key')
  await rejected.dispose()
  await expect(stat(f.keyFile)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('requires explicit initialization and never replaces an invalid existing key', async () => {
  const f = await setup()
  await f.fiber.dispose()
  await rm(f.keyFile)
  const missing = f.ctx.plugin(UserCredentials, { encryptionKeyFile: f.keyFile })
  await expect(missing.await()).rejects.toThrow('Cannot load personal credential key')
  await missing.dispose()
  await expect(stat(f.keyFile)).rejects.toMatchObject({ code: 'ENOENT' })
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(33)]) {
    await writeFile(f.keyFile, bytes, { mode: 0o600 })
    const invalid = f.ctx.plugin(UserCredentials, { encryptionKeyFile: f.keyFile, initializeKeyIfEmpty: true })
    await expect(invalid.await()).rejects.toThrow('Cannot load personal credential key')
    await invalid.dispose()
    expect(await readFile(f.keyFile)).toEqual(bytes)
  }
  if (process.platform !== 'win32') {
    await writeFile(f.keyFile, randomBytes(32))
    await chmod(f.keyFile, 0o644)
    const unsafe = f.ctx.plugin(UserCredentials, { encryptionKeyFile: f.keyFile, initializeKeyIfEmpty: true })
    await expect(unsafe.await()).rejects.toThrow('Cannot load personal credential key')
    await unsafe.dispose()
    expect((await stat(f.keyFile)).mode & 0o077).not.toBe(0)
  }
})

it('refuses initialization through a parent symlink into a workspace mount', async () => {
  const f = await setup()
  await f.fiber.dispose()
  const alias = join(f.root, 'workspace-alias')
  await symlink(join(f.root, 'workspaces'), alias, 'junction')
  const rejected = f.ctx.plugin(UserCredentials, {
    encryptionKeyFile: join(alias, 'new-key'), initializeKeyIfEmpty: true,
  })
  await expect(rejected.await()).rejects.toThrow('Cannot load personal credential key')
  await rejected.dispose()
  await expect(stat(join(f.root, 'workspaces', 'new-key'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('authorizes each current turn independently and refuses missing credentials, mixed callers and changed endpoints', async () => {
  const baseURL = 'https://inference.example.test/v1'
  const f = await setup(undefined, { inferenceBindings: [{ provider: 'personal-test', baseURL, credentialName: 'Test key' }] })
  await f.ctx.plugin(SessionStore)
  await f.ctx.plugin(SessionProjectionRegistry)
  await f.ctx.plugin(AgentRegistry)
  await f.ctx.plugin(LlmRuntime)
  const alice = await f.login('alice')
  const bob = await f.login('bob')
  if (alice.principal.kind !== 'user' || bob.principal.kind !== 'user') throw new Error('Expected real user peers')
  const ownerA = alice.principal
  const ownerB = bob.principal
  await f.invoke(alice, 'create', { name: 'Test key', value: 'ALICE-INFERENCE-CANARY' })
  const a = await agentForAccount(f.ctx, ownerA.userId)
  const b = await agentForAccount(f.ctx, ownerB.userId)
  async function claim(agent: Agent, principals: Array<typeof ownerA>, turn = 1, step = 1) {
    const messages = principals.map(principal => createUserMessage({ source: { kind: 'user', principal }, content: [{ type: 'text', text: 'hi' }] }))
    await f.ctx.waterfall('agent/pre-step', { agent, messages, turn, step, signal: new AbortController().signal,
      modelSelection: { provider: 'personal-test', model: 'model' } }, () => Promise.resolve({ kind: 'enter' as const, messages }))
  }
  const fallback = vi.fn(async () => 'GLOBAL-MUST-NOT-BE-USED')
  const requestFor = (agent: Agent) => ({ provider: 'personal-test', baseURL, model: 'model', credentialScope: 'request' as const, sessionId: agent.id })
  const resolve = (agent: Agent) => f.ctx.agents.withInitiator(agent,
    () => f.ctx.waterfall('llm-pi-ai/resolve-api-key', requestFor(agent), fallback))
  await claim(a, [ownerA])
  await claim(b, [ownerB])
  await expect(resolve(a)).resolves.toBe('ALICE-INFERENCE-CANARY')
  await expect(resolve(b)).rejects.toMatchObject({ code: 'PERSONAL_CREDENTIAL_MISSING' })
  await f.invoke(bob, 'create', { name: 'Test key', value: 'BOB-INFERENCE-CANARY' })
  const concurrent = await Promise.all([resolve(a), resolve(b)])
  expect(concurrent).toEqual(['ALICE-INFERENCE-CANARY', 'BOB-INFERENCE-CANARY'])
  await expect(f.ctx.agents.withInitiator(a, () => f.ctx.waterfall('llm-pi-ai/resolve-api-key', {
    ...requestFor(a), baseURL: 'https://other.example.test/v1',
  }, fallback))).rejects.toMatchObject({ code: 'PERSONAL_CREDENTIAL_ENDPOINT' })
  await claim(a, [ownerA, ownerB], 2)
  await expect(resolve(a)).rejects.toMatchObject({ code: 'PERSONAL_CREDENTIAL_UNAUTHORIZED' })
  await claim(a, [ownerA], 3)
  await claim(a, [], 3, 2)
  await expect(resolve(a)).resolves.toBe('ALICE-INFERENCE-CANARY')
  Reflect.set(a, 'status', 'idle')
  await expect(resolve(a)).rejects.toMatchObject({ code: 'PERSONAL_CREDENTIAL_UNAUTHORIZED' })
  expect(fallback).not.toHaveBeenCalled()
})

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

it.each(['empty', 'whitespace', 'oversized'] as const)('rejects a %s visitor inference key without changing its file', async (kind) => {
  const f = await setup()
  await f.fiber.dispose()
  const guestInferenceKeyFile = join(f.root, 'guest-key')
  const bytes = kind === 'empty' ? Buffer.alloc(0) : Buffer.alloc(kind === 'oversized' ? 33 : 32, kind === 'whitespace' ? ' ' : 'x')
  await writeFile(guestInferenceKeyFile, bytes, { mode: 0o600, flag: 'wx' })
  const rejected = f.ctx.plugin(UserCredentials, {
    encryptionKeyFile: f.keyFile, guestInferenceKeyFile, maxCredentialBytes: 32,
  })
  await expect(rejected.await()).rejects.toThrow('Visitor inference key')
  await rejected.dispose()
  expect(await readFile(guestInferenceKeyFile)).toEqual(bytes)
})

it.skipIf(process.platform === 'win32')('rejects publicly readable visitor keys and final file symlinks', async () => {
  const f = await setup()
  await f.fiber.dispose()
  const path = join(f.root, 'guest-key')
  await writeFile(path, 'GUEST-INFERENCE-CANARY', { mode: 0o600, flag: 'wx' })
  await chmod(path, 0o644)
  const publicKey = f.ctx.plugin(UserCredentials, { encryptionKeyFile: f.keyFile, guestInferenceKeyFile: path })
  await expect(publicKey.await()).rejects.toThrow('private regular file')
  await publicKey.dispose()
  await chmod(path, 0o600)
  const alias = join(f.root, 'guest-key-alias')
  await symlink(path, alias)
  const linked = f.ctx.plugin(UserCredentials, { encryptionKeyFile: f.keyFile, guestInferenceKeyFile: alias })
  await expect(linked.await()).rejects.toThrow()
  await linked.dispose()
  expect(await readFile(path, 'utf8')).toBe('GUEST-INFERENCE-CANARY')
})

it('rejects relative visitor keys, directories and aliases into workspace mounts', async () => {
  const f = await setup()
  await f.fiber.dispose()
  const inside = join(f.root, 'workspaces', 'guest-key')
  await writeFile(inside, 'GUEST-INFERENCE-CANARY', { mode: 0o600, flag: 'wx' })
  const alias = join(f.root, 'workspace-guest-alias')
  await symlink(join(f.root, 'workspaces'), alias, 'junction')
  for (const guestInferenceKeyFile of ['relative-key', f.root, inside, join(alias, 'guest-key')]) {
    const rejected = f.ctx.plugin(UserCredentials, { encryptionKeyFile: f.keyFile, guestInferenceKeyFile })
    await expect(rejected.await()).rejects.toThrow()
    await rejected.dispose()
  }
  expect(await readFile(inside, 'utf8')).toBe('GUEST-INFERENCE-CANARY')
})

it('uses a private visitor key only for an authorized guest turn on its exact inference binding', async () => {
  const f = await setup(undefined, {}, true, true)
  await f.fiber.dispose()
  const guestInferenceKeyFile = join(f.root, 'guest-key')
  const secret = 'GUEST-INFERENCE-CANARY'
  const encoded = `\n${secret}\n`
  await writeFile(guestInferenceKeyFile, encoded, { mode: 0o600, flag: 'wx' })
  const baseURL = 'https://inference.example.test/v1'
  const service = f.ctx.plugin(UserCredentials, {
    encryptionKeyFile: f.keyFile, guestInferenceKeyFile, maxCredentialBytes: Buffer.byteLength(encoded),
    inferenceBindings: [{ provider: 'guest-test', baseURL, credentialName: 'Test key' }],
  })
  await service.await()
  await f.ctx.plugin(SessionStore)
  await f.ctx.plugin(SessionProjectionRegistry)
  await f.ctx.plugin(AgentRegistry)
  await f.ctx.plugin(LlmRuntime)
  const login = await f.ctx.multiuser.loginGuest('guest-test-address')
  if (!login.ok) throw new Error('Guest login failed')
  const admission = f.ctx.multiuser.admit({ headers: { cookie: 'dsh-login=' + login.token } }, false)
  if (!('peer' in admission) || admission.peer.principal.kind !== 'user') throw new Error('Guest admission failed')
  const guestPeer = admission.peer
  const guest = admission.peer.principal
  const alicePeer = await f.login('alice')
  if (alicePeer.principal.kind !== 'user') throw new Error('Expected normal user')
  const alice = alicePeer.principal
  async function claim(agent: Agent, principals: Array<typeof guest>, turn = 1, signal = new AbortController().signal) {
    const messages = principals.map(principal => createUserMessage({ source: { kind: 'user', principal }, content: [{ type: 'text', text: 'hi' }] }))
    await f.ctx.waterfall('agent/pre-step', { agent, messages, turn, step: 1, signal,
      modelSelection: { provider: 'guest-test', model: 'model' } }, () => Promise.resolve({ kind: 'enter' as const, messages }))
  }
  const guestAgent = await agentForAccount(f.ctx, guest.userId)
  const aliceAgent = await agentForAccount(f.ctx, alice.userId)
  const fallback = vi.fn(async () => 'DEPLOYMENT-FALLBACK-MUST-NOT-BE-USED')
  const requestFor = (agent: Agent) => ({ provider: 'guest-test', baseURL, model: 'model', credentialScope: 'request' as const, sessionId: agent.id })
  const resolve = (agent: Agent) => f.ctx.agents.withInitiator(agent,
    () => f.ctx.waterfall('llm-pi-ai/resolve-api-key', requestFor(agent), fallback))
  await claim(guestAgent, [guest])
  await claim(aliceAgent, [alice])
  await expect(resolve(guestAgent)).resolves.toBe(secret)
  await expect(resolve(guestAgent)).resolves.toBe(secret)
  await expect(resolve(aliceAgent)).rejects.toMatchObject({ code: 'PERSONAL_CREDENTIAL_MISSING' })
  await f.invoke(alicePeer, 'create', { name: 'Test key', value: 'ALICE-INFERENCE-CANARY' })
  await expect(resolve(aliceAgent)).resolves.toBe('ALICE-INFERENCE-CANARY')
  await expect(f.invoke(guestPeer, 'list')).rejects.toMatchObject({ code: 'remote-access/denied' })
  await expect(f.ctx.agents.withInitiator(guestAgent, () => f.ctx.waterfall('llm-pi-ai/resolve-api-key', {
    ...requestFor(guestAgent), baseURL: 'https://other.example.test/v1',
  }, fallback))).rejects.toMatchObject({ code: 'PERSONAL_CREDENTIAL_ENDPOINT' })
  await expect(f.ctx.agents.withInitiator(guestAgent, () => f.ctx.waterfall('llm-pi-ai/resolve-api-key', {
    ...requestFor(guestAgent), credentialScope: 'global',
  }, fallback))).rejects.toMatchObject({ code: 'PERSONAL_CREDENTIAL_SCOPE' })
  await claim(guestAgent, [alice], 2)
  await expect(resolve(guestAgent)).rejects.toMatchObject({ code: 'PERSONAL_CREDENTIAL_UNAUTHORIZED' })
  await claim(guestAgent, [guest, alice], 3)
  await expect(resolve(guestAgent)).rejects.toMatchObject({ code: 'PERSONAL_CREDENTIAL_UNAUTHORIZED' })
  const canceled = new AbortController()
  await claim(guestAgent, [guest], 4, canceled.signal)
  canceled.abort()
  await expect(resolve(guestAgent)).rejects.toMatchObject({ code: 'PERSONAL_CREDENTIAL_UNAUTHORIZED' })
  await claim(guestAgent, [guest], 5)
  await expect(resolve(guestAgent)).resolves.toBe(secret)
  await f.ctx.multiuser.disableUser(guest.userId)
  await expect(resolve(guestAgent)).rejects.toMatchObject({ code: 'PERSONAL_CREDENTIAL_UNAUTHORIZED' })
  expect(fallback).not.toHaveBeenCalled()
  expect(await readFile(guestInferenceKeyFile, 'utf8')).toBe(encoded)
})
