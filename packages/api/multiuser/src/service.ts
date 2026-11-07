/** Account login, login-session lifecycle, workspace ownership, and connection admission. */

import { randomUUID } from 'node:crypto'
import { mkdir, rmdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Peer, type ConnectionAdmissionProvider, type ConnectionIndexAdmission, type PeerAdmission } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type { UserId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { WorkspaceId, workspaceRecord, type Workspace } from '@deepseek-ai/dsh-workspace'
import { MULTIUSER_CLIENT_SCRIPT, MULTIUSER_CLIENT_STYLE } from './client-script.ts'
import { hashPassword, newLoginToken, tokenDigest, verifyPassword } from './password.ts'
import { MultiuserPolicy, type MultiuserAccessIndex } from './policy.ts'
import { multiuserDomainSpec, type LoginSessionRecord, type UserRecord, type WorkspaceOwnerRecord } from './spec.ts'
import type { LoginValue, MultiuserUser } from './types.ts'

/** Login and workspace policy deployment values. */
export interface Config {
  /** Absolute root under which accounts' workspaces are allocated. */
  readonly workspaceRoot: string
  /** Absolute login lifetime in days. @default 7 */
  readonly loginMaxAgeDays?: number
  /** Login attempts allowed per address and window. @default 10 */
  readonly loginAttemptLimit?: number
  /** Fixed attempt window in milliseconds. @default 60000 */
  readonly loginAttemptWindowMs?: number
  /** How often expired login records are revoked, in milliseconds. @default 30000 */
  readonly sessionSweepIntervalMs?: number
}

/** Validated deployment values used by the service. */
export interface ResolvedConfig extends Config {
  readonly loginMaxAgeDays: number
  readonly loginAttemptLimit: number
  readonly loginAttemptWindowMs: number
  readonly sessionSweepIntervalMs: number
}

/** Stable Cordis plugin name. */
export const name = 'api-multiuser'

/** Browser cookie carrying the opaque login token. */
const COOKIE_NAME = 'dsh-login'
const MAX_BODY_BYTES = 16 * 1024
const MAX_USERNAME_LENGTH = 64
const MAX_PASSWORD_LENGTH = 1024
const MAX_TITLE_LENGTH = 200
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000
const EMPTY_COOKIE = `${COOKIE_NAME}=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax`
/** Request headers accepted by Connection's admission and index contracts. */
type AdmissionHeaders = Headers | Readonly<Record<string, string | readonly string[] | undefined>>

/** Result of one login attempt. */
export type LoginOutcome =
  | { readonly ok: true; readonly token: string; readonly expiresAt: number; readonly user: MultiuserUser }
  | { readonly ok: false; readonly reason: 'invalid' | 'disabled' | 'rate-limited'; readonly retryAfterMs?: number }

/** One issued login before it is written to storage. */
interface IssuedLogin {
  readonly token: string
  readonly record: LoginSessionRecord
  readonly expiresAt: number
}

/** Test-visible wire facts of one successful login. */
export interface AuthenticatedLogin {
  readonly user: MultiuserUser
  readonly record: LoginSessionRecord
}

/** Validates all multiuser deployment values before initialization. */
export const CONFIG_SCHEMA = z.object({
  workspaceRoot: z.string().required(),
  loginMaxAgeDays: z.natural().min(1).default(7),
  loginAttemptLimit: z.natural().min(1).default(10),
  loginAttemptWindowMs: z.natural().min(1).default(60_000),
  sessionSweepIntervalMs: z.natural().min(1).default(30_000),
})

export { CONFIG_SCHEMA as Config }

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Multiuser accounts, login sessions, workspace ownership, and Remote access policy. */
    multiuser: MultiuserService
  }
}

/** Account and ownership service installed by the multiuser composition. */
export class MultiuserService extends Service implements ConnectionAdmissionProvider, MultiuserAccessIndex {
  static inject = ['connection', 'remoteAccess', 'storageDomain', 'webServer', 'workspaceRegistry']

  /** Absolute root used to allocate account workspaces. */
  get workspaceRoot(): string { return this.config.workspaceRoot }

