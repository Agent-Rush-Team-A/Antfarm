/** Production Docker directory resolution during restart-safe publication. */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { basename, join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorkspaceFileScope } from '@deepseek-ai/dsh-fs/workspace-access'
import type { WorkspaceModeChange, WorkspaceModeChangeId, WorkspaceModeRuntime } from '@deepseek-ai/dsh-workspace/types'
import * as DockerModes from '../src/docker-modes.ts'
import WorkspaceSandbox from '../src/index.ts'
import { VultrApi } from '../src/vultr-api.ts'
import { fixture } from './fixtures/management.ts'

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) }
})

const taskGroup = process.getgroups?.().find(id => id > 0 && id !== process.getuid?.() && id !== process.getgid?.())

describe.runIf(process.platform === 'linux')('Docker mode directory publication', () => {
  test.each(['single-docker', 'multi-docker'] as const)('deleting a %s workspace waits for its configured Runner to confirm cleanup', async (mode) => {
    const f = await fixture(1000, false, 1000, 1000, mode)
    await f.sandboxFiber.dispose()
    await f.ctx.plugin(DockerModes, {
      socketPath: f.socketPath, workspaceRoot: f.workspaceRoot, stateRoot: join(f.home, 'mode-state'),
      maxFiles: 100, maxBytes: 4096,
    })
    await f.ctx.plugin(WorkspaceSandbox, { backend: 'provided', workspaceRoot: f.workspaceRoot })
    const file = join(f.alice.workspace.path, 'keep.txt')
    await writeFile(file, 'keep')
    const respond = f.control.respond
    f.control.respond = (response, method, call) => {
      if (method === 'DELETE') response.writeHead(409).end(JSON.stringify({ error: 'sandbox_cleanup_required' }))
      else respond(response, method, call)
    }

    expect(await f.remove(f.alice.cookie, f.alice.id)).toMatchObject({
      ok: false, error: { code: 'sandbox/failed', details: { reason: 'sandbox_cleanup_required' } },
    })
    expect(f.ctx.workspaceRegistry.get(f.alice.id)).toBe(f.alice.workspace)
    expect(f.ctx.multiuser.ownsWorkspace(f.alice.user.userId, f.alice.id)).toBe(true)

    f.control.respond = respond
    expect(await f.remove(f.alice.cookie, f.alice.id)).toEqual({ ok: true, value: { deleted: true } })
    const path = `/v1/workspaces/${f.alice.id}/sandbox`
    expect(f.calls.map(call => [call.method, call.path])).toEqual([['GET', path], ['DELETE', path], ['GET', path], ['DELETE', path]])
    expect(f.ctx.workspaceRegistry.get(f.alice.id)).toBeUndefined()
    expect(f.ctx.workspaceRegistry.get(f.bob.id)).toBe(f.bob.workspace)
    expect(await readFile(file, 'utf8')).toBe('keep')
  })

  test('the private drain socket lets an admitted upload finish and refuses new work', async () => {
    const f = await fixture(1000, false, 1000, 1000, 'multi-docker')
    await f.sandboxFiber.dispose()
    const drainSocket = join(f.home, 'drain.sock')
    const registry = f.ctx.workspaceRegistry
    const quiesce = registry.quiesceModes.bind(registry)
    const started = Promise.withResolvers<undefined>()
    vi.spyOn(registry, 'quiesceModes').mockImplementation(() => {
      const result = quiesce()
      started.resolve(undefined)
      return result
    })
    await f.ctx.plugin(DockerModes, {
      socketPath: f.socketPath, workspaceRoot: f.workspaceRoot, stateRoot: join(f.home, 'mode-state'),
      maxFiles: 100, maxBytes: 4096, drainSocket,
    })
    const callSocket = (method: string, path: string) => new Promise<number | undefined>((resolve, reject) => {
      request({ socketPath: drainSocket, path, method }, (response) => {
        response.resume()
        resolve(response.statusCode)
      }).once('error', reject).end()
    })
    await expect(callSocket('GET', '/ready')).resolves.toBe(204)
    const options = { signal: new AbortController().signal, admit: () => {} }
    const lease = await registry.modes.acquireUse(f.alice.id, options)
    const writing = Promise.withResolvers<undefined>()
    const finishWrite = Promise.withResolvers<undefined>()
    const upload = f.ctx.workspaceFileAccess.upload({
      ...options, workspaceId: f.alice.id, project: f.alice.workspace.path,
    }, 'drained.txt', (async function* () {
      writing.resolve(undefined)
      yield Buffer.from('saved')
      await finishWrite.promise
    })(), 100)
    let acknowledged = false
    let drained: Promise<number | undefined>
    try {
      await Promise.race([writing.promise, upload])
      drained = callSocket('POST', '/drain').then((status) => {
        acknowledged = true
        return status
      })
      const entered = await Promise.race([started.promise.then(() => true), drained.then(() => false)])
      expect(entered).toBe(true)
      await expect(callSocket('GET', '/ready')).resolves.toBe(503)
      await expect(registry.modes.acquireUse(f.bob.id, options)).rejects.toMatchObject({ code: 'workspace/mode-runtime-unavailable' })
      await expect(registry.modes.setMode({ workspaceId: f.bob.id, mode: 'single-docker', expectedRevision: 0 }, options))
        .rejects.toMatchObject({ code: 'workspace/mode-runtime-unavailable' })
      expect(acknowledged).toBe(false)
      expect(() => lease.admit()).not.toThrow()
    } finally {
      lease.release()
      finishWrite.resolve(undefined)
    }
    await expect(upload).resolves.toMatchObject({ bytes: 5 })
    expect(await readFile(join(f.alice.workspace.path, 'drained.txt'), 'utf8')).toBe('saved')
    await expect(drained).resolves.toBe(204)
  })

  test('rejects a default single-session VM before starting cloud providers', async () => {
    const f = await fixture(1000, false, 1000, 1000, 'single-vm')
    await f.sandboxFiber.dispose()
    const vm = {
      apiKeyFile: join(f.home, 'api-key'), sshKeyFile: join(f.home, 'ssh-key'), stateRoot: join(f.home, 'cloud-state'),
      helperArchive: join(f.home, 'helper.tar.gz'), helperArchiveHash: 'a'.repeat(64), helperHash: 'b'.repeat(64),
      deploymentId: 'test', region: 'nrt', plan: 'vc2-1c-1gb', osId: 2284,
    }
    const mountPoint = join(f.home, 'vfs')
    await expect(DockerModes.apply(f.ctx, {
      socketPath: f.socketPath, workspaceRoot: f.workspaceRoot, stateRoot: join(f.home, 'mode-state'), maxFiles: 100, maxBytes: 4096,
      vultr: {
        multi: vm,
        single: { ...vm, volumeId: randomUUID(), vfsScriptsRoot: join(f.home, 'scripts') },
        vfs: { mountPoint, mountTag: '113849250', workspaceRoot: join(mountPoint, 'workspaces'),
          stateRoot: join(f.home, 'identities'), taskIds: [11001] },
      },
    })).rejects.toThrow('Vultr VFS requires workspace.defaultMode other than single-vm')
    expect(f.calls).toEqual([])
  })

  test('rejects relative transition state and a symlinked Docker root before touching Runner', async () => {
    const f = await fixture(1000, false, 1000, 1000, 'multi-docker')
    await f.sandboxFiber.dispose()
    const config = { socketPath: f.socketPath, workspaceRoot: f.workspaceRoot, stateRoot: join(f.home, 'mode-state'), maxFiles: 20, maxBytes: 1024 }
    await expect(DockerModes.apply(f.ctx, { ...config, stateRoot: 'relative' })).rejects.toThrow('stateRoot must be absolute')
    const alias = join(f.home, 'alias')
    await symlink(f.workspaceRoot, alias)
    await expect(DockerModes.apply(f.ctx, { ...config, workspaceRoot: alias })).rejects.toThrow('workspaceRoot must be a canonical directory')
    expect(f.calls).toEqual([])
  })

  test('recovery restores a missing published root while binary access refuses it', async () => {
    const f = await fixture(1000, false, 1000, 1000, 'multi-docker')
    await f.sandboxFiber.dispose()
    f.control.respond = (response, method) => {
      response.end(JSON.stringify(method === 'PUT'
        ? { state: 'running', containerId: 'a'.repeat(64) } : { state: 'closed' }))
    }
    const modes = f.ctx.workspaceRegistry.modes
    const register = modes.registerRuntime.bind(modes)
    const registered: { runtime?: WorkspaceModeRuntime } = {}
    vi.spyOn(modes, 'registerRuntime').mockImplementation((runtime) => {
      registered.runtime = runtime
      return register(runtime)
    })
    const stateRoot = join(f.home, 'mode-state')
    await f.ctx.plugin(DockerModes, {
      socketPath: f.socketPath, workspaceRoot: f.workspaceRoot, stateRoot, maxFiles: 100, maxBytes: 4096,
    })
    if (registered.runtime === undefined) throw new Error('Docker mode runtime did not register')
    const change: WorkspaceModeChange = {
      changeId: brandString<WorkspaceModeChangeId>(randomUUID()), workspaceId: f.alice.id,
      project: f.alice.workspace.path, from: 'multi-docker', to: 'single-docker', previousRevision: 0,
    }
    const signal = new AbortController().signal
    await writeFile(join(change.project, 'input.csv'), 'amount\n32\n')
    await registered.runtime.prepare(change, signal)
    const hash = createHash('sha256').update('single-docker:' + change.changeId).digest('hex')
    const journalPath = join(stateRoot, hash, 'state.json')
    const journal = z.object({ role: z.object({ kind: z.literal('target'), phase: z.string() }).loose() }).loose()
      .parse(JSON.parse(await readFile(journalPath, 'utf8')))
    journal.role.phase = 'publishing'
    await writeFile(journalPath, JSON.stringify(journal))
    const stage = join(f.workspaceRoot, '.' + basename(change.project) + '.mode-' + hash)
    await rename(change.project, stage + '.previous')
    const scope: WorkspaceFileScope = { workspaceId: change.workspaceId, project: change.project, signal, admit: () => {} }
    await expect(f.ctx.workspaceFileAccess.list(scope, '', 100)).rejects.toMatchObject({ code: 'ENOENT' })
    await registered.runtime.settle(change, 'commit', signal)
    expect(await readFile(join(change.project, 'input.csv'), 'utf8')).toBe('amount\n32\n')
    await registered.runtime.settle(change, 'commit', signal)
    await expect(f.ctx.workspaceFileAccess.list({ ...scope, project: f.bob.workspace.path }, '', 100)).rejects.toThrow('workspace registration changed')
    const moved = change.project + '.moved'
    await rename(change.project, moved)
    await symlink(moved, change.project)
    await expect(f.ctx.workspaceFileAccess.list(scope, '', 100)).rejects.toThrow('not a real direct child')
    expect(f.calls.some(call => call.method === 'PUT')).toBe(false)
  })

  test.runIf(process.getuid?.() !== 0 && taskGroup !== undefined)('switches cloud file routes before the first Session without allocating a VM', async () => {
    if (taskGroup === undefined) throw new Error('Missing supplementary task group')
    const f = await fixture(1000, false, 1000, 1000, 'multi-docker')
    await f.sandboxFiber.dispose()
    f.control.respond = (response) => { response.end(JSON.stringify({ state: 'closed' })) }
    const mountPoint = join(f.home, 'vfs')
    const workspaceRoot = join(mountPoint, 'workspaces')
    const scriptsRoot = join(f.home, 'scripts')
    await mkdir(workspaceRoot, { recursive: true })
    await chmod(workspaceRoot, 0o711)
    await mkdir(scriptsRoot)
    await writeFile(join(scriptsRoot, 'check-mount.sh'), '#!/bin/sh\n')
    await writeFile(join(scriptsRoot, 'run-workspace-helper.sh'), '#!/bin/sh\n')
    const cloud = {
      apiKeyFile: join(f.home, 'api-key'), sshKeyFile: join(f.home, 'ssh-key'), helperArchive: join(f.home, 'helper.tar.gz'),
      helperArchiveHash: createHash('sha256').update('fixture archive').digest('hex'), helperHash: 'a'.repeat(64),
      apiEndpoint: 'https://fixture.invalid/v2', deploymentId: 'test', region: 'nrt', plan: 'vc2-1c-1gb', osId: 2284,
    }
    await writeFile(cloud.apiKeyFile, 'fixture', { mode: 0o600 })
    await writeFile(cloud.sshKeyFile, 'fixture', { mode: 0o600 })
    await writeFile(cloud.helperArchive, 'fixture archive')
    const inventory = vi.spyOn(VultrApi.prototype, 'instances').mockResolvedValue([])
    const create = vi.spyOn(VultrApi.prototype, 'create')
    const mountRead = vi.mocked(readFileSync)
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
    mountRead.mockImplementation((...args) => args[0] === '/proc/self/mountinfo'
      ? `24 23 0:42 / ${mountPoint} rw - virtiofs 113849250 rw\n` : fs.readFileSync(...args))
    try {
      const modes = f.ctx.workspaceRegistry.modes
      const register = vi.spyOn(modes, 'registerRuntime')
      const plugin = f.ctx.plugin(DockerModes, {
        socketPath: f.socketPath, workspaceRoot: f.workspaceRoot, stateRoot: join(f.home, 'mode-state'), maxFiles: 20, maxBytes: 1024,
        vultr: {
          multi: { ...cloud, stateRoot: join(f.home, 'multi') },
          single: { ...cloud, stateRoot: join(f.home, 'single'), volumeId: randomUUID(), vfsScriptsRoot: scriptsRoot },
          vfs: { mountPoint, mountTag: '113849250', workspaceRoot, stateRoot: join(f.home, 'identities'), taskIds: [taskGroup] },
        },
      })
      await plugin
      expect(register.mock.calls[0]?.[0].supportedModes).toEqual(['single-docker', 'multi-docker', 'multi-vm', 'single-vm'])
      const workspaceId = f.alice.id
      const project = f.alice.workspace.path
      const scope = { workspaceId, project, signal: new AbortController().signal, admit() {} }
      await writeFile(join(project, 'input.csv'), 'shared content')
      const changeMode = (mode: 'single-vm' | 'multi-vm') =>
        modes.setMode({ workspaceId, mode, expectedRevision: modes.get(workspaceId).revision }, scope)
      await expect(changeMode('single-vm')).resolves.toMatchObject({ mode: 'single-vm', operationState: 'ready', firstSessionId: null })
      await expect(f.ctx.workspaceFileAccess.list(scope, '', 10)).resolves.toMatchObject({ entries: [{ name: 'input.csv' }] })
      await expect(readFile(join(workspaceRoot, basename(project), 'input.csv'), 'utf8')).resolves.toBe('shared content')
      await expect(changeMode('multi-vm')).resolves.toMatchObject({ mode: 'multi-vm', operationState: 'ready' })
      const download = await f.ctx.workspaceFileAccess.download(scope, 'input.csv', 100)
      expect(await new Response(download.body).text()).toBe('shared content')
      await download.settled
      expect(inventory).toHaveBeenCalledOnce()
      expect(create).not.toHaveBeenCalled()
      await plugin.dispose()
    } finally { mountRead.mockReset() }
  })
})
