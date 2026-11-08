import { createHash } from 'node:crypto'
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { WorkspaceSshRuntime } from '../src/ssh-controller.ts'
import { VultrApi } from '../src/vultr-api.ts'
import { Config } from '../src/vultr-config.ts'
import { VultrSshProvisioning } from '../src/vultr-provision.ts'
import { CloudWorkspaceStore } from '../src/vultr-storage.ts'
import VultrWorkspaceBackend from '../src/vultr.ts'

const linuxTest = test.runIf(process.platform === 'linux')
afterEach(() => { vi.restoreAllMocks() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'antfarm-vultr-lifecycle-'))
  const ctx = new Context()
  const competitor = new CloudWorkspaceStore(join(root, 'state'))
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await competitor.close()
    await rm(root, { recursive: true, force: true })
  })
  const key = join(root, 'api-key')
  const sshKey = join(root, 'ssh-key')
  const helper = join(root, 'helper.tar.gz')
  await writeFile(key, 'local-test-only', { mode: 0o600 })
  await writeFile(sshKey, 'local-test-only', { mode: 0o600 })
  await writeFile(helper, 'test archive')
  const project = join(root, 'project')
  await mkdir(project)
  const settings = Config({ stateRoot: competitor.root, apiKeyFile: key, sshKeyFile: sshKey,
    helperArchive: helper, helperArchiveHash: createHash('sha256').update('test archive').digest('hex'),
    helperHash: 'a'.repeat(64), deploymentId: 'lifecycle', region: 'nrt', plan: 'vc2-1c-2gb', osId: 2284,
    apiEndpoint: 'https://api.invalid/v2', operationTimeoutMs: 10_000 })
  const inventory = vi.spyOn(VultrApi.prototype, 'instances').mockResolvedValue([])
  return { ctx, competitor, project, settings, inventory }
}

test.runIf(process.platform === 'linux' && process.getuid?.() !== 0)('existing private state opens beneath a search-only parent', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'antfarm-vultr-private-'))
  const store = new CloudWorkspaceStore(join(parent, 'state'))
  try {
    await mkdir(store.root, { mode: 0o700 })
    await chmod(parent, 0o100)
    await store.initialize()
    await expect(store.load()).resolves.toEqual([])
  } finally {
    await store.close()
    await chmod(parent, 0o700)
    await rm(parent, { recursive: true, force: true })
  }
})

linuxTest('record removal settles when the allocation directory was never created', async () => {
  const f = await fixture()
  await f.competitor.initialize()
  await expect(f.competitor.remove(WorkspaceId('unpublished-allocation'))).resolves.toBeUndefined()
})

linuxTest.each(['provider', 'root'] as const)('%s unload keeps the lock through request and SSH cleanup', async (owner) => {
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const cancelled = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const draining = Promise.withResolvers<undefined>()
  const drained = Promise.withResolvers<undefined>()
  let opening: Promise<unknown> | undefined
  let unloading: Promise<unknown> | undefined
  vi.spyOn(VultrSshProvisioning.prototype, 'bootstrap').mockImplementation(async (_record, signal) => {
    signal.addEventListener('abort', () => { cancelled.resolve(undefined) }, { once: true })
    entered.resolve(undefined)
    await release.promise
    signal.throwIfAborted()
    return '#!/bin/sh\n'
  })
  // oxlint-disable-next-line typescript/unbound-method -- Called below with the original runtime receiver.
  const dispose = WorkspaceSshRuntime.prototype.dispose
  const cleanup = vi.spyOn(WorkspaceSshRuntime.prototype, 'dispose').mockImplementation(async function (this: WorkspaceSshRuntime) {
    draining.resolve(undefined)
    await drained.promise
    await dispose.call(this)
  })
  try {
    const provider = f.ctx.plugin(VultrWorkspaceBackend, f.settings)
    await provider
    await expect(f.competitor.initialize()).rejects.toThrow('Another Harness owns')
    opening = f.ctx.sandboxRunnerClient.open(WorkspaceId('owned-workspace'), f.project).catch((error: unknown) => error)
    await entered.promise
    let disposed = false
    unloading = (owner === 'provider' ? provider.dispose() : f.ctx.fiber.dispose()).then(() => { disposed = true })
    await cancelled.promise
    await expect(f.competitor.initialize()).rejects.toThrow('Another Harness owns')
    expect(disposed).toBe(false)
    expect(cleanup).not.toHaveBeenCalled()
    release.resolve(undefined)
    expect(await opening).toMatchObject({ code: 'cloud_open_failed' })
    await draining.promise
    await expect(f.competitor.initialize()).rejects.toThrow('Another Harness owns')
    expect(disposed).toBe(false)
    drained.resolve(undefined)
    await unloading
    expect(cleanup).toHaveBeenCalledTimes(1)
    await f.competitor.initialize()
    const record = (await f.competitor.load())[0]
    expect(record).toMatchObject({ state: 'cleanup_required', failure: 'create' })
    if (record === undefined) throw new Error('Missing original operation record')
    await f.competitor.save({ ...record, label: 'next-owner' })
    await f.ctx.fiber.dispose()
    expect((await f.competitor.load())[0]?.label).toBe('next-owner')
  } finally {
    release.resolve(undefined)
    drained.resolve(undefined)
    await opening
    await unloading
  }
})

linuxTest.each(['validation', 'inventory'] as const)('startup failure during %s releases the state lock', async (phase) => {
  const f = await fixture()
  const cleanup = vi.spyOn(WorkspaceSshRuntime.prototype, 'dispose')
  const message = phase === 'validation' ? 'Vultr helper archive digest mismatch' : 'Inventory unavailable'
  if (phase === 'validation') f.settings.helperArchiveHash = 'b'.repeat(64)
  else f.inventory.mockRejectedValue(new Error(message))
  const provider = f.ctx.plugin(VultrWorkspaceBackend, f.settings)
  await expect(provider).rejects.toThrow(message)
  await f.competitor.initialize()
  expect(cleanup).toHaveBeenCalledTimes(phase === 'validation' ? 0 : 1)
})

linuxTest.each(['state-lock', 'inventory'] as const)('unload during initial %s acquisition releases ownership', async (phase) => {
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  if (phase === 'inventory') {
    f.inventory.mockImplementation(async () => { entered.resolve(undefined); await release.promise; return [] })
  } else {
    // oxlint-disable-next-line typescript/unbound-method -- Called below with the original store receiver.
    const initialize = CloudWorkspaceStore.prototype.initialize
    vi.spyOn(CloudWorkspaceStore.prototype, 'initialize').mockImplementation(async function (this: CloudWorkspaceStore) {
      await initialize.call(this)
      if (this !== f.competitor) { entered.resolve(undefined); await release.promise }
    })
  }
  const provider = f.ctx.plugin(VultrWorkspaceBackend, f.settings)
  let unloading: Promise<unknown> | undefined
  try {
    await entered.promise
    unloading = provider.dispose()
    await expect(f.competitor.initialize()).rejects.toThrow('Another Harness owns')
  } finally { release.resolve(undefined); await unloading }
  await f.competitor.initialize()
})
