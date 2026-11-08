/** Workspace archival through real ownership, Gateway and Runner cleanup. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fixture, running } from './fixtures/management.ts'

test('archive confirms sandbox release, retains files and ownership, and restores without starting resources', async () => {
  const f = await fixture()
  await writeFile(join(f.alice.workspace.path, 'keep.txt'), 'kept')
  const invoke = async (archived: boolean) => (await f.raw(f.alice.cookie, 'workspace/setArchived', {
    request: { workspaceId: f.alice.id, archived },
  })).json()
  expect(await invoke(true)).toMatchObject({ result: { ok: true, value: { workspace: { archived: true } } } })
  expect(f.calls.map(call => call.method)).toEqual(['DELETE'])
  expect(f.ctx.multiuser.ownsWorkspace(f.alice.user.userId, f.alice.id)).toBe(true)
  expect(await f.rpc(f.alice.cookie, 'open', { workspaceId: f.alice.id })).toMatchObject({ ok: false, error: { code: 'workspace/archived' } })
  expect(await readFile(join(f.alice.workspace.path, 'keep.txt'), 'utf8')).toBe('kept')
  await expect(f.ctx.workspaceRegistry.modes.acquireUse(f.alice.id, { signal: new AbortController().signal, admit: () => {} }))
    .rejects.toMatchObject({ code: 'workspace/archived' })
  expect(await invoke(false)).toMatchObject({ result: { ok: true, value: { workspace: { archived: false } } } })
  expect(f.calls.map(call => call.method)).toEqual(['DELETE'])
  expect((await f.rpc(f.alice.cookie, 'open', { workspaceId: f.alice.id })).ok).toBe(true)
  expect(f.calls.map(call => call.method)).toEqual(['DELETE', 'PUT'])
})

test('a different account cannot archive another workspace or release its sandbox', async () => {
  const f = await fixture()
  const response = await f.raw(f.bob.cookie, 'workspace/setArchived', { request: { workspaceId: f.alice.id, archived: true } })
  expect(await response.json()).toMatchObject({ result: { ok: false, error: { code: 'remote-access/denied' } } })
  expect(f.alice.workspace.archived).toBeUndefined()
  expect(f.calls).toEqual([])
})

test('cleanup failure leaves the workspace active and owned, and a later confirmed retry can archive it', async () => {
  const f = await fixture()
  f.control.respond = (response) => { response.writeHead(409).end(JSON.stringify({ error: 'sandbox_cleanup_required' })) }
  await expect(f.ctx.workspaceRegistry.setArchived(f.alice.id, true)).rejects.toMatchObject({ code: 'sandbox/failed' })
  expect(f.alice.workspace.archived).toBeUndefined()
  expect(f.ctx.multiuser.ownsWorkspace(f.alice.user.userId, f.alice.id)).toBe(true)
  f.control.respond = (response, method) => { response.end(JSON.stringify(method === 'DELETE' ? { state: 'closed' } : running)) }
  await expect(f.ctx.workspaceRegistry.setArchived(f.alice.id, true)).resolves.toMatchObject({ archived: true })
})

test('archive blocks new admission while a live lease drains and awaits cleanup before publishing', async () => {
  const f = await fixture()
  const lease = await f.ctx.workspaceRegistry.modes.acquireUse(f.alice.id, { signal: new AbortController().signal, admit: () => {} })
  const archiving = f.ctx.workspaceRegistry.setArchived(f.alice.id, true)
  await Promise.resolve()
  await Promise.resolve()
  expect(f.alice.workspace.archived).toBeUndefined()
  expect(f.calls).toEqual([])
  lease.release()
  await expect(archiving).resolves.toMatchObject({ archived: true })
})