  private readonly config: ResolvedConfig
  private usersTable!: KvTable<string, UserRecord>
  private loginsTable!: KvTable<string, LoginSessionRecord>
  private ownersTable!: KvTable<string, WorkspaceOwnerRecord>
  private domain!: Domain<typeof multiuserDomainSpec>
  private dummyDigest!: UserRecord['password']
  private readonly users = new Map<string, UserRecord>()
  private readonly usernameIds = new Map<string, string>()
  private readonly logins = new Map<string, LoginSessionRecord>()
  private readonly loginIdsByToken = new Map<string, string>()
  private readonly peers = new Map<string, Peer>()
  private readonly attempts = new Map<string, { count: number; resetAt: number }>()
  private readonly ownersByWorkspace = new Map<string, string>()
  private readonly workspacesByUser = new Map<string, Set<string>>()
  private workspaceBySession = new Map<string, string>()
  private operationTail: Promise<unknown> = Promise.resolve()
  private readonly isolatedTools = new Set<{ definition: ToolDefinition; authorize: (execution: Readonly<ToolExecution>) => boolean }>()

  /**
   * @param ctx - Host context carrying Connection, access control, storage, and the workspace registry.
   * @param config - workspace root and login policy.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'multiuser')
    this.config = CONFIG_SCHEMA(config)
    if (!isAbsolute(this.config.workspaceRoot)) {
      throw new Error(`multiuser: workspaceRoot must be absolute, got ${JSON.stringify(this.config.workspaceRoot)}`)
    }
  }

  protected async [Service.init](): Promise<void> {
    await mkdir(resolve(this.config.workspaceRoot), { recursive: true, mode: 0o700 })
    this.domain = await this.ctx.storageDomain.open(multiuserDomainSpec)
    this.ctx.effect(() => () => this.domain.close(), 'multiuser: domain')
    this.usersTable = this.domain.table('users')
    this.loginsTable = this.domain.table('login_sessions')
    this.ownersTable = this.domain.table('workspace_owners')
    for (const [, user] of this.usersTable.entries()) this.indexUser(user)
    for (const [, login] of this.loginsTable.entries()) this.indexLogin(login)
    this.refreshOwners()
    this.rebuildSessionIndex()
    this.dummyDigest = await hashPassword(randomUUID())

    this.ctx.remoteAccess.registerPolicy('user', new MultiuserPolicy(this))
    this.ctx.connection.installAdmissionProvider(this)
    this.ctx.effect(() => () => {
      const peers = [...this.peers.values()]
      this.peers.clear()
      return Promise.all(peers.map(peer => peer.dispose())).then(() => undefined)
    }, 'multiuser: login peers')
    this.ctx.effect(() => {
      const timer = setInterval(() => { void this.sweep() }, this.config.sessionSweepIntervalMs)
      timer.unref()
      return () => { clearInterval(timer) }
    }, 'multiuser: login expiry sweep')
    this.ctx.on('domain/changed', (change) => {
      if (change.domain !== 'workspace') return
      // The entity snapshot swaps after the domain resolves its write, so this
      // event's committed value is the authoritative membership fact.
      if (change.table === 'workspaces') {
        for (const [sessionId, workspaceId] of this.workspaceBySession) {
          if (workspaceId === change.key) this.workspaceBySession.delete(sessionId)
        }
        if (change.operation === 'put') {
          const record = workspaceRecord.parse(change.value)
          const ids = [...record.sessionIds,
            ...record.firstSessionId === null ? [] : [record.firstSessionId],
            ...record.modeIntent?.operation === 'create-session' ? [record.modeIntent.sessionId] : [],
          ]
          for (const sessionId of ids) this.workspaceBySession.set(String(sessionId), change.key)
        }
      }
      this.ctx.remoteAccess.invalidate()
    })
    this.ctx.on('webserver/index-inject', (table, peer) => {
      const user = this.userOfPeer(peer)
      table.push({
        kind: 'global',
        name: '__DSH_MULTIUSER__',
        value: {
          refreshIntervalMs: this.config.sessionSweepIntervalMs,
          authenticated: user !== undefined,
          ...(user === undefined ? {} : { user }),
        },
      })
      table.push({ kind: 'script-src', placement: 'head', src: 'auth/client.js' })
      table.push({ kind: 'style', text: MULTIUSER_CLIENT_STYLE })
    })
    this.ctx.inject(['tools'], (ctx) => {
      ctx.tools.guard((execution) => {
        if (execution.toolSet !== undefined && execution.parent === undefined) {
          const definition = ctx.tools.get(execution.name, execution.agent, execution.toolSet)
          for (const entry of this.isolatedTools) {
            if (entry.definition === definition && entry.authorize(execution)) return undefined
          }
        }
        return 'Tool execution is unavailable in this multiuser deployment.'
      })
    })
    this.registerRoutes()
  }

  /**
   * Register an isolated implementation's exception to the default execution denial.
   * Only the exact live definition in an admitted step may use it; nested dispatch stays denied.
   * @param definition - Tool whose provider owns isolation and validates the original initiator.
   * @param authorize - Synchronous per-call permission check; false retains the default denial.
   * @returns Caller-owned disposer removing this exception, also invoked on plugin unload.
   */
  registerIsolatedTool(definition: ToolDefinition, authorize: (execution: Readonly<ToolExecution>) => boolean): () => void {
    const entry = { definition, authorize }
    const dispose = this.ctx.effect(() => {
      this.isolatedTools.add(entry)
      return () => { this.isolatedTools.delete(entry) }
    }, 'multiuser.registerIsolatedTool()')
    return () => { void dispose() }
  }

