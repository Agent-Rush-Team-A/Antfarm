/** Real durable file transitions, restart reconciliation, rollback and aggregate copy refusals. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, onTestFinished, test, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import type { WorkspaceModeChange, WorkspaceModeChangeId, WorkspaceId, WorkspaceModeConfig } from '@deepseek-ai/dsh-workspace/types'
import { WorkspaceModeDirectoryResources } from '../src/mode-directory-resources.ts'
import { WorkspaceModeRuntimeAdapter } from '../src/mode-runtime.ts'
import { WorkspaceModeCopyError } from '../src/mode-copy.ts'
import type { WorkspaceModeTarget } from '../src/mode-routing.ts'
import type { SandboxContainerId } from '../src/runner-client.ts'

async function fixture(targetBytes = 4096, sourceFiles = 100) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-mode-transition-'))
  onTestFinished(async () => { await rm(home, { recursive: true, force: true }) })
  const root = join(home, 'workspace')
  await mkdir(root)
  await writeFile(join(root, 'uploaded.csv'), 'amount\n32\n', { mode: 0o640 })
  const change: WorkspaceModeChange = { changeId: brandString<WorkspaceModeChangeId>(randomUUID()),
    workspaceId: brandString<WorkspaceId>('workspace'), project: root, from: 'multi-docker', to: 'single-docker', previousRevision: 1 }
  let running = true
  const backend = {
    status: vi.fn(async () => running ? { state: 'running' as const, containerId: brandString<SandboxContainerId>('original') } : { state: 'closed' as const }),
    close: vi.fn(async () => { running = false; return { state: 'closed' as const } }),
    open: vi.fn(async () => { running = true; return { state: 'running' as const, containerId: brandString<SandboxContainerId>('restored') } }),
    execute: vi.fn(), cancel: vi.fn(), files: vi.fn(),
  } satisfies WorkspaceModeTarget['execution']
  const sourceConfig = { stateRoot: join(home, 'state'), mode: 'multi-docker' as const, backend,
    maxBytes: 4096, maxFiles: sourceFiles, directory: async () => ({ root, assertCurrent: () => {} }) }
  const targetConfig = { ...sourceConfig, mode: 'single-docker' as const, maxBytes: targetBytes }
  const build = (published?: (change: WorkspaceModeChange, signal: AbortSignal) => Promise<void>) => {
    const source = new WorkspaceModeDirectoryResources(sourceConfig)
    const target = new WorkspaceModeDirectoryResources({ ...targetConfig, ...published === undefined ? {} : { published } })
    const runtime = new WorkspaceModeRuntimeAdapter(new Map([['multi-docker', source], ['single-docker', target]]))
    return { source, target, runtime }
  }
  return { home, root, change, backend, build, signal: new AbortController().signal,
    ready: { workspaceId: change.workspaceId, mode: change.to, revision: 2, operationState: 'ready',
      modeLocked: false, lockReason: null, firstSessionId: null } satisfies WorkspaceModeConfig }
}

test('restart commits staged files and permissions, retaining recovery evidence until coordinator completion', async () => {
  const f = await fixture()
  await mkdir(join(f.root, 'nested'))
  await writeFile(join(f.root, 'nested', 'other.txt'), 'nested content')
  const prepared = f.build()
  await prepared.runtime.prepare(f.change, f.signal)
  await writeFile(join(f.root, 'uploaded.csv'), 'later mutation')
  const restarted = f.build()
  await restarted.runtime.settle(f.change, 'commit', f.signal)
  expect(await readFile(join(f.root, 'uploaded.csv'), 'utf8')).toBe('amount\n32\n')
  expect(await readFile(join(f.root, 'nested', 'other.txt'), 'utf8')).toBe('nested content')
  expect((await stat(join(f.root, 'uploaded.csv'))).mode & 0o777).toBe(0o640)
  await restarted.runtime.settle(f.change, 'commit', f.signal)
  await expect(restarted.source.collect(f.change, { ...f.ready, operationState: 'recovery-required' })).rejects.toThrow('still retained')
  await restarted.source.collect(f.change, f.ready)
  await restarted.target.collect(f.change, f.ready)
  expect(await readdir(join(f.home, 'state'))).toEqual([])
  expect((await readdir(f.home)).filter(name => name.startsWith('.workspace.mode-'))).toEqual([])
})

test('failed target preparation rolls back after restart and restores the original running source', async () => {
  const f = await fixture(2)
  await expect(f.build().runtime.prepare(f.change, f.signal)).rejects.toBeInstanceOf(WorkspaceModeCopyError)
  const restarted = f.build()
  await restarted.runtime.settle(f.change, 'rollback', f.signal)
  expect(await readFile(join(f.root, 'uploaded.csv'), 'utf8')).toBe('amount\n32\n')
  expect(f.backend.open).toHaveBeenCalledOnce()
  expect((await readdir(f.home)).filter(name => name.startsWith('.workspace.mode-'))).toEqual([])
})

test('entry limits count nested directories and files before a partial checkpoint can be published', async () => {
  const f = await fixture(4096, 1)
  await mkdir(join(f.root, 'nested'))
  await writeFile(join(f.root, 'nested', 'other.txt'), 'content')
  await expect(f.build().runtime.prepare(f.change, f.signal)).rejects.toMatchObject({ reason: 'entry-limit' })
  await f.build().runtime.settle(f.change, 'rollback', f.signal)
  expect(f.backend.open).toHaveBeenCalledOnce()
  expect(await readFile(join(f.root, 'nested', 'other.txt'), 'utf8')).toBe('content')
})

test('symlinks refuse preservation without losing source files', async () => {
  const f = await fixture()
  await symlink('uploaded.csv', join(f.root, 'alias.csv'))
  await expect(f.build().runtime.prepare(f.change, f.signal)).rejects.toMatchObject({ reason: 'unsupported-entry' })
  await f.build().runtime.settle(f.change, 'rollback', f.signal)
  expect(await readFile(join(f.root, 'uploaded.csv'), 'utf8')).toBe('amount\n32\n')
})

test('a failure after directory publication resumes the same commit and refuses destination discard', async () => {
  const f = await fixture()
  const published = vi.fn().mockRejectedValueOnce(new Error('provider metadata failed')).mockResolvedValue(undefined)
  const initial = f.build(published)
  await initial.runtime.prepare(f.change, f.signal)
  await expect(initial.runtime.settle(f.change, 'commit', f.signal)).rejects.toThrow('provider metadata failed')
  await expect(f.build(published).target.discard(f.change, f.signal)).rejects.toThrow('cannot be discarded')
  const resumed = f.build(published)
  await resumed.runtime.settle(f.change, 'commit', f.signal)
  expect(published).toHaveBeenCalledTimes(2)
  expect(await readFile(join(f.root, 'uploaded.csv'), 'utf8')).toBe('amount\n32\n')
})

test('durable directory corruption refuses collection outside the configured workspace', async () => {
  const f = await fixture()
  const initial = f.build()
  await initial.runtime.prepare(f.change, f.signal)
  const journals = await readdir(join(f.home, 'state'))
  for (const name of journals) {
    const path = join(f.home, 'state', name, 'state.json')
    const journal = z.object({ root: z.string(), role: z.object({ kind: z.string() }).loose() })
      .loose().parse(JSON.parse(await readFile(path, 'utf8')))
    if (journal.role.kind !== 'target') continue
    journal.root = join(f.home, 'other')
    await writeFile(path, JSON.stringify(journal))
  }
  await expect(f.build().target.collect(f.change, f.ready)).rejects.toThrow('directory conflicts')
  expect(await readFile(join(f.root, 'uploaded.csv'), 'utf8')).toBe('amount\n32\n')
})
