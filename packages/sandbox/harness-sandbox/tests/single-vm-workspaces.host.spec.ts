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
  const provider = (overrides: Partial<typeof config> = {}) => new SingleVmWorkspaces({ ...config, ...overrides }, id => records.get(id))
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
    new WorkspaceModeRuntimeAdapter(new Map([['multi-docker', docker], ['single-vm', vfs.resources('single-vm', backend, { ...limits, maxBytes })], ['multi-vm', vfs.resources('multi-vm', backend, { ...limits, maxBytes })]]))
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
    ['multi-vm', { execution: backend, files: vfs.files }],
  ]))
  return { scopes, provider, runtime, route, change, signal, workspaceRoot, stateRoot, mountPoint, mountRecord, records,
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

  test('preserves shared files and the task identity across both VM modes and rollback', async () => {
    const f = await setup()
    const scope = f.scopes[0]
    if (scope === undefined) throw new Error('Missing test workspace')
    await writeFile(join(scope.project, 'input.csv'), 'original')
    const entering = f.change(scope)
    await f.runtime(f.provider()).prepare(entering, f.signal)
    await f.runtime(f.provider()).settle(entering, 'commit', f.signal)
    const original = f.provider().resolve(scope)
    await f.route(f.provider(), 'single-vm').upload(scope, 'result.csv', bytes('shared result'), 64)
    const shared: WorkspaceModeChange = { ...f.change(scope), from: 'single-vm', to: 'multi-vm' }
    await f.runtime(f.provider()).prepare(shared, f.signal)
    await f.runtime(f.provider()).settle(shared, 'commit', f.signal)
    expect(f.provider().resolve(scope)).toMatchObject({ root: original.root, uid: original.uid, gid: original.gid })
    expect(await readFile(join(original.root, 'result.csv'), 'utf8')).toBe('shared result')
    const failing: WorkspaceModeChange = { ...f.change(scope), from: 'multi-vm', to: 'single-vm' }
    await expect(f.runtime(f.provider(), 1).prepare(failing, f.signal)).rejects.toMatchObject({ reason: 'byte-limit' })
    await f.runtime(f.provider()).settle(failing, 'rollback', f.signal)
    expect(await readFile(join(original.root, 'result.csv'), 'utf8')).toBe('shared result')
    const returning: WorkspaceModeChange = { ...f.change(scope), from: 'multi-vm', to: 'single-vm' }
    await f.runtime(f.provider()).prepare(returning, f.signal)
    await f.runtime(f.provider()).settle(returning, 'commit', f.signal)
    expect(f.provider().resolve(scope).uid).toBe(original.uid)
    const download = await f.route(f.provider(), 'single-vm').download(scope, 'result.csv', 64)
    expect(await new Response(download.body).text()).toBe('shared result')
    await download.settled
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
    await expect(f.runtime(f.provider()).prepare(f.change(peer), f.signal)).rejects.toMatchObject({ code: 'workspace/mode-single-vm-capacity' })
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

  test('rejects invalid VFS deployment paths, public state and unreserved task groups', async () => {
    const f = await setup()
    const uid = vi.spyOn(process, 'getuid').mockReturnValue(0)
    try { expect(() => f.provider()).toThrow('non-root Linux Web process') } finally { uid.mockRestore() }
    expect(() => f.provider({ mountPoint: 'relative' })).toThrow('canonical absolute paths')
    expect(() => f.provider({ workspaceRoot: join(f.mountPoint, 'nested', 'workspaces') })).toThrow('separate registration')
    expect(() => f.provider({ stateRoot: join(f.mountPoint, 'identities') })).toThrow('separate registration')
    expect(() => f.provider({ mountTag: 'untrusted' })).toThrow('separate registration')
    for (const taskIds of [[], [1.5], [0], [0xffff_ffff], [process.getuid!()], [process.getgid!()], [0xffff_fffe]]) {
      expect(() => f.provider({ taskIds })).toThrow('reserved supplementary groups')
    }
    await mkdir(f.stateRoot)
    await chmod(f.stateRoot, 0o755)
    expect(() => f.provider()).toThrow('storage must be private')
    await chmod(f.stateRoot, 0o700)
    const vfs = f.provider()
    expect(() => { vfs.assertOutside(f.stateRoot) }).not.toThrow()
    expect(() => { vfs.assertOutside(f.workspaceRoot) }).toThrow('outside workspace mounts')
    expect(() => { vfs.assertOutside(f.scopes[0]!.project) }).toThrow('outside workspace mounts')
  })

  test('revokes access when the registration, mount or VFS directory changes', async () => {
    const f = await setup()
    const [scope] = f.scopes
    if (scope === undefined) throw new Error('Missing test workspace')
    const vfs = f.provider()
    expect(() => vfs.resolve(scope)).toThrow('no bound task identity')
    expect(() => vfs.resolve({ ...scope, workspaceId: brandString<WorkspaceId>('unregistered') })).toThrow('registered direct child')
    const aborted = AbortSignal.abort(new Error('Admission revoked'))
    expect(() => vfs.resolve({ ...scope, signal: aborted })).toThrow('Admission revoked')
    await chmod(f.workspaceRoot, 0o700)
    expect(() => vfs.resolve(scope)).toThrow('workspace parent must belong to Web with mode 0711')
    await chmod(f.workspaceRoot, 0o711)
    await chmod(f.mountPoint, 0o775)
    expect(() => vfs.resolve(scope)).toThrow('volume root must be protected')
    await chmod(f.mountPoint, 0o755)
    f.setMount(f.mountRecord() + f.mountRecord(undefined, '/', '25'))
    expect(() => vfs.resolve(scope)).toThrow('expected virtiofs volume')
    f.setMount('')
    expect(() => vfs.resolve(scope)).toThrow('expected virtiofs volume')
    f.setMount(f.mountRecord())

    const change = f.change(scope)
    await f.runtime(vfs).prepare(change, f.signal)
    await f.runtime(vfs).settle(change, 'commit', f.signal)
    const directory = vfs.resolve(scope)
    expect(() => f.provider({ taskIds: taskIds.slice(1) }).resolve(scope)).toThrow('identity conflicts')
    const original = f.records.get(scope.workspaceId)!
    f.records.set(scope.workspaceId, { path: scope.project })
    expect(() => { directory.assertCurrent() }).toThrow('registration changed')
    f.records.set(scope.workspaceId, original)
    await rename(directory.root, directory.root + '.backup')
    expect(() => { directory.assertCurrent() }).toThrow('workspace directory changed')
    expect(() => vfs.resolve(scope)).toThrow('workspace directory is missing')
    await expect(f.runtime(vfs).prepare(f.change(scope, 'multi-docker'), f.signal)).rejects.toThrow('source directory is missing')
    await symlink(directory.root + '.backup', directory.root)
    expect(() => vfs.resolve(scope)).toThrow('not a canonical directory')
  })

  test('keeps a reserved identity quarantined if rollback finds a live VFS directory', async () => {
    const f = await setup(taskIds.slice(0, 1))
    const [scope, peer] = f.scopes
    if (scope === undefined || peer === undefined) throw new Error('Missing test workspace')
    await writeFile(join(scope.project, 'input.csv'), 'keep original')
    const change = f.change(scope)
    await f.runtime(f.provider()).prepare(change, f.signal)
    const leaf = basename(scope.project)
    const stage = (await readdir(f.workspaceRoot)).find(name => name.startsWith('.' + leaf + '.mode-'))
    if (stage === undefined) throw new Error('Missing staged copy')
    const live = join(f.workspaceRoot, leaf)
    await rename(join(f.workspaceRoot, stage), live)

    const restarted = f.runtime(f.provider())
    await expect(restarted.settle(change, 'rollback', f.signal)).rejects.toThrow('Workspace mode rollback did not finish')
    expect(await readFile(join(live, 'input.csv'), 'utf8')).toBe('keep original')
    await expect(restarted.prepare(f.change(peer), f.signal)).rejects.toMatchObject({ code: 'workspace/mode-single-vm-capacity' })
  })
})
