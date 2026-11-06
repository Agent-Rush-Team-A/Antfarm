/** Route refusals and lifecycle settlement, with real Connection and filesystem. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection/src/rpc-host.ts'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection/src/rpc.ts'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { afterEach, vi } from 'vitest'
import WorkspaceUpload from '../src/index.ts'

const roots: Array<{ ctx: Context; home: string }> = []
afterEach(async () => {
  for (const { ctx, home } of roots.splice(0)) {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
export const id = 'workspace-id' as WorkspaceId

export async function setup(maxBytes = 3) {
  const home = await mkdtemp(join(tmpdir(), 'upload-route-'))
  const root = join(home, 'workspace')
  await mkdir(root)
  const ctx = new Context()
  roots.push({ ctx, home })
  const connectionFiber = ctx.plugin((scope: Context) => { new HostConnectionService(scope, [], {} as BrowserAuth) })
  await connectionFiber.await()
  const connection = ctx.get('connection') as HostConnectionService
  const workspace = { path: root }
  let present = true
  let allowed = true
  ctx.provide('workspaceRegistry', { get: (workspaceId: WorkspaceId) => present && workspaceId === id ? workspace : undefined } as never)
  ctx.provide('workspaceController', {} as never)
  ctx.provide('typert', {} as never)
  const decide = vi.fn(() => allowed ? { kind: 'allow' as const } : { kind: 'deny' as const, reason: 'revoked' })
  ctx.provide('remoteAccess', { decide } as never)
  const transport = connection.fetch
  const registrations: ConnectionFetchRoute[] = []
  vi.spyOn(connection, 'fetch', 'get').mockReturnValue({
    register: (route) => { registrations.push(route); return transport.register(route) },
  })
  const fiber = ctx.plugin(WorkspaceUpload, { maxBytes })
  await fiber.await()
  const service = ctx.get('workspaceUpload') as WorkspaceUpload
  const handler = connection.createSharedFetchHandler('/api')
  const request = (query = 'workspaceId=workspace-id&name=file', options: RequestInit = {}) => new Request(
    'http://host/api/workspace/uploadFileBinary?' + query,
    { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'abc', ...options },
  )
  return { ctx, home, root, fiber, service, request, decide,
    route: registrations[0]!, peer: connection.browserPeer,
    send: (request: Request) => handler.fetch(request, connection.browserPeer),
    absent: () => { present = false }, revoke: () => { allowed = false },
  }
}
