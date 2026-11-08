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
import { Config as VultrConfig } from './vultr-config.ts'
import { SingleVmWorkspaces, type SingleVmWorkspaceConfig } from './single-vm-workspaces.ts'
import { createMultiVmVultrBackend, createSingleVmVultrBackend, type SingleVmVultrConfig } from './single-vm-vultr.ts'
import { importLegacyVfsWorkspaces } from './vm-vfs-import.ts'

/** Runner transport, shared bind root, private transition storage and optional Vultr providers. */
export type Config = DockerSettings & {
  readonly stateRoot: string
  readonly maxFiles: number
  readonly maxBytes: number
  readonly vultr?: {
    readonly multi: SingleVmVultrConfig
    readonly single: SingleVmVultrConfig
    readonly legacyMultiStateRoot?: string | undefined
    readonly vfs: Omit<SingleVmWorkspaceConfig, 'projectRoot' | 'taskIds'> & { readonly taskIds: number[] }
  } | undefined
}

/** Explicit deployment storage and complete-copy budgets. */
export const Config: Schema<Config> = Schema.intersect([DockerConfig, Schema.object({
  stateRoot: Schema.string().required(),
  maxFiles: Schema.natural().min(1).required(),
  maxBytes: Schema.natural().min(1).required(),
  vultr: Schema.union([Schema.const(undefined), Schema.object({
    multi: Schema.intersect([VultrConfig, Schema.object({
      remoteRoot: Schema.const('/workspace').default('/workspace'),
      volumeId: Schema.string().required(),
      vfsScriptsRoot: Schema.string().required(),
    })]).required(),
    single: Schema.intersect([VultrConfig, Schema.object({
      remoteRoot: Schema.const('/workspace').default('/workspace'),
      volumeId: Schema.string().required(),
      vfsScriptsRoot: Schema.string().required(),
    })]).required(),
    legacyMultiStateRoot: Schema.union([Schema.const(undefined), Schema.string()]),
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
  if (cloud != null && (registry.config.defaultMode === 'single-vm' || registry.config.defaultMode === 'multi-vm')) {
    throw new Error('Vultr VFS requires a Docker workspace.defaultMode. Select a VM mode before creating the first Session.')
  }
  if (cloud != null) {
    if (cloud.multi.volumeId !== cloud.single.volumeId || cloud.multi.region !== cloud.single.region) {
      throw new Error('Vultr VM modes must share the same VFS volume and region')
    }
    const stateRoots = [settings.stateRoot, cloud.single.stateRoot, cloud.multi.stateRoot, cloud.vfs.stateRoot,
      ...(cloud.legacyMultiStateRoot === undefined ? [] : [cloud.legacyMultiStateRoot])]
    if (stateRoots.some(path => !isAbsolute(path) || resolve(path) !== path)) {
      throw new Error('Vultr mode state roots must be canonical absolute paths')
    }
    if (new Set(stateRoots).size !== stateRoots.length) {
      throw new Error('Vultr mode state roots must be distinct')
    }
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
    let disposeFacade: (() => Promise<unknown>) | undefined
    const publish = async (providers: Context): Promise<void> => {
      // The facade keeps public service names while its owner retains private providers through teardown.
      const facade = providers.extend({ [Context.isolate]: ctx[Context.isolate] })
      const plugin = facade.plugin(WorkspaceModeBackend, {
        modes: registry.modes, targets, runtime: new WorkspaceModeRuntimeAdapter(resources),
      })
      disposeFacade = () => plugin.dispose()
      await plugin
    }
    if (cloud == null) { await publish(owner); return }

    const workspaces = new SingleVmWorkspaces({ ...cloud.vfs, projectRoot: root }, id => registry.get(id))
    workspaces.assertOutside(resolve(settings.stateRoot))
    for (const path of [cloud.multi.stateRoot, cloud.single.stateRoot,
      ...(cloud.legacyMultiStateRoot === undefined ? [] : [cloud.legacyMultiStateRoot])]) workspaces.assertOutside(path)
    for (const file of [cloud.multi.apiKeyFile, cloud.multi.sshKeyFile, cloud.multi.helperArchive,
      cloud.single.apiKeyFile, cloud.single.sshKeyFile, cloud.single.helperArchive]) {
      workspaces.assertOutside(await realpath(file))
    }
    const limits = { maxFiles: settings.maxFiles, maxBytes: settings.maxBytes }
    if (cloud.legacyMultiStateRoot !== undefined) {
      const legacyStateRoot = cloud.legacyMultiStateRoot
      const controller = new AbortController()
      const importing = Promise.resolve().then(() => importLegacyVfsWorkspaces({ stateRoot: legacyStateRoot,
        registry, workspaces, backend: execution, limits }, controller.signal))
      try {
        owner.effect(() => async () => {
          controller.abort()
          await Promise.allSettled([importing])
        })
      } catch (error) {
        controller.abort()
        await Promise.allSettled([importing])
        throw error
      }
      await importing
    }
    const single = await createSingleVmVultrBackend(owner, cloud.single, workspaces)
    try { owner.effect(() => async () => { try { await disposeFacade?.() } finally { await single.dispose() } }) }
    catch (error) { await single.dispose(); throw error }
    const multi = await createMultiVmVultrBackend(owner, cloud.multi, workspaces)
    try { owner.effect(() => async () => { try { await disposeFacade?.() } finally { await multi.dispose() } }) }
    catch (error) { await multi.dispose(); throw error }
    targets.set('multi-vm', { execution: multi, files: workspaces.files })
    targets.set('single-vm', { execution: single, files: workspaces.files })
    resources.set('multi-vm', workspaces.resources('multi-vm', multi, limits))
    resources.set('single-vm', workspaces.resources('single-vm', single, limits))
    await publish(owner)
  })
}
