/**
 * Workspace mode configuration, resource admission, runtime coordination, and typed failures.
 * @module @deepseek-ai/dsh-workspace/src/mode-types
 */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from './types.ts'

/** The four workspace modes shared by issues #41, #42, #43, and #45. */
export type WorkspaceMode = 'single-vm' | 'multi-vm' | 'single-docker' | 'multi-docker'

/** A durable transition identity reused during recovery. */
export type WorkspaceModeChangeId = Branded<'WorkspaceModeChangeId'>

/** Configuration locking is permanent after the first successful ordinary Session. */
export type WorkspaceModeLockReason = 'first-session-created'

/** Operational admission state, independent of permanent configuration locking. */
export type WorkspaceModeOperationState =
  | 'ready'
  | 'switching'
  | 'creating-session'
  | 'recovery-required'

/** Browser-safe configuration; every durable state mutation increases revision. */
export interface WorkspaceModeConfig {
  readonly workspaceId: WorkspaceId
  readonly mode: WorkspaceMode
  readonly revision: number
  readonly operationState: WorkspaceModeOperationState
  readonly modeLocked: boolean
  readonly lockReason: WorkspaceModeLockReason | null
  readonly firstSessionId: SessionId | null
}

/** The lease is a stable routing snapshot until release. */
export type WorkspaceModeUseConfig = WorkspaceModeConfig & {
  readonly operationState: 'ready'
}

/** Workspace getMode Remote request. */
export interface WorkspaceGetModeRequest {
  readonly workspaceId: WorkspaceId
}

/** Workspace setMode Remote request; stale edits fail before preparation. */
export interface WorkspaceSetModeRequest {
  readonly workspaceId: WorkspaceId
  readonly mode: WorkspaceMode
  readonly expectedRevision: number
}

/** Success payload of both mode Remote methods. */
export interface WorkspaceModeValue {
  readonly config: WorkspaceModeConfig
}

/** Captured authority and cancellation for one trusted internal operation. */
export interface WorkspaceModeOperationOptions {
  readonly signal: AbortSignal
  /** Throw if the original caller no longer owns the original registration. */
  admit(): void
}

/** Held across all resource use; nested helpers reuse it instead of reacquiring. */
export interface WorkspaceModeUseLease {
  readonly config: WorkspaceModeUseConfig
  /** Operation lifetime, aborted on withdrawal; release still follows actual settlement. */
  readonly signal: AbortSignal
  /** Recheck the captured authority before resource access or publication. */
  admit(): void
  /** Idempotent; invoke after all retained resource operations have settled. */
  release(): void
}

/** Host-only transition intent; never accept a path or identity from the browser. */
export interface WorkspaceModeChange {
  readonly changeId: WorkspaceModeChangeId
  readonly workspaceId: WorkspaceId
  /** Canonical immutable project identity; not necessarily the runtime file root. */
  readonly project: string
  readonly from: WorkspaceMode
  readonly to: WorkspaceMode
  readonly previousRevision: number
}

/** Durable coordinator decision, reused unchanged during retries. */
export type WorkspaceModeChangeDecision = 'commit' | 'rollback'

/**
 * Environment and file routing provider. Both methods are idempotent for changeId.
 * It must not re-enter the public mode coordinator while holding exclusivity.
 */
export interface WorkspaceModeRuntime {
  /** Supported default, persisted modes, and the selected direction of pending recovery. */
  readonly supportedModes: readonly WorkspaceMode[]
  /**
   * Quiesce the old environment and stage complete target files, retaining a recoverable
   * source. Resolve only after all preparation writes settle. On rejection, retained
   * work must be settled or recorded for settle(change, 'rollback') to reconcile.
   */
  prepare(change: WorkspaceModeChange, signal: AbortSignal): Promise<void>
  /**
   * Publish the selected environment/file routing and reconcile retained resources.
   * Commit follows a durable commit decision; rollback restores from-mode usability.
   * Must work after restart, without an in-memory result from prepare.
   * Resolve only when the selected mode is usable and all owned writes settle.
   */
  settle(
    change: WorkspaceModeChange,
    decision: WorkspaceModeChangeDecision,
    signal: AbortSignal,
  ): Promise<void>
}

/** Trusted Host API: ctx.workspaceRegistry.modes. */
export interface IWorkspaceModes {
  /** Read committed metadata, including transitional states; does not authorize or open resources. */
  get(workspaceId: WorkspaceId): WorkspaceModeConfig
  /** Register exactly one runtime adapter; its async disposer stops admission and drains owned work. */
  registerRuntime(runtime: WorkspaceModeRuntime): () => Promise<void>
  /**
   * Exclusive, revision-checked asynchronous change. Uses coordinator-owned settlement
   * after a durable decision; caller cancellation must not abandon pending recovery.
   */
  setMode(
    request: WorkspaceSetModeRequest,
    options: WorkspaceModeOperationOptions,
  ): Promise<WorkspaceModeConfig>
  /**
   * Retry the existing durable intent without changing its identity or decision.
   * Trusted maintenance only; no Remote endpoint. Concurrent recovery is deduplicated.
   * A ready workspace without an intent returns unchanged; quarantined storage refuses.
   */
  recover(
    workspaceId: WorkspaceId,
    options: WorkspaceModeOperationOptions,
  ): Promise<WorkspaceModeConfig>
  /**
   * Acquire shared resource use after earlier exclusive work settles. Recheck authority
   * after waiting. Rejections preserve business failure types; recovery-required refuses.
   */
  acquireUse(
    workspaceId: WorkspaceId,
    options: WorkspaceModeOperationOptions,
  ): Promise<WorkspaceModeUseLease>
}

/** New business failures, to be merged into RemoteErrorDetailsMap by the owners. */
export interface WorkspaceModeErrorDetailsMap {
  'workspace/mode-locked': {
    readonly workspaceId: WorkspaceId
    readonly mode: WorkspaceMode
    readonly firstSessionId: SessionId
    readonly lockReason: WorkspaceModeLockReason
  }
  'workspace/mode-revision-conflict': {
    readonly workspaceId: WorkspaceId
    readonly expectedRevision: number
    readonly actualRevision: number
  }
  'workspace/mode-unsupported': {
    readonly workspaceId: WorkspaceId
    readonly mode: WorkspaceMode
  }
  'workspace/mode-runtime-unavailable': { readonly workspaceId: WorkspaceId }
  'workspace/mode-switch-failed': {
    readonly workspaceId: WorkspaceId
    readonly changeId: WorkspaceModeChangeId
    readonly phase: 'prepare' | 'settle' | 'persist'
    readonly recoveryRequired: boolean
    readonly outcomeUnknown: boolean
  }
  'workspace/mode-recovery-required': {
    readonly workspaceId: WorkspaceId
    readonly operation: 'switch-mode' | 'create-session'
  }
  'workspace/session-limit': {
    readonly workspaceId: WorkspaceId
    readonly firstSessionId: SessionId
  }
  'workspace/session-operation-forbidden': {
    readonly workspaceId: WorkspaceId
    readonly sessionId: SessionId
    readonly operation: 'fork' | 'archive'
  }
  'session/reuse-unavailable': {
    readonly workspaceId: WorkspaceId
    readonly sessionId: SessionId
  }
}
