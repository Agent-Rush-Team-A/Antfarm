/**
 * Owns Docker container generations and capacity for one workspace sandbox deployment.
 * @module @deepseek-ai/dsh-sandbox-runner
 */

import { dirname, isAbsolute, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import {
  Config, creationLabel, deploymentLabel, project, projectLabel, resolveCreateRequest, sandboxName, workspaceLabel, type ResolvedConfig,
} from './config.ts'
import { DockerEngine, DockerRequestError, type DockerContainerId, type SandboxContainer } from './docker.ts'
import { SandboxLifecycleError } from './errors.ts'
import { listenRunnerSocket } from './server.ts'

export { InvalidWorkspaceDirectoryError } from './config.ts'
export { DockerRequestError, type DockerContainerId } from './docker.ts'
export { SandboxLifecycleError } from './errors.ts'

/** Docker has confirmed that this generation is running and not paused. */
export interface RunningSandbox {
  readonly state: 'running'
  readonly containerId: DockerContainerId
}

/** Docker has confirmed absence. */
export interface ClosedSandbox {
  readonly state: 'closed'
}

/** Observed Docker state or the Runner operation currently owning the workspace. */
export type SandboxStatus = RunningSandbox | ClosedSandbox | { readonly state: 'starting' | 'closing' | 'cleanup_required' }

type Phase =
  | { state: 'starting'; result: Promise<RunningSandbox> }
  | { state: 'closing'; result: Promise<ClosedSandbox> }
  | { state: 'running' | 'cleanup_required' }

interface Slot {
  directory: string | null
  container: DockerContainerId | { token: string } | null
  phase: Phase
}

function running(container: SandboxContainer): boolean {
  return container.State.Running && !container.State.Paused
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Deployment-local workspace sandbox lifecycle. */
    sandboxRunner: SandboxRunner
  }
}

/** Coordinates one container generation per workspace, with two slots per deployment. */
export default class SandboxRunner extends Service {
  static Config = Config

  private readonly startup = new AbortController()
  private readonly docker: DockerEngine
  private readonly slots = new Map<WorkspaceId, Slot>()
  private readonly statusQueries = new Set<Promise<SandboxStatus>>()
  private ready = false

  /**
   * @param ctx - Runner-only Cordis context.
   * @param config - Trusted deployment settings.
   */
  constructor(ctx: Context, private readonly config: ResolvedConfig) {
    if (!isAbsolute(config.dockerSocket)) throw new Error('The Docker socket path must be absolute')
    const { workspaceRoot } = config
    if (resolve(workspaceRoot) !== workspaceRoot || dirname(workspaceRoot) === workspaceRoot) {
      throw new Error('The workspace root must be an absolute, canonical data directory')
    }
    super(ctx, 'sandboxRunner')
    this.docker = new DockerEngine(config, this.startup.signal)
  }

  protected async [Service.init](): Promise<void> {
    let stop: (() => Promise<void>) | undefined
    // Disposal waits for init, but the fiber stops accepting effects as soon as disposal starts.
    this.ctx.effect(() => async () => {
      this.ready = false
      const inFlight = [...this.slots.values()].flatMap(({ phase }) =>
        phase.state === 'starting' || phase.state === 'closing' ? [phase.result] : [])
      const drained = Promise.allSettled([...inFlight, ...this.statusQueries])
      try {
        await stop?.()
      } finally {
        await drained
      }
    })
    const owner = this.ctx.fiber
    // Init runs after the fiber's creation event. Its next plugin event announces disposal.
    const stopStartupCancellation = this.ctx.on('internal/plugin', (fiber) => {
      if (fiber === owner) this.startup.abort()
    })
    const { signal } = this.startup
    try {
      if (this.config.runnerSocket !== undefined) {
        stop = await listenRunnerSocket(this.config.runnerSocket, this, (error) => { this.ctx.logger.error(error) })
      }
      signal.throwIfAborted()
      for (const id of await this.docker.list()) {
        const container = await this.docker.inspect(id)
        if (container && this.owner(container)) await this.removeAndConfirm(id)
      }
      signal.throwIfAborted()
      this.ready = true
    } catch (cause) {
      if (!signal.aborted) throw cause
    } finally {
      stopStartupCancellation()
    }
  }

