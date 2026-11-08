/** Startup imports retain legacy files and cloud records across retry and registration changes. */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { SingleVmWorkspaces } from '../src/single-vm-workspaces.ts'
import { importLegacyVfsWorkspaces } from '../src/vm-vfs-import.ts'
import { cloudRecord, CloudWorkspaceStore } from '../src/vultr-storage.ts'
import { fixture } from './fixtures/management.ts'

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) }
})

const taskIds = (process.getgroups?.() ?? []).filter(id => id > 0 && id !== process.getuid?.() && id !== process.getgid?.()).slice(0, 2)

async function setup() {
  const f = await fixture(1000, false, 1000, 1000, 'multi-vm')
  const mountPoint = join(f.home, 'volume')
  const workspaceRoot = join(mountPoint, 'workspaces')
  await mkdir(workspaceRoot, { recursive: true })
  await chmod(workspaceRoot, 0o711)
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.mocked(readFileSync).mockImplementation((...args) => args[0] === '/proc/self/mountinfo'
    ? `24 23 0:42 / ${mountPoint} rw - virtiofs 113849250 rw\n` : actual.readFileSync(...args))
  onTestFinished(() => { vi.mocked(readFileSync).mockReset() })
  const workspaces = () => new SingleVmWorkspaces({ projectRoot: f.workspaceRoot, mountPoint, mountTag: '113849250',
    workspaceRoot, stateRoot: join(f.home, 'identities'), taskIds }, id => f.ctx.workspaceRegistry.get(id))
  const stateRoot = join(f.home, 'legacy')
  const store = new CloudWorkspaceStore(stateRoot)
  await store.initialize()
  await store.close()
  const record = cloudRecord.parse({ format: 1, workspaceId: f.alice.id, project: f.alice.workspace.path,
    remoteRoot: '/workspace', deploymentId: 'legacy-test', label: 'retained', generation: 'a'.repeat(64),
    state: 'closed', phase: 'closed', snapshotId: randomUUID(), cache: 'copy-' + randomUUID(), seeded: true })
  const save = async (value = record) => {
    await store.initialize()
    try { await store.save(value) } finally { await store.close() }
  }
  const source = store.copyPath(record.workspaceId, record.cache!)
  await mkdir(source, { recursive: true, mode: 0o700 })
  await chmod(source, 0o700)
  await writeFile(join(source, 'result.txt'), 'legacy result', { mode: 0o600 })
  const config = () => ({ stateRoot, registry: f.ctx.workspaceRegistry, workspaces: workspaces(),
    backend: f.ctx.sandboxRunnerClient, limits: { maxFiles: 20, maxBytes: 4096 } })
  return { ...f, workspaces, stateRoot, store, record, save, source, config, workspaceRoot,
    signal: new AbortController().signal }
}

describe.runIf(process.platform === 'linux' && process.getuid?.() !== 0 && taskIds.length === 2)('Legacy VFS startup imports', () => {
  test('imports caches and never-allocated workspaces once while retaining later VFS writes and registry modes', async () => {
    const f = await setup()
    await f.save()
    await writeFile(join(f.bob.workspace.path, 'upload.txt'), 'initial upload')
    const mode = f.alice.workspace.modeConfig
    await importLegacyVfsWorkspaces(f.config(), f.signal)
    const scope = { workspaceId: f.alice.id, project: f.alice.workspace.path, signal: f.signal, admit() {} }
    const directory = f.workspaces().resolve(scope)
    expect(await readFile(join(directory.root, 'result.txt'), 'utf8')).toBe('legacy result')
    expect((await stat(directory.root)).mode & 0o7777).toBe(0o2770)
    expect((await stat(join(directory.root, 'result.txt'))).mode & 0o777).toBe(0o660)
    expect(await readFile(join(f.workspaceRoot, basename(f.bob.workspace.path), 'upload.txt'), 'utf8')).toBe('initial upload')
    await writeFile(join(directory.root, 'result.txt'), 'new VFS result')
    await importLegacyVfsWorkspaces(f.config(), f.signal)
    expect(await readFile(join(directory.root, 'result.txt'), 'utf8')).toBe('new VFS result')
    expect(f.workspaces().resolve(scope).uid).toBe(directory.uid)
    expect(f.alice.workspace.modeConfig).toEqual(mode)
    expect(JSON.parse(await readFile(join(f.stateRoot, f.record.workspaceId, 'state.json'), 'utf8'))).toMatchObject({
      snapshotId: f.record.snapshotId, state: 'closed', cache: f.record.cache,
    })
  })

  test('refuses an unresolved orphan allocation before importing any registered workspace and releases the old lock', async () => {
    const f = await setup()
    await f.save(cloudRecord.parse({ ...f.record, workspaceId: 'orphan', state: 'running', phase: 'running', instanceId: randomUUID() }))
    await expect(importLegacyVfsWorkspaces(f.config(), f.signal)).rejects.toMatchObject({ reason: 'legacy-not-closed' })
    await expect(stat(join(f.workspaceRoot, basename(f.alice.workspace.path)))).rejects.toMatchObject({ code: 'ENOENT' })
    await f.store.initialize()
    await f.store.close()
  })

  test('missing saved files refuse import while retaining the old snapshot and destination identity capacity', async () => {
    const f = await setup()
    await f.save(cloudRecord.parse({ ...f.record, cache: undefined }))
    await expect(importLegacyVfsWorkspaces(f.config(), f.signal)).rejects.toMatchObject({ reason: 'cache-missing' })
    await expect(stat(join(f.workspaceRoot, basename(f.alice.workspace.path)))).rejects.toMatchObject({ code: 'ENOENT' })
    await f.save()
    await expect(importLegacyVfsWorkspaces(f.config(), f.signal)).resolves.toBeUndefined()
    const retained = cloudRecord.parse(JSON.parse(await readFile(join(f.stateRoot, f.record.workspaceId, 'state.json'), 'utf8')))
    expect(retained.snapshotId).toBe(f.record.snapshotId)
  })
})
