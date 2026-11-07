/** Per-Workspace fair admission and durable runtime transition coordination. */
import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from './types.ts'
import type { WorkspaceEntity } from './entity.ts'
import { WorkspaceModeError } from './mode-errors.ts'
import type {
  IWorkspaceModes, WorkspaceModeChange, WorkspaceModeChangeId, WorkspaceModeConfig,
  WorkspaceModeOperationOptions, WorkspaceModeRuntime, WorkspaceModeUseLease,
  WorkspaceSetModeRequest,
} from './mode-types.ts'
import type { WorkspaceRecord } from './spec.ts'

type Release = () => void
interface Waiter {
  readonly exclusive: boolean
  readonly grant: (release: Release) => void
}

/** FIFO readers share a slot until an earlier writer reaches the head. */
class Admission {
  private readonly waiting: Waiter[] = []
  private readers = 0
  private writer = false
  private readonly drained = new Set<() => void>()

  acquire(exclusive: boolean, signal: AbortSignal): Promise<Release> {
    signal.throwIfAborted()
    return new Promise<Release>((resolve, reject) => {
      const abort = (): void => {
        const index = this.waiting.indexOf(waiter)
        if (index < 0) return
        this.waiting.splice(index, 1)
        signal.removeEventListener('abort', abort)
        reject(signal.reason)
        this.pump()
      }
      const waiter: Waiter = {
        exclusive,
        grant: (release) => {
          signal.removeEventListener('abort', abort)
          resolve(release)
        },
      }
      signal.addEventListener('abort', abort, { once: true })
      this.waiting.push(waiter)
      this.pump()
    })
  }

  drain(): Promise<void> {
    if (!this.writer && this.readers === 0 && this.waiting.length === 0) return Promise.resolve()
    return new Promise(resolve => this.drained.add(resolve))
  }

  private pump(): void {
    while (!this.writer && this.waiting.length > 0) {
      const head = this.waiting[0]
      if (head === undefined) break
      if (head.exclusive && this.readers > 0) break
      this.waiting.shift()
      if (head.exclusive) this.writer = true
      else this.readers++
      let released = false
      head.grant(() => {
        if (released) return
        released = true
        if (head.exclusive) this.writer = false
        else this.readers--
        this.pump()
      })
    }
    if (!this.writer && this.readers === 0 && this.waiting.length === 0) {
      for (const resolve of this.drained) resolve()
      this.drained.clear()
    }
  }
}

/** Registry-owned persistence and lifecycle facilities. */
export interface WorkspaceModesHost {
  /** Deployment mode used for new registrations. */
  readonly defaultMode: WorkspaceRecord['mode']
  /**
   * @param id - Original registration.
   * @returns its entity, or undefined after deletion.
   */
  entity(id: WorkspaceId): WorkspaceEntity | undefined
  /** @returns all original registrations currently present. */
  list(): readonly WorkspaceEntity[]
  /** @param error - Diagnostic failure retained by trusted maintenance logs. */
  report(error: unknown): void
}

interface RuntimeRegistration {
  readonly adapter: WorkspaceModeRuntime
  readonly lifetime: AbortController
  withdrawing: boolean
}

/** Owns stable resource leases, exclusive mode changes, and recovery retries. */
export class WorkspaceModes implements IWorkspaceModes {
  private readonly admission = new Map<WorkspaceId, Admission>()
  private readonly lifetime = new AbortController()
  private readonly recoveries = new Map<WorkspaceId, Promise<WorkspaceModeConfig>>()
  private runtime: RuntimeRegistration | undefined
  private runtimeEstablished = false
  private sessionRecovery?: (entity: WorkspaceEntity) => Promise<void>

  /** @param host - Registry-owned persistence, registration identities, and logs. */
  constructor(private readonly host: WorkspaceModesHost) {}

  get(workspaceId: WorkspaceId): WorkspaceModeConfig {
    return this.requireEntity(workspaceId).modeConfig
  }