  // ── Account provisioning ────────────────────────────────────────────────

  /**
   * Create one account through an explicit provisioning step. Existing names
   * are never overwritten and passwords are never reset implicitly.
   * @param username - display name users type at login.
   * @param password - plaintext to hash once; never stored.
   * @returns the public account.
   * @throws Error when the name is invalid or already provisioned.
   */
  provisionUser(username: string, password: string): Promise<MultiuserUser> {
    return this.enqueue(() => this.provisionUserNow(username, password))
  }

  private async provisionUserNow(username: string, password: string): Promise<MultiuserUser> {
    const normalized = normalizeUsername(username)
    if (normalized === undefined) throw new Error('multiuser: username must match [a-z0-9][a-z0-9._-]{0,63}')
    if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
      throw new Error(`multiuser: password must be 1-${String(MAX_PASSWORD_LENGTH)} characters`)
    }
    if (this.usernameIds.has(normalized)) throw new Error(`multiuser: account ${JSON.stringify(normalized)} already exists`)
    const user: UserRecord = {
      id: `user-${randomUUID()}`,
      username: username.trim(),
      usernameNormalized: normalized,
      password: await hashPassword(password),
      createdAt: new Date().toISOString(),
    }
    await this.usersTable.put(user.id, user)
    this.indexUser(user)
    return publicUser(user)
  }

  /**
   * Disable one account and revoke every login it still holds.
   * @param userId - account identity.
   * @returns whether the account existed.
   */
  disableUser(userId: UserId): Promise<boolean> {
    return this.enqueue(() => this.disableUserNow(userId))
  }

  private async disableUserNow(userId: UserId): Promise<boolean> {
    const user = this.users.get(String(userId))
    if (user === undefined) return false
    if (user.disabledAt !== undefined) return true
    const next: UserRecord = { ...user, disabledAt: new Date().toISOString() }
    await this.usersTable.put(next.id, next)
    this.users.set(next.id, next)
    for (const login of [...this.logins.values()]) {
      if (login.userId === next.id) await this.revokeRecord(login)
    }
    this.ctx.remoteAccess.invalidate({ kind: 'user', userId: brandString<UserId>(next.id) })
    return true
  }

  // ── Login lifecycle ─────────────────────────────────────────────────────

  /**
   * Validate one account password and issue a persistent login.
   * @param username - submitted account name.
   * @param password - submitted password.
   * @param rateKey - caller identity used for the attempt window.
   * @returns a token on success, or a stable failure reason.
   */
  async login(username: string, password: string, rateKey: string): Promise<LoginOutcome> {
    const now = Date.now()
    const limit = this.attempts.get(rateKey)
    if (limit !== undefined && limit.resetAt > now && limit.count >= this.config.loginAttemptLimit) {
      return { ok: false, reason: 'rate-limited', retryAfterMs: limit.resetAt - now }
    }
    // Reserve before password derivation so simultaneous guesses share the limit.
    this.recordAttempt(rateKey, now)
    const normalized = normalizeUsername(username)
    const user = normalized === undefined ? undefined : this.users.get(this.usernameIds.get(normalized) ?? '')
    const valid = await verifyPassword(password, user?.password ?? this.dummyDigest)
    if (user === undefined || !valid) {
      return { ok: false, reason: 'invalid' }
    }
    if (user.disabledAt !== undefined) {
      return { ok: false, reason: 'disabled' }
    }
    return this.enqueue(async () => {
      const current = this.users.get(user.id)
      if (current === undefined || current.disabledAt !== undefined) return { ok: false, reason: 'disabled' }
      const issued = await this.issueLogin(current, Date.now())
      return { ok: true, token: issued.token, expiresAt: issued.expiresAt, user: publicUser(current) }
    })
  }

  /**
   * Revoke the login named by a token. Repeating the call is harmless and
   * never affects another login.
   * @param token - browser token from the request cookie.
   * @returns whether a live login was revoked.
   */
  async logout(token: string | undefined): Promise<boolean> {
    const login = token === undefined ? undefined : this.loginForToken(token)
    if (login === undefined) return false
    await this.revokeRecord(login)
    return true
  }

  /**
   * Read the account and login behind a token without changing state.
   * @param token - browser token from the request cookie.
   * @returns the live login, or undefined when the token is unknown, expired, revoked, or disabled.
   */
  authenticateToken(token: string | undefined): AuthenticatedLogin | undefined {
    const login = token === undefined ? undefined : this.loginForToken(token)
    if (login === undefined) return undefined
    const user = this.users.get(login.userId)
    if (user === undefined || user.disabledAt !== undefined) {
      this.expireLogin(login)
      return undefined
    }
    return { user: publicUser(user), record: login }
  }

  // ── ConnectionAdmissionProvider ─────────────────────────────────────────

  /**
   * Admit only a live login and reuse its connection scope.
   * @param request - request headers after the trust fence.
   * @param _secure - listener TLS state; credentials have the same validity on both carriers.
   * @returns the authenticated Peer or a 401 refusal.
   */
  admit(request: { readonly headers: AdmissionHeaders }, _secure: boolean): PeerAdmission {
    const token = cookieValue(request.headers, COOKIE_NAME)
    const authenticated = this.authenticateToken(token)
    if (authenticated === undefined) return { rejection: 401 as const }
    return { peer: this.peerFor(authenticated.record) }
  }

  /**
   * Render an authenticated page or redirect to the public login document.
   * @param request - index request headers after the trust fence.
   * @param _secure - listener TLS state.
   * @returns the authenticated Peer or a document-relative login-page redirect.
   */
  admitIndex(request: { readonly headers: AdmissionHeaders }, _secure: boolean): ConnectionIndexAdmission {
    const authenticated = this.authenticateToken(cookieValue(request.headers, COOKIE_NAME))
    return authenticated === undefined
      ? { serve: false, redirect: 'auth/sign-in' }
      : { serve: true, peer: this.peerFor(authenticated.record) }
  }

  // ── MultiuserAccessIndex ────────────────────────────────────────────────

  /**
   * Check live account ownership of a registered workspace.
   * @param userId - account identity.
   * @param workspaceId - workspace identity.
   * @returns false for deleted workspaces, disabled accounts, or absent ownership.
   */
  ownsWorkspace(userId: UserId, workspaceId: WorkspaceId): boolean {
    return this.ctx.workspaceRegistry.get(workspaceId) !== undefined
      && this.users.get(String(userId))?.disabledAt === undefined
      && this.users.has(String(userId))
      && this.ownersByWorkspace.get(String(workspaceId)) === String(userId)
  }

  /**
   * Check access through the session's authoritative workspace membership.
   * @param userId - account identity.
   * @param sessionId - session identity.
   * @returns whether the account owns the session's live workspace.
   */
  ownsSession(userId: UserId, sessionId: SessionId): boolean {
    const workspace = this.ctx.workspaceRegistry.findSession(sessionId)
    return workspace !== undefined && this.ownsWorkspace(userId, workspace.id)
  }

  /**
   * Enumerate ownership bindings for one account.
   * @param userId - account identity.
   * @returns workspace identities whose conditions are rechecked by the policy.
   */
  ownedWorkspaces(userId: UserId): readonly WorkspaceId[] {
    return [...this.workspacesByUser.get(String(userId)) ?? []].map(WorkspaceId)
  }

  /**
   * Enumerate sessions in the account's owned workspaces.
   * @param userId - account identity.
   * @returns current session identities from committed workspace membership.
   */
  ownedSessions(userId: UserId): readonly SessionId[] {
    const sessions: SessionId[] = []
    for (const [sessionId, workspaceId] of this.workspaceBySession) {
      if (this.ownsWorkspace(userId, WorkspaceId(workspaceId))) sessions.push(brandString<SessionId>(sessionId))
    }
    return sessions
  }

  // ── Workspace ownership ─────────────────────────────────────────────────

  /**
   * Allocate a private directory and register one workspace owned by `userId`.
   * The ownership row commits before the workspace becomes accessible. If it
   * fails, the registration is withdrawn and the new empty directory removed.
   * @param userId - authenticated account identity.
   * @param title - optional display title.
   * @returns the committed workspace.
   */
  createUserWorkspace(userId: UserId, title?: string): Promise<Workspace> {
    return this.enqueue(() => this.createUserWorkspaceNow(userId, title))
  }

  /**
   * Drop ownership when its workspace registration is deleted.
   * @param workspaceId - deleted workspace identity.
   * @returns resolution after the owner row is gone.
   */
  async forgetWorkspace(workspaceId: WorkspaceId): Promise<void> {
    if (this.ownersByWorkspace.has(String(workspaceId))) {
      await this.ownersTable.delete(String(workspaceId))
      this.ownersByWorkspace.delete(String(workspaceId))
      for (const [owner, workspaces] of this.workspacesByUser) {
        workspaces.delete(String(workspaceId))
        if (workspaces.size === 0) this.workspacesByUser.delete(owner)
      }
      this.rebuildSessionIndex()
      this.ctx.remoteAccess.invalidate()
    }
  }

  /**
   * Read a workspace's stored owner identity.
   * @param workspaceId - workspace identity.
   * @returns the owning account id, or undefined when no ownership row exists.
   */
  ownerOfWorkspace(workspaceId: WorkspaceId): string | undefined {
    return this.ownersByWorkspace.get(String(workspaceId))
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private async createUserWorkspaceNow(userId: UserId, title?: string): Promise<Workspace> {
    const user = this.users.get(String(userId))
    if (user === undefined || user.disabledAt !== undefined) throw new Error('multiuser: account unavailable')
    const root = resolve(this.config.workspaceRoot)
    await mkdir(root, { recursive: true, mode: 0o700 })
    const path = join(root, `ws-${randomUUID()}`)
    const workspaceTitle = normalizedTitle(title)
    await mkdir(path, { mode: 0o700 })
    let workspace: Workspace | undefined
    try {
      const existing = await this.ctx.workspaceRegistry.resolveByPath(path)
      if (existing !== undefined) throw new Error('multiuser: allocated workspace path is already registered')
      workspace = await this.ctx.workspaceRegistry.create(path, workspaceTitle)
      const record: WorkspaceOwnerRecord = {
        workspaceId: String(workspace.id),
        userId: String(userId),
        createdAt: new Date().toISOString(),
      }
      await this.ownersTable.put(record.workspaceId, record)
      this.indexOwner(record)
      this.rebuildSessionIndex()
      this.ctx.remoteAccess.invalidate({ kind: 'user', userId })
      return workspace
    } catch (error) {
      if (workspace !== undefined) {
        try { await this.ctx.workspaceRegistry.delete(workspace.id) } catch { /* registration cleanup is best effort */ }
      }
      try { await rmdir(path) } catch { /* a non-empty or already-absent directory is left untouched */ }
      throw error
    }
  }

  private async issueLogin(user: UserRecord, now: number): Promise<IssuedLogin> {
    const token = newLoginToken()
    const digest = tokenDigest(token)
    if (this.loginIdsByToken.has(digest)) throw new Error('multiuser: generated duplicate login token')
    const record: LoginSessionRecord = {
      id: `login-${randomUUID()}`,
      tokenHash: digest,
      userId: user.id,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.config.loginMaxAgeDays * DAY_MILLISECONDS).toISOString(),
    }
    await this.loginsTable.put(record.id, record)
    this.indexLogin(record)
    return { token, record, expiresAt: Date.parse(record.expiresAt) }
  }

  private loginForToken(token: string): LoginSessionRecord | undefined {
    const id = this.loginIdsByToken.get(tokenDigest(token))
    const login = id === undefined ? undefined : this.logins.get(id)
    if (login === undefined) return undefined
    if (login.revokedAt !== undefined || Date.parse(login.expiresAt) <= Date.now()) {
      this.expireLogin(login)
      return undefined
    }
    return login
  }

  private expireLogin(login: LoginSessionRecord): void {
    // Expiry and disabled accounts lose access even if the durable medium is unavailable.
    this.loginIdsByToken.delete(login.tokenHash)
    const peer = this.peers.get(login.id)
    this.peers.delete(login.id)
    if (peer !== undefined) void peer.dispose().catch((error: unknown) => {
      this.ctx.logger.error(`multiuser: expired Peer disposal failed: ${String(error)}`)
    })
    void this.revokeRecord(login).catch((error: unknown) => {
      this.ctx.logger.warn(`multiuser: expired login remains unusable; durable cleanup failed: ${String(error)}`)
    })
  }

  private async revokeRecord(login: LoginSessionRecord): Promise<void> {
    if (login.revokedAt === undefined) {
      const next: LoginSessionRecord = { ...login, revokedAt: new Date().toISOString() }
      try {
        await this.loginsTable.put(next.id, next)
      } catch (error) {
        this.ctx.logger.warn(`multiuser: failed to persist revocation of login ${login.id}: ${String(error)}`)
        throw error
      }
      this.logins.set(next.id, next)
    }
    this.loginIdsByToken.delete(login.tokenHash)
    const peer = this.peers.get(login.id)
    this.peers.delete(login.id)
    if (peer !== undefined) await peer.dispose()
  }

  private peerFor(login: LoginSessionRecord): PeerScope {
    const existing = this.peers.get(login.id)
    if (existing !== undefined) return existing
    const peer = new Peer(this.ctx, {
      principal: { kind: 'user', userId: brandString<UserId>(login.userId) },
      interactions: 'answer',
    })
    this.peers.set(login.id, peer)
    peer.ctx.effect(() => {
      let timer: ReturnType<typeof setTimeout>
      const expire = (): void => {
        const remaining = Date.parse(login.expiresAt) - Date.now()
        if (remaining <= 0) { this.expireLogin(login); return }
        timer = setTimeout(expire, Math.min(remaining, 2_147_483_647))
        timer.unref()
      }
      expire()
      return () => { clearTimeout(timer) }
    }, 'multiuser: login deadline')
    return peer
  }

  private async sweep(): Promise<void> {
    const now = Date.now()
    for (const login of [...this.logins.values()]) {
      if (login.revokedAt !== undefined) {
        if (!this.loginIdsByToken.has(login.tokenHash) && !this.peers.has(login.id)) continue
        await this.revokeRecord(login).catch((error: unknown) => {
          this.ctx.logger.warn(`multiuser: login sweep failed for ${login.id}: ${String(error)}`)
        })
        continue
      }
      if (Date.parse(login.expiresAt) > now) continue
      await this.revokeRecord(login).catch((error: unknown) => {
        this.ctx.logger.warn(`multiuser: login sweep failed for ${login.id}: ${String(error)}`)
      })
    }
    for (const [key, attempt] of this.attempts) {
      if (attempt.resetAt <= now) this.attempts.delete(key)
    }
  }

  private recordAttempt(rateKey: string, now: number): void {
    const current = this.attempts.get(rateKey)
    if (current === undefined || current.resetAt <= now) {
      this.attempts.set(rateKey, { count: 1, resetAt: now + this.config.loginAttemptWindowMs })
      return
    }
    current.count += 1
  }

  private indexUser(user: UserRecord): void {
    this.users.set(user.id, user)
    this.usernameIds.set(user.usernameNormalized, user.id)
  }

  private indexLogin(login: LoginSessionRecord): void {
    this.logins.set(login.id, login)
    if (login.revokedAt === undefined) this.loginIdsByToken.set(login.tokenHash, login.id)
  }

  private refreshOwners(): void {
    this.ownersByWorkspace.clear()
    this.workspacesByUser.clear()
    for (const [workspaceId, owner] of this.ownersTable.entries()) this.indexOwner(owner, workspaceId)
  }

  private indexOwner(record: WorkspaceOwnerRecord, key = record.workspaceId): void {
    this.ownersByWorkspace.set(key, record.userId)
    const owned = this.workspacesByUser.get(record.userId) ?? new Set<string>()
    owned.add(key)
    this.workspacesByUser.set(record.userId, owned)
  }

  private rebuildSessionIndex(): void {
    const next = new Map<string, string>()
    for (const workspace of this.ctx.workspaceRegistry.list()) {
      const record = workspace.modeConfig
      const ids = [...workspace.sessionIds, ...record.firstSessionId === null ? [] : [record.firstSessionId]]
      for (const sessionId of ids) next.set(String(sessionId), String(workspace.id))
    }
    this.workspaceBySession = next
  }

  private userOfPeer(peer: PeerScope): MultiuserUser | undefined {
    const principal = peer.principal
    if (principal.kind !== 'user') return undefined
    const user = this.users.get(String(principal.userId))
    return user === undefined || user.disabledAt !== undefined ? undefined : publicUser(user)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }

  private registerRoutes(): void {
    const connection = this.ctx.connection
    const route = (path: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void): void => {
      this.ctx.effect(() => this.ctx.webServer.register({ kind: 'exact', path, handler: async (req, res) => {
        if (!connection.isTrusted(req)) {
          sendJson(res, 403, { error: 'forbidden' })
          return
        }
        try {
          await handler(req, res)
        } catch (error) {
          this.ctx.logger.warn(`multiuser: ${path} failed: ${String(error)}`)
          if (!res.writableEnded) sendJson(res, 500, { error: 'internal' })
        }
      } }), `multiuser: ${path}`)
    }

    route('/auth/login', async (req, res) => {
      if (req.method !== 'POST') {
        methodNotAllowed(res, 'POST')
        return
      }
      if (!isJson(req)) {
        sendJson(res, 415, { error: 'content-type must be application/json' })
        return
      }
      const text = await readBoundedBody(req)
      if (text === null) {
        sendJson(res, 413, { error: 'body too large' })
        return
      }
      const parsed = parseLoginBody(text)
      if (parsed === undefined) {
        sendJson(res, 401, { error: 'invalid-credentials' })
        return
      }
      // One address-wide window: rotating account names cannot bypass the
      // expensive password derivation.
      const rateKey = req.socket.remoteAddress ?? 'unknown'
      const outcome = await this.login(parsed.username, parsed.password, rateKey)
      if (!outcome.ok) {
        if (outcome.reason === 'rate-limited') {
          res.setHeader('retry-after', String(Math.ceil((outcome.retryAfterMs ?? 1000) / 1000)))
          sendJson(res, 429, { error: 'rate-limited' })
          return
        }
        sendJson(res, 401, { error: 'invalid-credentials' })
        return
      }
      const record = this.logins.get(this.loginIdsByToken.get(tokenDigest(outcome.token)) ?? '')
      if (record === undefined) {
        sendJson(res, 500, { error: 'internal' })
        return
      }
      const secure = this.ctx.get('webServer')?.protocol === 'https:'
      res.setHeader('set-cookie', sessionCookie(outcome.token, Date.parse(record.expiresAt), secure))
      sendJson(res, 200, { user: outcome.user } satisfies LoginValue)
    })

    route('/auth/logout', async (req, res) => {
      if (req.method !== 'POST') {
        methodNotAllowed(res, 'POST')
        return
      }
      const token = cookieValue(req.headers, COOKIE_NAME)
      try {
        await this.logout(token)
      } catch {
        sendJson(res, 503, { error: 'revocation-failed' })
        return
      }
      res.setHeader('set-cookie', EMPTY_COOKIE)
      res.statusCode = 204
      res.setHeader('cache-control', 'no-store')
      res.end()
    })

    route('/auth/me', (req, res) => {
      if (req.method !== 'GET') {
        methodNotAllowed(res, 'GET')
        return
      }
      const authenticated = this.authenticateToken(cookieValue(req.headers, COOKIE_NAME))
      if (authenticated === undefined) {
        sendJson(res, 401, { error: 'unauthorized' })
        return
      }
      sendJson(res, 200, { user: authenticated.user } satisfies LoginValue)
    })

    route('/auth/sign-in', (req, res) => {
      if (req.method !== 'GET') { methodNotAllowed(res, 'GET'); return }
      res.statusCode = 200
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.setHeader('x-content-type-options', 'nosniff')
      res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        + `<style>${MULTIUSER_CLIENT_STYLE}</style></head><body><script src="client.js"></script></body></html>`)
    })

    route('/auth/client.js', (req, res) => {
      if (req.method !== 'GET') {
        methodNotAllowed(res, 'GET')
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', 'text/javascript; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.setHeader('x-content-type-options', 'nosniff')
      res.end(MULTIUSER_CLIENT_SCRIPT)
    })
  }
}

