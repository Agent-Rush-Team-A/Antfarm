/** Durable multiuser records: accounts, login sessions, and workspace owners. */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** One password digest; the plaintext never reaches storage. */
export interface PasswordDigest {
  readonly algorithm: 'scrypt'
  readonly salt: string
  readonly hash: string
  readonly cost: number
  readonly blockSize: number
  readonly parallelization: number
  readonly keyLength: number
}

/** One account record. */
export interface UserRecord {
  readonly id: string
  readonly username: string
  readonly usernameNormalized: string
  readonly password: PasswordDigest
  readonly createdAt: string
  readonly disabledAt?: string | undefined
}

/** One browser login; only the token digest is stored. */
export interface LoginSessionRecord {
  readonly id: string
  readonly tokenHash: string
  readonly userId: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly revokedAt?: string | undefined
}

/** One workspace's single owner. */
export interface WorkspaceOwnerRecord {
  readonly workspaceId: string
  readonly userId: string
  readonly createdAt: string
}

const passwordDigestSchema = z.object({
  algorithm: z.literal('scrypt'),
  salt: z.string().min(1),
  hash: z.string().min(1),
  cost: z.number().int().positive(),
  blockSize: z.number().int().positive(),
  parallelization: z.number().int().positive(),
  keyLength: z.number().int().positive(),
})

const userSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  usernameNormalized: z.string().min(1),
  password: passwordDigestSchema,
  createdAt: z.iso.datetime(),
  disabledAt: z.iso.datetime().optional(),
})

const loginSessionSchema = z.object({
  id: z.string().min(1),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  userId: z.string().min(1),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().optional(),
})

const workspaceOwnerSchema = z.object({
  workspaceId: z.string().min(1),
  userId: z.string().min(1),
  createdAt: z.iso.datetime(),
})

/** Multiuser domain declaration. Version is the medium format, not the app version. */
export const multiuserDomainSpec = defineDomain({
  name: 'multiuser',
  version: 1,
  tables: {
    users: domainTable<string, UserRecord>(userSchema),
    login_sessions: domainTable<string, LoginSessionRecord>(loginSessionSchema),
    workspace_owners: domainTable<string, WorkspaceOwnerRecord>(workspaceOwnerSchema),
  },
})
