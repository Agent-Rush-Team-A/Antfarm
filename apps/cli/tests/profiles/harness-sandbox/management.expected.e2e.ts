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

test('published Web overlay authenticates, prepares message permits, revokes old turns and manages owned sandboxes', async (t) => {
  const patches = [overlay]
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
      if (path.endsWith('/exec')) {
        const execution = JSON.parse(body) as { executionId: string }
        response.end(JSON.stringify({ executionId: execution.executionId, exitCode: 7,
          stdout: { text: 'PROFILE_RUNNER_OK\n', truncated: false }, stderr: { text: 'command diagnostic\n', truncated: false } }))
        return
      }
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
    const created = await rpc(alice.cookie, 'session/create', { workspaceId: alice.id })
    expect(created.ok).toBe(true)
    const sessionId = (created.value as { sessionId: string }).sessionId
    expect(await rpc(bob.cookie, 'session/prompt', { sessionId, requestId: randomUUID(), mode: 'queue',
      content: [{ type: 'text', text: 'cross-user' }] })).toMatchObject({ ok: false, error: { code: 'remote-access/denied' } })
    expect(calls).toEqual([])
    const prompt = (requestId: string) => rpc(alice.cookie, 'session/prompt', {
      sessionId, requestId, mode: 'queue', content: [{ type: 'text', text: requestId }],
    })
    const active = await prompt('profile-active')
    expect(active, JSON.stringify(active)).toMatchObject({ ok: true, value: { accepted: true } })
    const first = await post('/__test/sandbox-admission/first', {})
    expect(first.status, first.text).toBe(200)
    expect(JSON.parse(first.text)).toMatchObject([{ sessionId, requestId: 'profile-active', cancelled: false }])
    expect(await prompt('profile-queued')).toMatchObject({ ok: true })
    expect(await rpc(alice.cookie, 'workspaceSandbox/close', { workspaceId: alice.id })).toMatchObject({ ok: true })
    const revoked = await post('/__test/sandbox-admission/state', {})
    expect(JSON.parse(revoked.text)).toMatchObject([{ requestId: 'profile-active', cancelled: true, modelCancelled: true }])
    const beforeRetry = calls.length
    expect(await prompt('profile-queued')).toMatchObject({ ok: true })
    expect(calls).toHaveLength(beforeRetry)
    expect(await prompt('profile-fresh')).toMatchObject({ ok: true })
    const second = await post('/__test/sandbox-admission/second', {})
    expect(JSON.parse(second.text)).toMatchObject([{ requestId: 'profile-active', cancelled: true }, { requestId: 'profile-fresh', cancelled: false }])
    expect(calls.slice(beforeRetry).map(call => call.method)).toEqual(['PUT'])
    const staged = await rpc(bob.cookie, 'session/create', { workspaceId: bob.id })
    expect(staged.ok).toBe(true)
    const beforeExecution = calls.length
    expect(await rpc(bob.cookie, 'session/prompt', { sessionId: (staged.value as { sessionId: string }).sessionId,
      requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'profile-runner-bash' }] })).toMatchObject({ ok: true })
    const completion = await post('/__test/sandbox-admission/completed', {})
    expect(completion.status, completion.text).toBe(200)
    const stagedResult = JSON.parse(completion.text) as {
      execution: { result: { isError: boolean; content: unknown }; description: string; presentation: unknown }
      modelView: { content: unknown; directory: string[]; tools: Array<{ name: string }> }
    }
    expect(stagedResult.execution.result.isError).toBe(false)
    expect(stagedResult.execution.description).toContain('foreground bash')
    expect(stagedResult.modelView.content).toEqual(stagedResult.execution.result.content)
    expect(stagedResult.modelView.directory.join('\n')).toContain('Current working directory: "/workspace".')
    expect(stagedResult.modelView.directory.join('\n')).not.toContain(root)
    expect(stagedResult.execution.presentation).toMatchObject({ card: 'terminal', exitCode: 7 })
    expect(stagedResult.modelView.tools.map(tool => tool.name)).toEqual(['bash'])
    expect(calls.slice(beforeExecution).map(call => call.method)).toEqual(['PUT', 'POST'])
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
      value: { workspaceId: alice.id, state: 'closing' } })
    expect(await prompt('profile-fresh')).toMatchObject({ ok: false })
    expect(await prompt('profile-unload-old')).toMatchObject({ ok: false })
    expect((await rpc(alice.cookie, 'workspaceSandbox/close', { workspaceId: alice.id })).ok).toBe(true)
    const beforeReloadedInput = calls.length
    expect(await prompt('profile-unload-old')).toMatchObject({ ok: false })
    expect(calls).toHaveLength(beforeReloadedInput)
    expect(await prompt('profile-reloaded-new')).toMatchObject({ ok: true })
    // Native services may keep live Session directories open on Windows; use an unactivated registration for this lifecycle check.
    const movable = await rpc(alice.cookie, 'workspace/create', { title: 'move-without-agent' })
    expect(movable.ok).toBe(true)
    alice.id = (movable.value as { workspace: { workspaceId: string } }).workspace.workspaceId
    expect((await rpc(alice.cookie, 'workspaceSandbox/open', { workspaceId: alice.id })).ok).toBe(true)
    const movableMount = JSON.parse(calls.at(-1)!.body) as { workspaceDir: string }
    await writeFile(join(movableMount.workspaceDir, 'retained.txt'), 'retained')
    const moved = `${movableMount.workspaceDir}-moved`
    await rename(movableMount.workspaceDir, moved)
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
        name: new URL('./fixtures/lifecycle-control.mjs', import.meta.url).href }, {
        id: 'sandbox-admission-control', name: new URL('./fixtures/admission-control.mjs', import.meta.url).href,
      }] }, { id: 'agent-default-model', config: { provider: 'sandbox-admission-fixture', model: 'fixture' } },
      { id: 'session-title', disabled: true }]))
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