  /** Register the current runtime provider and recover retained operations.
   * @param adapter - Provider supporting all retained and default modes.
   * @returns an asynchronous disposer that drains admitted work.
   */
  registerRuntime(adapter: WorkspaceModeRuntime): () => Promise<void> {
    if (this.runtime !== undefined) throw new Error('workspace mode runtime is already registered')
    this.lifetime.signal.throwIfAborted()
    const required = [this.host.defaultMode, ...this.host.list().flatMap((entity) => {
      const record = entity.modeRecord()
      return record.modeIntent?.operation === 'switch-mode' && record.modeIntent.phase === 'commit'
        ? [record.mode, record.modeIntent.to] : [record.mode]
    })]
    for (const mode of required) {
      if (!adapter.supportedModes.includes(mode)) throw new Error(`workspace mode runtime does not support persisted or default mode '${mode}'`)
    }
    const registration: RuntimeRegistration = { adapter, lifetime: new AbortController(), withdrawing: false }
    this.runtime = registration
    this.runtimeEstablished = true
    for (const entity of this.host.list()) {
      if (entity.modeRecord().modeIntent === undefined) continue
      void this.recover(entity.id, {
        signal: this.lifetime.signal,
        admit: () => { this.requireEntity(entity.id, entity) },
      }).catch(error => this.host.report(error))
    }
    let disposal: Promise<void> | undefined
    return () => disposal ??= (async () => {
      registration.withdrawing = true
      registration.lifetime.abort()
      await this.drain()
      if (this.runtime === registration) this.runtime = undefined
    })()
  }

  async setMode(request: WorkspaceSetModeRequest, options: WorkspaceModeOperationOptions): Promise<WorkspaceModeConfig> {
    return this.exclusive(request.workspaceId, options, async (entity, signal) => {
      this.assertReady(entity)
      const config = entity.modeConfig
      if (config.firstSessionId !== null) {
        throw new WorkspaceModeError('workspace/mode-locked', {
          workspaceId: entity.id, mode: config.mode, firstSessionId: config.firstSessionId,
          lockReason: 'first-session-created',
        })
      }
      if (config.revision !== request.expectedRevision) {
        throw new WorkspaceModeError('workspace/mode-revision-conflict', {
          workspaceId: entity.id, expectedRevision: request.expectedRevision, actualRevision: config.revision,
        })
      }
      if (config.mode === request.mode) return config
      const runtime = this.requireRuntime(entity.id)
      if (!runtime.adapter.supportedModes.includes(request.mode)) {
        throw new WorkspaceModeError('workspace/mode-unsupported', { workspaceId: entity.id, mode: request.mode })
      }
      const change: WorkspaceModeChange = {
        changeId: brandString<WorkspaceModeChangeId>(randomUUID()), workspaceId: entity.id,
        project: entity.path, from: config.mode, to: request.mode, previousRevision: config.revision,
      }
      let phase: 'prepare' | 'settle' | 'persist' = 'persist'
      let admissionFailed = false
      const admit = (): void => {
        signal.throwIfAborted()
        try {
          options.admit()
          this.requireEntity(entity.id, entity)
        } catch (error) {
          admissionFailed = true
          throw error
        }
      }
      try {
        await entity.updateMode((record) => {
          if (record.firstSessionId !== null) {
            throw new WorkspaceModeError('workspace/mode-locked', {
              workspaceId: entity.id, mode: record.mode, firstSessionId: record.firstSessionId,
              lockReason: 'first-session-created',
            })
          }
          if (record.modeRevision !== config.revision) {
            throw new WorkspaceModeError('workspace/mode-revision-conflict', {
              workspaceId: entity.id, expectedRevision: config.revision, actualRevision: record.modeRevision,
            })
          }
          return { ...record, modeIntent: { ...change, operation: 'switch-mode', phase: 'preparing' }, modeOperationState: 'switching' }
        })
        phase = 'prepare'
        await runtime.adapter.prepare(change, signal)
        admit()
        phase = 'persist'
        await entity.updateMode((record) => {
          admit()
          return { ...record, modeIntent: { ...change, operation: 'switch-mode', phase: 'commit' } }
        })
        phase = 'settle'
        await runtime.adapter.settle(change, 'commit', this.settlementSignal(runtime))
        phase = 'persist'
        await this.finishChange(entity, change, 'commit')
        return entity.modeConfig
      } catch (error) {
        this.host.report(error)
        // Reading the domain also respects unknown-state quarantine. No further writes follow it.
        let intent
        try { intent = entity.modeRecord().modeIntent } catch (inspectionError) {
          this.host.report(inspectionError)
          throw new WorkspaceModeError('workspace/mode-switch-failed', {
            workspaceId: entity.id, changeId: change.changeId, phase: 'persist', recoveryRequired: true, outcomeUnknown: true,
          }, { cause: error })
        }
        if (intent?.operation !== 'switch-mode') {
          if (error instanceof WorkspaceModeError) throw error
          throw new WorkspaceModeError('workspace/mode-switch-failed', {
            workspaceId: entity.id, changeId: change.changeId, phase, recoveryRequired: false, outcomeUnknown: false,
          }, { cause: error })
        }
        let recoveryRequired = true
        if (intent.phase !== 'commit') {
          try {
            await entity.updateMode(record => ({
              ...record, modeIntent: { ...intent, phase: 'rollback' },
            }))
            await runtime.adapter.settle(change, 'rollback', this.settlementSignal(runtime))
            await this.finishChange(entity, change, 'rollback')
            recoveryRequired = false
          } catch (settlementError) {
            this.host.report(settlementError)
          }
        }
        if (recoveryRequired) {
          try { await this.markRecovery(entity) } catch (persistenceError) { this.host.report(persistenceError) }
        }
        if (signal.aborted && !recoveryRequired) throw signal.reason
        if (admissionFailed && !recoveryRequired) throw error
        throw new WorkspaceModeError('workspace/mode-switch-failed', {
          workspaceId: entity.id, changeId: change.changeId, phase,
          recoveryRequired, outcomeUnknown: recoveryRequired,
        }, { cause: error })
      }
    })
  }

