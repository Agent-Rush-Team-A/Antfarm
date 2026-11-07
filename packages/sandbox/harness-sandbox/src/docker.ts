/** Docker Runner execution and native text access to its verified persistent bind directory. */
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { SandboxExecutionBackend, type WorkspaceRuntimeFiles } from './backend.ts'
import { RunnerConfig } from './config.ts'
import { RunnerClient, RunnerResponseError, type SandboxContainerId } from './runner-client.ts'
import type { RunnerExecutionIdentity, RunnerExecutionRequest } from './execution.ts'

/** The Runner and Harness must share the same absolute workspace root. */
export type Config = RunnerConfig & { readonly workspaceRoot: string }

/** Validate transport budgets and the deployment-owned workspace root. */
export const Config: Schema<Config> = Schema.intersect([RunnerConfig, Schema.object({ workspaceRoot: Schema.string().required() })])

interface DirectoryGeneration {
  readonly project: string
  readonly containerId: SandboxContainerId
  readonly lifetime: AbortController
}

/** Owns one Runner connection and a private filesystem; native tools receive only one bind directory. */
export default class DockerWorkspaceBackend extends SandboxExecutionBackend {
  static Config = Config
  private readonly client: RunnerClient
  private readonly root: string
  private readonly lifetime = new AbortController()
  private readonly generations = new Map<WorkspaceId, DirectoryGeneration>()
  private fs!: FileSystem

  /**
   * @param ctx - Isolated execution-provider owner.
   * @param config - Runner socket, operation budgets and shared persistent root.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    if (process.platform !== 'linux') throw new Error('Docker workspace file access requires a Linux Harness')
    const settings = Config(config)
    if (!isAbsolute(settings.workspaceRoot) || settings.workspaceRoot.includes('\0')) throw new Error('Docker workspaceRoot must be an absolute directory')
    this.root = resolve(settings.workspaceRoot)
    this.client = new RunnerClient(RunnerConfig(settings))
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('Docker workspace provider stopped'))
      for (const generation of this.generations.values()) generation.lifetime.abort()
      await this.client.dispose()
    })
  }

  async [Service.init](): Promise<void> {
    const files = this.ctx.isolate('fs')
    await files.plugin(LocalFileSystem, { cwd: this.root })
    const fs = files.get('fs')
    if (fs === undefined) throw new Error('Docker workspace filesystem did not load')
    this.fs = fs
  }

  override async open(workspaceId: WorkspaceId, workspaceDir: string) {
    await this.directory(workspaceDir)
    this.lifetime.signal.throwIfAborted()
    const target = await this.client.open(workspaceId, workspaceDir)
    const existing = this.generations.get(workspaceId)
    if (existing === undefined || existing.containerId !== target.containerId || existing.project !== workspaceDir) {
      existing?.lifetime.abort()
      this.generations.set(workspaceId, { project: workspaceDir, containerId: target.containerId, lifetime: new AbortController() })
    }
    return target
  }
  override status(workspaceId: WorkspaceId) { return this.client.status(workspaceId) }
  override close(workspaceId: WorkspaceId) {
    this.generations.get(workspaceId)?.lifetime.abort()
    return this.client.close(workspaceId)
  }
  override execute(workspaceId: WorkspaceId, request: RunnerExecutionRequest, signal?: AbortSignal) {
    return this.client.execute(workspaceId, request, signal)
  }
  override cancel(workspaceId: WorkspaceId, request: RunnerExecutionIdentity) { return this.client.cancel(workspaceId, request) }

  override async files(workspaceId: WorkspaceId, target: SandboxContainerId, signal?: AbortSignal): Promise<WorkspaceRuntimeFiles> {
    const generation = this.generations.get(workspaceId)
    if (generation === undefined || generation.containerId !== target) throw new RunnerResponseError('sandbox_workspace_conflict', 409, false)
    const lifetime = AbortSignal.any([this.lifetime.signal, generation.lifetime.signal, ...signal === undefined ? [] : [signal]])
    const assertCurrent = (): void => {
      lifetime.throwIfAborted()
      if (this.generations.get(workspaceId) !== generation) throw new RunnerResponseError('sandbox_workspace_conflict', 409, false)
    }
    assertCurrent()
    await this.directory(generation.project)
    const observed = await this.client.status(workspaceId)
    assertCurrent()
    if (observed.state !== 'running' || observed.containerId !== target) throw new RunnerResponseError('sandbox_workspace_conflict', 409, false)
    return { fs: this.fs, root: generation.project, displayRoot: '/workspace', signal: lifetime, assertCurrent }
  }

  private async directory(project: string): Promise<void> {
    const info = await lstat(project)
    const [root, path] = await Promise.all([realpath(this.root), realpath(project)])
    if (!info.isDirectory() || info.isSymbolicLink() || path !== project || dirname(path) !== root) {
      throw new RunnerResponseError('invalid_workspace_directory', 409, false)
    }
  }
}
