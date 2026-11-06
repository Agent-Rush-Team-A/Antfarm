/** Default Antfarm model catalogs and credentials through real Web processes. */
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { expect, test, vi } from 'vitest'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { descriptorOf } from '@deepseek-ai/dsh-storage-domain'
import { hashPassword, multiuserDomainSpec } from '@deepseek-ai/dsh-api-multiuser'
import type { PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { withDefaultWeb, webRequest } from './default-web-process.ts'

const antfarmPatch = fileURLToPath(new URL('../../../../config/antfarm-web.patch.yml', import.meta.url))
const model = 'deepseek-v4.1-flash-1017'
type Credential = { id: string; name: string }
type Catalog = { groups: Array<{ id: string; models: Array<{ id: string }> }>; default: { provider: string; model: string } }
type Events = { records: unknown[] }

test.skipIf(process.platform !== 'linux')('default personal models stay visible and preserve isolated credentials across process restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'antfarm-personal-models-'))
  t.onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  vi.stubEnv('DSH_USER_CREDENTIALS_KEY_FILE', undefined)
  vi.stubEnv('DSH_MULTIUSER_WORKSPACE_ROOT', undefined)
  vi.stubEnv('VULTR_API_KEY', 'GLOBAL-MUST-NOT-BE-USED')
  t.onTestFinished(() => { vi.unstubAllEnvs() })
  const home = join(root, 'home')
  const password = randomUUID()
  const requests: Array<{ authorization: string; body: unknown }> = []
  let status = 200
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      requests.push({ authorization: request.headers.authorization ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      if (status !== 200) {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: status === 401 ? 'Invalid inference credential' : 'Inference service unavailable' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const choice of [
        { index: 0, delta: { role: 'assistant', content: 'PERSONAL-MODEL-REPLY' }, finish_reason: null },
        { index: 0, delta: {}, finish_reason: 'stop' },
      ]) response.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model, choices: [choice] }) + '\n\n')
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  t.onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected an owned TCP listener')
  const baseURL = `http://127.0.0.1:${address.port}/v1`
  const noTitlePatch = join(root, 'no-title.patch.yml')
  await writeFile(noTitlePatch, '- id: session-title-llm\n  disabled: true\n')
  const schema = yaml.JSON_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => String(value) }))
  const defaults = yaml.load(await readFile(antfarmPatch, 'utf8'), { schema }) as Array<{ id?: string; config?: { providers?: Record<string, PiAiProviderProfile> } }>
  const providers = defaults.find(row => row.id === 'llm-pi-ai')?.config?.providers
  if (providers?.vultr === undefined) throw new Error('Default Antfarm entry must configure Vultr')
  const vultr = providers.vultr
  expect(vultr).toMatchObject({ credentialScope: 'request', baseURL: 'https://api.vultrinference.com/v1' })
  const externalPatch = join(root, 'inference.patch.yml')
  await writeFile(externalPatch, yaml.dump([
    { id: 'llm-pi-ai', config: { providers: { vultr: { ...vultr, baseURL, apiKeyEnv: 'VULTR_API_KEY', retryPolicy: { mode: 'normal', maxRetries: 0 } } } } },
  ]) + `- id: user-credentials
  config:
    encryptionKeyFile: !!js process.getBuiltinModule('node:path').join(ctx.profileContext.home, 'secrets', 'user-credentials.key')
    initializeKeyIfEmpty: true
    allowLoopbackHttp: true
    inferenceBindings:
      - provider: vultr
        baseURL: ${baseURL}
        credentialName: Vultr API Key
`)

  function api(url: string) {
    const origin = new URL(url).origin
    async function post(path: string, body: unknown, cookie = '') {
      return webRequest(new URL(path, url), t.signal, { method: 'POST',
        headers: { 'content-type': 'application/json', origin, cookie }, body: JSON.stringify(body) })
    }
    async function login(username: string) {
      const result = await post('/auth/login', { username, password })
      expect(result.status, result.text).toBe(200)
      return result.headers['set-cookie']![0]!.split(';', 1)[0]!
    }
    async function rpc<T>(cookie: string, method: string, args: unknown = {}): Promise<T> {
      const response = await post(`/api/${method}`, { type: 'client-request', rpcId: randomUUID(), method, payload: { args } }, cookie)
      expect(response.status, response.text).toBe(200)
      const result = (JSON.parse(response.text) as { result: { ok: boolean; value: T; error?: unknown } }).result
      expect(result.ok, JSON.stringify(result.error)).toBe(true)
      return result.value
    }
    async function session(cookie: string, selectModel = true) {
      const { workspace } = await rpc<{ workspace: { workspaceId: string } }>(cookie, 'workspace/create', { request: {} })
      const { sessionId } = await rpc<{ sessionId: string }>(cookie, 'session/create', { request: { workspaceId: workspace.workspaceId } })
      if (selectModel) await rpc(cookie, 'session/selectModel', { request: { sessionId, provider: 'vultr', model } })
      return sessionId
    }
    async function prompt(cookie: string, sessionId: string, expected: string) {
      await rpc(cookie, 'session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Reply briefly.' }] } })
      await expect.poll(async () => JSON.stringify(await rpc<Events>(cookie, 'session/events', { request: { address: { kind: 'session', sessionId } } })),
        { timeout: 30_000 }).toContain(expected)
    }
    return { login, rpc, session, prompt }
  }

  let aliceCredential: Credential | undefined
  let originalKey: Buffer | undefined
  await withDefaultWeb(t, async ({ url, request }) => {
    const roster = await request('roster')
    expect(roster.client.entries.map(entry => entry.id)).toContain('@deepseek-ai/dsh-client-ui-user-credentials')
    const { login, rpc, session, prompt } = api(url)
    const alice = await login('alice')
    const catalog = await rpc<Catalog>(alice, 'session/modelCatalog')
    expect(catalog.groups.map(group => group.id)).toEqual(['vultr'])
    expect(catalog.default).toEqual({ provider: 'vultr', model })
    expect(catalog.groups.find(group => group.id === 'vultr')?.models.map(entry => entry.id))
      .toEqual(vultr.models!.map(entry => entry.id))
    expect(await rpc(alice, 'userCredentials/list')).toEqual([])
    await prompt(alice, await session(alice, false), 'PERSONAL_CREDENTIAL_MISSING')
    expect(requests).toHaveLength(0)
    aliceCredential = await rpc<Credential>(alice, 'userCredentials/create', { request: { name: 'Vultr API Key', value: 'ALICE-INFERENCE-CANARY' } })
    originalKey = await readFile(join(home, 'secrets', 'user-credentials.key'))
    expect(originalKey).toHaveLength(32)
    expect(await readFile(join(home, 'storages', 'user_credentials.json'), 'utf8')).not.toContain('ALICE-INFERENCE-CANARY')
  }, { home, patches: [antfarmPatch, noTitlePatch], prepare: async () => {
    const backend = new JsonStorageBackend(join(home, 'storages'))
    try {
      const unit = await backend.kv.open(descriptorOf(multiuserDomainSpec))
      await unit.loadAll()
      for (const username of ['alice', 'bob']) {
        const id = `user-${randomUUID()}`
        await unit.putRecord('users', id, { id, username, usernameNormalized: username, password: await hashPassword(password), createdAt: new Date().toISOString() })
      }
    } finally { await backend.close() }
  } })
  await withDefaultWeb(t, async ({ url }) => {
    const { login, rpc, session, prompt } = api(url)
    const alice = await login('alice')
    const bob = await login('bob')
    expect(await rpc<Credential[]>(alice, 'userCredentials/list')).toEqual([expect.objectContaining(aliceCredential!)])
    expect(await readFile(join(home, 'secrets', 'user-credentials.key'))).toEqual(originalKey)
    await prompt(bob, await session(bob), 'PERSONAL_CREDENTIAL_MISSING')
    expect(requests).toHaveLength(0)
    await rpc(bob, 'userCredentials/create', { request: { name: 'Vultr API Key', value: 'BOB-INFERENCE-CANARY' } })
    await prompt(alice, await session(alice), 'PERSONAL-MODEL-REPLY')
    await prompt(bob, await session(bob), 'PERSONAL-MODEL-REPLY')
    expect(requests.map(request => request.authorization)).toEqual(['Bearer ALICE-INFERENCE-CANARY', 'Bearer BOB-INFERENCE-CANARY'])
    expect(JSON.stringify(requests.map(request => request.body))).not.toMatch(/INFERENCE-CANARY|GLOBAL-MUST-NOT-BE-USED/)
    await rpc(alice, 'userCredentials/delete', { request: { id: aliceCredential!.id } })
    await prompt(alice, await session(alice), 'PERSONAL_CREDENTIAL_MISSING')
    expect(requests).toHaveLength(2)
    expect((await rpc<Catalog>(alice, 'session/modelCatalog')).groups.find(group => group.id === 'vultr')?.models).toHaveLength(3)
    await prompt(bob, await session(bob), 'PERSONAL-MODEL-REPLY')
    expect(requests.at(-1)?.authorization).toBe('Bearer BOB-INFERENCE-CANARY')
    status = 401
    await prompt(bob, await session(bob), 'AUTH')
    status = 503
    await prompt(bob, await session(bob), 'SERVER')
    expect(requests).toHaveLength(5)
  }, { home, patches: [antfarmPatch, noTitlePatch, externalPatch] })
}, 120_000)
