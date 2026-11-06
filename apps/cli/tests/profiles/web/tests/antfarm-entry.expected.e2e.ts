/** Default repository Web commands admit accounts and mount their file services. */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { descriptorOf } from '@deepseek-ai/dsh-storage-domain'
import { hashPassword, multiuserDomainSpec } from '@deepseek-ai/dsh-api-multiuser'
import { expect, test, vi } from 'vitest'
import { devWebAppArguments } from '../../../../../../scripts/dev-web.ts'
import { withDefaultWeb, webGet, webRequest } from './default-web-process.ts'

const repoRoot = fileURLToPath(new URL('../../../../../../', import.meta.url))

for (const entry of ['start', 'development'] as const) {
  test.skipIf(process.platform !== 'linux')(`${entry} Web entry requires account login and isolates workspace files`, async (t) => {
    const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    const args = entry === 'start'
      ? manifest.scripts['start:web']!.split(/\s+/u).slice(4)
      : devWebAppArguments([])
    const patches = args.flatMap((value, index) => value === '--patch' ? [join(repoRoot, args[index + 1]!)] : [])
    const password = randomUUID()
    vi.stubEnv('DSH_MULTIUSER_WORKSPACE_ROOT', undefined)
    t.onTestFinished(() => { vi.unstubAllEnvs() })
    await withDefaultWeb(t, async ({ root, url }) => {
      const origin = new URL(url).origin
      async function post(path: string, body: unknown, cookie = '') {
        return webRequest(new URL(path, url), t.signal, { method: 'POST',
          headers: { 'content-type': 'application/json', origin, cookie }, body: JSON.stringify(body) })
      }
      async function rpc(cookie: string, method: string, args: unknown) {
        const response = await post(`/api/${method}`, {
          type: 'client-request', rpcId: randomUUID(), method, payload: { args },
        }, cookie)
        expect(response.status, response.text).toBe(200)
        return (JSON.parse(response.text) as { result: {
          ok: boolean
          value?: { workspace: { workspaceId: string; path: string } }
          error?: { code: string }
        } }).result
      }
      const homepage = await webGet(new URL('/', url), t.signal)
      expect(homepage.status).toBe(303)
      expect(homepage.headers.location).toBe('auth/sign-in')
      expect(new URL(url).search).toBe('')
      expect((await webGet(new URL('/?token=old-single-user-token', url), t.signal)).status).toBe(303)
      expect((await post('/api/session/list', {})).status).toBe(401)
      expect((await post('/auth/login', { username: 'alice', password: 'incorrect' })).status).toBe(401)
      async function account(username: string) {
        const login = await post('/auth/login', { username, password })
        expect(login.status, login.text).toBe(200)
        const cookie = login.headers['set-cookie']![0]!.split(';', 1)[0]!
        const created = await rpc(cookie, 'workspace/create', { request: { title: username } })
        expect(created.ok).toBe(true)
        const workspaceId = created.value!.workspace.workspaceId
        expect((await webGet(new URL('/', url), t.signal, { cookie })).status).toBe(200)
        return { cookie, workspaceId }
      }
      const alice = await account('alice')
      const bob = await account('bob')
      expect(alice.workspaceId).not.toBe(bob.workspaceId)
      const content = 'month,total\n2026-01,42\n'
      const query = new URLSearchParams({ workspaceId: alice.workspaceId, name: 'summary.csv' })
      const upload = await webRequest(new URL(`/api/workspace/uploadFileBinary?${query}`, url), t.signal, {
        method: 'POST', headers: { origin, cookie: alice.cookie, 'content-type': 'application/octet-stream',
          'content-length': String(Buffer.byteLength(content)) }, body: content,
      })
      expect(upload.status, upload.text).toBe(200)
      expect(JSON.parse(upload.text)).toMatchObject({ ok: true })
      expect(await rpc(alice.cookie, 'workspaceArtifacts/list', { request: { workspaceId: alice.workspaceId }, path: '' }))
        .toMatchObject({ ok: true, value: { entries: [{ name: 'summary.csv' }] } })
      const download = new URL('/api/workspace/downloadFileBinary', url)
      download.search = new URLSearchParams({ workspaceId: alice.workspaceId, path: 'summary.csv' }).toString()
      const owned = await webGet(download, t.signal, { cookie: alice.cookie })
      expect(owned.status).toBe(200)
      expect(owned.text).toBe(content)
      expect(await rpc(bob.cookie, 'workspaceArtifacts/list', { request: { workspaceId: alice.workspaceId }, path: '' }))
        .toMatchObject({ ok: false, error: { code: 'remote-access/denied' } })
      expect((await webGet(download, t.signal, { cookie: bob.cookie })).status).toBe(403)
      const stored = JSON.parse(await readFile(join(root, 'home', 'storages', 'workspace.json'), 'utf8')) as {
        tables: { workspaces: Record<string, { path: string }> }
      }
      expect(stored.tables.workspaces[alice.workspaceId]!.path).toContain(join(root, 'home', 'workspaces'))
      expect((await post('/auth/logout', {}, alice.cookie)).status).toBe(204)
      expect((await webGet(new URL('/auth/me', url), t.signal, { cookie: alice.cookie })).status).toBe(401)
    }, {
      patches,
      prepare: async (root) => {
        const backend = new JsonStorageBackend(join(root, 'home', 'storages'))
        try {
          const unit = await backend.kv.open(descriptorOf(multiuserDomainSpec))
          await unit.loadAll()
          for (const username of ['alice', 'bob']) {
            const id = `user-${randomUUID()}`
            await unit.putRecord('users', id, { id, username, usernameNormalized: username,
              password: await hashPassword(password), createdAt: new Date().toISOString() })
          }
        } finally {
          await backend.close()
        }
      },
    })
  }, 90_000)
}
