/** Real workspace/domain composition with instance-owned storage and controllable persistence. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import WorkspaceRegistry from '../src/index.ts'
import type { WorkspaceMode, WorkspaceModeRuntime } from '../src/types.ts'

export function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

export async function modeFixture(
  options: { mode?: WorkspaceMode; pool?: MemoryMediaPool; headers?: SessionHeader[]; path?: string } = {},
) {
  const path = options.path ?? await mkdtemp(join(tmpdir(), 'workspace-mode-'))
  if (options.path === undefined) onTestFinished(() => rm(path, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Storage)
  const pool = options.pool ?? new MemoryMediaPool()
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const domain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', domain)
  ctx.provide('storageDomain', domain)
  const headers = new Map((options.headers ?? []).map(header => [header.id, header]))
  ctx.provide('sessionPersistence', {
    list: vi.fn(async () => [...headers.values()].map(header => ({ header, revision: SessionPersistenceRevision(`revision-${header.id}`) }))),
  } as never)
  const fiber = await ctx.plugin(WorkspaceRegistry, { defaultMode: options.mode ?? 'multi-vm' })
  const registry = ctx.workspaceRegistry
  const workspace = await registry.create(path)
  const adapter: WorkspaceModeRuntime = {
    supportedModes: ['single-vm', 'multi-vm', 'single-docker', 'multi-docker'],
    prepare: vi.fn(async () => {}), settle: vi.fn(async () => {}),
  }
  return { ctx, fiber, pool, headers, registry, workspace, adapter, path,
    options: { signal: new AbortController().signal, admit: vi.fn(() => {}) } }
}