  /** Open or reuse the workspace sandbox. A conflicting request never queues for a slot.
   * @param workspaceId - Workspace registry identity.
   * @param directory - Existing workspace directory in the deployment's data root.
   * @returns The confirmed running generation.
   */
  async open(workspaceId: WorkspaceId, directory: string): Promise<RunningSandbox> {
    this.assertReady()
    let slot = this.slots.get(workspaceId)
    if (slot) {
      if (slot.phase.state === 'closing') throw new SandboxLifecycleError('sandbox_closing')
      if (slot.directory !== directory) throw new SandboxLifecycleError('sandbox_workspace_conflict')
      if (slot.phase.state === 'starting') return slot.phase.result
      if (slot.phase.state === 'cleanup_required') throw new SandboxLifecycleError('sandbox_cleanup_required')
    } else {
      const occupied = [...this.slots.values()].filter(entry => entry.directory !== null || entry.container !== null).length
      if (occupied >= 2) throw new SandboxLifecycleError('sandbox_capacity')
      slot = { directory, container: null, phase: { state: 'cleanup_required' } }
      this.slots.set(workspaceId, slot)
    }
    const entry = slot
    const result = Promise.resolve().then(() => this.openSlot(workspaceId, directory, entry))
    entry.phase = { state: 'starting', result }
    return result
  }

  /** Query the current generation without interpreting an uncertain create as absent. Disposal waits for in-flight queries.
   * @param workspaceId - Workspace registry identity.
   * @returns The observed sandbox state.
   */
  async status(workspaceId: WorkspaceId): Promise<SandboxStatus> {
    const query = this.queryStatus(workspaceId)
    this.statusQueries.add(query)
    try {
      return await query
    } finally {
      this.statusQueries.delete(query)
    }
  }

  private async queryStatus(workspaceId: WorkspaceId): Promise<SandboxStatus> {
    this.assertReady()
    const slot = this.slots.get(workspaceId)
    const phase = slot?.phase
    if (phase?.state === 'starting' || phase?.state === 'closing') return { state: phase.state }

    const container = await this.observe(workspaceId, slot?.container ?? null)
    this.assertReady()
    if (this.slots.get(workspaceId) !== slot || slot?.phase !== phase) return this.queryStatus(workspaceId)
    if (!container) {
      if (slot) this.slots.delete(workspaceId)
      return { state: 'closed' }
    }
    if (slot && typeof slot.container !== 'string') slot.container = container.Id
    if (slot?.phase.state === 'running' && running(container)) {
      this.assertMount(container, slot.directory)
      return { state: 'running', containerId: container.Id }
    }
    return { state: 'cleanup_required' }
  }

  /** Close the current generation. Acknowledging deletion alone does not release its slot.
   * @param workspaceId - Workspace registry identity.
   * @returns Closed after Docker confirms the generation is absent.
   */
  async close(workspaceId: WorkspaceId): Promise<ClosedSandbox> {
    this.assertReady()
    const slot: Slot = this.slots.get(workspaceId) ?? { directory: null, container: null, phase: { state: 'cleanup_required' } }
    if (slot.phase.state === 'closing') return slot.phase.result
    const opening = slot.phase.state === 'starting' ? slot.phase.result : undefined
    const result = Promise.resolve().then(() => this.closeSlot(workspaceId, slot, opening))
    slot.phase = { state: 'closing', result }
    this.slots.set(workspaceId, slot)
    return result
  }

  private assertReady(): void {
    if (!this.ready) throw new SandboxLifecycleError('sandbox_not_ready')
  }

  private assertOpening(slot: Slot): void {
    this.assertReady()
    if (slot.phase.state === 'closing') throw new SandboxLifecycleError('sandbox_closing')
  }

  private owner(container: SandboxContainer): string | undefined {
    const labels = container.Config.Labels
    if (labels?.[deploymentLabel] !== this.config.deploymentId || labels[projectLabel] !== project) return undefined
    return labels[workspaceLabel] || undefined
  }

  private assertOwner(container: SandboxContainer, workspaceId: WorkspaceId): void {
    if (this.owner(container) !== workspaceId) throw new SandboxLifecycleError('sandbox_name_conflict')
  }

