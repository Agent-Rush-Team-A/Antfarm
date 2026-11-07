/** Task-owned sandbox generations retained through queued input, commands, and file cleanup. */
import type { RunnerRunningSandbox } from './runner-client.ts'

/** Lifecycle operations supplied by the mode-selected Docker or VM owner. */
export interface TaskSandboxDriver {
  /** Create or adopt one generation; provider-owned work must settle before rejection. */
  open(signal: AbortSignal): Promise<RunnerRunningSandbox>
  /** Delete only the captured generation, using provider-owned cancellation and finite cleanup budgets. */
  close(target: RunnerRunningSandbox): Promise<void>
  /** Publish a persistent cleanup failure through the owning service's status/logging mechanism. */
  failed(error: TaskSandboxFailure): void
}

/** One reservation retained until all input, execution, and write activity it owns has settled. */
export interface TaskSandboxUse {
  readonly target: RunnerRunningSandbox
  readonly signal: AbortSignal
  /** Idempotently release this reservation; the last user awaits confirmed destruction. */
  release(): Promise<void>
}

/** Accepted preparation work retains a generation without allocating an environment until needed. */
export interface TaskSandboxReservation {
  readonly signal: AbortSignal
  /** Open or reuse the reserved generation after request validation succeeds. */
  ready(): Promise<RunnerRunningSandbox>
  /** Release after preparation failure or actual turn/resource settlement. */
  release(): Promise<void>
}

/** Failed creation or destruction blocks new generations until managed recovery confirms cleanup. */
export class TaskSandboxFailure extends Error {
  /**
   * @param phase - Operation whose outcome requires provider recovery.
   * @param cause - Original provider error, retained only in trusted Host diagnostics.
   */
  constructor(readonly phase: 'open' | 'close', cause: unknown) {
    super('Task sandbox requires cleanup before another task can run', { cause })
    this.name = 'TaskSandboxFailure'
  }
}

interface Generation {
  readonly ready: PromiseWithResolvers<RunnerRunningSandbox>
  readonly closed: PromiseWithResolvers<void>
  readonly users: Set<symbol>
}

type State =
  | { readonly kind: 'closed' }
  | { readonly kind: 'reserved'; readonly generation: Generation }
  | { readonly kind: 'opening'; readonly generation: Generation }
  | { readonly kind: 'running'; readonly generation: Generation; readonly target: RunnerRunningSandbox }
  | { readonly kind: 'closing'; readonly generation: Generation; readonly target: RunnerRunningSandbox }
  | { readonly kind: 'cleanup-required'; readonly generation: Generation; readonly failure: TaskSandboxFailure }

/** One instance owns one workspace; closing is committed synchronously before later input can acquire it. */
export class TaskSandboxLifecycle {
  private state: State = { kind: 'closed' }
  private readonly lifetime = new AbortController()
  private disposal: Promise<void> | undefined

  /** @param driver - Selected provider and failure-reporting owner for this workspace. */
  constructor(private readonly driver: TaskSandboxDriver) {}

  /**
   * Observe resource lifecycle without starting or repairing it.
   * @returns Current lifecycle state; cleanup-required never admits another generation.
   */
  status(): State['kind'] { return this.state.kind }

  /**
   * Reserve queued input or resource work before waiting for the environment.
   * Caller cancellation withdraws a waiting reservation; admitted work releases only after its own cleanup.
   * @param signal - Cancellation while waiting for admission.
   * @returns Captured generation and an idempotent settlement release.
   */
  async acquire(signal: AbortSignal): Promise<TaskSandboxUse> {
    const reservation = await this.reserve(signal)
    const target = await reservation.ready()
    return { target, signal: reservation.signal, release: () => reservation.release() }
  }

