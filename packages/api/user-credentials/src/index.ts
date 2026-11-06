/** Personal credential management; secrets remain in the Host and never become model tools. */
import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, sep } from 'node:path'
import { realpath } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { PeerScope, UserId } from '@deepseek-ai/dsh-typert-protocol'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-api-multiuser'
import { loadCredentialKey, encryptCredential, decryptCredential } from './crypto.ts'
import { userCredentialsDomain, type EncryptedCredential } from './spec.ts'
import type { CreateCredentialRequest, CredentialRequest, ReplaceCredentialRequest, UserCredentialId, UserCredentialView } from './types.ts'

export type * from './types.ts'

/** Host deployment values; no secret is stored in plugin configuration. */
export interface Config {
  /** Absolute path of a provisioned private 32-byte file outside workspace mounts. */
  encryptionKeyFile: string
  /** Maximum UTF-8 secret bytes. @default 16384 */
  maxCredentialBytes?: number
  /** Maximum credentials per account. @default 64 */
  maxRecordsPerUser?: number
}

/** Validated deployment configuration. */
export const Config: schema<Config> = schema.object({
  encryptionKeyFile: schema.string().required(),
  maxCredentialBytes: schema.natural().min(1).default(16384),
  maxRecordsPerUser: schema.natural().min(1).default(64),
})

const createSchema = z.object({ name: z.string().trim().min(1).max(128), value: z.string().min(1) }).strict()
const idSchema = z.object({ id: z.uuid() }).strict()
const replaceSchema = z.object({ id: z.uuid(), value: z.string().min(1) }).strict()

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Caller-owned personal credentials, separate from inference credentials. */
    userCredentials: UserCredentials
  }
}

/** Host service backing the personal-credential browser API. */
export class UserCredentials extends TypertRemoteService {
  static inject = ['storageDomain', 'multiuser']
  private domain: Domain<typeof userCredentialsDomain> | undefined
  private table!: KvTable<string, EncryptedCredential>
  private key!: Buffer
  private readonly config: Required<Config>
  private operations: Promise<void> = Promise.resolve()
  private closed = false