  async acquireUse(workspaceId: WorkspaceId, options: WorkspaceModeOperationOptions): Promise<WorkspaceModeUseLease> {
    const entity = this.requireEntity(workspaceId)
    const signal = this.operationSignal(options.signal)
    const release = await this.queue(workspaceId).acquire(false, signal)
    try {
      this.check(entity, options, signal)
      this.assertReady(entity)
      const config = entity.modeConfig
      if (config.operationState !== 'ready') throw new Error('workspace mode admission invariant failed')
      return {
        config: Object.freeze({ ...config, operationState: 'ready' }), signal,
        admit: () => { this.check(entity, options, signal) }, release,
      }
    } catch (error) {
      release()
      throw error
    }
  }

  async recover(workspaceId: WorkspaceId, options: WorkspaceModeOperationOptions): Promise<WorkspaceModeConfig> {
    options.signal.throwIfAborted()
    options.admit()
    const existing = this.recoveries.get(workspaceId)
    if (existing !== undefined) {
      await existing
      options.signal.throwIfAborted()
      options.admit()
      return this.get(workspaceId)
    }
    const recovery = this.exclusive(workspaceId, options, async (entity) => {
      const intent = entity.modeRecord().modeIntent
      if (intent === undefined) return entity.modeConfig
      try {
        if (intent.operation === 'create-session') {
          if (this.sessionRecovery === undefined) {
            throw new WorkspaceModeError('workspace/mode-recovery-required', { workspaceId, operation: intent.operation })
          }
          await this.sessionRecovery(entity)
        } else {
          const runtime = this.requireRuntime(workspaceId)
          const decision = intent.phase === 'commit' ? 'commit' : 'rollback'
          if (intent.phase === 'preparing') {
            await entity.updateMode(record => ({ ...record, modeIntent: { ...intent, phase: decision } }))
          }
          const change: WorkspaceModeChange = {
            changeId: intent.changeId, workspaceId: intent.workspaceId, project: intent.project,
            from: intent.from, to: intent.to, previousRevision: intent.previousRevision,
          }
          await runtime.adapter.settle(change, decision, this.settlementSignal(runtime))
          await this.finishChange(entity, change, decision)
        }
        return entity.modeConfig
      } catch (error) {
        await this.markRecovery(entity)
        throw error
      }
    })
    this.recoveries.set(workspaceId, recovery)
    try { return await recovery } finally {
      if (this.recoveries.get(workspaceId) === recovery) this.recoveries.delete(workspaceId)
    }
  }

