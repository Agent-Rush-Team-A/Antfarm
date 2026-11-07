/** Loader composition for registry-owned Docker and optional Vultr workspace modes. */
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { WorkspaceId, WorkspaceMode } from '@deepseek-ai/dsh-workspace/types'
import DockerWorkspaceBackend, { Config as DockerConfig } from './docker.ts'
import type { Config as DockerSettings } from './docker.ts'
import WorkspaceModeBackend from './mode-backend.ts'
import { WorkspaceModeDirectoryFiles } from './mode-directory-files.ts'
import type { WorkspaceModeDirectory } from './mode-directory-files.ts'
import { WorkspaceModeDirectoryResources } from './mode-directory-resources.ts'
import { WorkspaceModeRuntimeAdapter, type WorkspaceModeResources } from './mode-runtime.ts'
import type { WorkspaceModeTarget } from './mode-routing.ts'
import VultrWorkspaceBackend, { Config as VultrConfig } from './vultr.ts'
import type { Config as VultrSettings } from './vultr-config.ts'
import { SingleVmWorkspaces, type SingleVmWorkspaceConfig } from './single-vm-workspaces.ts'
import { createSingleVmVultrBackend, type SingleVmVultrConfig } from './single-vm-vultr.ts'

/** Runner transport, shared bind root, private transition storage and optional Vultr providers. */
export type Config = DockerSettings & {
  readonly stateRoot: string
  readonly maxFiles: number
  readonly maxBytes: number
  readonly vultr?: {
    readonly multi: VultrSettings
    readonly single: SingleVmVultrConfig
    readonly vfs: Omit<SingleVmWorkspaceConfig, 'projectRoot' | 'taskIds'> & { readonly taskIds: number[] }
  } | undefined
}

/** Explicit deployment storage and complete-copy budgets. */
export const Config: Schema<Config> = Schema.intersect([DockerConfig, Schema.object({
  stateRoot: Schema.string().required(),
  maxFiles: Schema.natural().min(1).required(),
  maxBytes: Schema.natural().min(1).required(),
  vultr: Schema.union([Schema.const(undefined), Schema.object({
    multi: VultrConfig.required(),
    single: Schema.intersect([VultrConfig, Schema.object({
      volumeId: Schema.string().required(),
      vfsScriptsRoot: Schema.string().required(),
    })]).required(),
    vfs: Schema.object({
      mountPoint: Schema.string().required(),
      mountTag: Schema.string().required(),
      workspaceRoot: Schema.string().required(),
      stateRoot: Schema.string().required(),
      taskIds: Schema.array(Schema.natural().min(1).max(0xffff_fffe)).min(1).required(),
    }).required(),
  })]),
})])

/** Docker mode composition entry. */
export const name = 'workspace-docker-modes'
/** Registry coordination stays outside the isolated execution provider. */
export const inject = ['workspaceRegistry']

