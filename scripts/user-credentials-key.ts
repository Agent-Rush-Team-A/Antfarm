/** Provision a private personal-credential master key without overwriting one. */
import { resolve } from 'node:path'
import { provisionCredentialKey } from '../packages/api/user-credentials/src/crypto.ts'

export { provisionCredentialKey } from '../packages/api/user-credentials/src/crypto.ts'

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
