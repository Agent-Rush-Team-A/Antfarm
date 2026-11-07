/** Workspace-mode admission retained through inbox, execution and binary file settlement. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { IWorkspaceModes, WorkspaceId, WorkspaceModeRuntime } from '@deepseek-ai/dsh-workspace/types'
import { WorkspaceFileAccess, type WorkspaceFileScope, type WorkspaceFileDownload } from '@deepseek-ai/dsh-fs/workspace-access'
import { SandboxExecutionBackend, type SandboxExecutionAdmission } from './backend.ts'
import { TaskSandboxLifecycle } from './mode-reclamation.ts'
import { WorkspaceModeRouting, isSingleSessionMode, type WorkspaceModeTarget } from './mode-routing.ts'
import type { RunnerExecutionIdentity, RunnerExecutionRequest } from './execution.ts'
import { RunnerResponseError, type SandboxContainerId } from './runner-client.ts'

/** Trusted composition supplies the #41 coordinator and independently owned Docker/VM providers. */
export interface Config {
  readonly modes: Pick<IWorkspaceModes, 'acquireUse' | 'registerRuntime' | 'get'>
  readonly targets: ReadonlyMap<import('@deepseek-ai/dsh-workspace/types').WorkspaceMode, WorkspaceModeTarget>
  readonly runtime: WorkspaceModeRuntime
}

interface TaskWorld {
  readonly project: string
  readonly backend: WorkspaceModeTarget['execution']
  readonly lifecycle: TaskSandboxLifecycle
}

class ModeFileAccess extends WorkspaceFileAccess {
  constructor(ctx: Context, private readonly provider: WorkspaceModeBackend) { super(ctx) }
  override list(scope: WorkspaceFileScope, path: string, maxEntries: number) {
    return this.provider.binary(scope, (selected, admitted) => selected.files.list(admitted, path, maxEntries))
  }
  override upload(scope: WorkspaceFileScope, name: string, chunks: AsyncIterable<Uint8Array>, maxBytes: number) {
    return this.provider.binary(scope, (selected, admitted) => selected.files.upload(admitted, name, chunks, maxBytes))
  }
  override download(scope: WorkspaceFileScope, path: string, maxBytes: number) {
    return this.provider.download(scope, path, maxBytes)
  }
}

/** One deployment's mode selection and single-session generations; provider resources remain independent. */
export default class WorkspaceModeBackend extends SandboxExecutionBackend {
  static inject = ['workspaceRegistry']
  private readonly routing: WorkspaceModeRouting
  private readonly lifetime = new AbortController()
  private readonly worlds = new Map<WorkspaceId, TaskWorld>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly active = new Set<Promise<void>>()
  private readonly config: Config

