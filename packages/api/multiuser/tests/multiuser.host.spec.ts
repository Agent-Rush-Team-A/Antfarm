/** Real storage + Connection + Gateway + Workspace Controller multiuser behavior. */

import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import WorkspaceController from '@deepseek-ai/dsh-api-workspace-controller'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { apply as connectionApply, inject as connectionInject, type ConnectionConfig } from '@deepseek-ai/dsh-client-connection'
import { Remote, TypertRemoteService, type PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import MultiuserService from '../src/index.ts'
import type { Config as MultiuserConfig } from '../src/service.ts'

const roots: Array<{ ctx: Context; home: string }> = []

afterEach(async () => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) {
    await root.ctx.fiber.dispose()
    await rm(root.home, { recursive: true, force: true })
  }
})

class RecordCredentials {
  private record: unknown
  readRecord(): Promise<unknown> { return Promise.resolve(this.record) }
  async modifyRecord(_key: unknown, mutate: (current: unknown) => Promise<unknown>): Promise<unknown> {
    const next = await mutate(this.record)
    if (next !== undefined) this.record = next
    return this.record
  }
  deleteRecord(): Promise<void> { this.record = undefined; return Promise.resolve() }
}

/** A Remote namespace that records whether its methods ran; authorization must decide first. */
declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionProbe: SessionProbe
  }
}

class SessionProbe extends TypertRemoteService {
  readonly prompts: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'sessionProbe', { namespace: 'session' })
  }

  @Remote('prompt')
  prompt(request: { readonly sessionId: string }): { readonly accepted: true } {
    this.prompts.push(request.sessionId)
    return { accepted: true }
  }
}

function header(id: string, cwd: string): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: Date.now(), isSeeded: false, cwd }
}

interface Fixture {
  readonly disposeMultiuser: () => Promise<void>
  readonly ctx: Context
  readonly home: string
  readonly base: string
  readonly workspaceRoot: string
  readonly listed: SessionPersistenceSnapshot[]
  readonly passwords: ReadonlyMap<string, string>
}

async function setup(options: {
  storageRoot?: string
  workspaceRoot?: string
  loginAttemptLimit?: number
  provision?: boolean
} = {}): Promise<Fixture> {
  const home = options.storageRoot === undefined ? await mkdtemp(join(tmpdir(), 'dsh-multiuser-')) : options.storageRoot
  const workspaceRoot = options.workspaceRoot ?? join(home, 'workspaces')
  const ctx = new Context()
  roots.push({ ctx, home })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(home, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const listed: SessionPersistenceSnapshot[] = []
  ctx.provide('sessionPersistence', {
    list: async () => listed,
    open: () => { throw new Error('event bodies are not read in this fixture') },
    stat: () => { throw new Error('per-session stat is not used in this fixture') },
  } as never)
  ctx.provide('credentials', new RecordCredentials() as never)
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  await ctx.plugin(TypertGatewayService)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin({ inject: connectionInject, apply: connectionApply }, {
    multiuser: true,
  } satisfies ConnectionConfig)
  ctx.typert.resources.register('session', { field: 'sessionId' })
  await ctx.plugin(SessionProbe)
  await ctx.plugin(WorkspaceController, {})
  const config: MultiuserConfig = {
    workspaceRoot,
    ...(options.loginAttemptLimit === undefined ? {} : { loginAttemptLimit: options.loginAttemptLimit }),
  }
  const multiuserFiber = ctx.plugin(MultiuserService, config)
  await multiuserFiber.await()
  const passwords = new Map([['alice', randomUUID()], ['bob', randomUUID()]])
  if (options.provision !== false) {
    for (const [name, password] of passwords) {
      await ctx.multiuser.provisionUser(name, password)
    }
  }
  return { disposeMultiuser: () => multiuserFiber.dispose(), ctx, home, base: `http://127.0.0.1:${String(ctx.webServer.port)}`, workspaceRoot, listed, passwords }
}

async function login(base: string, username: string, password: string): Promise<string> {
  const response = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username, password }),
  })
  expect(response.status).toBe(200)
  const cookie = response.headers.getSetCookie()[0]
  expect(cookie).toBeDefined()
  if (cookie === undefined) throw new Error('login returned no cookie')
  return cookie.split(';', 1)[0]!
}

