/** Published optional overlay through the built dsh Web process, with real account storage. */

import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { descriptorOf } from '@deepseek-ai/dsh-storage-domain'
import { hashPassword, multiuserDomainSpec } from '@deepseek-ai/dsh-api-multiuser'
import { expect, test, vi } from 'vitest'
import { withDefaultWeb, webRequest } from '../web/tests/default-web-process.ts'

const overlay = fileURLToPath(new URL('../../../config/examples/harness-sandbox.patch.yml', import.meta.url))
const antfarmWeb = fileURLToPath(new URL('../../../config/antfarm-web.patch.yml', import.meta.url))

test('published Web overlay authenticates two accounts and manages only their own sandboxes', async (t) => {
  const patches = [antfarmWeb, overlay]
  const password = randomUUID()
  const calls: Array<{ method: string | undefined; path: string | undefined; body: string }> = []
  const running = new Set<string>()
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\dsh-overlay-${randomUUID()}` : `/tmp/dsh-overlay-${randomUUID()}.sock`
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8').on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      calls.push({ method: request.method, path: request.url, body })
      const path = request.url ?? ''
      if (request.method === 'PUT') running.add(path)
      if (request.method === 'DELETE') running.delete(path)
      response.end(JSON.stringify(running.has(path) ? { state: 'running', containerId: 'a'.repeat(64) } : { state: 'closed' }))
    })
  })
  t.onTestFinished(async () => {
    vi.unstubAllEnvs()
    if (server.listening) await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
      server.closeAllConnections()
    })
  })
  await once(server.listen(socketPath), 'listening')
  vi.stubEnv('DSH_SANDBOX_RUNNER_SOCKET', socketPath)
  await withDefaultWeb(t, async ({ root, url }) => {
    async function post(path: string, body: unknown, cookie = '') {
      const response = await webRequest(new URL(path, url), t.signal, { method: 'POST',
        headers: { 'content-type': 'application/json', origin: new URL(url).origin, cookie }, body: JSON.stringify(body) })
      return response
    }
    async function rpc(cookie: string, method: string, request: unknown) {
      const response = await post(`/api/${method}`, { type: 'client-request', rpcId: randomUUID(), method, payload: { args: { request } } }, cookie)
      expect(response.status).toBe(200)
      return (JSON.parse(response.text) as { result: { ok: boolean; value: unknown; error?: { code: string } } }).result
    }
    async function account(username: string) {
      const response = await post('/auth/login', { username, password })
      expect(response.status).toBe(200)
      const cookie = response.headers['set-cookie']![0]!.split(';')[0]!
      const result = await rpc(cookie, 'workspace/create', { title: username })
      expect(result.ok).toBe(true)
      return { cookie, id: (result.value as { workspace: { workspaceId: string } }).workspace.workspaceId }
    }
    const alice = await account('alice')
    const bob = await account('bob')
    for (const user of [alice, bob]) {
      for (const operation of ['open', 'status', 'close', 'close']) {
        expect(await rpc(user.cookie, `workspaceSandbox/${operation}`, { workspaceId: user.id })).toEqual({ ok: true,
          value: { workspaceId: user.id, state: operation === 'close' ? 'closed' : 'running' } })
      }
    }
    const mount = JSON.parse(calls[0]!.body) as { workspaceDir: string }
    expect(mount.workspaceDir).toContain(join(root, 'workspaces'))
    calls.length = 0
    for (const operation of ['open', 'status', 'close']) {
      expect(await rpc(bob.cookie, `workspaceSandbox/${operation}`, { workspaceId: alice.id })).toMatchObject({ ok: false, error: { code: 'remote-access/denied' } })
    }
    expect(calls).toEqual([])
    expect((await rpc(alice.cookie, 'workspaceSandbox/open', { workspaceId: alice.id })).ok).toBe(true)
    const offline = await post('/__test/sandbox-lifecycle/disable', {})
    expect(offline.status, offline.text).toBe(200)
    expect(JSON.parse(offline.text) as { loaded: boolean }).toEqual({ loaded: false })
    expect(await rpc(alice.cookie, 'workspace/delete', { workspaceId: alice.id })).toMatchObject({ ok: false,
      error: { code: 'sandbox/failed' } })
    const online = await post('/__test/sandbox-lifecycle/enable', {})
    expect(online.status, online.text).toBe(200)
    expect(JSON.parse(online.text) as { loaded: boolean }).toEqual({ loaded: true })
    expect(await rpc(alice.cookie, 'workspaceSandbox/status', { workspaceId: alice.id })).toEqual({ ok: true,
      value: { workspaceId: alice.id, state: 'running' } })
    await writeFile(join(mount.workspaceDir, 'retained.txt'), 'retained')
    const moved = `${mount.workspaceDir}-moved`
    await rename(mount.workspaceDir, moved)
    expect(await rpc(alice.cookie, 'workspaceSandbox/status', { workspaceId: alice.id })).toEqual({ ok: true,
      value: { workspaceId: alice.id, state: 'running' } })
    const beforeDeletion = calls.length
    expect(await rpc(alice.cookie, 'workspace/delete', { workspaceId: alice.id })).toMatchObject({ ok: false,
      error: { code: 'workspace/sandbox-active' } })
    expect(calls.slice(beforeDeletion).map(call => call.method)).toEqual(['GET'])
    expect((await rpc(alice.cookie, 'workspaceSandbox/close', { workspaceId: alice.id })).ok).toBe(true)
    expect(await rpc(alice.cookie, 'workspace/delete', { workspaceId: alice.id })).toEqual({ ok: true, value: { deleted: true } })
    expect((await rpc(alice.cookie, 'workspaceSandbox/open', { workspaceId: alice.id })).ok).toBe(false)
    expect(await readFile(join(moved, 'retained.txt'), 'utf8')).toBe('retained')
    const roster = await post('/api/workspaceSandbox/status', {})
    expect(roster.status).toBe(401)
  }, {
    patches,
    prepare: async (root) => {
      const controls = join(root, 'sandbox-lifecycle.patch.yml')
      await writeFile(controls, JSON.stringify([{ insert: [{ id: 'sandbox-lifecycle-control',
        name: new URL('./fixtures/lifecycle-control.mjs', import.meta.url).href }] }]))
      patches.push(controls)
      vi.stubEnv('DSH_MULTIUSER_WORKSPACE_ROOT', join(root, 'workspaces'))
      const backend = new JsonStorageBackend(join(root, 'home', 'storages'))
      try {
        const unit = await backend.kv.open(descriptorOf(multiuserDomainSpec))
        await unit.loadAll()
        for (const username of ['alice', 'bob']) {
          const id = `user-${randomUUID()}`
          await unit.putRecord('users', id, { id, username, usernameNormalized: username, password: await hashPassword(password), createdAt: new Date().toISOString() })
        }
      } finally {
        await backend.close()
      }
    },
  })
}, 90_000)