function normalizeUsername(value: string): string | undefined {
  const normalized = value.trim().normalize('NFKC').toLowerCase()
  return normalized.length <= MAX_USERNAME_LENGTH && USERNAME_PATTERN.test(normalized) ? normalized : undefined
}

function normalizedTitle(title: string | undefined): string {
  const value = title?.trim() ?? ''
  const chosen = value === '' ? 'Workspace' : value
  return chosen.slice(0, MAX_TITLE_LENGTH)
}

function publicUser(user: UserRecord): MultiuserUser {
  return { userId: brandString<UserId>(user.id), username: user.username }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(JSON.stringify(payload))
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

function isJson(req: IncomingMessage): boolean {
  const contentType = req.headers['content-type']
  const essence = (typeof contentType === 'string' ? contentType : '').split(';', 1)[0]?.trim().toLowerCase()
  return essence === 'application/json'
}

function parseLoginBody(text: string): { username: string; password: string } | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const username: unknown = Reflect.get(value, 'username')
  const password: unknown = Reflect.get(value, 'password')
  if (typeof username !== 'string' || typeof password !== 'string') return undefined
  if (username.length === 0 || username.length > MAX_USERNAME_LENGTH) return undefined
  if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return undefined
  return { username, password }
}

async function readBoundedBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

function sessionCookie(token: string, expiresAt: number, secure: boolean): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
  const attributes = `${COOKIE_NAME}=${token}; Max-Age=${String(maxAge)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Lax`
  return secure ? `${attributes}; Secure` : attributes
}

function cookieValue(
  headers: Headers | Readonly<Record<string, string | readonly string[] | undefined>>,
  name: string,
): string | undefined {
  const raw = headers instanceof Headers ? headers.get('cookie') ?? undefined : header(headers, 'cookie')
  if (raw === undefined) return undefined
  for (const segment of raw.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== name) continue
    const value = segment.slice(at + 1).trim()
    return value === '' ? undefined : value
  }
  return undefined
}

function header(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  name: string,
): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}