/**
 * Install the configured modes with one shared router and transition runtime.
 * @param ctx - Loader owner carrying the native workspace registry.
 * @param config - Shared Runner/root configuration, private transition storage and optional Vultr settings.
 * @returns after the execution, file and transition providers are available.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const settings = Config(config)
  const registry = ctx.workspaceRegistry
  const cloud = settings.vultr
  if (cloud != null && registry.config.defaultMode === 'single-vm') {
    throw new Error('Vultr VFS requires workspace.defaultMode other than single-vm. Switch to single-vm before creating the first Session.')
  }
  if (!isAbsolute(settings.stateRoot)) throw new Error('Docker mode stateRoot must be absolute')
  const root = resolve(settings.workspaceRoot)
  if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) {
    throw new Error('Docker mode workspaceRoot must be a canonical directory')
  }
  const directory = async (workspaceId: WorkspaceId, project: string, signal: AbortSignal,
    admit: () => void, allowMissing = false): Promise<WorkspaceModeDirectory> => {
    const workspace = registry.get(workspaceId)
    const assertCurrent = (): void => {
      signal.throwIfAborted()
      admit()
      if (workspace === undefined || workspace.path !== project || registry.get(workspaceId) !== workspace) {
        throw new Error('Docker mode workspace registration changed')
      }
    }
    assertCurrent()
    if (dirname(project) !== root || await realpath(root) !== root) {
      throw new Error('Docker mode workspace parent changed')
    }
    const info = await lstat(project).catch((error: unknown) => {
      if (allowMissing && typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    })
    if (info !== undefined && (!info.isDirectory() || info.isSymbolicLink() || await realpath(project) !== project)) {
      throw new Error('Docker mode workspace is not a real direct child of workspaceRoot')
    }
    assertCurrent()
    return { root: project, assertCurrent }
  }
  const isolated = ctx.isolate('sandboxRunnerClient')
  await isolated.plugin(DockerWorkspaceBackend, settings)
  await isolated.inject(['sandboxRunnerClient'], async (owner) => {
    const execution = owner.sandboxRunnerClient
    const files = new WorkspaceModeDirectoryFiles(scope =>
      directory(scope.workspaceId, scope.project, scope.signal, () => { scope.admit() }))
    const modes: readonly WorkspaceMode[] = ['single-docker', 'multi-docker']
    const targets = new Map<WorkspaceMode, WorkspaceModeTarget>(modes.map(mode => [mode, { execution, files }]))
    const resources = new Map<WorkspaceMode, WorkspaceModeResources>(modes.map(mode => [mode, new WorkspaceModeDirectoryResources({
      stateRoot: settings.stateRoot, maxFiles: settings.maxFiles, maxBytes: settings.maxBytes, mode, backend: execution,
      directory: (change, signal) => directory(change.workspaceId, change.project, signal, () => {}, true),
    })]))
    const publish = async (providers: Context): Promise<void> => {
      // The facade keeps public service names while its owner retains private providers through teardown.
      const facade = providers.extend({ [Context.isolate]: ctx[Context.isolate] })
      await facade.plugin(WorkspaceModeBackend, {
        modes: registry.modes, targets, runtime: new WorkspaceModeRuntimeAdapter(resources),
      })
    }
    if (cloud == null) { await publish(owner); return }

    const workspaces = new SingleVmWorkspaces({ ...cloud.vfs, projectRoot: root }, id => registry.get(id))
    workspaces.assertOutside(resolve(settings.stateRoot))
    workspaces.assertOutside(resolve(cloud.multi.stateRoot))
    for (const file of [cloud.multi.apiKeyFile, cloud.multi.sshKeyFile, cloud.multi.helperArchive]) {
      workspaces.assertOutside(await realpath(file))
    }
    if (cloud.multi.remoteRoot !== undefined && cloud.multi.remoteRoot !== '/workspace') {
      throw new Error('Vultr workspace modes require /workspace as the guest root')
    }
    const vm = owner.isolate('sandboxRunnerClient').isolate('workspaceFileAccess')
    await vm.plugin(VultrWorkspaceBackend, cloud.multi)
    await vm.inject(['sandboxRunnerClient', 'workspaceFileAccess'], async (providers) => {
      const multi = providers.sandboxRunnerClient
      if (!(multi instanceof VultrWorkspaceBackend)) throw new Error('Vultr mode execution provider did not load')
      const single = await createSingleVmVultrBackend(providers, cloud.single, workspaces)
      try { providers.effect(() => () => single.dispose()) }
      catch (error) { await single.dispose(); throw error }
      targets.set('multi-vm', { execution: multi, files: providers.workspaceFileAccess })
      targets.set('single-vm', { execution: single, files: workspaces.files })
      resources.set('multi-vm', multi.modeResources({
        stateRoot: settings.stateRoot, maxFiles: settings.maxFiles, maxBytes: settings.maxBytes, mode: 'multi-vm',
        directory: (change, signal) => directory(change.workspaceId, change.project, signal, () => {}, true),
      }))
      resources.set('single-vm', workspaces.resources(single, { maxFiles: settings.maxFiles, maxBytes: settings.maxBytes }))
      await publish(providers)
    })
  })
}
