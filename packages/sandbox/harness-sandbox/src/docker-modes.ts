/** Loader composition for persistent Docker files and registry-owned single/multi-session modes. */
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
import { WorkspaceModeRuntimeAdapter } from './mode-runtime.ts'
import type { WorkspaceModeTarget } from './mode-routing.ts'

/** Runner transport, shared bind root, and private bounded mode-transition storage. */
export type Config = DockerSettings & {
  readonly stateRoot: string
  readonly maxFiles: number
  readonly maxBytes: number
}

/** Explicit deployment storage and complete-copy budgets. */
export const Config: Schema<Config> = Schema.intersect([DockerConfig, Schema.object({
  stateRoot: Schema.string().required(),
  maxFiles: Schema.natural().min(1).required(),
  maxBytes: Schema.natural().min(1).required(),
})])

/** Docker mode composition entry. */
export const name = 'workspace-docker-modes'
/** Registry coordination stays outside the isolated execution provider. */
export const inject = ['workspaceRegistry']

/**
 * Install both Docker modes with one isolated Runner and persistent file directory provider.
 * @param ctx - Loader owner carrying the native workspace registry.
 * @param config - Shared Runner/root configuration and private mode-transition storage.
 * @returns after the execution, file and transition providers are available.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const settings = Config(config)
  if (!isAbsolute(settings.stateRoot)) throw new Error('Docker mode stateRoot must be absolute')
  const root = resolve(settings.workspaceRoot)
  if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) {
    throw new Error('Docker mode workspaceRoot must be a canonical directory')
  }
  const registry = ctx.workspaceRegistry
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
    const resources = new Map(modes.map(mode => [mode, new WorkspaceModeDirectoryResources({
      stateRoot: settings.stateRoot, maxFiles: settings.maxFiles, maxBytes: settings.maxBytes, mode, backend: execution,
      directory: (change, signal) => directory(change.workspaceId, change.project, signal, () => {}, true),
    })]))
    // The facade keeps public names while its owner retains the private Runner through teardown.
    const facade = owner.extend({ [Context.isolate]: ctx[Context.isolate] })
    await facade.plugin(WorkspaceModeBackend, {
      modes: registry.modes, targets, runtime: new WorkspaceModeRuntimeAdapter(resources),
    })
  })
}
