/** Personal credential save, public discovery and model selection through the built Web profile. */
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { driveVultrModelDiscovery } from '../../../apps/web/tests/vultr-model-discovery.browser.ts'
import { expect, test } from 'vitest'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { formatSystemPromptSnapshot, formatToolSchemasSnapshot, normalizedSystemPrompts, normalizedToolSchemas,
  normalizeSessionSnapshot, redactSessionSnapshotIds } from '@deepseek-ai/dsh-session-snapshot'
import { descriptorOf } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { hashPassword, multiuserDomainSpec } from '@deepseek-ai/dsh-api-multiuser'
import { withDefaultWeb } from '../../../apps/cli/tests/profiles/web/tests/default-web-process.ts'

const directory = fileURLToPath(new URL('.', import.meta.url))
const antfarm = fileURLToPath(new URL('../../../apps/cli/config/antfarm-web.patch.yml', import.meta.url))
const observer = new URL('../../../apps/cli/tests/profiles/web/tests/fixtures/vultr-snapshot-observer.mjs', import.meta.url).href

test('snapshot: saving a personal Vultr key loads models and calls a newly discovered model', async (t) => {
  const refresh = process.env.DSH_SNAPSHOT === 'refresh'
  const source = await readFile(join(directory, 'session.v4.jsonl'), 'utf8')
  const events = parseSessionLog(source)
  const task = events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user'
    ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])[0]!
  const reply = events.flatMap(event => event.type === 'assistant/message'
    ? event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : []).join('')
  const catalog = await readFile(new URL('../../../packages/llm/llm-pi-ai/tests/fixtures/vultr-catalog.json', import.meta.url), 'utf8')
  const calls: Array<{ authorization: string; model: string; maxTokens: number }> = []
  const directoryAuth: string[] = []
  const key = 'KEYLESS-VULTR-SNAPSHOT'
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      directoryAuth.push(request.headers.authorization ?? '')
      response.setHeader('Content-Type', 'application/json'); response.end(catalog); return
    }
    let body = ''
    request.setEncoding('utf8').on('data', (chunk: string) => { body += chunk }).on('end', () => {
      const parsed = JSON.parse(body) as { model: string; max_tokens: number }
      calls.push({ authorization: request.headers.authorization ?? '', model: parsed.model, maxTokens: parsed.max_tokens })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const choice of [
        { index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null },
        { index: 0, delta: {}, finish_reason: 'stop' },
      ]) response.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1,
        model: parsed.model, choices: [choice] }) + '\n\n')
      response.end('data: [DONE]\n\n')
    })
  })
  t.onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing directory listener')
  const baseURL = `http://127.0.0.1:${address.port}/v1`
  const patches = [antfarm]
  const password = randomUUID()
  await withDefaultWeb(t, async ({ url, request }) => {
    await request('roster')
    const observed = await driveVultrModelDiscovery({ url, key, task, password, refresh })
    expect(calls).toEqual([{ authorization: `Bearer ${key}`, model: 'glm-5.2', maxTokens: 8192 }])
    expect(directoryAuth.length).toBeGreaterThan(0)
    expect(directoryAuth.every(value => value === '')).toBe(true)
    expect(observed.log).not.toContain(key)
    const normalizeContext = { sessionIds: [], cwd: observed.cwd }
    const actual = normalizeSessionSnapshot(redactSessionSnapshotIds([observed.log])[0]!, normalizeContext, { identityMode: 'preserve' })
    const prompt = formatSystemPromptSnapshot(normalizedSystemPrompts(observed.log, normalizeContext)[0]!)
    const schemas = formatToolSchemasSnapshot(normalizedToolSchemas(observed.log, normalizeContext)[0]!)
    for (const [name, value] of [['session.v4.jsonl', actual], ['system-prompt.expected.md', prompt], ['tool-schemas.expected.json', schemas]] as const) {
      if (refresh) await writeFile(join(directory, name), value)
      else expect(value, name).toBe(await readFile(join(directory, name), 'utf8'))
    }
  }, { patches, prepare: async root => {
    const patch = join(root, 'vultr.patch.yml')
    await writeFile(patch, JSON.stringify([
      { id: 'llm-pi-ai', config: { providers: { vultr: { displayName: 'Vultr', credentialScope: 'request', api: 'openai-completions', baseURL,
        modelDiscovery: { type: 'vultr', cachePath: join(root, 'cache', 'catalog.json') }, models: [{ id: 'deepseek-v4.1-flash-1017' }] } } } },
      { id: 'user-credentials', config: { encryptionKeyFile: join(root, 'credential.key'), initializeKeyIfEmpty: true,
        allowLoopbackHttp: true, inferenceBindings: [{ provider: 'vultr', baseURL, credentialName: 'Vultr API Key' }] } },
      { insert: [{ id: 'vultr-snapshot-observer', name: observer }] },
    ]))
    patches.push(patch)
    const backend = new JsonStorageBackend(join(root, 'home', 'storages'))
    try {
      const unit = await backend.kv.open(descriptorOf(multiuserDomainSpec)); await unit.loadAll()
      const id = `user-${randomUUID()}`
      await unit.putRecord('users', id, { id, username: 'alice', usernameNormalized: 'alice',
        password: await hashPassword(password), createdAt: new Date().toISOString() })
    } finally { await backend.close() }
  } })
})
