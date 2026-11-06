/** Ciphertext-only storage declarations for personal credentials. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** A persisted credential; secret plaintext never reaches domain events. */
export interface EncryptedCredential {
  readonly id: string
  readonly ownerUserId: string
  readonly name: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly encryptionVersion: 1
  readonly nonce: string
  readonly ciphertext: string
  readonly authTag: string
}

/** Isolated domain, independent of workspace ownership and global credentials. */
export const userCredentialsDomain = defineDomain({
  name: 'user_credentials',
  version: 1,
  tables: {
    credentials: domainTable<string, EncryptedCredential>(z.object({
      id: z.uuid(), ownerUserId: z.string().min(1), name: z.string().min(1),
      createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
      encryptionVersion: z.literal(1), nonce: z.string().regex(/^[a-f0-9]{24}$/),
      ciphertext: z.string().regex(/^(?:[a-f0-9]{2})+$/), authTag: z.string().regex(/^[a-f0-9]{32}$/),
    }).strict()),
  },
})
