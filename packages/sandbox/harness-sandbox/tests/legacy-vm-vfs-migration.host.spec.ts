/** Offline legacy cache imports preserve cloud ownership and recover durable directory publication. */
import { randomUUID } from 'node:crypto'
import { chmod, chown, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorkspaceModeChange, WorkspaceModeChangeId } from '@deepseek-ai/dsh-workspace/types'
import { importLegacyVmCache, LegacyVmVfsMigrationError } from '../src/legacy-vm-vfs-migration.ts'
import { WorkspaceModeDirectoryResources } from '../src/mode-directory-resources.ts'
import { WorkspaceModeCopyError } from '../src/mode-copy.ts'
import type { WorkspaceModeTarget } from '../src/mode-routing.ts'
import { cloudRecord, CloudWorkspaceStore, type CloudRecord } from '../src/vultr-storage.ts'

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-legacy-vfs-'))
  onTestFinished(async () => { await rm(home, { recursive: true, force: true }) })
  const store = new CloudWorkspaceStore(join(home, 'legacy'))
  const record = cloudRecord.parse({ format: 1, workspaceId: 'workspace', project: join(home, 'original'),
    remoteRoot: '/workspace', deploymentId: 'test', label: 'legacy', generation: 'a'.repeat(64),
    state: 'closed', phase: 'closed', snapshotId: randomUUID(), cache: 'copy-' + randomUUID(), seeded: true })
  const source = store.copyPath(record.workspaceId, record.cache!)
  await mkdir(join(source, 'nested'), { recursive: true, mode: 0o700 })
  await chmod(source, 0o700)
  await writeFile(join(source, 'input.csv'), 'amount\n32\n', { mode: 0o600 })
  await writeFile(join(source, 'nested', 'run.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  const originalMetadata = JSON.stringify(record) + '\n'
  const metadata = join(home, 'legacy', record.workspaceId, 'state.json')
  await writeFile(metadata, originalMetadata, { mode: 0o600 })
  const destination = join(home, 'vfs-workspace')
  await mkdir(destination, { mode: 0o2770 })
  await chmod(destination, 0o2770)
  const uid = process.getuid!() === 0 ? 24001 : process.getuid!()
  const gid = process.getuid!() === 0 ? 24001 : process.getgid!()
  await chown(destination, uid, gid)
  await writeFile(join(destination, 'existing.txt'), 'previous target')
  const change: WorkspaceModeChange = { changeId: brandString<WorkspaceModeChangeId>(randomUUID()),
    workspaceId: record.workspaceId, project: record.project, from: 'multi-vm', to: 'multi-vm', previousRevision: 1 }
  const backend = { open: vi.fn(), close: vi.fn(), status: vi.fn(), execute: vi.fn(), cancel: vi.fn(), files: vi.fn() } satisfies WorkspaceModeTarget['execution']
  const build = (maxBytes = 4096, published?: () => Promise<void>) => new WorkspaceModeDirectoryResources({
    stateRoot: join(home, 'migration-journals'), mode: 'multi-vm', backend, maxFiles: 10, maxBytes,
    shareWithGroup: true, directory: async () => ({ root: destination, assertCurrent: () => {} }),
    ...published === undefined ? {} : { published },
  })
  const current = { record, store, change, assertCurrent: vi.fn() }
  const untouched = async () => {
    expect(await readFile(metadata, 'utf8')).toBe(originalMetadata)
    expect(await readFile(join(source, 'input.csv'), 'utf8')).toBe('amount\n32\n')
    expect(record.snapshotId).toBe(cloudRecord.parse(JSON.parse(originalMetadata)).snapshotId)
    expect(backend.open).not.toHaveBeenCalled()
    expect(backend.close).not.toHaveBeenCalled()
    expect(backend.status).not.toHaveBeenCalled()
  }
  return { home, source, destination, current, build, untouched, uid, gid, signal: new AbortController().signal }
}

describe.runIf(process.platform === 'linux')('Offline legacy VM VFS import', () => {
  test('publishes complete cached files with the destination task ownership and group modes', async () => {
    const f = await fixture()
    await importLegacyVmCache({ ...f.current, target: f.build() }, f.signal)
    expect(await readFile(join(f.destination, 'input.csv'), 'utf8')).toBe('amount\n32\n')
    expect(await readFile(join(f.destination, 'nested', 'run.sh'), 'utf8')).toBe('#!/bin/sh\nexit 0\n')
    for (const [path, mode] of [['', 0o2770], ['nested', 0o2770], ['input.csv', 0o660], ['nested/run.sh', 0o770]] as const) {
      const info = await stat(join(f.destination, path))
      expect({ uid: info.uid, gid: info.gid, mode: info.mode & 0o3777 }).toEqual({ uid: f.uid, gid: f.gid, mode })
    }
    await expect(stat(join(f.destination, 'existing.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await f.untouched()
  })

  test.each([
    { state: 'running' }, { state: 'starting' }, { state: 'closing' }, { state: 'cleanup_required' },
    { phase: 'saving_snapshot' }, { phase: 'failed' }, { instanceId: randomUUID() },
    { candidateCache: 'copy-' + randomUUID() }, { mutation: 'create' }, { mutation: 'snapshot' },
    { pendingSnapshotId: randomUUID() }, { oldSnapshotId: randomUUID() },
    { snapshotDescription: 'unacknowledged-create' }, { failure: 'interrupted' }, { resumePhase: 'deleting' },
  ])('refuses unresolved legacy ownership %j before staging', async (fields) => {
    const f = await fixture()
    const target = { stage: vi.fn(), publish: vi.fn() }
    await expect(importLegacyVmCache({ ...f.current, record: cloudRecord.parse({ ...f.current.record, ...fields }), target }, f.signal))
      .rejects.toMatchObject({ reason: 'legacy-not-closed' })
    expect(target.stage).not.toHaveBeenCalled()
    expect(target.publish).not.toHaveBeenCalled()
    await f.untouched()
  })

  test('refuses a missing cache even if the original project directory is available', async () => {
    const f = await fixture()
    await mkdir(f.current.record.project)
    const record: CloudRecord = { ...f.current.record, cache: undefined }
    const target = { stage: vi.fn(), publish: vi.fn() }
    await expect(importLegacyVmCache({ ...f.current, record, target }, f.signal)).rejects.toMatchObject({ reason: 'cache-missing' })
    expect(target.stage).not.toHaveBeenCalled()
    await f.untouched()
  })

  test.each(['missing', 'symlink', 'public', 'invalid-identity'] as const)('refuses an unavailable cache: %s', async (kind) => {
    const f = await fixture()
    let record = f.current.record
    if (kind === 'missing') record = { ...record, cache: 'copy-' + randomUUID() }
    if (kind === 'invalid-identity') record = { ...record, cache: '../escape' }
    if (kind === 'public') await chmod(f.source, 0o755)
    if (kind === 'symlink') {
      const link = 'copy-' + randomUUID()
      await symlink(f.source, f.current.store.copyPath(record.workspaceId, link), 'dir')
      record = { ...record, cache: link }
    }
    const target = { stage: vi.fn(), publish: vi.fn() }
    await expect(importLegacyVmCache({ ...f.current, record, target }, f.signal))
      .rejects.toBeInstanceOf(LegacyVmVfsMigrationError)
    await expect(importLegacyVmCache({ ...f.current, record, target }, f.signal))
      .rejects.toMatchObject({ reason: 'cache-unavailable' })
    expect(target.stage).not.toHaveBeenCalled()
    await f.untouched()
  })

  test('rejects a transition belonging to another legacy workspace before staging', async () => {
    const f = await fixture()
    const target = { stage: vi.fn(), publish: vi.fn() }
    await expect(importLegacyVmCache({ ...f.current, target, change: { ...f.current.change, project: join(f.home, 'another') } }, f.signal))
      .rejects.toMatchObject({ reason: 'identity-conflict' })
    expect(target.stage).not.toHaveBeenCalled()
    await f.untouched()
  })

  test('refuses incomplete copying without replacing destination files, then retries from the complete cache', async () => {
    const f = await fixture()
    await expect(importLegacyVmCache({ ...f.current, target: f.build(1) }, f.signal)).rejects.toBeInstanceOf(WorkspaceModeCopyError)
    expect(await readFile(join(f.destination, 'existing.txt'), 'utf8')).toBe('previous target')
    await f.untouched()
    await importLegacyVmCache({ ...f.current, target: f.build() }, f.signal)
    expect(await readFile(join(f.destination, 'input.csv'), 'utf8')).toBe('amount\n32\n')
    await f.untouched()
  })

  test('does not publish when the legacy owner is revoked after staging', async () => {
    const f = await fixture()
    const resources = f.build()
    let revoked = false
    const publish = vi.fn((change: WorkspaceModeChange, signal: AbortSignal) => resources.publish(change, signal))
    const target = {
      stage: async (...args: Parameters<typeof resources.stage>) => { await resources.stage(...args); revoked = true }, publish,
    }
    await expect(importLegacyVmCache({ ...f.current, target, assertCurrent: () => {
      if (revoked) throw new Error('Legacy generation revoked')
    } }, f.signal)).rejects.toThrow('Legacy generation revoked')
    expect(publish).not.toHaveBeenCalled()
    expect(await readFile(join(f.destination, 'existing.txt'), 'utf8')).toBe('previous target')
    await f.untouched()
  })

  test('restarts after publication acknowledgement fails and retains the legacy snapshot on every attempt', async () => {
    const f = await fixture()
    await expect(importLegacyVmCache({ ...f.current, target: f.build(4096, async () => {
      throw new Error('Destination metadata acknowledgement lost')
    }) }, f.signal)).rejects.toThrow('Destination metadata acknowledgement lost')
    expect(await readFile(join(f.destination, 'input.csv'), 'utf8')).toBe('amount\n32\n')
    await f.untouched()
    await importLegacyVmCache({ ...f.current, target: f.build() }, f.signal)
    await writeFile(join(f.destination, 'after-import.txt'), 'new VM result')
    await importLegacyVmCache({ ...f.current, target: f.build() }, f.signal)
    expect(await readFile(join(f.destination, 'after-import.txt'), 'utf8')).toBe('new VM result')
    await f.untouched()
  })
})
