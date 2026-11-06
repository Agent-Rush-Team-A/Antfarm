/** Password verification and login-token digests. */

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import type { PasswordDigest } from './spec.ts'

/** scrypt cost parameters fixed by this security contract. */
const COST = 16_384
const BLOCK_SIZE = 8
const PARALLELIZATION = 1
const KEY_LENGTH = 64
const SALT_BYTES = 16
/** Node's default scrypt memory ceiling is below this profile's need. */
const MAX_MEMORY = 128 * 1024 * 1024

/**
 * Derive one scrypt digest.
 * @param password - plaintext submitted by the account owner.
 * @param salt - random salt bytes.
 * @returns the complete digest stored beside the account.
 */
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, {
      N: COST, r: BLOCK_SIZE, p: PARALLELIZATION, maxmem: MAX_MEMORY,
    }, (error, key) => {
      if (error !== null) reject(error)
      else resolve(key)
    })
  })
}

/**
 * Hash one password with a fresh salt.
 * @param password - plaintext to hash.
 * @returns a self-describing digest with its algorithm parameters.
 */
export async function hashPassword(password: string): Promise<PasswordDigest> {
  const salt = randomBytes(SALT_BYTES)
  const hash = await derive(password, salt)
  return {
    algorithm: 'scrypt',
    salt: salt.toString('base64url'),
    hash: hash.toString('base64url'),
    cost: COST,
    blockSize: BLOCK_SIZE,
    parallelization: PARALLELIZATION,
    keyLength: KEY_LENGTH,
  }
}

/**
 * Verify one password against a stored digest.
 * @param password - plaintext submitted by the account owner.
 * @param digest - stored digest; an unsupported parameter set fails closed.
 * @returns whether the password matches.
 */
export async function verifyPassword(password: string, digest: PasswordDigest): Promise<boolean> {
  if (digest.cost !== COST
    || digest.blockSize !== BLOCK_SIZE || digest.parallelization !== PARALLELIZATION
    || digest.keyLength !== KEY_LENGTH) return false
  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(digest.salt, 'base64url')
    expected = Buffer.from(digest.hash, 'base64url')
  } catch {
    return false
  }
  if (salt.byteLength === 0 || expected.byteLength !== KEY_LENGTH) return false
  const actual = await derive(password, salt)
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected)
}

/**
 * Digest one login token for storage and synchronous lookup.
 * @param token - base64url token sent in the browser cookie.
 * @returns lowercase SHA-256 hex of the token.
 */
export function tokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * Mint one unguessable login token.
 * @returns 32 random bytes as unpadded base64url.
 */
export function newLoginToken(): string {
  return randomBytes(32).toString('base64url')
}