async function loginFor(fixture: Fixture, username: string): Promise<string> {
  const password = fixture.passwords.get(username)
  if (password === undefined) throw new Error(`fixture has no password for ${username}`)
  return login(fixture.base, username, password)
}

interface RpcResult {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: { readonly code: string }
}

async function rpc(base: string, cookie: string, method: string, payload: unknown): Promise<RpcResult> {
  const response = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: 'test', method, payload: { args: payload } }),
  })
  const envelope = await response.json() as { result: RpcResult }
  return envelope.result
}

async function createWorkspace(base: string, cookie: string, title: string): Promise<string> {
  const result = await rpc(base, cookie, 'workspace/create', { request: { title } })
  expect(result.ok).toBe(true)
  const value = result.value as { workspace: { workspaceId: string } }
  return value.workspace.workspaceId
}

/** A trusted in-process Peer carrying one authenticated account. */
function userPeer(ctx: Context, userId: string): PeerScope {
  return ctx.connection.createPeer({ principal: { kind: 'user', userId: userId as never } })
}

async function followWorkspaces(ctx: Context, peer: PeerScope): Promise<Array<{ workspaceId: string; sessionIds: string[] }>> {
  const abort = new AbortController()
  const stream = await ctx.typertGateway.stream({
    peer, namespace: 'workspace', method: 'follow', args: {}, signal: abort.signal,
  })
  const iterator = stream[Symbol.asyncIterator]()
  const first = await iterator.next()
  abort.abort()
  await iterator.return?.()
  const frame = first.value as { type: string; value: { items: Array<{ workspaceId: string; sessionIds: string[] }> } }
  expect(frame.type).toBe('baseline')
  return frame.value.items
}

async function followWorkspaceIds(ctx: Context, peer: PeerScope): Promise<string[]> {
  return (await followWorkspaces(ctx, peer)).map(item => item.workspaceId)
}

