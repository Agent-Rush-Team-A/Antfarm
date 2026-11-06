import { brandString } from '@deepseek-ai/dsh-brand'
import { expect, test } from 'vitest'
import WorkspaceSandbox, { type SandboxContainerId } from '../src/index.ts'
import { SandboxExecutionBackend } from '../src/backend.ts'
import { fixture } from './fixtures/management.ts'

class ProvidedBackend extends SandboxExecutionBackend {
  readonly opened: string[] = []
  override async open(_workspaceId: string, path: string) {
    this.opened.push(path)
    return { state: 'running' as const, containerId: brandString<SandboxContainerId>('b'.repeat(64)) }
  }
  override async status() { return { state: 'closed' as const } }
  override async close() { return { state: 'closed' as const } }
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
