/**
 * Owns Docker container generations and capacity for one workspace sandbox deployment.
 * @module @deepseek-ai/dsh-sandbox-runner
 */

import { createHash } from 'node:crypto'
import { dirname, isAbsolute, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import {
  Config, creationLabel, deploymentLabel, project, projectLabel, resolveCreateRequest, sandboxName, workspaceLabel, type ResolvedConfig,
} from './config.ts'
import {
  DockerEngine, DockerRequestError, type DockerContainerId, type DockerExecResult, type DockerExecSession, type SandboxContainer,
} from './docker.ts'
import { SandboxExecutionError, SandboxLifecycleError } from './errors.ts'
import type { SupervisorCancelReason, SupervisorFinished, SupervisorResult } from './protocol.ts'
import { listenRunnerSocket } from './server.ts'

export { InvalidWorkspaceDirectoryError } from './config.ts'
export { DockerRequestError, type DockerContainerId } from './docker.ts'
export { SandboxExecutionError, SandboxLifecycleError, type SandboxExecutionFailure } from './errors.ts'

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

/** Caller identity used to retrieve one execution's result in the same container generation. */
export type SandboxExecutionId = Branded<'SandboxExecutionId'>

/** Identity of one accepted command in a specific container generation. */
export interface SandboxExecutionIdentity {
  readonly executionId: SandboxExecutionId
  readonly expectedContainerId: DockerContainerId
}

/** Validated execution inputs for a trusted Runner caller. */
export interface SandboxExecutionRequest extends SandboxExecutionIdentity {
  /** Canonical command arguments, including the normalized working directory when supplied. */
  readonly argv: readonly string[]
  /** Command budget in milliseconds; cleanup and supervisor confirmation have their own deadline. */
  readonly timeoutMs: number
}

/** Confirmed foreground result with the caller's execution ID. */
export interface SandboxExecutionResult extends DockerExecResult {
  readonly executionId: SandboxExecutionId
}

/** Cancellation acceptance, independent of the command's final result and cleanup. */
export interface SandboxCancellationResult {
  readonly executionId: SandboxExecutionId
  readonly containerId: DockerContainerId
  readonly cancellation: 'requested' | 'settled'
}

const executionRecordLimit = 128

interface ExecutionRecord {
  readonly fingerprint: string
  readonly result: Promise<SandboxExecutionResult>
  readonly preparation: AbortController
  phase: 'preparing' | 'running' | 'cleaning' | 'settled'
  started: boolean
  requested?: SupervisorCancelReason
  session?: DockerExecSession
  finished?: SupervisorFinished
  retirement?: { code: 'execution_outcome_unknown' | 'execution_container_recycled'; result: Promise<RemovalOutcome> }
}

type RemovalOutcome = { cleanup: 'container_removed' } | { cleanup: 'unconfirmed'; cause: unknown }

type Phase =
  | { state: 'starting'; result: Promise<RunningSandbox> }
  | { state: 'closing'; result: Promise<ClosedSandbox> }
  | { state: 'running' | 'cleanup_required' }

interface Slot {
  directory: string | null
  container: DockerContainerId | { token: string } | null
  phase: Phase
  readonly executions: Map<SandboxExecutionId, ExecutionRecord>
  recovery?: Promise<RemovalOutcome>
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
  private readonly observations = new Set<Promise<SandboxStatus>>()
  private readonly inFlightExecutions = new Set<Promise<SandboxExecutionResult>>()
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
      for (const slot of this.slots.values()) {
        for (const record of slot.executions.values()) this.cancelExecution(record, 'shutdown')
      }
      const inFlight = [...this.slots.values()].flatMap(({ phase }) =>
        phase.state === 'starting' || phase.state === 'closing' ? [phase.result] : [])
      const drained = Promise.allSettled([...inFlight, ...this.observations, ...this.inFlightExecutions])
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
      return this.trackObservation(this.reuseOrReplaceSlot(workspaceId, directory, slot))
    } else {
      const occupied = [...this.slots.values()].filter(entry => entry.directory !== null || entry.container !== null).length
      if (occupied >= this.config.maxInstances) throw new SandboxLifecycleError('sandbox_capacity')
      slot = { directory, container: null, phase: { state: 'cleanup_required' }, executions: new Map() }
      this.slots.set(workspaceId, slot)
    }
    return this.startOpening(workspaceId, directory, slot)
  }

  /** Query the current generation without interpreting an uncertain create as absent. Disposal waits for in-flight queries.
   * @param workspaceId - Workspace registry identity.
   * @returns The observed sandbox state.
   */
  async status(workspaceId: WorkspaceId): Promise<SandboxStatus> {
    return this.trackObservation(this.queryStatus(workspaceId))
  }

  private async trackObservation<T extends SandboxStatus>(query: Promise<T>): Promise<T> {
    this.observations.add(query)
    try {
      return await query
    } finally {
      this.observations.delete(query)
    }
  }

  private startOpening(workspaceId: WorkspaceId, directory: string, slot: Slot): Promise<RunningSandbox> {
    const result = Promise.resolve().then(() => this.openSlot(workspaceId, directory, slot))
    slot.phase = { state: 'starting', result }
    return result
  }

  private async reuseOrReplaceSlot(workspaceId: WorkspaceId, directory: string, slot: Slot): Promise<RunningSandbox> {
    const id = slot.container
    await resolveCreateRequest(this.config, workspaceId, directory)
    this.assertOpening(slot)
    const container = await this.observe(workspaceId, id)
    this.assertOpening(slot)
    if (this.slots.get(workspaceId) !== slot) throw new SandboxLifecycleError('sandbox_outcome_unknown')
    if (slot.phase.state === 'starting') return slot.phase.result
    this.assertExecutable(slot)
    if (slot.container !== id) throw new SandboxLifecycleError('sandbox_outcome_unknown')
    if (container) {
      this.assertMount(container, directory)
      if (running(container)) return { state: 'running', containerId: container.Id }
    }
    for (const { result } of slot.executions.values()) {
      if (this.inFlightExecutions.has(result)) throw new SandboxLifecycleError('sandbox_outcome_unknown')
    }
    return this.startOpening(workspaceId, directory, slot)
  }

  private async queryStatus(workspaceId: WorkspaceId): Promise<SandboxStatus> {
    this.assertReady()
    const slot = this.slots.get(workspaceId)
    const phase = slot?.phase
    if (phase?.state === 'starting' || phase?.state === 'closing') return { state: phase.state }
    if (slot?.recovery) return { state: 'cleanup_required' }

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

  /** Run a supervised command on the expected workspace container. Distinct execution IDs can run concurrently.
   * Matching retries share the pending or stored result, including failures.
   * Confirmed per-command cleanup keeps the container usable. An unknown result freezes and removes its generation.
   * Caller disconnects do not cancel the operation; accepted failures include independent cleanup details.
   * @param workspaceId - Workspace registry identity.
   * @param request - Validated arguments and expected generation from the trusted caller.
   * @returns The confirmed exit code and retained output for the caller's execution ID.
   */
  async execute(workspaceId: WorkspaceId, request: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    this.assertReady()
    const { executionId, expectedContainerId, timeoutMs } = request
    const slot = this.slots.get(workspaceId)
    if (!slot || slot.container !== expectedContainerId) throw new SandboxLifecycleError('execution_generation_mismatch')
    const id = slot.container

    const argv = [...request.argv]
    const fingerprint = createHash('sha256').update(JSON.stringify([argv, timeoutMs])).digest('hex')
    const previous = slot.executions.get(executionId)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new SandboxLifecycleError('execution_id_conflict')
      return previous.result
    }

    this.assertExecutable(slot)
    if (slot.executions.size >= executionRecordLimit) throw new SandboxLifecycleError('execution_limit')

    const expiresAt = performance.now() + timeoutMs
    const record: ExecutionRecord = {
      fingerprint, preparation: new AbortController(), phase: 'preparing', started: false,
      result: Promise.resolve().then(() => this.executeSlot(workspaceId, slot, id, executionId, argv, record, expiresAt))
        .finally(() => {
          record.phase = 'settled'
          delete record.session
          clearTimeout(timer)
          this.inFlightExecutions.delete(record.result)
        }),
    }
    const timer = setTimeout(() => { this.cancelExecution(record, 'timeout') }, timeoutMs)
    timer.unref()
    slot.executions.set(executionId, record)
    this.inFlightExecutions.add(record.result)
    return record.result
  }

  /** Request cancellation of an existing command without waiting for cleanup or changing its first accepted reason.
   * Repeated requests share its control channel; a settled command is left unchanged, even in a blocked generation.
   * @param workspaceId - Workspace registry identity.
   * @param request - Execution identity and the original expected container.
   * @returns Whether cancellation is requested or the original result is already settled.
   */
  cancel(workspaceId: WorkspaceId, request: SandboxExecutionIdentity): SandboxCancellationResult {
    this.assertReady()
    const slot = this.slots.get(workspaceId)
    if (!slot || slot.container !== request.expectedContainerId) throw new SandboxLifecycleError('execution_generation_mismatch')
    const record = slot.executions.get(request.executionId)
    if (!record) throw new SandboxLifecycleError('execution_not_found')
    this.cancelExecution(record, 'cancelled')
    return {
      executionId: request.executionId, containerId: request.expectedContainerId,
      cancellation: record.phase === 'settled' ? 'settled' : 'requested',
    }
  }

  /** Close the current generation. Acknowledging deletion alone does not release its slot.
   * @param workspaceId - Workspace registry identity.
   * @returns Closed after Docker confirms the generation is absent.
   */
  async close(workspaceId: WorkspaceId): Promise<ClosedSandbox> {
    this.assertReady()
    const slot: Slot = this.slots.get(workspaceId)
      ?? { directory: null, container: null, phase: { state: 'cleanup_required' }, executions: new Map() }
    if (slot.phase.state === 'closing') return slot.phase.result
    const opening = slot.phase.state === 'starting' ? slot.phase.result : undefined
    const recovery = slot.recovery
    const removal = Promise.resolve().then(async (): Promise<RemovalOutcome> => {
      if (recovery) return recovery
      try {
        await this.closeSlot(workspaceId, slot, opening)
        return { cleanup: 'container_removed' }
      } catch (cause) {
        return { cleanup: 'unconfirmed', cause }
      }
    })
    const result = removal.then(async (outcome): Promise<ClosedSandbox> => {
      await Promise.allSettled([...slot.executions.values()].map(record => record.result))
      if (outcome.cleanup === 'unconfirmed') {
        this.settleFailure(workspaceId, slot)
        throw outcome.cause
      }
      if (this.slots.get(workspaceId) === slot) this.slots.delete(workspaceId)
      return { state: 'closed' }
    })
    slot.phase = { state: 'closing', result }
    this.slots.set(workspaceId, slot)
    this.retireExecutions(slot, removal)
    return result
  }

  private assertReady(): void {
    if (!this.ready) throw new SandboxLifecycleError('sandbox_not_ready')
  }

  private assertOpening(slot: Slot): void {
    this.assertReady()
    if (slot.phase.state === 'closing') throw new SandboxLifecycleError('sandbox_closing')
  }

  private assertExecutable(slot: Slot): void {
    if (slot.phase.state === 'closing') throw new SandboxLifecycleError('sandbox_closing')
    if (slot.phase.state === 'cleanup_required') throw new SandboxLifecycleError('sandbox_cleanup_required')
    if (slot.phase.state !== 'running') throw new SandboxLifecycleError('sandbox_not_running')
  }

  private async executeSlot(
    workspaceId: WorkspaceId, slot: Slot, id: DockerContainerId, executionId: SandboxExecutionId,
    argv: readonly string[], record: ExecutionRecord, expiresAt: number,
  ): Promise<SandboxExecutionResult> {
    const signal = record.preparation.signal
    const current = () => this.slots.get(workspaceId) === slot && slot.container === id
    const stopping = () => record.requested !== undefined || record.retirement !== undefined
    const confirm = () => {
      this.assertReady()
      if (!current()) throw new SandboxLifecycleError('execution_generation_mismatch')
      this.assertExecutable(slot)
      signal.throwIfAborted()
    }
    const inspectExecutable = async (inspectionSignal: AbortSignal) => {
      confirm()
      const container = await this.docker.inspect(id, inspectionSignal)
      confirm()
      if (!container || !running(container)) throw new SandboxLifecycleError('sandbox_not_running')
      this.assertOwner(container, workspaceId)
      this.assertMount(container, slot.directory)
    }

    let completed: SupervisorResult
    try {
      await inspectExecutable(signal)
      const exec = await this.docker.createExec(id, executionId, signal)
      confirm()
      const session = this.docker.startExec(exec, id, {
        executionId, argv, expiresAt,
        beforeStart: () => { confirm(); record.started = true },
        beforeRun: async (transport) => {
          // A cancellation keeps the protocol alive while preventing any late run.
          if (stopping()) return
          const container = await this.docker.inspect(id, transport)
          if (stopping()) return
          confirm()
          if (!container || !running(container)) throw new SandboxLifecycleError('sandbox_not_running')
          this.assertOwner(container, workspaceId)
          this.assertMount(container, slot.directory)
        },
        onRun: () => { record.phase = 'running' },
        onFinished: (finished) => { record.finished = finished; record.phase = 'cleaning' },
      })
      record.session = session
      if (record.retirement) session.interrupt()
      else if (record.requested) session.cancel(record.requested)
      completed = await session.result
      if (record.retirement) throw new Error('Container generation was retired before execution settlement')
      if (completed.finished.reason === 'control_eof') throw new Error('Unexpected supervisor control EOF')
    } catch (cause) {
      const retirement = record.retirement ?? (record.started ? this.recoverSlot(workspaceId, slot, id, record) : undefined)
      if (retirement) {
        const outcome = await retirement.result
        throw new SandboxExecutionError(retirement.code, {
          executionId, containerId: id, cleanup: outcome.cleanup, reason: record.finished?.reason ?? null,
          ...record.finished ? { bash: record.finished.bash } : {},
        }, outcome.cleanup === 'unconfirmed' ? new AggregateError([cause, outcome.cause], 'Execution and removal failed') : cause)
      }
      if (record.requested) {
        throw new SandboxExecutionError(record.requested === 'timeout' ? 'execution_timeout' : 'execution_cancelled', {
          executionId, containerId: id, reason: record.requested, cleanup: 'not_started', bash: null,
        }, cause)
      }
      throw cause
    }
    const { finished, stdout, stderr } = completed
    if (finished.reason !== 'exited') {
      throw new SandboxExecutionError(finished.reason === 'timeout' ? 'execution_timeout' : 'execution_cancelled', {
        executionId, containerId: id, reason: finished.reason, cleanup: 'processes_cleaned', bash: finished.bash,
      })
    }
    if (finished.bash === null) throw new Error('An exited supervisor result must contain the Bash status')
    return { executionId, exitCode: finished.bash.exitCode ?? 128 + finished.bash.signal, stdout, stderr }
  }

  private cancelExecution(record: ExecutionRecord, reason: SupervisorCancelReason): void {
    if (record.phase === 'settled' || record.finished || record.requested || record.retirement) return
    record.requested = reason
    record.phase = 'cleaning'
    if (record.started) record.session?.cancel(reason)
    else record.preparation.abort(reason)
  }

  private retireExecutions(slot: Slot, result: Promise<RemovalOutcome>): void {
    for (const record of slot.executions.values()) {
      if (record.phase === 'settled') continue
      record.retirement ??= { code: 'execution_container_recycled', result }
      record.phase = 'cleaning'
      record.preparation.abort()
      record.session?.interrupt()
    }
  }

  private recoverSlot(
    workspaceId: WorkspaceId, slot: Slot, id: DockerContainerId, failed: ExecutionRecord,
  ): NonNullable<ExecutionRecord['retirement']> {
    slot.phase = { state: 'cleanup_required' }
    const result = slot.recovery ?? Promise.resolve().then(async (): Promise<RemovalOutcome> => {
      try {
        await this.removeAndConfirm(id)
        if (this.slots.get(workspaceId) === slot && slot.container === id && slot.phase.state !== 'closing') {
          this.slots.delete(workspaceId)
        }
        return { cleanup: 'container_removed' }
      } catch (cause) {
        return { cleanup: 'unconfirmed', cause }
      } finally {
        if (slot.recovery === result) delete slot.recovery
      }
    })
    slot.recovery = result
    const retirement = { code: 'execution_outcome_unknown' as const, result }
    failed.retirement = retirement
    this.retireExecutions(slot, result)
    return retirement
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
        slot.executions.clear()
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
    const container = await this.observe(workspaceId, slot.container)
    if (container) {
      slot.container = container.Id
      await this.removeAndConfirm(container.Id)
    }
    if (this.slots.get(workspaceId) === slot) this.slots.delete(workspaceId)
    return { state: 'closed' }
  }

  private settleFailure(workspaceId: WorkspaceId, slot: Slot): void {
    if (slot.container === null) {
      if (this.slots.get(workspaceId) === slot) this.slots.delete(workspaceId)
    } else slot.phase = { state: 'cleanup_required' }
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