describe('multiuser authentication and ownership', () => {
  it('logs in two accounts, allocates separate workspaces, and rejects forged or cross-user access', async () => {
    const fixture = await setup()
    const alice = await loginFor(fixture, 'alice')
    const bob = await loginFor(fixture, 'bob')

    const aliceMe = await fetch(`${fixture.base}/auth/me`, { headers: { cookie: alice } })
    const bobMe = await fetch(`${fixture.base}/auth/me`, { headers: { cookie: bob } })
    const aliceUser = (await aliceMe.json() as { user: { userId: string; username: string } }).user
    const bobUser = (await bobMe.json() as { user: { userId: string; username: string } }).user
    expect(aliceUser.username).toBe('alice')
    expect(bobUser.username).toBe('bob')
    expect(aliceUser.userId).not.toBe(bobUser.userId)

    const aliceWorkspace = await createWorkspace(fixture.base, alice, 'Alice workspace')
    const bobWorkspace = await createWorkspace(fixture.base, bob, 'Bob workspace')
    expect(aliceWorkspace).not.toBe(bobWorkspace)

    const aliceIds = await followWorkspaceIds(fixture.ctx, userPeer(fixture.ctx, aliceUser.userId))
    const bobIds = await followWorkspaceIds(fixture.ctx, userPeer(fixture.ctx, bobUser.userId))
    expect(aliceIds).toEqual([aliceWorkspace])
    expect(bobIds).toEqual([bobWorkspace])

    const rename = await rpc(fixture.base, alice, 'workspace/rename', {
      request: { workspaceId: bobWorkspace, title: 'stolen' },
    })
    expect(rename.ok).toBe(false)
    expect(rename.error?.code).toBe('remote-access/denied')

    await expect(fixture.ctx.typertGateway.invoke({
      peer: userPeer(fixture.ctx, aliceUser.userId),
      namespace: 'workspace',
      method: 'insertBefore',
      args: { request: { workspaceId: aliceWorkspace, beforeWorkspaceId: bobWorkspace } },
    })).rejects.toMatchObject({ code: 'remote-access/denied' })

    const pathCreate = await rpc(fixture.base, alice, 'workspace/create', { request: { path: '/tmp' } })
    expect(pathCreate.ok).toBe(false)

    const forged = await rpc(fixture.base, alice, 'workspace/create', {
      request: {
        title: 'forged', userId: bobUser.userId, principal: { kind: 'user', userId: bobUser.userId },
      },
    })
    const forgedWorkspace = (forged.value as { workspace: { workspaceId: string } }).workspace.workspaceId
    const afterForged = await followWorkspaceIds(fixture.ctx, userPeer(fixture.ctx, bobUser.userId))
    expect(afterForged).toEqual([bobWorkspace])
    const aliceAfterForged = await followWorkspaceIds(fixture.ctx, userPeer(fixture.ctx, aliceUser.userId))
    expect(aliceAfterForged).toContain(forgedWorkspace)
    expect(await rpc(fixture.base, alice, 'workspace/rename', {
      request: { workspaceId: aliceWorkspace, title: 'Alice renamed' },
    })).toMatchObject({ ok: true })
  })

  it('issues cookies that are HttpOnly and rejects logout replay without touching another login', async () => {
    const fixture = await setup()
    const loginResponse = await fetch(`${fixture.base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: fixture.base },
      body: JSON.stringify({ username: 'alice', password: fixture.passwords.get('alice') }),
    })
    const setCookie = loginResponse.headers.getSetCookie()[0] ?? ''
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
    expect(setCookie).toContain('Path=/')
    expect(loginResponse.headers.get('cache-control')).toBe('no-store')
    const first = setCookie.split(';', 1)[0]!
    const second = await loginFor(fixture, 'alice')

    expect(await fetch(`${fixture.base}/auth/me`, { headers: { cookie: first } })).toMatchObject({ status: 200 })
    expect(await fetch(`${fixture.base}/auth/logout`, {
      method: 'POST', headers: { cookie: first, origin: fixture.base },
    })).toMatchObject({ status: 204 })
    expect(await fetch(`${fixture.base}/auth/me`, { headers: { cookie: first } })).toMatchObject({ status: 401 })
    expect(await fetch(`${fixture.base}/auth/logout`, {
      method: 'POST', headers: { cookie: first, origin: fixture.base },
    })).toMatchObject({ status: 204 })
    expect(await fetch(`${fixture.base}/auth/me`, { headers: { cookie: second } })).toMatchObject({ status: 200 })
  })

  it('rejects unknown users, wrong passwords, empty bodies, oversized bodies, cross-origin writes, and forged cookies', async () => {
    const fixture = await setup()
    const cases = [
      { username: 'nobody', password: 'whatever' },
      { username: 'alice', password: 'wrong' },
      { username: '', password: '' },
    ]
    for (const body of cases) {
      const response = await fetch(`${fixture.base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: fixture.base },
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(401)
    }
    const oversized = await fetch(`${fixture.base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: fixture.base },
      body: JSON.stringify({ username: 'alice', password: 'x'.repeat(20_000) }),
    })
    expect(oversized.status).toBe(413)
    const crossOrigin = await fetch(`${fixture.base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ username: 'alice', password: fixture.passwords.get('alice') }),
    })
    expect(crossOrigin.status).toBe(403)
    expect(fixture.ctx.connection.authenticatedUrl(fixture.base)).toBe(fixture.base)
    expect(await fetch(`${fixture.base}/connect?token=legacy`)).toMatchObject({ status: 404 })
    expect(await fetch(`${fixture.base}/auth/me`, {
      headers: { cookie: 'dsh-login=forged' },
    })).toMatchObject({ status: 401 })
    expect(await fetch(`${fixture.base}/auth/me`, {
      headers: { cookie: 'dsh-login=' + 'a'.repeat(43) },
    })).toMatchObject({ status: 401 })
  })

  it('keeps sessions inside their owning workspace and rejects cross-user prompt calls before dispatch', async () => {
    const fixture = await setup()
    const alice = await loginFor(fixture, 'alice')
    const bob = await loginFor(fixture, 'bob')
    const aliceWorkspace = await createWorkspace(fixture.base, alice, 'Alice workspace')
    const bobWorkspace = await createWorkspace(fixture.base, bob, 'Bob workspace')
    const aliceUser = (await (await fetch(`${fixture.base}/auth/me`, { headers: { cookie: alice } })).json() as { user: { userId: string } }).user
    const bobUser = (await (await fetch(`${fixture.base}/auth/me`, { headers: { cookie: bob } })).json() as { user: { userId: string } }).user

    const aliceEntity = fixture.ctx.workspaceRegistry.get(aliceWorkspace as never)
    const bobEntity = fixture.ctx.workspaceRegistry.get(bobWorkspace as never)
    if (aliceEntity === undefined || bobEntity === undefined) throw new Error('workspace missing')
    const aliceSession = 'session-alice-1'
    const bobSession = 'session-bob-1'
    fixture.listed.push({ header: header(aliceSession, aliceEntity.path), revision: SessionPersistenceRevision('a1') })
    fixture.listed.push({ header: header(bobSession, bobEntity.path), revision: SessionPersistenceRevision('b1') })
    await aliceEntity.attachSession(SessionId(aliceSession))
    await bobEntity.attachSession(SessionId(bobSession))

    const alicePeer = userPeer(fixture.ctx, aliceUser.userId)
    const bobPeer = userPeer(fixture.ctx, bobUser.userId)
    expect(await followWorkspaces(fixture.ctx, alicePeer)).toMatchObject([
      { workspaceId: aliceWorkspace, sessionIds: [aliceSession] },
    ])
    expect(await followWorkspaces(fixture.ctx, bobPeer)).toMatchObject([
      { workspaceId: bobWorkspace, sessionIds: [bobSession] },
    ])
    expect(fixture.ctx.remoteAccess.decide({
      principal: alicePeer.principal,
      action: 'session/create',
      resources: [
        { kind: 'workspace', id: aliceEntity.id },
        { kind: 'session', id: SessionId(aliceSession) },
      ],
    })).toMatchObject({ kind: 'allow' })
    expect(fixture.ctx.remoteAccess.decide({
      principal: bobPeer.principal,
      action: 'session/create',
      resources: [
        { kind: 'workspace', id: bobEntity.id },
        { kind: 'session', id: SessionId(aliceSession) },
      ],
    })).toMatchObject({ kind: 'deny' })
    const probe = fixture.ctx.sessionProbe
    await expect(fixture.ctx.typertGateway.invoke({
      peer: alicePeer, namespace: 'session', method: 'prompt', args: { request: { sessionId: aliceSession } },
    })).resolves.toEqual({ accepted: true })
    expect(probe.prompts).toEqual([aliceSession])
    await expect(fixture.ctx.typertGateway.invoke({
      peer: bobPeer, namespace: 'session', method: 'prompt', args: { request: { sessionId: aliceSession } },
    })).rejects.toMatchObject({ code: 'remote-access/denied' })
    expect(probe.prompts).toEqual([aliceSession])
    await expect(fixture.ctx.typertGateway.invoke({
      peer: bobPeer, namespace: 'session', method: 'prompt', args: { request: { sessionId: bobSession } },
    })).resolves.toEqual({ accepted: true })
    expect(fixture.ctx.remoteAccess.decide({
      principal: { kind: 'user', userId: aliceUser.userId as never },
      action: 'event:api-session/added',
      resources: [{ kind: 'session', id: bobSession as never }],
    })).toMatchObject({ kind: 'deny' })
    expect(fixture.ctx.remoteAccess.decide({
      principal: { kind: 'user', userId: aliceUser.userId as never },
      action: 'event:api-session/added',
      resources: [{ kind: 'session', id: aliceSession as never }],
    })).toEqual({ kind: 'allow' })
  })

  it('rate-limits repeated password guesses', async () => {
    const fixture = await setup({ loginAttemptLimit: 2 })
    const statuses: number[] = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(`${fixture.base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: fixture.base },
        body: JSON.stringify({ username: 'rate-limit-target', password: 'wrong' }),
      })
      statuses.push(response.status)
    }
    expect(statuses.at(-1)).toBe(429)
    const rotated = await fetch(`${fixture.base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: fixture.base },
      body: JSON.stringify({ username: 'another-name', password: 'wrong' }),
    })
    expect(rotated.status).toBe(429)
  })

  it('persists accounts, ownership, and valid logins across a restart; revoked logins never return', async () => {
    const fixture = await setup()
    const alice = await loginFor(fixture, 'alice')
    const bob = await loginFor(fixture, 'bob')
    const aliceWorkspace = await createWorkspace(fixture.base, alice, 'Alice workspace')
    const bobWorkspace = await createWorkspace(fixture.base, bob, 'Bob workspace')
    const revoked = await loginFor(fixture, 'alice')
    await fetch(`${fixture.base}/auth/logout`, { method: 'POST', headers: { cookie: revoked, origin: fixture.base } })

    await fixture.ctx.fiber.dispose()
    const reopened = await setup({ storageRoot: fixture.home, workspaceRoot: fixture.workspaceRoot, provision: false })
    expect(await fetch(`${reopened.base}/auth/me`, { headers: { cookie: alice } })).toMatchObject({ status: 200 })
    expect(await fetch(`${reopened.base}/auth/me`, { headers: { cookie: revoked } })).toMatchObject({ status: 401 })
    const repos = await rpc(reopened.base, bob, 'workspace/rename', {
      request: { workspaceId: bobWorkspace, title: 'Bob after restart' },
    })
    expect(repos.ok).toBe(true)
    expect(await rpc(reopened.base, bob, 'workspace/rename', {
      request: { workspaceId: aliceWorkspace, title: 'x' },
    })).toMatchObject({
      ok: false, error: { code: 'remote-access/denied' },
    })
  })
})

