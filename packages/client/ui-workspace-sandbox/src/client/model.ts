/** Workspace observations and user operations owned by one browser plugin. */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { remoteErrorOf, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ConnectionGenerationState } from '@deepseek-ai/dsh-client-connection/client'
import type { SandboxValue, SandboxFailureReason } from '@deepseek-ai/dsh-harness-sandbox/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {} from '@deepseek-ai/dsh-api-remote-access/types'
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap { /** Authenticated workspace sandbox observation. */ workspacesandbox: SandboxView }
}

/** The three authenticated operations, without paths or container identifiers. */
export type SandboxApi = Record<'open' | 'status' | 'close',
  (workspaceId: WorkspaceId, signal: AbortSignal) => Promise<RemoteResult<SandboxValue>>>
/** A localized report selects copy by reason, never by an exception's message. */
export interface SandboxFailure {
  readonly reason: SandboxFailureReason | 'disconnected' | 'request_failed' | 'denied' | 'busy'
  readonly operation: 'open' | 'status' | 'close'
  readonly outcomeUnknown: boolean
}
/** Latest observation plus an independently pending user operation. */
export interface SandboxView {
  readonly workspaceId: WorkspaceId
  readonly state: SandboxValue['state'] | undefined
  readonly pending: 'open' | 'close' | undefined
  readonly failure: SandboxFailure | undefined
  readonly statusFailure: SandboxFailure | undefined
  readonly connected: boolean
}

interface RecordState {
  readonly store: SnapshotStore<SandboxView>
  holders: number
  revision: number
  timer: ReturnType<typeof setTimeout> | undefined
  query: AbortController | undefined
  mutation: AbortController | undefined
}

/** Normalize transport and business failures without exposing internal diagnostics. */
function failure(error: unknown, operation: SandboxFailure['operation']): SandboxFailure {
  const remote = remoteErrorOf(error)
  if (remote?.code === 'sandbox/failed') return { reason: remote.details.reason, operation, outcomeUnknown: remote.details.outcomeUnknown }
  if (remote?.code === 'remote-access/denied') return { reason: 'denied', operation, outcomeUnknown: false }
  return { reason: 'request_failed', operation,
    outcomeUnknown: operation !== 'status' }
}

/**
 * Share one query loop per visible workspace. Closing a panel releases polling,
 * while a submitted mutation stays owned until settlement or connection loss.
 */
export class SandboxModel {
  private readonly records = new Map<WorkspaceId, RecordState>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly unsubscribe: () => void
  private disposed = false

  /**
   * @param api - Authenticated Harness callbacks.
   * @param generations - Active connection identity.
   * @param pollIntervalMs - Delay after a completed query.
   * @param allowed - Current workspace permission, read again at operation boundaries.
   */
  constructor(private readonly api: SandboxApi, private readonly generations: ConnectionGenerationState,
    private readonly pollIntervalMs: number,
    private readonly allowed: (id: WorkspaceId, operation: 'open' | 'status' | 'close') => boolean) {
    this.unsubscribe = generations.subscribe(() => {
      for (const [id, record] of this.records) {
        const pending = record.store.getSnapshot().pending
        this.stop(record)
        record.mutation?.abort()
        record.mutation = undefined
        record.store.set({ workspaceId: id, state: undefined, pending: undefined,
          connected: generations.getSnapshot() !== undefined,
          failure: pending === undefined ? undefined : { reason: 'disconnected', operation: pending, outcomeUnknown: true },
          statusFailure: undefined })
        if (record.holders > 0) this.refresh(id)
        else this.records.delete(id)
      }
    })
  }

  /**
   * Share workspace observations while this resource holder remains active.
   * @param workspaceId - Native workspace identity.
   * @param signal - Resource holder lifetime.
   * @returns Current observation followed by coalesced updates.
   */
  async *watch(workspaceId: WorkspaceId, signal: AbortSignal): AsyncIterable<RemoteResult<SandboxView>> {
    if (signal.aborted || this.disposed) return
    const record = this.record(workspaceId)
    record.holders++
    let changed = true
    let wake: (() => void) | undefined
    const notify = (): void => { changed = true; wake?.() }
    const isActive = (): boolean => !signal.aborted && !this.disposed
    const hasChanged = (): boolean => changed
    const unsubscribe = record.store.subscribe(notify)
    signal.addEventListener('abort', notify, { once: true })
    if (record.holders === 1) this.refresh(workspaceId)
    try {
      while (isActive()) {
        if (!hasChanged()) await new Promise<void>((resolve) => { wake = resolve })
        wake = undefined
        if (!isActive()) break
        changed = false
        yield { ok: true, value: record.store.getSnapshot() }
      }
    } finally {
      unsubscribe()
      signal.removeEventListener('abort', notify)
      record.holders--
      if (record.holders === 0) {
        this.stop(record)
        if (record.mutation === undefined) this.records.delete(workspaceId)
      }
    }
  }

