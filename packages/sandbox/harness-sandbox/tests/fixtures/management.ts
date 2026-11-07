/** Real login, durable ownership, workspace allocation, Gateway and local Runner HTTP. */

import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry, { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import WorkspaceController from '@deepseek-ai/dsh-api-workspace-controller'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import Multiuser from '@deepseek-ai/dsh-api-multiuser'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { expect, vi, onTestFinished } from 'vitest'
import WorkspaceSandbox from '../../src/index.ts'

export const running = { state: 'running', containerId: 'a'.repeat(64) }
export interface Call { method: string | undefined; path: string | undefined; body: unknown }
export interface RpcResult { ok: boolean; value?: unknown; error?: { code: string; message: string; details: unknown } }

export async function fixture(mutationTimeoutMs = 1000, persistentSessions = false, execTimeoutMs = 1000, queryTimeoutMs = 1000) {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'dsh-management-'))
  const workspaceRoot = join(home, 'workspaces')
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\dsh-management-${randomUUID()}` : join(home, 'runner.sock')
  const ctx = new Context()
  const calls: Call[] = []
  const control = { respond: (response: ServerResponse, method: string | undefined, _call: Call) => {
    response.end(JSON.stringify(method === 'DELETE' ? { state: 'closed' } : running))
  } }
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString()
      const parsed: unknown = body === '' ? undefined : JSON.parse(body)
      const call = { method: request.method, path: request.url, body: parsed }
      calls.push(call)
      control.respond(response, request.method, call)
    })
  })
  onTestFinished(async () => {
    vi.restoreAllMocks()
    await ctx.fiber.dispose()
    if (server.listening) await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
      server.closeAllConnections()
    })
    await rm(home, { recursive: true, force: true })
  })
  await once(server.listen(socketPath), 'listening')
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(home, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  // Session event bodies and owner credentials are outside these account lifecycle operations.
  if (persistentSessions) await ctx.plugin(JsonlPersistence, { root: join(home, 'sessions'), compression: 'none' })
  else ctx.provide('sessionPersistence', { list: async () => [], open: () => { throw new Error('unused') }, stat: () => { throw new Error('unused') } } as never)
  let credentialRecord: unknown
  ctx.provide('credentials', { readRecord: async () => credentialRecord, modifyRecord: async (_key: unknown, mutate: (current: unknown) => Promise<unknown>) => { credentialRecord = await mutate(credentialRecord); return credentialRecord } } as never)
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(Gateway)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(Connection, { multiuser: true })
  await ctx.plugin(WorkspaceController, {})
  await ctx.plugin(Multiuser, { workspaceRoot })
  const sandboxFiber = ctx.plugin(WorkspaceSandbox, {
    socketPath, workspaceRoot, mutationTimeoutMs, queryTimeoutMs, execTimeoutMs, cancelTimeoutMs: 1000,
  })
  await sandboxFiber
  const base = `http://127.0.0.1:${String(ctx.webServer.port)}`
  async function raw(cookie: string, method: string, args: unknown, origin = base) {
    return fetch(`${base}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', origin, cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }) })
  }
  async function rpc(cookie: string, operation: string, request: unknown): Promise<RpcResult> {
    const response = await raw(cookie, `workspaceSandbox/${operation}`, { request })
    expect(response.status).toBe(200)
    return (await response.json() as { result: RpcResult }).result
  }
  async function remove(cookie: string, workspaceId: string): Promise<RpcResult> {
    const response = await raw(cookie, 'workspace/delete', { request: { workspaceId } })
    expect(response.status).toBe(200)
    return (await response.json() as { result: RpcResult }).result
  }
  async function account(username: string) {
    const password = randomUUID()
    const user = await ctx.multiuser.provisionUser(username, password)
    const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ username, password }) })
    expect(response.status).toBe(200)
    const cookie = response.headers.getSetCookie()[0]!.split(';', 1)[0]!
    const created = await raw(cookie, 'workspace/create', { request: { title: username } })
    const result = (await created.json() as { result: RpcResult }).result
    expect(result.ok).toBe(true)
    const id = WorkspaceId((result.value as { workspace: { workspaceId: string } }).workspace.workspaceId)
    return { user, cookie, id, workspace: ctx.workspaceRegistry.get(id)! }
  }
  const alice = await account('alice')
  const bob = await account('bob')
  return { ctx, home, workspaceRoot, socketPath, server, control, calls, sandboxFiber, base, raw, rpc, remove, alice, bob }
}
