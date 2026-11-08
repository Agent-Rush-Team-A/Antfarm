/** Workspace-bound bare-VM execution over SSH; no Docker, cloud creation or host fallback. */
import { randomBytes } from 'node:crypto'
import { constants } from 'node:os'
import { posix } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { resolveSshConfig } from '@deepseek-ai/dsh-ssh'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'
import { SshWorkspaceFiles } from '@deepseek-ai/dsh-ssh/workspace-files'
import { type WorkspaceRuntimeFiles } from './backend.ts'
import { RunnerExecutionError, RunnerRequestError, RunnerResponseError } from './runner-client.ts'
import type { RunnerRunningSandbox, RunnerClosedSandbox, RunnerSandboxStatus, SandboxContainerId } from './runner-client.ts'
import type { RunnerExecutionId, RunnerExecutionRequest, RunnerExecutionIdentity, RunnerExecutionResult,
  RunnerCancellationResult, RunnerExecutionFailure } from './execution.ts'
import { Config, type ResolvedConfig, type WorkspaceSshBinding } from './ssh-config.ts'
import { createWorkspaceSshServices, type WorkspaceSshServices } from './ssh-runtime.ts'

export { Config } from './ssh-config.ts'
export type { WorkspaceSshBinding } from './ssh-config.ts'

type StopReason = 'cancelled' | 'timeout' | 'shutdown'
interface Execution {
  request?: RunnerExecutionRequest
  result?: Promise<RunnerExecutionResult>
  readonly controller: AbortController
  reason?: StopReason
  settled: boolean
  handle?: SubprocessHandle
}
interface Generation {
  readonly id: SandboxContainerId
  readonly project: string
  readonly controller: AbortController
  readonly executions: Map<RunnerExecutionId, Execution>
  readonly ready: Promise<WorkspaceSshServices>
  state: 'starting' | 'running' | 'closing' | 'cleanup_required'
  services?: WorkspaceSshServices
  closing?: Promise<RunnerClosedSandbox>
}

/** Keeps each original execution on its own fixed VM and connection generation. */
export class WorkspaceSshRuntime {
  private readonly settings: ResolvedConfig
  private readonly bindings = new Map<WorkspaceId, WorkspaceSshBinding & { readonly generation?: SandboxContainerId }>()
  private readonly generations = new Map<WorkspaceId, Generation>()
  private disposed = false
  private disposal: Promise<void> | undefined