  /** @param ctx - Host context. @param config - explicit key file and account limits. */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'userCredentials', { namespace: 'userCredentials' })
    this.config = Config(config) as Required<Config>
    const workspaceRoot = ctx.multiuser.workspaceRoot
    if (!isAbsolute(this.config.encryptionKeyFile)) throw new Error('Personal credential key path must be absolute.')
    const within = relative(workspaceRoot, this.config.encryptionKeyFile)
    if (within === '' || (within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within))) {
      throw new Error('Personal credential key must be outside the workspace root.')
    }
  }

  protected async [Service.init](): Promise<void> {
    try {
      const [workspaceRoot, keyFile] = await Promise.all([
        realpath(this.ctx.multiuser.workspaceRoot), realpath(this.config.encryptionKeyFile),
      ])
      const within = relative(workspaceRoot, keyFile)
      if (within === '' || (within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within))) {
        throw new Error('Personal credential key must be outside workspace mounts.')
      }
      this.key = await loadCredentialKey(this.config.encryptionKeyFile)
    } catch (_error) {
      // File-system failures are operational facts; never attach secret-bearing causes.
      throw new Error('Cannot load personal credential key; provision a private 32-byte key file.')
    }
    this.ctx.effect(() => async () => {
      this.closed = true
      await this.operations
      try { await this.domain?.close() } finally { this.key.fill(0) }
    }, 'user-credentials: key lifetime')
    this.domain = await this.ctx.storageDomain.open(userCredentialsDomain)
    this.table = this.domain.table('credentials')
    // Validate existing ciphertext before exposing a store with the wrong master key.
    for (const [, record] of this.table.entries()) {
      try {
        decryptCredential(this.key, record).fill(0)
      } catch (_error) {
        throw new Error('Personal credential store cannot be decrypted; restore its original key and intact storage.')
      }
    }

  }

  /**
   * Lists only the authenticated caller's credential metadata.
   * @param signal - Request lifetime.
   * @returns Metadata without secret fragments.
   */
  @Remote
  list(signal: AbortSignal): UserCredentialView[] {
    const caller = this.caller(signal)
    return this.safe(() => [...this.table.entries()]
      .filter(([, record]) => record.ownerUserId === caller.userId)
      .map(([, record]) => view(record)))
  }

  /**
   * Encrypts and durably stores a new credential for the authenticated caller.
   * @param request - Name and submitted secret.
   * @param signal - Request lifetime.
   * @returns Committed metadata without the secret.
   */
  @Remote
  create(request: CreateCredentialRequest, signal: AbortSignal): Promise<UserCredentialView> {
    const caller = this.caller(signal)
    const parsed = parse(createSchema, request)
    this.checkSize(parsed.value)
    return this.enqueue(caller, async () => {
      const count = [...this.table.entries()].filter(([, record]) => record.ownerUserId === caller.userId).length
      if (count >= this.config.maxRecordsPerUser) throw new RemoteError('user-credentials/limit', 'Credential limit reached.', {})
      const now = new Date().toISOString()
      const record = { id: randomUUID(), ownerUserId: String(caller.userId), name: parsed.name,
        createdAt: now, updatedAt: now, encryptionVersion: 1 as const }
      const encrypted = { ...record, ...encryptCredential(this.key, record, parsed.value) }
      await this.table.put(record.id, encrypted)
      return view(encrypted)
    })
  }

  /**
   * Replaces the secret of a credential owned by the authenticated caller.
   * @param request - Own record and replacement secret.
   * @param signal - Request lifetime.
   * @returns Committed metadata without the secret.
   */
  @Remote
  replace(request: ReplaceCredentialRequest, signal: AbortSignal): Promise<UserCredentialView> {
    const caller = this.caller(signal)
    const parsed = parse(replaceSchema, request)
    this.checkSize(parsed.value)
    return this.enqueue(caller, async () => {
      const record = this.owned(caller.userId, parsed.id)
      const encrypted = { ...record, updatedAt: new Date().toISOString(), ...encryptCredential(this.key, record, parsed.value) }
      await this.table.put(record.id, encrypted)
      return view(encrypted)
    })
  }

  /**
   * Durably removes a credential owned by the authenticated caller.
   * @param request - Own record to delete.
   * @param signal - Request lifetime.
   * @returns Confirmation after durable removal.
   */
  @Remote
  delete(request: CredentialRequest, signal: AbortSignal): Promise<{ removed: true }> {
    const caller = this.caller(signal)
    const parsed = parse(idSchema, request)
    return this.enqueue(caller, async () => {
      this.owned(caller.userId, parsed.id)
      await this.table.delete(parsed.id)
      return { removed: true }
    })
  }

  /**
   * Authenticates and decrypts the caller's stored credential only in Host memory.
   * @param request - Own record to check.
   * @param signal - Request lifetime.
   * @returns Storage readability, not external-service authorization.
   */
  @Remote
  check(request: CredentialRequest, signal: AbortSignal): { readable: true } {
    const caller = this.caller(signal)
    const parsed = parse(idSchema, request)
    return this.safe(() => {
      const record = this.owned(caller.userId, parsed.id)
      decryptCredential(this.key, record).fill(0)
      return { readable: true }
    })
  }

  private caller(signal: AbortSignal): { userId: UserId; peer: PeerScope; signal: AbortSignal } {
    const invocation = this.ctx.invocation
    if (invocation === undefined || invocation.peer.principal.kind !== 'user') {
      throw new RemoteError('user-credentials/unauthorized', 'Sign in to manage personal credentials.', {})
    }
    const caller = { userId: invocation.peer.principal.userId, peer: invocation.peer, signal }
    this.assertLive(caller)
    return caller
  }

  private assertLive(caller: { peer: PeerScope; signal: AbortSignal }): void {
    if (this.closed || caller.peer.signal.aborted || caller.signal.aborted) {
      throw new RemoteError('user-credentials/unauthorized', 'The credential request is no longer active.', {})
    }
  }

  private owned(userId: UserId, id: string): EncryptedCredential {
    const record = this.table.get(id)
    if (record === undefined || record.ownerUserId !== userId) {
      throw new RemoteError('user-credentials/not-found', 'Credential not found.', {})
    }
    return record
  }

  private checkSize(value: string): void {
    if (Buffer.byteLength(value, 'utf8') > this.config.maxCredentialBytes) {
      throw new RemoteError('user-credentials/invalid-request', 'Credential value is too large.', {})
    }
  }


  private safe<T>(operation: () => T): T {
    try { return operation() } catch (error) { throw safeError(error) }
  }

  private enqueue<T>(caller: { peer: PeerScope; signal: AbortSignal }, operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(async () => {
      this.assertLive(caller)
      try { return await operation() } catch (error) { throw safeError(error) }
    })
    this.operations = result.then(() => undefined, () => undefined)
    return result
  }
}

function parse<T>(validator: z.ZodType<T>, request: unknown): T {
  const parsed = validator.safeParse(request)
  if (!parsed.success) throw new RemoteError('user-credentials/invalid-request', 'Invalid credential request.', {})
  return parsed.data
}

function safeError(error: unknown): RemoteError {
  if (error instanceof RemoteError && error.code === 'user-credentials/not-found') {
    return new RemoteError('user-credentials/not-found', 'Credential not found.', {})
  }
  if (error instanceof RemoteError && error.code === 'user-credentials/limit') {
    return new RemoteError('user-credentials/limit', 'Credential limit reached.', {})
  }
  return new RemoteError('user-credentials/unavailable', 'Credential storage is unavailable. Try again or contact the administrator.', {})
}

function view(record: EncryptedCredential): UserCredentialView {
  return { id: brandString<UserCredentialId>(record.id), name: record.name, configured: true,
    createdAt: record.createdAt, updatedAt: record.updatedAt }
}

export default UserCredentials
