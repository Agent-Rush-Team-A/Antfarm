/** Fixed-instance SSH provider over the shared execution-generation controller. */
import { Context } from '@deepseek-ai/cordis'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { SandboxExecutionBackend } from './backend.ts'
import { Config } from './ssh-config.ts'
import { WorkspaceSshRuntime } from './ssh-controller.ts'
import type { RunnerExecutionIdentity, RunnerExecutionRequest } from './execution.ts'
import type { SandboxContainerId } from './runner-client.ts'

/** Keeps fixed Workspace bindings separate from execution and cloud allocation. */
export default class WorkspaceSshBackend extends SandboxExecutionBackend {
  static Config = Config
  private readonly runtime: WorkspaceSshRuntime
  /**
   * @param ctx - Provider owner.
   * @param config - Fixed deployment coordinates.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.runtime = new WorkspaceSshRuntime(ctx, config)
    ctx.effect(() => () => this.runtime.dispose())
  }
  override open(workspaceId: WorkspaceId, workspaceDir: string) { return this.runtime.open(workspaceId, workspaceDir) }
  override status(workspaceId: WorkspaceId) { return this.runtime.status(workspaceId) }
  override close(workspaceId: WorkspaceId) { return this.runtime.close(workspaceId) }
  override execute(workspaceId: WorkspaceId, request: RunnerExecutionRequest, signal?: AbortSignal) {
    return this.runtime.execute(workspaceId, request, signal)
  }
  override cancel(workspaceId: WorkspaceId, request: RunnerExecutionIdentity) { return this.runtime.cancel(workspaceId, request) }
  override files(workspaceId: WorkspaceId, target: SandboxContainerId, signal?: AbortSignal) {
    return this.runtime.files(workspaceId, target, signal)
  }
}