  /**
   * @param ctx - Deployment owner, with each target's services isolated from this facade.
   * @param config - Trusted shared coordinator, selected providers and transition runtime.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = { ...config, targets: new Map(config.targets) }
    this.routing = new WorkspaceModeRouting(this.config.modes, this.config.targets)
  }

  async [Service.init](): Promise<void> {
    const supported = new Set(this.config.runtime.supportedModes)
    if (supported.size !== this.routing.supportedModes.length || this.routing.supportedModes.some(mode => !supported.has(mode))) {
      throw new Error('Workspace mode execution and transition providers must support the same modes')
    }
    const unregister = this.config.modes.registerRuntime(this.config.runtime)
    this.ctx.effect(() => async () => {
      this.lifetime.abort(new Error('Workspace mode provider stopped'))
      const results = await Promise.allSettled([
        ...this.pending, ...this.active, ...[...this.worlds.values()].map(world => world.lifecycle.dispose()),
      ])
      await unregister()
      const failures = results.filter(result => result.status === 'rejected')
      if (failures.length > 0) throw new AggregateError(failures.map((result): unknown => result.reason),
        'Workspace mode teardown requires cleanup')
    })
    await this.ctx.plugin(ModeFileAccess, this)
  }

  override admit(scope: WorkspaceFileScope): Promise<SandboxExecutionAdmission> {
    const pending = this.admission(scope).finally(() => { this.pending.delete(pending) })
    this.pending.add(pending)
    return pending
  }

  private async admission(original: WorkspaceFileScope): Promise<SandboxExecutionAdmission> {
    const signal = AbortSignal.any([original.signal, this.lifetime.signal])
    const scope = { ...original, signal, admit: () => { signal.throwIfAborted(); original.admit() } }
    scope.admit()
    // Count input in the current generation before coordinator admission can yield.
    let lifecycle = this.worlds.get(scope.workspaceId)?.lifecycle
    let reservation = lifecycle?.reserve(signal)
    if (reservation !== undefined) void reservation.catch(() => {})
    let selected: Awaited<ReturnType<WorkspaceModeRouting['acquireExecution']>>
    try { selected = await this.routing.acquireExecution(scope) }
    catch (error) { if (reservation !== undefined) await (await reservation).release(); throw error }
    try {
      const taskManaged = isSingleSessionMode(selected.config.mode)
      if (taskManaged) {
        let world = this.worlds.get(scope.workspaceId)
        if (world === undefined || world.backend !== selected.backend || world.project !== scope.project) {
          if (reservation !== undefined) await (await reservation).release()
          world = this.world(scope, selected.backend)
          this.worlds.set(scope.workspaceId, world)
          reservation = world.lifecycle.reserve(selected.scope.signal)
        }
        lifecycle = world.lifecycle
      } else if (reservation !== undefined) {
        await (await reservation).release()
        reservation = undefined
      }
      if (!taskManaged) lifecycle = undefined
      const task = reservation === undefined ? undefined : await reservation
      selected.scope.admit()
      const settled = Promise.withResolvers<void>()
      this.active.add(settled.promise)
      void settled.promise.catch(() => {})
      let release: Promise<void> | undefined
      const retainedWork = new Set<Promise<void>>()
      return {
        backend: selected.backend, scope: selected.scope, files: selected.files, taskManaged,
        ready: async () => {
          if (release !== undefined) throw new Error('Sandbox input resources were released')
          selected.scope.admit()
          const target = task === undefined ? await selected.backend.open(scope.workspaceId, scope.project) : await task.ready()
          selected.scope.admit()
          return target
        },
        retain: async () => {
          selected.scope.admit()
          if (release !== undefined) throw new Error('Sandbox input resources were released')
          const done = Promise.withResolvers<void>()
          retainedWork.add(done.promise)
          void done.promise.catch(() => {})
          let retained: Awaited<ReturnType<TaskSandboxLifecycle['reserve']>> | undefined
          try { retained = lifecycle === undefined ? undefined : await lifecycle.reserve(selected.scope.signal) }
          catch (error) { retainedWork.delete(done.promise); done.resolve(); throw error }
          let cleanup: Promise<void> | undefined
          return () => cleanup ??= (async () => {
            try { await retained?.release(); retainedWork.delete(done.promise); done.resolve() }
            catch (error) { done.reject(error); throw error }
          })()
        },
        release: () => release ??= (async () => {
          try { await Promise.all([...retainedWork]); await task?.release(); settled.resolve() }
          catch (error) { settled.reject(error); throw error }
          finally { selected.release(); this.active.delete(settled.promise) }
        })(),
      }
    } catch (error) {
      try { if (reservation !== undefined) await (await reservation).release() }
      finally { selected.release() }
      throw error
    }
  }

  private world(scope: WorkspaceFileScope, backend: WorkspaceModeTarget['execution']): TaskWorld {
    const lifecycle = new TaskSandboxLifecycle({
      open: async (signal) => { signal.throwIfAborted(); return backend.open(scope.workspaceId, scope.project) },
      close: async (target) => {
        const current = await backend.status(scope.workspaceId)
        if (current.state === 'closed') return
        if (current.state !== 'running' || current.containerId !== target.containerId) {
          throw new RunnerResponseError('sandbox_workspace_conflict', 409, true)
        }
        const closed = await backend.close(scope.workspaceId)
        await this.ctx.get('workspaceSandboxState')?.query(scope.workspaceId, () => Promise.resolve(closed))
      },
      failed: (error) => {
        this.ctx.logger.warn('workspace-mode: workspace %s could not complete %s; new tasks are blocked. Query the provider and reconcile its resources before restarting mode admission.', scope.workspaceId, error.phase)
      },
    })
    return { project: scope.project, backend, lifecycle }
  }

  /**
   * Run a completed binary operation under one mode lease.
   * @param scope - Original HTTP authorization and registered project.
   * @param operation - Selected provider operation; no nested coordinator acquisition.
   * @returns Original provider result, retaining descriptor/transport failures.
   */
  async binary<T>(scope: WorkspaceFileScope,
    operation: (target: WorkspaceModeTarget, admitted: WorkspaceFileScope) => Promise<T>): Promise<T> {
    const admission = await this.admit(scope)
    try {
      if (admission.files === undefined) throw new Error('Mode admission did not capture its binary provider')
      return await operation({ execution: admission.backend, files: admission.files }, admission.scope)
    } finally { await admission.release() }
  }