  private assertMount(container: SandboxContainer, directory: string | null): void {
    const mounts = container.Mounts.filter(mount => mount.Type !== 'tmpfs')
    const mount = mounts[0]
    if (mounts.length !== 1 || mount?.Type !== 'bind' || mount.Source !== directory || mount.Destination !== '/workspace' || !mount.RW) {
      throw new SandboxLifecycleError('sandbox_workspace_conflict')
    }
  }

  private async observe(workspaceId: WorkspaceId, generation: Slot['container']): Promise<SandboxContainer | null> {
    const container = typeof generation === 'string'
      ? await this.docker.inspect(generation)
      : await this.docker.find(sandboxName(this.config.deploymentId, workspaceId))
    if (generation && typeof generation !== 'string' && container?.Config.Labels?.[creationLabel] !== generation.token) {
      throw new SandboxLifecycleError('sandbox_outcome_unknown')
    }
    if (container) this.assertOwner(container, workspaceId)
    return container
  }

  private async openSlot(workspaceId: WorkspaceId, directory: string, slot: Slot): Promise<RunningSandbox> {
    try {
      const spec = await resolveCreateRequest(this.config, workspaceId, directory)
      this.assertOpening(slot)
      if (slot.container !== null) {
        const old = await this.observe(workspaceId, slot.container)
        if (old) {
          this.assertMount(old, directory)
          this.assertOpening(slot)
          if (running(old)) {
            slot.phase = { state: 'running' }
            return { state: 'running', containerId: old.Id }
          }
          await this.removeAndConfirm(old.Id)
        }
        slot.container = null
      }

      this.assertOpening(slot)
      const orphan = await this.observe(workspaceId, null)
      if (orphan) {
        slot.container = orphan.Id
        this.assertMount(orphan, directory)
        this.assertOpening(slot)
        await this.removeAndConfirm(orphan.Id)
        slot.container = null
      }
      this.assertOpening(slot)
      slot.container = { token: spec.token }
      let id: DockerContainerId
      try {
        id = await this.docker.create(spec)
      } catch (cause) {
        if (cause instanceof DockerRequestError && cause.kind === 'engine') {
          const status = cause.details.status
          if (status === 400 || status === 404 || status === 409) slot.container = null
          if (status === 409) throw new SandboxLifecycleError('sandbox_name_conflict', cause)
        }
        throw cause
      }
      slot.container = id
      this.assertOpening(slot)
      const created = await this.observe(workspaceId, id)
      if (!created) {
        slot.container = null
        throw new SandboxLifecycleError('sandbox_outcome_unknown')
      }
      this.assertMount(created, directory)
      this.assertOpening(slot)
      await this.docker.start(id)
      const started = await this.observe(workspaceId, id)
      if (!started) slot.container = null
      if (!started || !running(started)) throw new SandboxLifecycleError('sandbox_outcome_unknown')
      this.assertMount(started, directory)
      this.assertOpening(slot)
      slot.phase = { state: 'running' }
      return { state: 'running', containerId: id }
    } catch (cause) {
      if (slot.phase.state !== 'closing') this.settleFailure(workspaceId, slot)
      throw cause
    }
  }

  private async closeSlot(workspaceId: WorkspaceId, slot: Slot, opening: Promise<RunningSandbox> | undefined): Promise<ClosedSandbox> {
    // The opening caller receives its failure; closing still owns any generation it left behind.
    if (opening) await Promise.allSettled([opening])
    try {
      const container = await this.observe(workspaceId, slot.container)
      if (container) {
        slot.container = container.Id
        await this.removeAndConfirm(container.Id)
      }
      this.slots.delete(workspaceId)
      return { state: 'closed' }
    } catch (cause) {
      this.settleFailure(workspaceId, slot)
      throw cause
    }
  }

  private settleFailure(workspaceId: WorkspaceId, slot: Slot): void {
    if (slot.container === null) this.slots.delete(workspaceId)
    else slot.phase = { state: 'cleanup_required' }
  }

  private async removeAndConfirm(id: DockerContainerId): Promise<void> {
    try {
      await this.docker.remove(id)
    } catch (cause) {
      if (await this.docker.inspect(id) === null) return
      throw cause
    }
    if (await this.docker.inspect(id) !== null) throw new SandboxLifecycleError('sandbox_cleanup_required')
  }
}
