/** Host-only authenticated encryption and explicit master-key loading. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import type { EncryptedCredential } from './spec.ts'

/**
 * Load an explicitly provisioned 32-byte key from a private regular file.
 * @param path - absolute Host path, outside workspace mounts.
 * @returns key bytes; missing or invalid files fail without regeneration.
 */
export async function loadCredentialKey(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size !== 32 || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
      throw new Error('Personal credential key must be a private regular file containing exactly 32 bytes.')
    }
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

function associatedData(record: Pick<EncryptedCredential, 'id' | 'ownerUserId' | 'encryptionVersion'>): Buffer {
  return Buffer.from(JSON.stringify(['user-credentials', record.encryptionVersion, record.ownerUserId, record.id]))
}

/**
 * Encrypt one submitted secret with a fresh nonce and its ownership identity.
 * @param key - Host master key.
 * @param record - record identity to authenticate.
 * @param value - submitted secret, kept only in memory.
 * @returns ciphertext fields safe for persistence and domain events.
 */
export function encryptCredential(key: Buffer, record: Pick<EncryptedCredential, 'id' | 'ownerUserId' | 'encryptionVersion'>, value: string): Pick<EncryptedCredential, 'nonce' | 'ciphertext' | 'authTag'> {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(associatedData(record))
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return { nonce: nonce.toString('hex'), ciphertext: ciphertext.toString('hex'), authTag: cipher.getAuthTag().toString('hex') }
}

/**
 * Authenticate and decrypt a caller-owned record for the Host storage check.
 * @param key - Host master key.
 * @param record - encrypted record whose ownership has been checked.
 * @returns plaintext bytes; the caller clears them immediately after checking.
 */
export function decryptCredential(key: Buffer, record: EncryptedCredential): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.nonce, 'hex'))
  decipher.setAAD(associatedData(record))
  decipher.setAuthTag(Buffer.from(record.authTag, 'hex'))
  const plaintext = decipher.update(Buffer.from(record.ciphertext, 'hex'))
  try {
    return Buffer.concat([plaintext, decipher.final()])
  } finally {
    plaintext.fill(0)
  }
}
