/**
 * Provision one multiuser account into an existing JSON storage root.
 *
 * This is a maintenance operation, not an application launcher: it opens the
 * same `multiuser` unit the web service uses, creates one user when the
 * normalized name is absent, and closes the medium. It never resets a password
 * and never prints the submitted value.
 *
 *   pnpm exec tsx scripts/multiuser-provision.ts \
 *     --storage-root "$DSH_HOME/storages" --username alice
 *
 * Set DSH_MULTIUSER_PASSWORD for a non-interactive run; otherwise the script
 * reads a hidden password from a TTY.
 */

import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { descriptorOf } from '@deepseek-ai/dsh-storage-domain'
import { hashPassword, multiuserDomainSpec, type UserRecord } from '@deepseek-ai/dsh-api-multiuser'

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

function normalize(value: string): string | undefined {
  const normalized = value.trim().normalize('NFKC').toLowerCase()
  return USERNAME_PATTERN.test(normalized) ? normalized : undefined
}

async function readHiddenPassword(): Promise<string> {
  const fromEnvironment = process.env.DSH_MULTIUSER_PASSWORD
  if (fromEnvironment !== undefined) return fromEnvironment
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('multiuser-provision: set DSH_MULTIUSER_PASSWORD or run with a terminal')
  }
  process.stdout.write('Password: ')
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding('utf8')
  let value = ''
  try {
    for await (const chunk of process.stdin) {
      for (const character of String(chunk)) {
        if (character === '\u0003') throw new Error('multiuser-provision: cancelled')
        if (character === '\r' || character === '\n') {
          process.stdout.write('\n')
          return value
        }
        if (character === '\u007f') {
          value = value.slice(0, -1)
          continue
        }
        value += character
      }
    }
  } finally {
    process.stdin.setRawMode(false)
    process.stdin.pause()
  }
  process.stdout.write('\n')
  return value
}

const { values } = parseArgs({
  options: {
    'storage-root': { type: 'string' },
    username: { type: 'string' },
  },
  allowPositionals: false,
})

const storageRoot = values['storage-root']
const username = values.username
if (storageRoot === undefined || username === undefined) {
  throw new Error('multiuser-provision: --storage-root and --username are required')
}
const normalized = normalize(username)
if (normalized === undefined) {
  throw new Error('multiuser-provision: username must match [a-z0-9][a-z0-9._-]{0,63}')
}
const password = await readHiddenPassword()
if (password.length === 0 || password.length > 1024) {
  throw new Error('multiuser-provision: password must be 1-1024 characters')
}

const backend = new JsonStorageBackend(storageRoot)
const unit = await backend.kv.open(descriptorOf(multiuserDomainSpec))
try {
  const snapshot = await unit.loadAll()
  const users = Object.values(snapshot.tables.users ?? {}) as UserRecord[]
  if (users.some(user => user.usernameNormalized === normalized)) {
    throw new Error(`multiuser-provision: account ${JSON.stringify(normalized)} already exists`)
  }
  const user: UserRecord = {
    id: `user-${randomUUID()}`,
    username: username.trim(),
    usernameNormalized: normalized,
    password: await hashPassword(password),
    createdAt: new Date().toISOString(),
  }
  await unit.putRecord('users', user.id, user)
  process.stdout.write(`Provisioned ${JSON.stringify(user.username)} (${user.id}).\n`)
} finally {
  await backend.close()
}
