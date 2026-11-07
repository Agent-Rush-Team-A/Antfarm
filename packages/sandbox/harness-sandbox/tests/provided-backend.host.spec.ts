import { brandString } from '@deepseek-ai/dsh-brand'
import { expect, test, vi } from 'vitest'
import WorkspaceSandbox, { type SandboxContainerId } from '../src/index.ts'
import { SandboxExecutionBackend } from '../src/backend.ts'
import { fixture } from './fixtures/management.ts'

class ProvidedBackend extends SandboxExecutionBackend {
  readonly opened: string[] = []
  readonly operations: string[] = []
  private running = false
  override async open(_workspaceId: string, path: string) {
    this.operations.push('open')
    this.running = true
    this.opened.push(path)
    return { state: 'running' as const, containerId: brandString<SandboxContainerId>('b'.repeat(64)) }
  }
  override async status() {
    this.operations.push('status')
    return this.running ? { state: 'running' as const, containerId: brandString<SandboxContainerId>('b'.repeat(64)) } : { state: 'closed' as const }
  }
  override async close() { this.operations.push('close'); this.running = false; return { state: 'closed' as const } }
  override async execute(): Promise<never> { throw new Error('unused') }
  override async cancel(): Promise<never> { throw new Error('unused') }
}

test('provided mode needs no Runner socket and retains native user ownership and project records', async () => {
  const f = await fixture()
  await f.sandboxFiber.dispose()
  await f.ctx.plugin(ProvidedBackend)
  const backend = f.ctx.sandboxRunnerClient
  const manager = f.ctx.plugin(WorkspaceSandbox, { backend: 'provided', workspaceRoot: f.workspaceRoot })
  await manager
  expect(await f.rpc(f.bob.cookie, 'open', { workspaceId: f.alice.id })).toMatchObject({ ok: false })
  expect(await f.rpc(f.alice.cookie, 'open', { workspaceId: f.alice.id })).toMatchObject({ ok: true, value: { state: 'running' } })
  expect((backend as ProvidedBackend).opened).toEqual([f.alice.workspace.path])
  expect(f.calls).toEqual([])
  await expect(backend.files(f.alice.id, brandString<SandboxContainerId>('b'.repeat(64)))).rejects.toMatchObject({ code: 'workspace_files_unavailable' })
  await manager.dispose()
})

test('conditional idle close uses the provided backend and skips activity without contacting Runner', async () => {
  const f = await fixture()
  await f.sandboxFiber.dispose()
  await f.ctx.plugin(ProvidedBackend)
  const backend = f.ctx.sandboxRunnerClient as ProvidedBackend
  const manager = f.ctx.plugin(WorkspaceSandbox, { backend: 'provided', workspaceRoot: f.workspaceRoot })
  await manager
  let now = 100
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  await f.ctx.workspaceSandbox.openForUser(f.alice.user.userId, f.alice.id)
  const target = () => {
    const activity = f.ctx.workspaceSandbox.activityForUser(f.alice.user.userId, f.alice.id)
    if (activity.sandbox.state !== 'running' || activity.idleSince === null) throw new Error('Expected a running idle generation')
    return { containerId: activity.sandbox.containerId, version: activity.version,
      revision: activity.revision, idleSince: activity.idleSince }
  }
  const original = target()
  now += 1_800_000
  const finish = f.ctx.workspaceSandboxState.beginExecution(f.alice.id)
  finish()
  expect(await f.ctx.workspaceSandbox.closeIfIdleForUser(f.alice.user.userId, f.alice.id, original,
    1_800_000, new AbortController().signal)).toEqual({ state: 'skipped' })
  expect(backend.operations).toEqual(['open'])
  const current = target()
  expect(current.idleSince).toBe(now)
  now += 1_800_000
  expect(await f.ctx.workspaceSandbox.closeIfIdleForUser(f.alice.user.userId, f.alice.id, current,
    1_800_000, new AbortController().signal)).toEqual({ state: 'closed' })
  expect(backend.operations).toEqual(['open', 'status', 'status', 'close'])
  expect(f.calls).toEqual([])
  expect(f.ctx.workspaceSandboxState.activity(f.alice.id).sandbox).toEqual({ state: 'closed' })
  await manager.dispose()
})
