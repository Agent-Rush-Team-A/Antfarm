/** Real Web-profile process, native account storage and externally controlled Runner HTTP. */
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type ServerResponse } from 'node:http'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, vi, type TestContext } from 'vitest'
import { descriptorOf } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { hashPassword, multiuserDomainSpec } from '@deepseek-ai/dsh-api-multiuser'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SandboxIdleActivity, RunnerSandboxStatus, SandboxContainerId } from '@deepseek-ai/dsh-harness-sandbox'
import { withDefaultWeb, webRequest } from '../../web/tests/default-web-process.ts'

interface Call { method: string; path: string; id: string; body: Record<string, string> }

/** @param t - Case owning the socket and persistent workspace mount. @returns Controlled external Runner. */
export async function idleRunner(t: TestContext) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-idle-workspaces-'))
  t.onTestFinished(async () => { await rm(workspaceRoot, { recursive: true, force: true }) })
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\dsh-idle-${randomUUID()}` : `/tmp/dsh-idle-${randomUUID()}.sock`
  const calls: Call[] = []
  const states = new Map<string, RunnerSandboxStatus>()
  const errors = new Map<string, string>()
  const listeners = new Set<() => void>()
  let generation = 0
  const control = {
    workspaceRoot, socketPath, calls, states, errors, password: randomUUID(),
    respond: (response: ServerResponse, call: Call) => {
      const error = errors.get(`${call.method}:${call.id}`)
      if (error) { response.writeHead(503).end(JSON.stringify({ error })); return }
      if (call.path.endsWith('/exec/cancel')) {
        response.writeHead(202).end(JSON.stringify({ executionId: call.body.executionId,
          containerId: call.body.expectedContainerId, cancellation: 'requested' }))
      } else if (call.path.endsWith('/exec')) {
        response.end(JSON.stringify({ executionId: call.body.executionId, exitCode: 0,
          stdout: { text: 'PROFILE_IDLE_OK\n', truncated: false }, stderr: { text: '', truncated: false } }))
      } else {
        if (call.method === 'PUT' && states.get(call.id)?.state !== 'running') {
          states.set(call.id, { state: 'running', containerId: brandString<SandboxContainerId>((++generation).toString(16).padStart(64, '0')) })
        }
        if (call.method === 'DELETE') states.set(call.id, { state: 'closed' })
        response.end(JSON.stringify(states.get(call.id) ?? { state: 'closed' }))
      }
    },
    hold: (method: string, id: string, ending = '/sandbox') => {
      const entered = Promise.withResolvers<{ response: ServerResponse; call: Call }>()
      const original = control.respond
      let pending: { response: ServerResponse; call: Call } | undefined
      control.respond = (response, call) => {
        if (!pending && call.method === method && call.id === id && call.path.endsWith(ending)) {
          pending = { response, call }; entered.resolve(pending)
        } else original(response, call)
      }
      const release = () => { if (pending && !pending.response.writableEnded) original(pending.response, pending.call) }
      t.onTestFinished(release)
      return { entered: entered.promise, release }
    },
    seen: (method: string, id: string, ending: string) => {
      const found = () => calls.some(call => call.method === method && call.id === id && call.path.endsWith(ending))
      if (found()) return Promise.resolve()
      return new Promise<void>((resolve) => {
        const listener = () => { if (found()) { listeners.delete(listener); resolve() } }
        listeners.add(listener)
      })
    },
  }
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8').on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      const path = request.url!
      const call = { method: request.method!, path, id: path.split('/')[3]!, body: body ? JSON.parse(body) as Record<string, string> : {} }
      calls.push(call)
      control.respond(response, call)
      for (const listener of listeners) listener()
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
  vi.stubEnv('DSH_MULTIUSER_WORKSPACE_ROOT', workspaceRoot)
  return control
}

/** Internal observations from the test-only clock control. */
export interface IdleState {
  now: number
  scheduled: number
  cleared: number
  timers: number
  activity: SandboxIdleActivity
  candidates: string[]
}

/** Public RPC receipt, retaining denial and failure evidence. */
interface Receipt { ok: boolean; value: Record<string, unknown>; error?: { code: string } }

interface ModelRequest { label: string; cancelled: boolean; tools: string[] }

/**
 * @param t - Owning case.
 * @param runner - External Runner.
 * @param inspect - Product assertions.
 * @param seed - Optional saved native storage; omission provisions fresh accounts.
 */
export async function withIdleWeb(
  t: TestContext, runner: Awaited<ReturnType<typeof idleRunner>>,
  inspect: (app: {
    root: string
    output: () => { stdout: string; stderr: string }
    rpc: (cookie: string, method: string, request: unknown) => Promise<Receipt>
    control: (body: Record<string, unknown>) => Promise<IdleState>
    model: (body: Record<string, unknown>) => Promise<ModelRequest[]>
    account: (username: string) => Promise<{ cookie: string; userId: string; id: string }>
  }) => Promise<void>, seed?: string,
) {
  const patches = ['antfarm-web.patch.yml', 'examples/harness-sandbox.patch.yml'].map(path => fileURLToPath(new URL(`../../../../config/${path}`, import.meta.url)))
  await withDefaultWeb(t, async ({ root, url, output }) => {
    const post = (path: string, body: unknown, cookie = '') => webRequest(new URL(path, url), t.signal, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: new URL(url).origin, cookie }, body: JSON.stringify(body),
    })
    const rpc = async (cookie: string, method: string, request: unknown): Promise<Receipt> => {
      const response = await post(`/api/${method}`, { type: 'client-request', rpcId: randomUUID(), method, payload: { args: { request } } }, cookie)
      expect(response.status, response.text).toBe(200)
      return (JSON.parse(response.text) as { result: Receipt }).result
    }
    const control = async (body: Record<string, unknown>) => {
      const response = await post('/__test/sandbox-idle', body)
      expect(response.status, response.text).toBe(200)
      return JSON.parse(response.text) as IdleState
    }
    const model = async (body: Record<string, unknown>) => {
      const response = await post('/__test/sandbox-idle-model', body)
      expect(response.status, response.text).toBe(200)
      return JSON.parse(response.text) as ModelRequest[]
    }
    const account = async (username: string) => {
      const login = await post('/auth/login', { username, password: runner.password })
      expect(login.status, login.text).toBe(200)
      const cookie = login.headers['set-cookie']![0]!.split(';')[0]!
      const created = await rpc(cookie, 'workspace/create', { title: username })
      expect(created.ok).toBe(true)
      return { cookie, userId: (JSON.parse(login.text) as { user: { userId: string } }).user.userId,
        id: (created.value.workspace as { workspaceId: string }).workspaceId }
    }
    await inspect({ root, rpc, control, model, account, output })
  }, { patches, prepare: async (root) => {
    const patch = join(root, 'idle-test.patch.yml')
    await writeFile(patch, JSON.stringify([
      { id: 'sandbox-idle', inject: ['multiuser', 'workspaceRegistry', 'workspaceSandboxState', 'sandboxIdleTestClock'], config: { sweepIntervalMs: 60_001 } },
      { insert: [{ id: 'sandbox-idle-control', name: new URL('./idle-control.mjs', import.meta.url).href },
        { id: 'sandbox-idle-model', name: new URL('./idle-model.mjs', import.meta.url).href }] },
      { id: 'agent-default-model', config: { provider: 'sandbox-idle-fixture', model: 'fixture' } }, { id: 'session-title', disabled: true },
    ]))
    patches.push(patch)
    if (seed) { await cp(seed, join(root, 'home', 'storages'), { recursive: true }); return }
    const backend = new JsonStorageBackend(join(root, 'home', 'storages'))
    try {
      const unit = await backend.kv.open(descriptorOf(multiuserDomainSpec))
      await unit.loadAll()
      for (const username of ['alice', 'bob']) {
        const id = `user-${randomUUID()}`
        await unit.putRecord('users', id, { id, username, usernameNormalized: username, password: await hashPassword(runner.password), createdAt: new Date().toISOString() })
      }
    } finally { await backend.close() }
  } })
}
