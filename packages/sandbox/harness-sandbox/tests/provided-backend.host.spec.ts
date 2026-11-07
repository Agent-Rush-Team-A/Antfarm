import { brandString } from '@deepseek-ai/dsh-brand'
import { expect, test, vi } from 'vitest'
import WorkspaceSandbox, { type SandboxContainerId } from '../src/index.ts'
import { SandboxExecutionBackend } from '../src/backend.ts'
import { fixture } from './fixtures/management.ts'

class ProvidedBackend extends SandboxExecutionBackend {
  readonly opened: string[] = []
  readonly operations: string[] = []
  readonly background = { openings: 0, executions: 0, closing: false }
  queryGate?: () => Promise<void>
  private running = false
  override activity() { return this.background }
  override async open(_workspaceId: string, path: string) {
    this.operations.push('open')
    this.running = true
    this.opened.push(path)
    return { state: 'running' as const, containerId: brandString<SandboxContainerId>('b'.repeat(64)) }
  }
  override async status() {
    this.operations.push('status')
    await this.queryGate?.()
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

async function providedFixture() {
  const f = await fixture()
  await f.sandboxFiber.dispose()
  await f.ctx.plugin(ProvidedBackend)
  const backend = f.ctx.sandboxRunnerClient as ProvidedBackend
  await f.ctx.plugin(WorkspaceSandbox, { backend: 'provided', workspaceRoot: f.workspaceRoot })
  let now = 100
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const manager = f.ctx.workspaceSandbox
  const user = f.alice.user.userId
  const id = f.alice.id
  const activity = () => manager.activityForUser(user, id)
  const target = () => {
    const current = activity()
    if (current.sandbox.state !== 'running' || current.idleSince === null) throw new Error('Expected a running idle generation')
    return { containerId: current.sandbox.containerId, version: current.version,
      revision: current.revision, idleSince: current.idleSince }
  }
  return { ...f, backend, manager, user, id, activity, target, advance: (value: number) => { now = value } }
}

test.each(['openings', 'executions', 'closing'] as const)('provider %s invalidates idle until a fresh running observation', async (kind) => {
  const f = await providedFixture()
  await f.manager.openForUser(f.user, f.id)
  const original = f.target()
  f.advance(1_800_100)
  if (kind === 'closing') f.backend.background.closing = true
  else f.backend.background[kind] = 1
  expect(await f.manager.closeIfIdleForUser(f.user, f.id, original, 1_800_000,
    new AbortController().signal)).toEqual({ state: 'skipped' })
  expect(f.backend.operations).toEqual(['open'])
  expect(f.activity()).toMatchObject({ busy: true, idleSince: null, sandbox: { state: 'unconfirmed' }, version: original.version })
  expect(f.activity().revision).toBeGreaterThan(original.revision)
  Object.assign(f.backend.background, { openings: 0, executions: 0, closing: false })
  f.advance(2_000_000)
  await f.manager.statusForUser(f.user, f.id)
  expect(f.target().idleSince).toBe(2_000_000)
  expect(await f.manager.closeIfIdleForUser(f.user, f.id, original, 1_800_000,
    new AbortController().signal)).toEqual({ state: 'skipped' })
  const current = f.target()
  f.advance(3_800_000)
  expect(await f.manager.closeIfIdleForUser(f.user, f.id, current, 1_800_000,
    new AbortController().signal)).toEqual({ state: 'closed' })
  expect(f.calls).toEqual([])
})

test('provider work starting during the final idle query prevents closure', async () => {
  const f = await providedFixture()
  await f.manager.openForUser(f.user, f.id)
  const original = f.target()
  f.advance(1_800_100)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  f.backend.queryGate = async () => { entered.resolve(undefined); await release.promise }
  const closing = f.manager.closeIfIdleForUser(f.user, f.id, original, 1_800_000, new AbortController().signal)
  try {
    await entered.promise
    f.backend.background.openings = 1
  } finally { release.resolve(undefined) }
  expect(await closing).toEqual({ state: 'skipped' })
  expect(f.backend.operations).toEqual(['open', 'status'])
  expect(f.activity()).toMatchObject({ busy: true, idleSince: null })
  expect(f.calls).toEqual([])
})

test('file activity restoring a closed provider re-enters idle discovery', async () => {
  const f = await providedFixture()
  await f.manager.statusForUser(f.user, f.id)
  expect(f.ctx.workspaceSandboxState.candidateWorkspaces()).not.toContain(f.id)
  const finish = f.ctx.workspaceSandboxState.beginExecution(f.id)
  try {
    expect(f.ctx.workspaceSandboxState.candidateWorkspaces()).toContain(f.id)
    await f.backend.open(f.id, f.alice.workspace.path)
  } finally { finish() }
  expect(f.activity()).toMatchObject({ busy: false, idleSince: null, sandbox: { state: 'unconfirmed' } })
  f.advance(500)
  await f.manager.statusForUser(f.user, f.id)
  const restored = f.target()
  expect(restored.idleSince).toBe(500)
  f.advance(1_800_500)
  expect(await f.manager.closeIfIdleForUser(f.user, f.id, restored, 1_800_000,
    new AbortController().signal)).toEqual({ state: 'closed' })
  expect(f.ctx.workspaceSandboxState.candidateWorkspaces()).not.toContain(f.id)
  expect(f.calls).toEqual([])
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
