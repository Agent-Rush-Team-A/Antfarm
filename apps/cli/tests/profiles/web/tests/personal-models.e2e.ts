/** Credentialed Vultr acceptance through the default Antfarm Web process. */
import { randomUUID } from 'node:crypto'
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

const apiKey = process.env.VULTR_API_KEY
const antfarmPatch = fileURLToPath(new URL('../../../../config/antfarm-web.patch.yml', import.meta.url))

test.skipIf(process.platform !== 'linux' || !apiKey)('saved personal Vultr credentials produce a real model reply before and after Web restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'antfarm-vultr-inference-'))
  t.onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  vi.stubEnv('DSH_USER_CREDENTIALS_KEY_FILE', undefined)
  vi.stubEnv('DSH_MULTIUSER_WORKSPACE_ROOT', undefined)
  t.onTestFinished(() => { vi.unstubAllEnvs() })
  const home = join(root, 'home')
  const password = randomUUID()
  const schema = yaml.JSON_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => String(value) }))
  const defaults = yaml.load(await readFile(antfarmPatch, 'utf8'), { schema }) as Array<{ id?: string; config?: { providers?: Record<string, PiAiProviderProfile> } }>
  const profile = defaults.find(row => row.id === 'llm-pi-ai')?.config?.providers?.vultr
  if (profile?.models === undefined) throw new Error('Default Antfarm entry must configure Vultr models')
  const bounded = join(root, 'bounded-call.patch.yml')
  await writeFile(bounded, yaml.dump([
    { id: 'llm-pi-ai', config: { providers: { vultr: { ...profile, retryPolicy: { mode: 'normal', maxRetries: 0 },
      models: profile.models.map(model => ({ ...model, maxTokens: 128 })) } } } },
    { id: 'session-title-llm', disabled: true },
  ]))
  let savedId: string | undefined
  for (const restart of [false, true]) {
    await withDefaultWeb(t, async ({ url }) => {
      const origin = new URL(url).origin
      const login = await webRequest(new URL('/auth/login', url), t.signal, { method: 'POST', headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ username: 'inference-user', password }) })
      expect(login.status).toBe(200)
      const cookie = login.headers['set-cookie']![0]!.split(';', 1)[0]!
      async function rpc<T>(method: string, args: unknown = {}): Promise<T> {
        const response = await webRequest(new URL(`/api/${method}`, url), t.signal, { method: 'POST', headers: { 'content-type': 'application/json', origin, cookie },
          body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }) })
        expect(response.status).toBe(200)
        const result = (JSON.parse(response.text) as { result: { ok: boolean; value: T; error?: { code: string } } }).result
        expect(result.ok, result.error?.code).toBe(true)
        return result.value
      }
      if (!restart) savedId = (await rpc<{ id: string }>('userCredentials/create', { request: { name: 'Vultr API Key', value: apiKey! } })).id
      else expect(await rpc('userCredentials/check', { request: { id: savedId! } })).toEqual({ readable: true })
      const { workspace } = await rpc<{ workspace: { workspaceId: string } }>('workspace/create', { request: {} })
      const { sessionId } = await rpc<{ sessionId: string }>('session/create', { request: { workspaceId: workspace.workspaceId } })
      await rpc('session/selectModel', { request: { sessionId, provider: 'vultr', model: 'qwen3.8-27b' } })
      await rpc('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue',
        content: [{ type: 'text', text: 'Do not use tools. Reply with the exact word ANTFARM_OK and nothing else.' }] } })
      await expect.poll(async () => JSON.stringify(await rpc('session/events', { request: { address: { kind: 'session', sessionId } } })),
        { timeout: 60_000 }).toMatch(/assistant\/message/)
      const page = await rpc<{ records: Array<{ event: { type: string } }> }>('session/events', { request: { address: { kind: 'session', sessionId } } })
      const assistant = page.records.filter(record => record.event.type === 'assistant/message')
      expect(JSON.stringify(assistant)).toContain('ANTFARM_OK')
      const events = JSON.stringify(page)
      expect(events.includes(apiKey!), 'Credential must not enter Session output').toBe(false)
      expect((await readFile(join(home, 'storages', 'user_credentials.json'), 'utf8')).includes(apiKey!), 'Credential must stay encrypted on disk').toBe(false)
    }, { home, patches: [antfarmPatch, bounded], ...restart ? {} : { prepare: async () => {
      const backend = new JsonStorageBackend(join(home, 'storages'))
      try {
        const unit = await backend.kv.open(descriptorOf(multiuserDomainSpec))
        await unit.loadAll()
        const id = `user-${randomUUID()}`
        await unit.putRecord('users', id, { id, username: 'inference-user', usernameNormalized: 'inference-user',
          password: await hashPassword(password), createdAt: new Date().toISOString() })
      } finally { await backend.close() }
    } } })
  }
}, 180_000)
