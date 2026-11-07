/** Optional independent Vultr VM provider; execution coordination remains on the Harness. */
import { readFile, realpath } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { WorkspaceFileAccess, type WorkspaceFileScope } from '@deepseek-ai/dsh-fs/workspace-access'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { SandboxExecutionBackend } from './backend.ts'
import { Config, type ResolvedConfig } from './vultr-config.ts'
import { VultrApi } from './vultr-api.ts'
import { CloudWorkspaceStore } from './vultr-storage.ts'
import { VultrSshProvisioning } from './vultr-provision.ts'
import { VultrWorkspaceController } from './vultr-controller.ts'
import { WorkspaceSshRuntime } from './ssh-controller.ts'
import type { RunnerExecutionIdentity, RunnerExecutionRequest } from './execution.ts'
import type { SandboxContainerId } from './runner-client.ts'

export { Config } from './vultr-config.ts'

class CloudFileAccess extends WorkspaceFileAccess {
  constructor(ctx: Context, private readonly controller: VultrWorkspaceController) { super(ctx) }
  private async activity<T>(scope: WorkspaceFileScope, operation: () => Promise<T>, settle?: (result: T) => Promise<void>): Promise<T> {
    const release = this.ctx.get('workspaceSandboxState')?.beginExecution(scope.workspaceId)
    let transferred = false
    try {
      const result = await operation()
      if (settle !== undefined) { transferred = true; void settle(result).then(() => release?.(), () => release?.()) }
      return result
    } finally { if (!transferred) release?.() }
  }
  override list(scope: WorkspaceFileScope, path: string, maxEntries: number) {
    return this.activity(scope, () => this.controller.list(scope, path, maxEntries))
  }
  override download(scope: WorkspaceFileScope, path: string, maxBytes: number) {
    return this.activity(scope, () => this.controller.download(scope, path, maxBytes), stream => stream.settled)
  }
  override upload(scope: WorkspaceFileScope, name: string, chunks: AsyncIterable<Uint8Array>, maxBytes: number) {
    return this.activity(scope, () => this.controller.upload(scope, name, chunks, maxBytes))
  }
}

/** Owns persisted cloud resources and supplies matching text, binary, and command providers. */
export default class VultrWorkspaceBackend extends SandboxExecutionBackend {
  static Config = Config
  private readonly settings: ResolvedConfig
  private controller!: VultrWorkspaceController

  /**
   * @param ctx - Deployment owner.
   * @param config - Explicit allocation settings.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.settings = Config(config)
    if (process.platform !== 'linux') throw new Error('Vultr workspace backend requires a Linux Harness')
    z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/u).parse(this.settings.deploymentId)
    const endpoint = new URL(this.settings.apiEndpoint)
    if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname))) throw new Error('Vultr endpoint must use HTTPS or test loopback')
    if (endpoint.username || endpoint.password || endpoint.search
      || endpoint.hash) throw new Error('Vultr API endpoint cannot contain credentials, query or fragment')
  }

  async [Service.init](): Promise<void> {
    const store = new CloudWorkspaceStore(this.settings.stateRoot)
    await store.initialize()
    this.ctx.effect(() => () => store.close())
    const provisioning = new VultrSshProvisioning(this.settings)
    await provisioning.validate()
    this.settings.apiKeyFile = await realpath(this.settings.apiKeyFile)
    this.settings.sshKeyFile = await realpath(this.settings.sshKeyFile)
    const key = (await readFile(this.settings.apiKeyFile, 'utf8')).trim()
    if (key.length === 0 || /[\r\n]/u.test(key)) throw new Error('Vultr API credential is empty or malformed')
    const api = new VultrApi(key, this.settings.apiEndpoint.replace(/\/$/u, ''), this.settings.requestTimeoutMs,
      this.settings.maxInventoryPages, this.settings.maxApiResponseBytes)
    const runtime = new WorkspaceSshRuntime(this.ctx, { bindings: {}, maxExecutions: this.settings.maxExecutions,
      maxOutputBytes: this.settings.maxOutputBytes, graceMs: this.settings.graceMs })
    this.controller = new VultrWorkspaceController(this.settings, api, store, runtime, provisioning, (id, failure) => {
      this.ctx.logger.warn('workspace-vultr: workspace %s failed during %s; dependent work is blocked, and existing cloud disks are retained. Query status and retry closure after checking the cloud operation.', id, failure)
    })
    this.ctx.effect(() => () => this.controller.dispose())
    await this.controller.initialize()
    await this.ctx.plugin(CloudFileAccess, this.controller)
  }

  override open(workspaceId: WorkspaceId, workspaceDir: string) { return this.controller.open(workspaceId, workspaceDir) }
  override status(workspaceId: WorkspaceId) { return this.controller.status(workspaceId) }
  override close(workspaceId: WorkspaceId) { return this.controller.close(workspaceId) }
  override execute(workspaceId: WorkspaceId, request: RunnerExecutionRequest, signal?: AbortSignal) {
    return this.controller.execute(workspaceId, request, signal)
  }
  override cancel(workspaceId: WorkspaceId, request: RunnerExecutionIdentity) { return this.controller.cancel(workspaceId, request) }
  override files(workspaceId: WorkspaceId, target: SandboxContainerId, signal?: AbortSignal) {
    return this.controller.files(workspaceId, target, signal)
  }
  override activity(workspaceId: WorkspaceId) { return this.controller.activity(workspaceId) }
  override progress(workspaceId: WorkspaceId) { return this.controller.progress(workspaceId) }
}
