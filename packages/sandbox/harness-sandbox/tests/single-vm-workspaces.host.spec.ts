/** Single VM directory admission over real Linux files, with a controlled provider mount record. */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorkspaceFileScope } from '@deepseek-ai/dsh-fs/workspace-access'
import type { WorkspaceId, WorkspaceMode, WorkspaceModeChange, WorkspaceModeChangeId } from '@deepseek-ai/dsh-workspace/types'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { z } from 'zod'
import { WorkspaceModeDirectoryFiles } from '../src/mode-directory-files.ts'
import { WorkspaceModeDirectoryResources } from '../src/mode-directory-resources.ts'
import { WorkspaceModeRouting, type WorkspaceModeTarget } from '../src/mode-routing.ts'
import { WorkspaceModeRuntimeAdapter } from '../src/mode-runtime.ts'
import { SingleVmWorkspaces } from '../src/single-vm-workspaces.ts'

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) }
})

const taskIds = (process.getgroups?.() ?? []).filter(id => id > 0 && id !== process.getuid?.() && id !== process.getgid?.()).slice(0, 2)

async function* bytes(content: string) { yield Buffer.from(content) }

async function setup(configuredTaskIds = taskIds) {
  const home = await mkdtemp(join(tmpdir(), 'single-vm-vfs-'))
  const mountRead = vi.mocked(readFileSync)
  onTestFinished(async () => {
    mountRead.mockReset()
    await rm(home, { recursive: true, force: true })
  })
  const projectRoot = join(home, 'registered')
  const mountPoint = join(home, 'VFS volume')
  const workspaceRoot = join(mountPoint, 'workspaces')
  const stateRoot = join(home, 'private')
  await mkdir(projectRoot)
  await mkdir(workspaceRoot, { recursive: true })
  await chmod(workspaceRoot, 0o711)
  const mountTag = '113849250'
  const mountRecord = (tag = mountTag, fsRoot = '/', mountId = '24') =>
    mountId + ' 23 0:42 ' + fsRoot + ' ' + mountPoint.replaceAll(' ', '\\040') + ' rw,nosuid,nodev - virtiofs ' + tag + ' rw\n'
  const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
  let mountInfo = mountRecord()
  mountRead.mockImplementation((...args) => args[0] === '/proc/self/mountinfo' ? mountInfo : actualFs.readFileSync(...args))

  const signal = new AbortController().signal
  const scopes: WorkspaceFileScope[] = await Promise.all(['ws-a', 'ws-b'].map(async (leaf, index) => {
    const project = join(projectRoot, leaf)
    await mkdir(project, { mode: 0o700 })
    return { workspaceId: brandString<WorkspaceId>('registry-' + String(index)), project, signal, admit() {} }
  }))
  const records = new Map(scopes.map(scope => [scope.workspaceId, { path: scope.project }]))
  const config = { projectRoot, mountPoint, mountTag, workspaceRoot, stateRoot, taskIds: configuredTaskIds }
  const provider = () => new SingleVmWorkspaces(config, id => records.get(id))
  const backend = {
    status: vi.fn(async () => ({ state: 'closed' as const })),
    close: vi.fn(async () => ({ state: 'closed' as const })),
    open: vi.fn(), execute: vi.fn(), cancel: vi.fn(), files: vi.fn(),
  } satisfies WorkspaceModeTarget['execution']
  const limits = { maxFiles: 20, maxBytes: 1024 }
  const localDirectory = async (scope: { project: string }) => ({ root: scope.project, assertCurrent() {} })
  const localFiles = new WorkspaceModeDirectoryFiles(localDirectory)
  const docker = new WorkspaceModeDirectoryResources({
    ...limits, mode: 'multi-docker', stateRoot, backend, directory: localDirectory,
  })
  const runtime = (vfs: SingleVmWorkspaces, maxBytes = limits.maxBytes) =>
    new WorkspaceModeRuntimeAdapter(new Map([['multi-docker', docker], ['single-vm', vfs.resources(backend, { ...limits, maxBytes })]]))
  const change = (scope: WorkspaceFileScope, to: WorkspaceMode = 'single-vm'): WorkspaceModeChange => ({
    changeId: brandString<WorkspaceModeChangeId>(randomUUID()), workspaceId: scope.workspaceId, project: scope.project,
    from: to === 'single-vm' ? 'multi-docker' : 'single-vm', to, previousRevision: 1,
  })
  const route = (vfs: SingleVmWorkspaces, mode: WorkspaceMode) => new WorkspaceModeRouting({
    async acquireUse(workspaceId) {
      return {
        config: { workspaceId, mode, revision: 1, operationState: 'ready', modeLocked: false, lockReason: null, firstSessionId: null },
        signal, admit() {}, release() {},
      }
    },
  }, new Map<WorkspaceMode, WorkspaceModeTarget>([
    ['multi-docker', { execution: backend, files: localFiles }], ['single-vm', { execution: backend, files: vfs.files }],
  ]))
  return { scopes, provider, runtime, route, change, signal, workspaceRoot, stateRoot, mountRecord,
    setMount(value: string) { mountInfo = value } }
}