  /**
   * Registry-private exclusive admission for creation and deletion. Nested work consumes this slot directly.
   * @param workspaceId - Original registration.
   * @param options - Captured authority and cancellation.
   * @param operation - Work performed while every earlier lease is settled.
   * @returns the operation result after its owned work settles.
   */
  async exclusive<T>(workspaceId: WorkspaceId, options: WorkspaceModeOperationOptions,
    operation: (entity: WorkspaceEntity, signal: AbortSignal) => Promise<T>): Promise<T> {
    const entity = this.requireEntity(workspaceId)
    const signal = this.operationSignal(options.signal)
    const release = await this.queue(workspaceId).acquire(true, signal)
    try {
      this.check(entity, options, signal)
      return await operation(entity, signal)
    } finally { release() }
  }

  /** Refuse admission while a durable operation remains pending.
   * @param entity - Registration whose pending intent prevents resource admission.
   */
  assertReady(entity: WorkspaceEntity): void {
    const record = entity.modeRecord()
    if (record.modeIntent !== undefined || record.modeOperationState !== 'ready') {
      throw new WorkspaceModeError('workspace/mode-recovery-required', {
        workspaceId: entity.id, operation: record.modeIntent?.operation ?? 'switch-mode',
      })
    }
  }

  /** Install registry-owned ordinary Session recovery.
   * @param recover - Private ordinary Session recovery owned by this registry.
   */
  registerSessionRecovery(recover: (entity: WorkspaceEntity) => Promise<void>): void {
    this.sessionRecovery = recover
  }

  /** Stop admission, abort owned work, and await actual operation and lease settlement. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    await this.drain()
  }

  private async drain(): Promise<void> {
    await Promise.all([...this.admission.values()].map(queue => queue.drain()))
  }

  private check(entity: WorkspaceEntity, options: WorkspaceModeOperationOptions, signal: AbortSignal): void {
    signal.throwIfAborted()
    options.admit()
    this.requireEntity(entity.id, entity)
    if (this.runtimeEstablished) this.requireRuntime(entity.id)
  }

  private operationSignal(signal: AbortSignal): AbortSignal {
    return AbortSignal.any([signal, this.lifetime.signal, ...this.runtime === undefined ? [] : [this.runtime.lifetime.signal]])
  }

  private settlementSignal(runtime: RuntimeRegistration): AbortSignal {
    return AbortSignal.any([this.lifetime.signal, runtime.lifetime.signal])
  }

  private requireRuntime(workspaceId: WorkspaceId): RuntimeRegistration {
    if (this.runtime === undefined || this.runtime.withdrawing) {
      throw new WorkspaceModeError('workspace/mode-runtime-unavailable', { workspaceId })
    }
    return this.runtime
  }

  private requireEntity(id: WorkspaceId, expected?: WorkspaceEntity): WorkspaceEntity {
    const entity = this.host.entity(id)
    if (entity === undefined || expected !== undefined && entity !== expected) {
      throw new WorkspaceModeError('workspace/not-found', { workspaceId: id })
    }
    entity.modeRecord()
    return entity
  }

  private queue(id: WorkspaceId): Admission {
    let queue = this.admission.get(id)
    if (queue === undefined) { queue = new Admission(); this.admission.set(id, queue) }
    return queue
  }

  private async finishChange(entity: WorkspaceEntity, change: WorkspaceModeChange,
    decision: 'commit' | 'rollback'): Promise<void> {
    await entity.updateMode(record => ({
      ...record, mode: decision === 'commit' ? change.to : change.from,
      modeIntent: undefined, modeOperationState: 'ready',
    }))
  }

  private async markRecovery(entity: WorkspaceEntity): Promise<void> {
    const record = entity.modeRecord()
    if (record.modeIntent === undefined || record.modeOperationState === 'recovery-required') return
    await entity.updateMode(current => ({ ...current, modeOperationState: 'recovery-required' }))
  }
}
