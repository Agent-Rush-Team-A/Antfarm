/** Personal credential management; secrets remain in the Host and never become model tools. */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { mkdir, open, realpath } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { PeerScope, UserId } from '@deepseek-ai/dsh-typert-protocol'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-api-multiuser'
import { loadCredentialKey, encryptCredential, decryptCredential, provisionCredentialKey } from './crypto.ts'
import { userCredentialsDomain, type EncryptedCredential } from './spec.ts'
import { inferenceBindingsSchema, installInferenceBindings } from './inference.ts'
import type { InferenceBinding } from './inference.ts'
import type { CreateCredentialRequest, CredentialRequest, ReplaceCredentialRequest, UserCredentialId, UserCredentialView } from './types.ts'

export type * from './types.ts'
export type { InferenceBinding } from './inference.ts'

/** Host deployment values; no secret is stored in plugin configuration. */
export interface Config {
  /** Absolute path of a private 32-byte master-key file outside workspace mounts. */
  encryptionKeyFile: string
  /** Create a missing key only when the persisted credential table is empty. @default false */
  initializeKeyIfEmpty?: boolean
  /** Maximum UTF-8 secret bytes. @default 16384 */
  maxCredentialBytes?: number
  /** Maximum credentials per account. @default 64 */
  maxRecordsPerUser?: number
  /** Provider routes allowed to consume this account's named credentials. @default [] */
  inferenceBindings?: InferenceBinding[]
  /** Allow HTTP only for explicitly bound loopback test providers. @default false */
  allowLoopbackHttp?: boolean
  /** Private deployment key used only for passwordless visitor inference. */
  guestInferenceKeyFile?: string
}