  /**
   * Count incoming work before preparation without opening a VM or container.
   * @param signal - Cancellation while waiting or preparing; after ready, the caller owns settlement.
   * @returns A lazy generation reservation; release even when preparation fails before ready.
   */
  async reserve(signal: AbortSignal): Promise<TaskSandboxReservation> {
    const waiting = AbortSignal.any([signal, this.lifetime.signal])
    waiting.throwIfAborted()
    while (this.state.kind === 'closing') {
      await this.wait(this.state.generation.closed.promise, waiting)
      waiting.throwIfAborted()
    }
    if (this.state.kind === 'cleanup-required') throw this.state.failure
    const generation = this.state.kind === 'closed' ? this.start() : this.state.generation
    const token = Symbol('task-sandbox-use')
    generation.users.add(token)
    let release: Promise<void> | undefined
    const finish = (): Promise<void> => release ??= this.release(generation, token)
    return {
      signal: this.lifetime.signal,
      ready: async () => {
        try {
          waiting.throwIfAborted()
          if (release !== undefined) throw new Error('Task sandbox reservation was released')
          if (this.state.kind === 'reserved' && this.state.generation === generation) {
            this.state = { kind: 'opening', generation }
            void this.open(generation)
          }
          const target = await this.wait(generation.ready.promise, waiting)
          waiting.throwIfAborted()
          return target
        } catch (error) {
          // The lifecycle retains late creation and cleanup even after preparation is cancelled.
          await finish()
          throw error
        }
      },
      release: finish,
    }
  }

  /**
   * Stop new input, revoke active users, and wait for their real settlement and provider cleanup.
   * @returns Confirmed destruction, or the retained provider failure requiring maintenance.
   */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.lifetime.abort(new Error('Task sandbox lifecycle stopped'))
    this.disposal = this.state.kind === 'closed' ? Promise.resolve() : this.state.generation.closed.promise
    return this.disposal
  }

  private start(): Generation {
    const generation: Generation = {
      ready: Promise.withResolvers<RunnerRunningSandbox>(),
      closed: Promise.withResolvers<void>(),
      users: new Set(),
    }
    this.state = { kind: 'reserved', generation }
    // These promises also retain failures for callers arriving after the original waiter withdrew.
    void generation.ready.promise.catch(() => {})
    void generation.closed.promise.catch(() => {})
    return generation
  }

  private async open(generation: Generation): Promise<void> {
    let target: RunnerRunningSandbox
    try { target = await this.driver.open(this.lifetime.signal) }
    catch (cause) {
      const failure = this.fail(generation, 'open', cause)
      generation.ready.reject(failure)
      generation.closed.reject(failure)
      return
    }
    this.state = { kind: 'running', generation, target }
    generation.ready.resolve(target)
    if (generation.users.size === 0) this.close(generation, target)
  }

  private release(generation: Generation, token: symbol): Promise<void> {
    generation.users.delete(token)
    if (generation.users.size > 0) return Promise.resolve()
    const state = this.state
    if (state.kind === 'reserved' && state.generation === generation) {
      this.state = { kind: 'closed' }
      generation.closed.resolve()
    }
    if (state.kind === 'running' && state.generation === generation) {
      this.close(generation, state.target)
      return generation.closed.promise
    }
    if (state.kind === 'closing' && state.generation === generation) return generation.closed.promise
    if ((state.kind === 'opening' || state.kind === 'cleanup-required') && state.generation === generation) {
      return generation.closed.promise
    }
    return Promise.resolve()
  }

  private close(generation: Generation, target: RunnerRunningSandbox): void {
    this.state = { kind: 'closing', generation, target }
    void this.destroy(generation, target)
  }

  private async destroy(generation: Generation, target: RunnerRunningSandbox): Promise<void> {
    try { await this.driver.close(target) }
    catch (cause) { generation.closed.reject(this.fail(generation, 'close', cause)); return }
    this.state = { kind: 'closed' }
    generation.closed.resolve()
  }

  private fail(generation: Generation, phase: TaskSandboxFailure['phase'], cause: unknown): TaskSandboxFailure {
    let failure = new TaskSandboxFailure(phase, cause)
    this.state = { kind: 'cleanup-required', generation, failure }
    try { this.driver.failed(failure) }
    catch (reportingError) {
      failure = new TaskSandboxFailure(phase, new AggregateError([cause, reportingError], 'Sandbox cleanup and reporting failed'))
      this.state = { kind: 'cleanup-required', generation, failure }
    }
    return failure
  }

  private wait<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => {
        signal.removeEventListener('abort', abort)
        const cause: unknown = signal.reason
        reject(cause instanceof Error ? cause : new Error('Task sandbox wait was cancelled', { cause }))
      }
      signal.addEventListener('abort', abort, { once: true })
      void operation.then(
        (value) => { signal.removeEventListener('abort', abort); resolve(value) },
        (cause: unknown) => {
          signal.removeEventListener('abort', abort)
          reject(cause instanceof Error ? cause : new Error('Task sandbox wait failed', { cause }))
        },
      )
    })
  }
}