describe.runIf(process.platform === 'linux' && process.getuid?.() !== 0 && taskIds.length === 2)('single VM shared directories', () => {
  test('preserves existing uploads across mode changes and reuses distinct identities after restart', async () => {
    const f = await setup()
    const vfs = f.provider()
    const docker = f.route(vfs, 'multi-docker')
    await Promise.all(f.scopes.map(async (scope) => {
      await docker.upload(scope, 'input.csv', bytes(scope.workspaceId), 64)
      await chmod(join(scope.project, 'input.csv'), 0o600)
      await mkdir(join(scope.project, 'nested'), { mode: 0o700 })
      await writeFile(join(scope.project, 'nested', 'run.sh'), 'echo hello\n', { mode: 0o700 })
      const switchIn = f.change(scope)
      await f.runtime(vfs).prepare(switchIn, f.signal)
      await f.runtime(f.provider()).settle(switchIn, 'commit', f.signal)
    }))
    const restarted = f.provider()
    const [a, b] = f.scopes.map(scope => restarted.resolve(scope))
    if (a === undefined || b === undefined) throw new Error('Missing test workspace')
    expect(a.uid).not.toBe(b.uid)
    expect(a.gid).toBe(a.uid)
    expect(b.gid).toBe(b.uid)
    for (const scope of f.scopes) {
      const location = restarted.resolve(scope)
      expect(location.volumePath).toBe('/workspaces/' + basename(scope.project))
      expect(vfs.resolve(scope).uid).toBe(location.uid)
      expect((await stat(location.root)).mode & 0o7777).toBe(0o2770)
      expect((await stat(join(location.root, 'nested'))).mode & 0o7777).toBe(0o2770)
      expect((await stat(join(location.root, 'nested', 'run.sh'))).mode & 0o777).toBe(0o770)
      const router = f.route(restarted, 'single-vm')
      const input = await router.download(scope, 'input.csv', 64)
      expect(await new Response(input.body).text()).toBe(scope.workspaceId)
      await input.settled
      await router.upload(scope, 'extra.csv', bytes('shared result'), 64)
      expect(await stat(join(location.root, 'extra.csv'))).toMatchObject({ gid: location.gid })
      expect((await stat(join(location.root, 'extra.csv'))).mode & 0o777).toBe(0o660)
      const listing = await router.list(scope, '', 10)
      expect(listing.entries).toContainEqual({ name: 'extra.csv', kind: 'file', bytes: 13 })
      const switchBack = f.change(scope, 'multi-docker')
      await f.runtime(restarted).prepare(switchBack, f.signal)
      await f.runtime(f.provider()).settle(switchBack, 'commit', f.signal)
      expect(await readFile(join(scope.project, 'extra.csv'), 'utf8')).toBe('shared result')
      expect(await readFile(join(scope.project, 'input.csv'), 'utf8')).toBe(scope.workspaceId)
    }
  })

  test('rolls back a failed stage and rejects incorrect mounts, identities, and paths', async () => {
    const f = await setup()
    const [scope, peer] = f.scopes
    if (scope === undefined || peer === undefined) throw new Error('Missing test workspace')
    const vfs = f.provider()
    await writeFile(join(scope.project, 'input.csv'), 'keep original')
    const failed = f.change(scope)
    await expect(f.runtime(vfs, 1).prepare(failed, f.signal)).rejects.toMatchObject({ reason: 'byte-limit' })
    await f.runtime(f.provider()).settle(failed, 'rollback', f.signal)
    expect(await readFile(join(scope.project, 'input.csv'), 'utf8')).toBe('keep original')
    await expect(readFile(join(f.workspaceRoot, 'ws-a', 'input.csv'))).rejects.toMatchObject({ code: 'ENOENT' })
    const successful = f.change(scope)
    await f.runtime(vfs).prepare(successful, f.signal)
    await f.runtime(vfs).settle(successful, 'commit', f.signal)
    const router = f.route(vfs, 'single-vm')
    await expect(router.download({ ...scope, project: peer.project }, 'input.csv', 64)).rejects.toThrow('registered direct child')
    await expect(router.download(scope, '../ws-b/input.csv', 64)).rejects.toMatchObject({ reason: 'invalid-path' })
    const location = vfs.resolve(scope)
    await symlink(peer.project, join(location.root, 'escape'))
    await expect(router.download(scope, 'escape/input.csv', 64)).rejects.toMatchObject({ reason: 'not-found' })
    await chmod(location.root, 0o700)
    await expect(router.list(scope, '', 10)).rejects.toThrow('unexpected task ownership')
    await chmod(location.root, 0o2770)
    f.setMount(f.mountRecord('wrong'))
    await expect(router.upload(scope, 'rejected.csv', bytes('bad'), 64)).rejects.toThrow('expected virtiofs')
    f.setMount(f.mountRecord(undefined, '/other'))
    await expect(router.list(scope, '', 10)).rejects.toThrow('expected virtiofs')
    f.setMount(f.mountRecord(undefined, '/', '25'))
    expect(() => { location.assertCurrent() }).toThrow('mount changed')
    expect(await readFile(join(location.root, 'input.csv'), 'utf8')).toBe('keep original')
  })

  test.each(['copy', 'journal'] as const)('releases the only first-use identity on rollback after a %s failure', async (failure) => {
    const f = await setup(taskIds.slice(0, 1))
    const [scope, peer] = f.scopes
    if (scope === undefined || peer === undefined) throw new Error('Missing test workspace')
    const modeState = join(f.stateRoot, 'modes')
    if (failure === 'journal') {
      await mkdir(f.stateRoot, { mode: 0o700 })
      await mkdir(modeState)
      await chmod(modeState, 0o755)
    }
    await writeFile(join(scope.project, 'input.csv'), 'keep original')
    const failed = f.change(scope)
    const preparing = f.runtime(f.provider(), 1).prepare(failed, f.signal)
    if (failure === 'journal') await expect(preparing).rejects.toThrow('Mode journal root must be private')
    else await expect(preparing).rejects.toMatchObject({ reason: 'byte-limit' })
    await f.runtime(f.provider()).settle(failed, 'rollback', f.signal)
    expect(await readdir(f.workspaceRoot)).toEqual([])
    expect(await readFile(join(scope.project, 'input.csv'), 'utf8')).toBe('keep original')
    if (failure === 'journal') await chmod(modeState, 0o700)

    const entering = f.change(peer)
    await f.runtime(f.provider()).prepare(entering, f.signal)
    await f.runtime(f.provider()).settle(entering, 'commit', f.signal)
    await f.runtime(f.provider()).settle(failed, 'rollback', f.signal)
    expect(f.provider().resolve(peer).uid).toBe(taskIds[0])
  })

  test('retains a previously published identity and its files when a later switch rolls back', async () => {
    const f = await setup(taskIds.slice(0, 1))
    const [scope, peer] = f.scopes
    if (scope === undefined || peer === undefined) throw new Error('Missing test workspace')
    const vfs = f.provider()
    await writeFile(join(scope.project, 'input.csv'), 'keep original')
    const entering = f.change(scope)
    await f.runtime(vfs).prepare(entering, f.signal)
    await f.runtime(vfs).settle(entering, 'commit', f.signal)
    const location = vfs.resolve(scope)
    const leaving = f.change(scope, 'multi-docker')
    await f.runtime(vfs).prepare(leaving, f.signal)
    await f.runtime(vfs).settle(leaving, 'commit', f.signal)
    const failing = f.change(scope)
    await expect(f.runtime(vfs, 1).prepare(failing, f.signal)).rejects.toMatchObject({ reason: 'byte-limit' })
    await f.runtime(f.provider()).settle(failing, 'rollback', f.signal)
    expect(f.provider().resolve(scope).uid).toBe(location.uid)
    expect(await readFile(join(location.root, 'input.csv'), 'utf8')).toBe('keep original')
    await expect(f.runtime(f.provider()).prepare(f.change(peer), f.signal)).rejects.toThrow('No reserved single VM task identity')
  })

  test('commits the first identity after restarting between directory rename and publication', async () => {
    const f = await setup()
    const [scope] = f.scopes
    if (scope === undefined) throw new Error('Missing test workspace')
    await writeFile(join(scope.project, 'input.csv'), 'keep original')
    const entering = f.change(scope)
    await f.runtime(f.provider()).prepare(entering, f.signal)
    const hash = createHash('sha256').update('single-vm:' + entering.changeId).digest('hex')
    const journalPath = join(f.stateRoot, 'modes', hash, 'state.json')
    const journal = z.object({ role: z.object({ phase: z.string() }).loose() }).loose()
      .parse(JSON.parse(await readFile(journalPath, 'utf8')))
    journal.role.phase = 'publishing'
    await writeFile(journalPath, JSON.stringify(journal))
    const leaf = basename(scope.project)
    await rename(join(f.workspaceRoot, '.' + leaf + '.mode-' + hash), join(f.workspaceRoot, leaf))

    const restarted = f.provider()
    expect(() => { restarted.resolve(scope) }).toThrow('reserved by another transition')
    await f.runtime(restarted).settle(entering, 'commit', f.signal)
    expect(await readFile(join(restarted.resolve(scope).root, 'input.csv'), 'utf8')).toBe('keep original')
    await f.runtime(f.provider()).settle(entering, 'commit', f.signal)
  })
})