  /**
   * Transfer mode and task retention to the downloaded stream's actual settlement.
   * @param scope - Original HTTP authorization and registered project.
   * @param path - Relative regular-file path.
   * @param maxBytes - Complete-file limit.
   * @returns Body and settlement including mode/task release failures.
   */
  async download(scope: WorkspaceFileScope, path: string, maxBytes: number): Promise<WorkspaceFileDownload> {
    const admission = await this.admit(scope)
    try {
      if (admission.files === undefined) throw new Error('Mode admission did not capture its binary provider')
      const stream = await admission.files.download(admission.scope, path, maxBytes)
      const settled = (async () => { try { await stream.settled } finally { await admission.release() } })()
      void settled.catch((error: unknown) => {
        this.ctx.logger.warn('workspace-mode: file settlement failed for workspace %s: %o', scope.workspaceId, error)
      })
      return { ...stream, settled }
    } catch (error) { await admission.release(); throw error }
  }

  private scope(workspaceId: WorkspaceId, project?: string): WorkspaceFileScope {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined || project !== undefined && workspace.path !== project) throw new RunnerResponseError('sandbox_workspace_conflict', 409, false)
    const path = workspace.path
    return { workspaceId, project: path, signal: this.lifetime.signal,
      admit: () => { this.lifetime.signal.throwIfAborted(); if (this.ctx.workspaceRegistry.get(workspaceId)?.path !== path) throw new RunnerResponseError('sandbox_workspace_conflict', 409, false) } }
  }

  override open(workspaceId: WorkspaceId, workspaceDir: string) { return this.routing.open(this.scope(workspaceId, workspaceDir), 'manual') }
  override close(workspaceId: WorkspaceId) { return this.routing.close(this.scope(workspaceId), 'manual') }
  override status(workspaceId: WorkspaceId) {
    const barrier = this.barrier(workspaceId)
    if (barrier !== undefined) return Promise.resolve(barrier)
    return this.routing.withExecution(this.scope(workspaceId), ({ backend }) => backend.status(workspaceId))
  }
  override barrier(workspaceId: WorkspaceId) {
    const world = this.worlds.get(workspaceId)
    if (world?.lifecycle.status() === 'closing') return { state: 'closing' as const }
    if (world?.lifecycle.status() === 'cleanup-required') return { state: 'cleanup_required' as const }
    return undefined
  }
  override execute(workspaceId: WorkspaceId, request: RunnerExecutionRequest, signal?: AbortSignal) {
    return this.routing.withExecution(this.scope(workspaceId), ({ backend }) => backend.execute(workspaceId, request, signal))
  }
  override cancel(workspaceId: WorkspaceId, request: RunnerExecutionIdentity) {
    return this.routing.withExecution(this.scope(workspaceId), ({ backend }) => backend.cancel(workspaceId, request))
  }
  override files(workspaceId: WorkspaceId, target: SandboxContainerId, signal?: AbortSignal) {
    return this.routing.withExecution(this.scope(workspaceId), ({ backend }) => backend.files(workspaceId, target, signal))
  }
  override activity(workspaceId: WorkspaceId) {
    const state = this.worlds.get(workspaceId)?.lifecycle.status()
    const target = this.config.targets.get(this.config.modes.get(workspaceId).mode)
    const activity = target?.execution.activity?.(workspaceId)
    return state === undefined ? activity : { openings: (activity?.openings ?? 0) + (state === 'opening' ? 1 : 0),
      executions: activity?.executions ?? 0, closing: activity?.closing === true || state === 'closing' || state === 'cleanup-required' }
  }
  override progress(workspaceId: WorkspaceId) {
    return this.config.targets.get(this.config.modes.get(workspaceId).mode)?.execution.progress?.(workspaceId)
  }
}