describe('login Peer lifetime', () => {
  it('ends an open access-filtered stream when its login is revoked', async () => {
    const fixture = await setup()
    const cookie = await loginFor(fixture, 'alice')
    const admission = fixture.ctx.multiuser.admit({ headers: { cookie } }, false)
    if (!('peer' in admission)) throw new Error('login did not admit a Peer')
    const abort = new AbortController()
    const stream = await fixture.ctx.typertGateway.stream({
      peer: admission.peer, namespace: 'workspace', method: 'follow', args: {}, signal: abort.signal,
    })
    const iterator = stream[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { type: 'baseline' } })
    const token = cookie.slice(cookie.indexOf('=') + 1)
    await expect(fixture.ctx.multiuser.logout(token)).resolves.toBe(true)
    await expect(iterator.next()).rejects.toMatchObject({ code: 'gateway/cancelled' })
    expect(fixture.ctx.multiuser.admit({ headers: { cookie } }, false)).toEqual({ rejection: 401 })
  })
})


describe('login expiry and account disable', () => {
  it('refuses an expired login and removes the Peer on account disable', async () => {
    const fixture = await setup()
    const cookie = await loginFor(fixture, 'alice')
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-09T00:00:00.000Z'))
    expect(await fetch(`${fixture.base}/auth/me`, { headers: { cookie } })).toMatchObject({ status: 401 })
    vi.useRealTimers()

    const second = await loginFor(fixture, 'alice')
    const admission = fixture.ctx.multiuser.admit({ headers: { cookie: second } }, false)
    if (!('peer' in admission)) throw new Error('login did not admit a Peer')
    const abort = new AbortController()
    const stream = await fixture.ctx.typertGateway.stream({
      peer: admission.peer, namespace: 'workspace', method: 'follow', args: {}, signal: abort.signal,
    })
    const iterator = stream[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ done: false })
    const user = (await (await fetch(`${fixture.base}/auth/me`, { headers: { cookie: second } })).json() as { user: { userId: string } }).user
    await expect(fixture.ctx.multiuser.disableUser(user.userId as never)).resolves.toBe(true)
    await expect(iterator.next()).rejects.toMatchObject({ code: 'gateway/cancelled' })
    expect(await fetch(`${fixture.base}/auth/me`, { headers: { cookie: second } })).toMatchObject({ status: 401 })
    const relogin = await fetch(`${fixture.base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: fixture.base },
      body: JSON.stringify({ username: 'alice', password: fixture.passwords.get('alice') }),
    })
    expect(relogin.status).toBe(401)
  })
})


describe('unowned resources and exact routes', () => {
  it('keeps an ownership-less workspace invisible and refuses exact Fetch routes to users', async () => {
    const fixture = await setup()
    const alice = await loginFor(fixture, 'alice')
    const aliceUser = (await (await fetch(`${fixture.base}/auth/me`, { headers: { cookie: alice } })).json() as { user: { userId: string } }).user
    const orphanPath = join(fixture.workspaceRoot, 'orphan')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(orphanPath, { recursive: true })
    const orphan = await fixture.ctx.workspaceRegistry.create(orphanPath, 'Orphan')
    expect(await followWorkspaceIds(fixture.ctx, userPeer(fixture.ctx, aliceUser.userId))).toEqual([])
    expect(orphan.id).toBeDefined()

    fixture.ctx.connection.fetch.register({
      path: '/api/internal-export',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => new Response('owner-only', { status: 200 }),
    })
    const owner = fixture.ctx.connection.createPeer({ principal: { kind: 'owner' } })
    const user = userPeer(fixture.ctx, aliceUser.userId)
    const handler = fixture.ctx.connection.createSharedFetchHandler('/api')
    const request = new Request('http://127.0.0.1/api/internal-export')
    await expect(handler.fetch(request, owner)).resolves.toMatchObject({ status: 200 })
    await expect(handler.fetch(request, user)).resolves.toMatchObject({ status: 403 })
  })
})

describe('concurrent authentication and resource lifecycle', () => {
  it('reserves the attempt limit before concurrent password computations', async () => {
    const fixture = await setup({ loginAttemptLimit: 2 })
    const outcomes = await Promise.all(Array.from({ length: 8 }, () =>
      fixture.ctx.multiuser.login('alice', 'incorrect', 'concurrent-client')))
    expect(outcomes.filter(value => !value.ok && value.reason === 'rate-limited')).toHaveLength(6)
    expect(outcomes.filter(value => !value.ok && value.reason === 'invalid')).toHaveLength(2)
  })

  it('serializes duplicate account provisioning and preserves the original password', async () => {
    const fixture = await setup()
    const results = await Promise.allSettled([
      fixture.ctx.multiuser.provisionUser('charlie', 'first-password'),
      fixture.ctx.multiuser.provisionUser('CHARLIE', 'second-password'),
    ])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(await fixture.ctx.multiuser.login('charlie', 'first-password', 'provision-test')).toMatchObject({ ok: true })
    expect(await fixture.ctx.multiuser.login('charlie', 'second-password', 'provision-test')).toMatchObject({ ok: false })
  })

  it('expires the active Peer at its deadline without waiting for a request or sweep', async () => {
    const fixture = await setup()
    const cookie = await loginFor(fixture, 'alice')
    vi.useFakeTimers()
    const admission = fixture.ctx.multiuser.admit({ headers: { cookie } }, false)
    if (!('peer' in admission)) throw new Error('missing Peer')
    expect(admission.peer.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60 * 1000)
    expect(admission.peer.signal.aborted).toBe(true)
    expect(fixture.ctx.multiuser.admit({ headers: { cookie } }, false)).toEqual({ rejection: 401 })
  })

  it('denies deleted workspaces even before their ownership row is cleaned up', async () => {
    const fixture = await setup()
    const cookie = await loginFor(fixture, 'alice')
    const workspaceId = await createWorkspace(fixture.base, cookie, 'Temporary')
    const authenticated = fixture.ctx.multiuser.authenticateToken(cookie.split('=')[1])!
    await fixture.ctx.workspaceRegistry.delete(workspaceId as never)
    expect(fixture.ctx.multiuser.ownsWorkspace(authenticated.user.userId, workspaceId as never)).toBe(false)
  })

  it('removes routes, Peers, and admission when the multiuser plugin unloads', async () => {
    const fixture = await setup()
    const cookie = await loginFor(fixture, 'alice')
    const admission = fixture.ctx.multiuser.admit({ headers: { cookie } }, false)
    if (!('peer' in admission)) throw new Error('missing Peer')
    await fixture.disposeMultiuser()
    expect(admission.peer.signal.aborted).toBe(true)
    expect(fixture.ctx.connection.admit({ headers: { host: new URL(fixture.base).host, cookie } })).toEqual({ rejection: 401 })
    expect(await fetch(`${fixture.base}/auth/me`, { headers: { cookie } })).toMatchObject({ status: 404 })
  })
})