  /**
   * @param ctx - Provider owner.
   * @param config - Trusted bindings; no model input can replace them.
   */
  constructor(private readonly ctx: Context, config: Config) {
    this.settings = Config(config)
    const instances = new Set<string>()
    const hosts = new Set<string>()
    for (const [key, value] of Object.entries(this.settings.bindings)) {
      const id = WorkspaceId(z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u).parse(key))
      const instance = z.string().min(1).max(128).parse(value.instanceId)
      if (instances.has(instance)) throw new Error('Different workspaces must bind different instance identities')
      instances.add(instance)
      const { instanceId: _instanceId, ...connection } = value
      const resolved = resolveSshConfig(connection)
      if (hosts.has(resolved.host)) throw new Error('Different workspaces must bind different SSH host aliases')
      hosts.add(resolved.host)
      this.bindings.set(id, { ...resolved, instanceId: instance })
    }
    if (!posix.isAbsolute(this.settings.bash)
      || this.settings.bash.includes('\0')) throw new Error('Remote Bash must be an absolute executable path')
  }

  /** Stop admission and join all original generations; the enclosing provider owns this disposal. */
  dispose(): Promise<void> {
    this.disposed = true
    this.disposal ??= this.drain()
    return this.disposal
  }

  private async drain(): Promise<void> {
    const results = await Promise.allSettled([...this.generations.keys()].map(id => this.close(id)))
    const errors: unknown[] = []
    for (const result of results) if (result.status === 'rejected') errors.push(result.reason)
    if (errors.length > 0) throw new AggregateError(errors, 'Workspace SSH provider cleanup is unconfirmed')
  }

  /**
   * Install a verified binding before establishing a Workspace generation.
   * @param workspaceId - Trusted workspace.
   * @param binding - Verified instance coordinates. Replace only after the previous connection is released.
   * @param generation - Optional generation already reserved by the allocation owner. Otherwise SSH assigns one on open.
   */
  bind(workspaceId: WorkspaceId, binding: WorkspaceSshBinding, generation?: SandboxContainerId): void {
    if (this.generations.has(workspaceId)) throw new RunnerResponseError('sandbox_closing', 409, false)
    const { instanceId, ...connection } = binding
    this.bindings.set(workspaceId, { ...resolveSshConfig(connection), instanceId, ...generation === undefined ? {} : { generation } })
  }

  /**
   * Revoke new effects and drain managed commands before preservation.
   * @param workspaceId - Original workspace.
   * @returns Quiescent read-only helper after managed effects settle.
   */
  async pause(workspaceId: WorkspaceId): Promise<WorkspaceSshServices | undefined> {
    const generation = this.generations.get(workspaceId)
    if (generation === undefined) return undefined
    generation.state = 'closing'
    generation.controller.abort(new Error('Workspace generation closed'))
    for (const execution of generation.executions.values()) this.stop(execution, 'shutdown')
    const services = await generation.ready
    await Promise.allSettled([...generation.executions.values()].flatMap(execution => execution.result === undefined
      ? [] : [execution.result]))
    await services.ssh.request('workspace.quiesce', {}, z.null())
    return services
  }

  /**
   * Release revoked local resources after the owner independently confirms no remote work can continue.
   * @param workspaceId - Original workspace with a stopped VM or a fenced, quiescent guest.
   */
  async releaseStopped(workspaceId: WorkspaceId): Promise<void> {
    const generation = this.generations.get(workspaceId)
    if (generation === undefined) return
    generation.controller.abort(new Error('Original VM stopped'))
    for (const execution of generation.executions.values()) this.stop(execution, 'shutdown')
    await Promise.allSettled([...generation.executions.values()].flatMap(execution => execution.result === undefined
      ? [] : [execution.result]))
    const services = await generation.ready.catch(() => undefined)
    await services?.close().catch(() => {}) // The cloud owner already confirmed the original process world is stopped.
    if (this.generations.get(workspaceId) === generation) this.generations.delete(workspaceId)
  }

  /**
   * Reuse a live generation or establish one on the fixed Workspace VM.
   * @param workspaceId - Original authorized identity.
   * @param workspaceDir - Registered project metadata.
   * @returns Verified original SSH generation.
   */
  async open(workspaceId: WorkspaceId, workspaceDir: string): Promise<RunnerRunningSandbox> {
    if (this.disposed) throw new RunnerResponseError('runner_unavailable', 503, false)
    const binding = this.bindings.get(workspaceId)
    if (binding === undefined) throw new RunnerResponseError('sandbox_workspace_conflict', 409, false)
    let generation = this.generations.get(workspaceId)
    if (generation !== undefined && generation.project !== workspaceDir) throw new RunnerResponseError('sandbox_workspace_conflict', 409, false)
    if (generation?.state === 'closing') throw new RunnerResponseError('sandbox_closing', 409, false)
    if (generation?.state === 'cleanup_required') throw new RunnerResponseError('sandbox_cleanup_required', 409, true)
    if (generation === undefined) {
      const controller = new AbortController()
      const { instanceId: _instanceId, generation: reserved, ...connection } = binding
      const slot: Generation = {
        id: reserved ?? brandString<SandboxContainerId>(randomBytes(32).toString('hex')), project: workspaceDir, controller,
        state: 'starting', executions: new Map(),
        ready: createWorkspaceSshServices(connection),
      }
      generation = slot
      this.generations.set(workspaceId, slot)
      void slot.ready.catch((_error: unknown) => { /* open and close retain startup failure. */ })
    }
    try {
      const services = await generation.ready
      if (generation.services === undefined) {
        generation.services = services
        const captured = generation
        const lost = (): void => {
          if (captured.state === 'running' || captured.state === 'starting') this.quarantine(captured)
        }
        services.ssh.signal.addEventListener('abort', lost, { once: true })
        if (services.ssh.signal.aborted) lost()
      }
      if (generation.state === 'starting') generation.state = 'running'
    } catch (error) {
      if (generation.state === 'starting') generation.state = 'cleanup_required'
      throw new RunnerRequestError('runner_unavailable', error)
    }
    this.current(workspaceId, generation.id)
    return { state: 'running', containerId: generation.id }
  }

  /**
   * Observe helper health without establishing another connection.
   * @param workspaceId - Authorized identity.
   * @returns Fresh connection state without reconnecting.
   */
  async status(workspaceId: WorkspaceId): Promise<RunnerSandboxStatus> {
    const generation = this.generations.get(workspaceId)
    if (generation === undefined) return { state: 'closed' }
    if (generation.state !== 'running') return { state: generation.state }
    const services = await generation.ready
    try { await services.ssh.checkHealth() }
    catch (_error) {
      if (this.stateOf(generation) === 'running') this.quarantine(generation)
    }
    const state = this.stateOf(generation)
    return state === 'running' ? { state: 'running', containerId: generation.id } : { state }
  }

  /**
   * Drain executions and retain the barrier until the original helper confirms cleanup.
   * @param workspaceId - Authorized identity.
   * @returns Closed after helper cleanup acknowledgement.
   */
  async close(workspaceId: WorkspaceId): Promise<RunnerClosedSandbox> {
    const generation = this.generations.get(workspaceId)
    if (generation === undefined) return { state: 'closed' }
    generation.closing ??= this.closeGeneration(workspaceId, generation)
    return generation.closing
  }

  private async closeGeneration(workspaceId: WorkspaceId, generation: Generation): Promise<RunnerClosedSandbox> {
    generation.state = 'closing'
    generation.controller.abort(new Error('Workspace generation closed'))
    for (const execution of generation.executions.values()) this.stop(execution, 'shutdown')
    try {
      const services = await generation.ready
      await Promise.allSettled([...generation.executions.values()]
        .flatMap(execution => execution.result === undefined ? [] : [execution.result]))
      await services.close()
      if (this.generations.get(workspaceId) === generation) this.generations.delete(workspaceId)
      return { state: 'closed' }
    } catch (error) {
      generation.state = 'cleanup_required'
      throw error instanceof RunnerResponseError ? error : new RunnerRequestError('runner_outcome_unknown', error)
    }
  }

  /**
   * Retain the original command result without replaying a cancelled execution.
   * @param workspaceId - Original workspace.
   * @param request - Complete original request.
   * @param signal - Observer cancellation.
   * @returns Retained original result without replay.
   */
  execute(workspaceId: WorkspaceId, request: RunnerExecutionRequest, signal?: AbortSignal): Promise<RunnerExecutionResult> {
    const generation = this.current(workspaceId, request.expectedContainerId)
    let execution = generation.executions.get(request.executionId)
    if (execution?.request !== undefined && JSON.stringify(execution.request) !== JSON.stringify(request)) {
      throw new RunnerResponseError('execution_request_conflict', 409, false)
    }
    if (execution === undefined) {
      this.capacity(generation)
      execution = { request: { ...request }, controller: new AbortController(), settled: false }
      generation.executions.set(request.executionId, execution)
    }
    execution.request ??= { ...request }
    execution.result ??= this.run(generation, execution, execution.request)
    void execution.result.catch((_error: unknown) => { /* Each observer reads the retained original failure. */ })
    return this.observe(execution.result, signal)
  }

  /**
   * Cancel the original execution or reserve its cancellation before dispatch.
   * @param workspaceId - Original workspace.
   * @param request - Original execution and generation.
   * @returns Cancellation receipt, not cleanup acknowledgement.
   */
  cancel(workspaceId: WorkspaceId, request: RunnerExecutionIdentity): Promise<RunnerCancellationResult> {
    try {
      const generation = this.current(workspaceId, request.expectedContainerId)
      let execution = generation.executions.get(request.executionId)
      if (execution === undefined) {
        this.capacity(generation)
        execution = { controller: new AbortController(), settled: false }
        generation.executions.set(request.executionId, execution)
      }
      this.stop(execution, 'cancelled')
      return Promise.resolve({ executionId: request.executionId, containerId: generation.id,
        cancellation: execution.settled ? 'settled' : 'requested' })
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('Workspace cancellation failed', { cause: error }))
    }
  }

  /**
   * Capture filesystem capabilities without opening or switching a generation.
   * @param workspaceId - Original workspace.
   * @param target - Original generation.
   * @param signal - Caller cancellation.
   * @returns Captured generation-bound files.
   */
  async files(workspaceId: WorkspaceId, target: SandboxContainerId, signal?: AbortSignal): Promise<WorkspaceRuntimeFiles> {
    const generation = this.current(workspaceId, target)
    const services = await generation.ready
    const lifetime = signal === undefined ? generation.controller.signal : AbortSignal.any([signal, generation.controller.signal])
    lifetime.throwIfAborted()
    return { fs: services.fs, root: services.root, signal: lifetime,
      assertCurrent: () => { lifetime.throwIfAborted(); this.current(workspaceId, target) },
    }
  }

  /**
   * Use binary file RPC on the current generation’s original helper.
   * @param workspaceId - Original workspace.
   * @param target - Original generation.
   * @returns Binary access on the same captured helper as text and Bash.
   */
  async binary(workspaceId: WorkspaceId, target: SandboxContainerId): Promise<SshWorkspaceFiles> {
    const generation = this.current(workspaceId, target)
    const services = await generation.ready
    this.current(workspaceId, target)
    return new SshWorkspaceFiles(services.ssh)
  }

  private current(workspaceId: WorkspaceId, target: SandboxContainerId): Generation {
    const generation = this.generations.get(workspaceId)
    if (this.disposed || generation?.state !== 'running' || generation.id !== target || generation.controller.signal.aborted) {
      throw new RunnerResponseError('sandbox_workspace_conflict', 409, false)
    }
    return generation
  }

  private capacity(generation: Generation): void {
    if (generation.executions.size >= this.settings.maxExecutions) throw new RunnerResponseError('execution_limit', 429, false)
  }

  // Read mutable owner state again after asynchronous process or transport waits.
  private stateOf(generation: Generation): Generation['state'] { return generation.state }
  private stopReason(execution: Execution): StopReason | undefined { return execution.reason }

  private stop(execution: Execution, reason: StopReason): void {
    if (execution.settled || execution.reason !== undefined) return
    execution.reason = reason
    execution.controller.abort(new Error(reason))
  }

  private quarantine(generation: Generation): void {
    if (generation.state !== 'cleanup_required') {
      this.ctx.logger.warn('workspace-ssh: remote outcomes or cleanup are unknown; further work is blocked. Close the workspace to confirm cleanup; if SSH is lost, verify the VM externally before recovery. Generation: %s', generation.id)
    }
    if (generation.state !== 'closing') generation.state = 'cleanup_required'
    generation.controller.abort(new Error('Workspace SSH connection lost'))
    for (const execution of generation.executions.values()) this.stop(execution, 'shutdown')
  }

  private async run(generation: Generation, execution: Execution, request: RunnerExecutionRequest): Promise<RunnerExecutionResult> {
    let bash: RunnerExecutionFailure['bash']
    const failure = (reason: StopReason, cleanup: 'not_started' | 'processes_cleaned'): RunnerExecutionError =>
      new RunnerExecutionError(reason === 'timeout' ? 'execution_timeout' : 'execution_cancelled', 409, {
        executionId: request.executionId, containerId: generation.id, reason, cleanup,
        ...bash === undefined ? {} : { bash },
      }, { cause: execution.controller.signal.reason })
    if (execution.reason !== undefined) { execution.settled = true; throw failure(execution.reason, 'not_started') }
    const timer = setTimeout(() => { this.stop(execution, 'timeout') }, request.timeoutMs)
    try {
      const services = await generation.ready
      const cwd = posix.resolve(services.root, request.workdir)
      const relative = posix.relative(services.root, cwd)
      if (relative === '..' || relative.startsWith('../')
        || posix.isAbsolute(relative)) throw new RunnerResponseError('invalid_workspace_directory', 400, false)
      const handle = services.subprocess.spawn({
        argv: [this.settings.bash, '--noprofile', '--norc', '-c', request.command], cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: this.settings.maxOutputBytes }, stderr: { maxBytes: this.settings.maxOutputBytes } },
        graceMs: this.settings.graceMs, signal: execution.controller.signal,
      })
      execution.handle = handle
      const outcome = await handle.done
      const signalCode = outcome.signal === null ? undefined : constants.signals[outcome.signal]
      if (outcome.exitCode !== null && outcome.signal === null) bash = { exitCode: outcome.exitCode, signal: null }
      else if (signalCode !== undefined) bash = { exitCode: null, signal: signalCode }
      if (!await handle.waitForExit()) throw new Error('Remote process cleanup was not confirmed')
      const reason = this.stopReason(execution)
      if (reason !== undefined) throw failure(reason, 'processes_cleaned')
      const stdout = handle.collected.stdout?.readFrom(0)
      const stderr = handle.collected.stderr?.readFrom(0)
      if (stdout === undefined || stderr === undefined) throw new Error('SSH provider omitted collected command output')
      const exitCode = outcome.exitCode ?? (signalCode === undefined ? undefined : 128 + signalCode)
      if (exitCode === undefined) throw new Error('SSH provider did not confirm command exit status')
      return { executionId: request.executionId, exitCode,
        stdout: { text: stdout.text, truncated: stdout.lossy }, stderr: { text: stderr.text, truncated: stderr.lossy } }
    } catch (error) {
      if (error instanceof RunnerResponseError) throw error
      const reason = this.stopReason(execution)
      if (reason !== undefined) {
        const handle = execution.handle
        if (handle === undefined) throw failure(reason, 'not_started')
        let confirmed = false
        try {
          confirmed = await handle.waitForExit()
        } catch (_cleanup) {
          // The generation owner below stops dependent work; no cleanup success is inferred.
          confirmed = false
        }
        if (confirmed) throw failure(reason, 'processes_cleaned')
      }
      this.quarantine(generation)
      throw new RunnerExecutionError('execution_outcome_unknown', 503, {
        executionId: request.executionId, containerId: generation.id, reason: this.stopReason(execution) ?? null, cleanup: 'unconfirmed',
        ...bash === undefined ? {} : { bash },
      }, { cause: error })
    } finally { clearTimeout(timer); execution.settled = true }
  }

  private async observe(result: Promise<RunnerExecutionResult>, signal?: AbortSignal): Promise<RunnerExecutionResult> {
    if (signal === undefined) return result
    const cancelled = Promise.withResolvers<never>()
    const abort = (): void => { cancelled.reject(new RunnerRequestError('runner_outcome_unknown', signal.reason)) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    try { return await Promise.race([result, cancelled.promise]) }
    finally { signal.removeEventListener('abort', abort) }
  }
}
