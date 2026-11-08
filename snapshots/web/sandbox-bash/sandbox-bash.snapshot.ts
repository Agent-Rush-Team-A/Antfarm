/** Recorded-session replay through dsh Web, native authentication and the shipped Runner Bash preset. */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'
import { deriveReplayScript, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { formatSystemPromptSnapshot, formatToolSchemasSnapshot, normalizedSystemPrompts, normalizedToolSchemas,
  normalizeSessionSnapshot, redactSessionSnapshotIds } from '@deepseek-ai/dsh-session-snapshot'
import { descriptorOf } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { hashPassword, multiuserDomainSpec } from '@deepseek-ai/dsh-api-multiuser'
import { withDefaultWeb, webRequest } from '../../../apps/cli/tests/profiles/web/tests/default-web-process.ts'

const directory = fileURLToPath(new URL('.', import.meta.url))
const fixture = join(directory, 'session.v4.jsonl')
const overlay = fileURLToPath(new URL('../../../apps/cli/config/examples/harness-sandbox.patch.yml', import.meta.url))
const antfarmWeb = fileURLToPath(new URL('../../../apps/cli/config/antfarm-web.patch.yml', import.meta.url))
const stdout = '中\0'.repeat(16_384)
const stderr = `${'e'.repeat(65_525)}diagnostic\n`

test('snapshot: Web multi-VM Bash retains its generation across Sessions and releases it on idle, archive and delete', async (t) => {
  const refresh = process.env.DSH_SNAPSHOT === 'refresh'
  expect(existsSync(fixture), 'replay requires the committed Session fixture').toBe(true)
  const source = await readFile(fixture, 'utf8')
  const script = deriveReplayScript(parseSessionLog(source))
  const task = parseSessionLog(source).flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user'
      ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])[0]!
  const password = randomUUID()
  const patches = [antfarmWeb, overlay]
  const calls: Array<{ method: string | undefined; path: string; body: Record<string, unknown> }> = []
  let running = false
  let allocations = 0
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\dsh-sandbox-snapshot-${randomUUID()}` : `/tmp/dsh-sandbox-${randomUUID()}.sock`
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8').on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      const parsed = body === '' ? {} : JSON.parse(body) as Record<string, unknown>
      calls.push({ method: request.method, path: request.url!, body: parsed })
      if (request.method === 'PUT') { if (!running) allocations++; running = true }
      if (request.method === 'DELETE') running = false
      response.end(JSON.stringify(request.url?.endsWith('/exec') ? {
        executionId: parsed.executionId, exitCode: parsed.command === 'pwd' ? 0 : 7,
        stdout: { text: parsed.command === 'pwd' ? '/workspace\n' : stdout, truncated: parsed.command !== 'pwd' },
        stderr: { text: parsed.command === 'pwd' ? '' : stderr, truncated: parsed.command !== 'pwd' },
      } : running ? { state: 'running', containerId: (allocations === 1 ? 'a' : 'b').repeat(64) } : { state: 'closed' }))
    })
  })
  t.onTestFinished(async () => {
    vi.unstubAllEnvs()
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() })
  })
  await once(server.listen(socketPath), 'listening')
  vi.stubEnv('DSH_SANDBOX_RUNNER_SOCKET', socketPath)
  await withDefaultWeb(t, async ({ root, url, output }) => {
    const post = (path: string, body: unknown, cookie = '') => webRequest(new URL(path, url), t.signal, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: new URL(url).origin, cookie }, body: JSON.stringify(body),
    })
    const login = await post('/auth/login', { username: 'alice', password })
    expect(login.status).toBe(200)
    const cookie = login.headers['set-cookie']![0]!.split(';')[0]!
    const rpc = async (method: string, request: unknown) => {
      const response = await post(`/api/${method}`, { type: 'client-request', rpcId: randomUUID(), method, payload: { args: { request } } }, cookie)
      expect(response.status, response.text).toBe(200)
      const envelope = JSON.parse(response.text) as { result: { ok: boolean; value: Record<string, unknown> } }
      expect(envelope.result.ok, response.text + '\n' + output().stderr).toBe(true)
      return envelope.result.value
    }
    const workspace = (await rpc('workspace/create', { title: 'snapshot' })).workspace as { workspaceId: string }
    const sessionId = (await rpc('session/create', { workspaceId: workspace.workspaceId })).sessionId as string
    const requestId = randomUUID()
    expect(await rpc('session/prompt', { sessionId, requestId, mode: 'queue', content: [{ type: 'text', text: task }] })).toMatchObject({ accepted: true })
    const response = await post('/__test/sandbox-snapshot', {})
    expect(response.status, response.text).toBe(200)
    const observed = JSON.parse(response.text) as { log: string; requests: Array<{ messages: unknown[]; tools: Array<{ name: string }> }>; presentations: unknown[] }
    expect(observed.requests).toHaveLength(4)
    for (const request of observed.requests) {
      expect(request.tools.map(tool => tool.name)).toEqual(['bash'])
      const modelText = JSON.stringify(request)
      expect(modelText).toContain('Current working directory: \\"/workspace\\".')
      for (const hidden of [root, 'a'.repeat(64), 'expectedContainerId', 'workspaceId', 'run_in_background', 'sandbox_permissions']) expect(modelText).not.toContain(hidden)
      expect(modelText).not.toContain('session workspace:')
      expect(modelText).not.toContain('Current DSH file policy:')
      expect(modelText).not.toContain('full path relative to the working directory')
    }
    expect(JSON.stringify(observed.requests[2]?.messages)).toContain('diagnostic')
    expect(JSON.stringify(observed.requests[2]?.messages)).toContain('[exit code: 7]')
    expect(observed.presentations).toMatchObject([
      { call: { card: 'terminal', cwd: '/workspace' }, result: { card: 'terminal', exitCode: 0, output: '/workspace\n' } },
      { call: { card: 'terminal', cwd: '/workspace' }, result: { card: 'terminal', exitCode: 7 } },
      { call: { card: 'terminal', cwd: '/workspace' }, result: { card: 'generic', content: [{ type: 'text',
        text: 'Error: Invalid command request. Check the arguments and keep the complete UTF-8 JSON request within 64 KiB.' }] } },
    ])
    expect(JSON.stringify(observed.requests[3]?.messages)).toContain('Invalid command request. Check the arguments and keep the complete UTF-8 JSON request within 64 KiB.')
    expect(JSON.stringify(observed.requests[2]?.messages)).toContain(JSON.stringify(stdout).slice(1, -1))
    expect(JSON.stringify(observed.requests[2]?.messages)).toContain(JSON.stringify(stderr).slice(1, -1))
    expect(JSON.stringify(observed.requests[2]?.messages)).not.toContain('Full formatted result stored at:')
    expect(JSON.stringify(observed.requests[2]?.messages)).not.toContain('Use read with offset/limit')
    const events = await rpc('session/events', { address: { kind: 'session', sessionId }, maxMessages: 100 })
    expect(JSON.stringify(events)).toContain('"exitCode":7')
    expect(JSON.stringify(events)).toContain('diagnostic')
    const executions = calls.filter(call => call.path.endsWith('/exec'))
    expect(executions).toHaveLength(2)
    expect(calls.map(call => call.method)).toEqual(['PUT', 'POST', 'POST'])
    expect(executions.map(call => call.body.workdir)).toEqual(['.', '.'])
    expect(new Set(executions.map(call => call.body.executionId)).size).toBe(2)
    const cwd = (calls[0]!.body.workspaceDir as string)
    const context = { sessionIds: [], cwd }
    const redacted = redactSessionSnapshotIds([observed.log])[0]!
    const actual = normalizeSessionSnapshot(redacted, context, { identityMode: 'preserve' })
    const prompt = formatSystemPromptSnapshot(normalizedSystemPrompts(observed.log, context)[0]!)
    const schemas = formatToolSchemasSnapshot(normalizedToolSchemas(observed.log, context)[0]!)
    for (const [name, value] of [['session.v4.jsonl', actual], ['system-prompt.expected.md', prompt], ['tool-schemas.expected.json', schemas],
      ['presentation.expected.json', JSON.stringify(observed.presentations, null, 2) + '\n']] as const) {
      if (refresh) await writeFile(join(directory, name), value)
      else expect(value, name).toBe(await readFile(join(directory, name), 'utf8'))
    }
    const secondSessionId = (await rpc('session/create', { workspaceId: workspace.workspaceId })).sessionId as string
    expect(await rpc('session/prompt', { sessionId: secondSessionId, requestId: randomUUID(), mode: 'queue',
      content: [{ type: 'text', text: task }] })).toMatchObject({ accepted: true })
    const secondIdle = await post('/__test/sandbox-idle', { op: 'idle', sessionId: secondSessionId })
    expect(secondIdle.status, secondIdle.text).toBe(200)
    expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(0)
    expect(allocations).toBe(1)
    expect(calls.filter(call => call.path.endsWith('/exec'))).toHaveLength(4)
    expect(new Set(calls.filter(call => call.path.endsWith('/exec')).map(call => call.body.expectedContainerId))).toEqual(new Set(['a'.repeat(64)]))
    const reclaimed = await post('/__test/sandbox-idle', { op: 'round', advance: 1_800_000, workspaceId: workspace.workspaceId })
    expect(reclaimed.status, reclaimed.text).toBe(200)
    expect(JSON.parse(reclaimed.text)).toMatchObject({ activity: { busy: false, sandbox: { state: 'closed' } } })
    expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(1)
    expect(await rpc('workspaceSandbox/status', { workspaceId: workspace.workspaceId })).toEqual({ workspaceId: workspace.workspaceId, state: 'closed' })
    expect(await rpc('session/events', { address: { kind: 'session', sessionId }, maxMessages: 100 })).toEqual(events)
    const afterClose = await post('/__test/sandbox-snapshot', {})
    expect(afterClose.status, afterClose.text).toBe(200)
    const afterLog = (JSON.parse(afterClose.text) as { log: string }).log
    expect(normalizeSessionSnapshot(redactSessionSnapshotIds([afterLog])[0]!, context, { identityMode: 'preserve' })).toBe(actual)
    const beforeDuplicate = calls.length
    expect(await rpc('session/prompt', { sessionId, requestId, mode: 'queue', content: [{ type: 'text', text: task }] })).toMatchObject({ accepted: true })
    expect(calls).toHaveLength(beforeDuplicate)
    await rpc('workspaceSandbox/open', { workspaceId: workspace.workspaceId })
    await rpc('workspace/setArchived', { workspaceId: workspace.workspaceId, archived: true })
    expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(2)
    await rpc('workspace/setArchived', { workspaceId: workspace.workspaceId, archived: false })
    await rpc('workspaceSandbox/open', { workspaceId: workspace.workspaceId })
    await rpc('workspace/delete', { workspaceId: workspace.workspaceId })
    expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(3)
    expect(allocations).toBe(3)
  }, { patches, prepare: async (root) => {
    vi.stubEnv('DSH_MULTIUSER_WORKSPACE_ROOT', join(root, 'workspaces'))
    const patch = join(root, 'snapshot.patch.yml')
    await writeFile(patch, JSON.stringify([
      { id: 'workspace', config: { defaultMode: 'multi-vm' } },
      { id: 'workspace-sandbox', inject: ['sandboxRunnerClient'], config: { backend: 'provided', workspaceRoot: join(root, 'workspaces') } },
      { id: 'sandbox-idle', inject: ['multiuser', 'workspaceRegistry', 'workspaceSandboxState', 'sandboxIdleTestClock'], config: { sweepIntervalMs: 60_001 } },
      { insert: [{ id: 'sandbox-snapshot-control',
        name: new URL('../../../apps/cli/tests/profiles/harness-sandbox/fixtures/snapshot-control.mjs', import.meta.url).href, config: { script, repeatScript: true } },
      { id: 'sandbox-snapshot-modes', name: new URL('../../../apps/cli/tests/profiles/harness-sandbox/fixtures/snapshot-modes.mjs', import.meta.url).href },
      { id: 'sandbox-idle-clock', name: new URL('../../../apps/cli/tests/profiles/harness-sandbox/fixtures/idle-control.mjs', import.meta.url).href }] },
      { id: 'agent-default-model', config: { provider: 'sandbox-snapshot', model: 'fixture' } }, { id: 'session-title', disabled: true }]))
    patches.push(patch)
    const backend = new JsonStorageBackend(join(root, 'home', 'storages'))
    try {
      const unit = await backend.kv.open(descriptorOf(multiuserDomainSpec))
      await unit.loadAll()
      const id = `user-${randomUUID()}`
      await unit.putRecord('users', id, { id, username: 'alice', usernameNormalized: 'alice', password: await hashPassword(password), createdAt: new Date().toISOString() })
    } finally { await backend.close() }
  } })
}, 90_000)
