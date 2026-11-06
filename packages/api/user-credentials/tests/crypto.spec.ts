/** Ownership-authenticated ciphertext and exclusive key provisioning. */
import { randomBytes } from 'node:crypto'
import { mkdtemp, chmod, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { encryptCredential, decryptCredential, loadCredentialKey } from '../src/crypto.ts'
import { provisionCredentialKey } from '../../../../scripts/user-credentials-key.ts'

it('authenticates ciphertext, nonce, owner, record identity and encryption version', () => {
  const key = randomBytes(32)
  const identity = { id: 'record-a', ownerUserId: 'alice', encryptionVersion: 1 as const }
  const record = { ...identity, name: 'Test', createdAt: '', updatedAt: '', ...encryptCredential(key, identity, 'private-value') }
  expect(decryptCredential(key, record).toString()).toBe('private-value')
  const second = encryptCredential(key, identity, 'private-value')
  expect(second.nonce).not.toBe(record.nonce)
  expect(second.ciphertext).not.toBe(record.ciphertext)
  for (const changed of [{ ownerUserId: 'bob' }, { id: 'record-b' }, { nonce: '00'.repeat(12) }, { authTag: '00'.repeat(16) }, { ciphertext: '00' }]) {
    expect(() => decryptCredential(key, { ...record, ...changed })).toThrow()
  }
  expect(() => decryptCredential(randomBytes(32), record)).toThrow()
})

it('provisions a private key durably, refuses overwrites, and rejects missing or malformed files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'credential-key-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'secrets', 'master.key')
  await provisionCredentialKey(path)
  const original = await readFile(path)
  expect(await loadCredentialKey(path)).toEqual(original)
  expect(original).toHaveLength(32)
  if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
  await expect(provisionCredentialKey(path)).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(path)).toEqual(original)
  await expect(provisionCredentialKey('relative.key')).rejects.toThrow('must be absolute')
  await expect(loadCredentialKey(join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  await writeFile(path, 'invalid', { mode: 0o600 })
  await expect(loadCredentialKey(path)).rejects.toThrow('exactly 32 bytes')
  if (process.platform !== 'win32') {
    await writeFile(path, original)
    await chmod(path, 0o644)
    await expect(loadCredentialKey(path)).rejects.toThrow('private regular file')
    await symlink(path, join(root, 'link'))
    await expect(loadCredentialKey(join(root, 'link'))).rejects.toMatchObject({ code: 'ELOOP' })
  }
})
