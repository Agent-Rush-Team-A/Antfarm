/** Harness-side Runner transport; user authorization belongs to the management caller. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { RunnerConfig } from './config.ts'
import { RunnerClient, type RunnerRunningSandbox, type RunnerClosedSandbox, type RunnerSandboxStatus } from './runner-client.ts'

export { RunnerConfig as Config } from './config.ts'
export { RunnerRequestError, RunnerResponseError, type RunnerRunningSandbox, type RunnerClosedSandbox, type RunnerSandboxStatus, type SandboxContainerId } from './runner-client.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Deployment-trusted local Runner transport; not a user authorization API. */
    sandboxRunnerClient: SandboxRunnerClient
  }
}

/** Lifecycle-managed internal communication with one independent Runner. */
export default class SandboxRunnerClient extends Service {
  static Config = RunnerConfig
  private readonly client: RunnerClient

  /**
   * @param ctx - Harness context owning transport disposal.
   * @param config - Trusted Runner socket and transport limits.
   */
  constructor(ctx: Context, config: RunnerConfig) {
    super(ctx, 'sandboxRunnerClient')
    this.client = new RunnerClient(RunnerConfig(config))
    ctx.effect(() => () => { this.client.dispose() })
  }

  /**
   * Send an authorized caller's open request; this transport does not authenticate users.
   * @param workspaceId - Trusted Runner workspace identity.
   * @param workspaceDir - Trusted persistent workspace directory.
   * @returns Confirmed running generation, retaining its full container identity.
   */
  open(workspaceId: WorkspaceId, workspaceDir: string): Promise<RunnerRunningSandbox> { return this.client.open(workspaceId, workspaceDir) }

  /**
   * Query the Runner for an authorized caller's workspace.
   * @param workspaceId - Trusted Runner workspace identity.
   * @returns The current validated observation; failures never synthesize closed.
   */
  status(workspaceId: WorkspaceId): Promise<RunnerSandboxStatus> { return this.client.status(workspaceId) }

  /**
   * Request closure after the caller has authorized this operation; never automatically replay it.
   * @param workspaceId - Trusted Runner workspace identity.
   * @returns Closed only after the Runner confirms container absence.
   */
  close(workspaceId: WorkspaceId): Promise<RunnerClosedSandbox> { return this.client.close(workspaceId) }
}
