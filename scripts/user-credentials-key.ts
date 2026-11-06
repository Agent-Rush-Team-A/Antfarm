/** Provision a private personal-credential master key without overwriting one. */
import { randomBytes } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

/**
 * Exclusively create a 32-byte master-key file; existing paths always fail.
 * @param path - absolute Host path outside workspace mounts.
 * @returns resolution after durable file creation and key-buffer clearing.
 */
export async function provisionCredentialKey(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error('Credential key path must be absolute.')
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const handle = await open(path, 'wx', 0o600)
  const key = randomBytes(32)
  try {
    await handle.writeFile(key)
    await handle.sync()
  } finally {
    key.fill(0)
    await handle.close()
  }
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--path' || args[1] === undefined) {
    console.error('Usage: pnpm exec tsx scripts/user-credentials-key.ts --path /absolute/private/key-file')
    process.exitCode = 1
  } else {
    try {
      await provisionCredentialKey(args[1])
      console.log('Personal credential master key provisioned. Back up this file securely.')
    } catch (_error) {
      console.error('Cannot provision credential key. Use an absolute writable path that does not already exist.')
      process.exitCode = 1
    }
  }
}
