/** Mode-transition resource ownership beneath the workspace coordinator's durable decision. */
import type {
  WorkspaceMode, WorkspaceModeChange, WorkspaceModeChangeDecision, WorkspaceModeRuntime,
} from '@deepseek-ai/dsh-workspace/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { WorkspaceModeRoutingError } from './mode-routing.ts'

/** A complete, durable file checkpoint retained by the source provider until transition settlement. */
export interface WorkspaceModeCheckpoint {
  readonly root: string
}

/**
 * One mode's private transition operations. All operations are restart-safe and idempotent by changeId.
 * Providers persist resource identities and file checkpoints before returning or reporting uncertain effects.
 */
export interface WorkspaceModeResources {
  /** Quiesce source commands/writes and retain a complete checkpoint without losing rollback data. */
  checkpoint(change: WorkspaceModeChange, signal: AbortSignal): Promise<WorkspaceModeCheckpoint>
  /** Prepare destination files privately; partial work remains discoverable by discard after restart. */
  stage(change: WorkspaceModeChange, checkpoint: WorkspaceModeCheckpoint, signal: AbortSignal): Promise<void>
  /** Publish destination files/routing from the durable stage; never depends on an in-memory checkpoint. */
  publish(change: WorkspaceModeChange, signal: AbortSignal): Promise<void>
  /** Retire obsolete source resources after destination publication; retain retry evidence until coordinator completion. */
  retire(change: WorkspaceModeChange, signal: AbortSignal): Promise<void>
  /** Remove only this transition's uncommitted destination resources, independently of source restoration. */
  discard(change: WorkspaceModeChange, signal: AbortSignal): Promise<void>
  /** Restore source usability, including any execution environment stopped during checkpointing. */
  restore(change: WorkspaceModeChange, signal: AbortSignal): Promise<void>
}

/** Prepares complete destination files and settles only in the coordinator's selected direction. */
export class WorkspaceModeRuntimeAdapter implements WorkspaceModeRuntime {
  private readonly resources: ReadonlyMap<WorkspaceMode, WorkspaceModeResources>
  readonly supportedModes: readonly WorkspaceMode[]

  /** @param resources - Explicit supported modes and their durable resource owners. */
  constructor(resources: ReadonlyMap<WorkspaceMode, WorkspaceModeResources>) {
    this.resources = new Map(resources)
    this.supportedModes = Object.freeze([...resources.keys()])
  }

  /**
   * Quiesce the original mode and prepare destination files before the commit decision.
   * @param change - Coordinator-owned stable transition identity.
   * @param signal - Pre-decision cancellation; providers retain partial work for rollback.
   * @returns Completed preparation, preserving the source's rollback data.
   */
  async prepare(change: WorkspaceModeChange, signal: AbortSignal): Promise<void> {
    const source = this.resource(change, change.from)
    const destination = this.resource(change, change.to)
    signal.throwIfAborted()
    const checkpoint = await source.checkpoint(change, signal)
    signal.throwIfAborted()
    await destination.stage(change, checkpoint, signal)
    signal.throwIfAborted()
  }

  /**
   * Complete a durable decision; rollback attempts destination cleanup and source restoration independently.
   * @param change - Original transition, also supplied after process restart.
   * @param decision - Persisted coordinator decision, never recomputed from current mode metadata.
   * @param signal - Coordinator-owned settlement lifetime.
   * @returns Completed destination activation/source retirement or complete rollback; failures remain visible.
   */
  async settle(change: WorkspaceModeChange, decision: WorkspaceModeChangeDecision, signal: AbortSignal): Promise<void> {
    const source = this.resource(change, change.from)
    const destination = this.resource(change, change.to)
    signal.throwIfAborted()
    switch (decision) {
      case 'commit':
        await destination.publish(change, signal)
        signal.throwIfAborted()
        await source.retire(change, signal)
        return
      case 'rollback':
        return this.rollback(change, source, destination, signal)
      default:
        return assertNever(decision)
    }
  }

  private async rollback(
    change: WorkspaceModeChange, source: WorkspaceModeResources, destination: WorkspaceModeResources, signal: AbortSignal,
  ): Promise<void> {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => destination.discard(change, signal)),
      Promise.resolve().then(() => source.restore(change, signal)),
    ])
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length > 0) {
      throw new AggregateError(failures.map((result): unknown => result.reason), 'Workspace mode rollback did not finish')
    }
  }

  private resource(change: WorkspaceModeChange, mode: WorkspaceMode): WorkspaceModeResources {
    const resource = this.resources.get(mode)
    if (resource === undefined) throw new WorkspaceModeRoutingError(change.workspaceId, mode, 'unsupported-mode')
    return resource
  }
}