  /**
   * Query a watched workspace without overlapping an existing operation.
   * @param workspaceId - Workspace being observed.
   */
  refresh(workspaceId: WorkspaceId): void {
    const record = this.records.get(workspaceId)
    if (this.disposed || !record || record.holders === 0 || record.mutation || this.generations.getSnapshot() === undefined) return
    this.stop(record)
    if (!this.allowed(workspaceId, 'status')) {
      record.store.set({ ...record.store.getSnapshot(), state: undefined,
        statusFailure: { reason: 'denied', operation: 'status', outcomeUnknown: false } })
      return
    }
    const revision = record.revision
    const controller = record.query = new AbortController()
    void this.track((async () => {
      try {
        const result = await this.api.status(workspaceId, controller.signal)
        if (controller.signal.aborted || record.revision !== revision || !this.allowed(workspaceId, 'status')) return
        const view = record.store.getSnapshot()
        record.store.set({ ...view, state: result.ok ? result.value.state : view.state,
          statusFailure: result.ok ? undefined : failure(result.error, 'status') })
      } catch (error) {
        if (!controller.signal.aborted) record.store.set({ ...record.store.getSnapshot(), statusFailure: failure(error, 'status') })
      } finally {
        if (!controller.signal.aborted && record.revision === revision) {
          record.query = undefined
          record.timer = setTimeout(() => { this.refresh(workspaceId) }, this.pollIntervalMs)
        }
      }
    })())
  }

  /**
   * Submit one authorized user action and retain its result until settlement.
   * @param workspaceId - Workspace selected by the user.
   * @param operation - Explicit user gesture; mutations are never retried automatically.
   * @returns Failure for localized feedback, or undefined after confirmation.
   */
  async change(workspaceId: WorkspaceId, operation: 'open' | 'close'): Promise<SandboxFailure | undefined> {
    if (this.disposed) return { reason: 'disconnected', operation, outcomeUnknown: false }
    if (!this.allowed(workspaceId, operation)) return { reason: 'denied', operation, outcomeUnknown: false }
    const record = this.record(workspaceId)
    if (record.mutation) return { reason: 'busy', operation, outcomeUnknown: false }
    if (this.generations.getSnapshot() === undefined) return { reason: 'disconnected', operation, outcomeUnknown: false }
    this.stop(record)
    const controller = record.mutation = new AbortController()
    record.store.set({ ...record.store.getSnapshot(), pending: operation, failure: undefined })
    return this.track((async () => {
      let problem: SandboxFailure | undefined
      try {
        const result = await this.api[operation](workspaceId, controller.signal)
        if (controller.signal.aborted || !this.allowed(workspaceId, operation)) {
          problem = { reason: 'disconnected', operation, outcomeUnknown: true }
          return problem
        }
        if (result.ok) record.store.set({ ...record.store.getSnapshot(), state: result.value.state })
        else problem = failure(result.error, operation)
      } catch (error) {
        problem = controller.signal.aborted ? { reason: 'disconnected', operation, outcomeUnknown: true } : failure(error, operation)
      } finally {
        if (record.mutation === controller) {
          record.mutation = undefined
          record.store.set({ ...record.store.getSnapshot(), pending: undefined, failure: problem })
          if (record.holders > 0) this.refresh(workspaceId)
          else if (record.holders === 0) this.records.delete(workspaceId)
        }
      }
      return problem
    })())
  }

  /** Stop polling and pending requests before the generated namespace is withdrawn. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.unsubscribe()
    for (const record of this.records.values()) {
      this.stop(record)
      record.mutation?.abort()
      record.store.set({ ...record.store.getSnapshot(), connected: false })
    }
    await Promise.allSettled([...this.operations])
    this.records.clear()
  }

  private record(id: WorkspaceId): RecordState {
    let record = this.records.get(id)
    if (!record) {
      record = { holders: 0, revision: 0, timer: undefined, query: undefined, mutation: undefined,
        store: createSnapshotStore<SandboxView>({ workspaceId: id,
          state: undefined, pending: undefined, failure: undefined, statusFailure: undefined,
          connected: this.generations.getSnapshot() !== undefined }) }
      this.records.set(id, record)
    }
    return record
  }

  private stop(record: RecordState): void {
    record.revision++
    clearTimeout(record.timer)
    record.query?.abort()
    record.query = undefined
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    void operation.then(() => { this.operations.delete(operation) }, () => { this.operations.delete(operation) })
    return operation
  }
}
