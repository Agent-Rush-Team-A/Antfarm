/** Route refusals and lifecycle settlement, with real Connection and filesystem. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection/src/rpc-host.ts'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection/src/rpc.ts'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, vi } from 'vitest'
import WorkspaceArtifacts from '../src/index.ts'

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

export async function setup(maxDownloadBytes = 3) {
  const home = await mkdtemp(join(tmpdir(), 'artifacts-route-'))
  const root = join(home, 'workspace')
  await mkdir(root)
  await writeFile(join(root, 'file'), 'abc')
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
  const fiber = ctx.plugin(WorkspaceArtifacts, { maxDownloadBytes })
  await fiber.await()
  const service = ctx.get('workspaceArtifacts') as WorkspaceArtifacts
  const handler = connection.createSharedFetchHandler('/api')
  const invocation: RemoteInvocation = {
    request: { namespace: 'workspaceArtifacts', method: 'list', args: {} },
    service: 'workspaceArtifacts', peer: connection.browserPeer, signal: new AbortController().signal,
    uplink: <In>(): AsyncIterable<In> => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
  }
  const request = (query = 'workspaceId=workspace-id&path=file', options: RequestInit = {}) => new Request(
    'http://host/api/workspace/downloadFileBinary?' + query,
    { method: 'GET', ...options },
  )
  return { ctx, home, root, fiber, service, request, decide, remote: ctx.extend({ invocation }).workspaceArtifacts,
    route: registrations[0]!, peer: connection.browserPeer,
    send: (request: Request) => handler.fetch(request, connection.browserPeer),
    absent: () => { present = false }, revoke: () => { allowed = false },
  }
}