/** Validated deployment configuration. */
export const Config: schema<Config> = schema.object({
  encryptionKeyFile: schema.string().required(),
  initializeKeyIfEmpty: schema.boolean().default(false),
  maxCredentialBytes: schema.natural().min(1).default(16384),
  maxRecordsPerUser: schema.natural().min(1).default(64),
  inferenceBindings: schema.array(schema.object({
    provider: schema.string().required(), baseURL: schema.string().required(), credentialName: schema.string().required(),
  })).default([]),
  allowLoopbackHttp: schema.boolean().default(false),
  guestInferenceKeyFile: schema.string().default(''),
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
  private guestKey: Buffer | undefined

  /** @param ctx - Host context. @param config - explicit key file and account limits. */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'userCredentials', { namespace: 'userCredentials' })
    this.config = Config(config) as Required<Config>
    this.config.inferenceBindings = inferenceBindingsSchema.parse(this.config.inferenceBindings)
    const workspaceRoot = ctx.multiuser.workspaceRoot
    if (!isAbsolute(this.config.encryptionKeyFile)) throw new Error('Personal credential key path must be absolute.')
    const within = relative(workspaceRoot, this.config.encryptionKeyFile)
    if (within === '' || (within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within))) {
      throw new Error('Personal credential key must be outside the workspace root.')
    }
  }

  protected async [Service.init](): Promise<void> {
    let key: Buffer | undefined
    this.ctx.effect(() => async () => {
      this.closed = true
      await this.operations
      // Initialization can fail before either resource is acquired.
      try { await this.domain?.close() } finally { key?.fill(0); this.guestKey?.fill(0) }
    }, 'user-credentials: key lifetime')
    this.domain = await this.ctx.storageDomain.open(userCredentialsDomain)
    this.table = this.domain.table('credentials')
    try {
      if (this.config.initializeKeyIfEmpty) {
        await mkdir(dirname(this.config.encryptionKeyFile), { recursive: true, mode: 0o700 })
      }
      const workspaceRoot = await realpath(this.ctx.multiuser.workspaceRoot)
      let keyFile: string
      try { keyFile = await realpath(this.config.encryptionKeyFile) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        keyFile = join(await realpath(dirname(this.config.encryptionKeyFile)), basename(this.config.encryptionKeyFile))
      }
      const within = relative(workspaceRoot, keyFile)
      if (within === '' || (within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within))) {
        throw new Error('Personal credential key must be outside workspace mounts.')
      }
      try {
        key = await loadCredentialKey(this.config.encryptionKeyFile)
      } catch (error) {
        if (!this.config.initializeKeyIfEmpty || (error as NodeJS.ErrnoException).code !== 'ENOENT'
          || [...this.table.entries()].length !== 0) throw error
        await provisionCredentialKey(this.config.encryptionKeyFile)
        key = await loadCredentialKey(this.config.encryptionKeyFile)
        this.ctx.logger.info('Personal credential master key initialized. Back up the key file together with the encrypted credential store.')
      }
    } catch (_error) {
      // File-system failures are operational facts; never attach secret-bearing causes.
      throw new Error('Cannot load personal credential key; restore the original private 32-byte key or provision one for an empty store.')
    }
    this.key = key
    if (this.config.guestInferenceKeyFile !== '') {
      if (!isAbsolute(this.config.guestInferenceKeyFile)) throw new Error('Visitor inference key path must be absolute.')
      const path = await realpath(this.config.guestInferenceKeyFile)
      const within = relative(await realpath(this.ctx.multiuser.workspaceRoot), path)
      if (within === '' || (within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within))) {
        throw new Error('Visitor inference key must be outside workspace mounts.')
      }
      this.guestKey = await loadGuestInferenceKey(this.config.guestInferenceKeyFile, this.config.maxCredentialBytes)
    }
    // Validate existing ciphertext before exposing a store with the wrong master key.
    for (const [, record] of this.table.entries()) {
      try {
        decryptCredential(this.key, record).fill(0)
      } catch (_error) {
        throw new Error('Personal credential store cannot be decrypted; restore its original key and intact storage.')
      }
    }
    installInferenceBindings(this.ctx, this.config.inferenceBindings, this.config.allowLoopbackHttp, (userId, name) => {
      if (this.closed) throw new Error('Personal credential service is closed.')
      const records = [...this.table.entries()].map(([, record]) => record)
        .filter(record => record.ownerUserId === userId && record.name === name)
      if (records.length > 1) throw new Error('Personal inference credential name is ambiguous.')
      if (records.length === 0 && this.ctx.multiuser.isGuest(userId) && this.guestKey !== undefined) {
        return Buffer.from(this.guestKey.toString('utf8').trim(), 'utf8')
      }
      const record = records[0]
      return record === undefined ? undefined : decryptCredential(this.key, record)
    })
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
      await this.notifyModels(record.name)
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
      await this.notifyModels(record.name)
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
      const record = this.owned(caller.userId, parsed.id)
      await this.table.delete(parsed.id)
      await this.notifyModels(record.name)
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

  private async notifyModels(name: string): Promise<void> {
    for (const binding of this.config.inferenceBindings) {
      if (binding.credentialName !== name) continue
      try { await this.ctx.parallel('llm/models-updated', binding.provider) }
      catch (_error) {
        // The credential is already committed; observer failure cannot turn it into a failed write.
        this.ctx.logger.warn('Personal credential saved; model catalog refresh failed. Reopen the model selector.')
      }
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

/** Read a bounded visitor secret from a private regular file without following a final symlink. */
async function loadGuestInferenceKey(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let value: Buffer | undefined
  try {
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes
        || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
        throw new Error('Visitor inference key must be a private regular file within the deployment byte limit.')
      }
      value = Buffer.alloc(stat.size + 1)
      let offset = 0
      while (offset < value.length) {
        const { bytesRead } = await handle.read(value, offset, value.length - offset, offset)
        if (bytesRead === 0) break
        offset += bytesRead
      }
      if (offset !== stat.size || value.subarray(0, offset).toString('utf8').trim() === '') {
        throw new Error('Visitor inference key is empty or changed while being read.')
      }
      return value.subarray(0, offset)
    } finally {
      await handle.close()
    }
  } catch (error) {
    value?.fill(0)
    throw error
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
