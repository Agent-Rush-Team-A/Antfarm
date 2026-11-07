/** Pure projection shared by registry snapshots and committed Workspace feeds. */
import type { WorkspaceId, WorkspaceModeConfig } from './types.ts'
import type { WorkspaceRecord } from './spec.ts'

/**
 * Derive permanent locking from the durable first identity; operation state remains independent.
 * @param workspaceId - Original registration identity.
 * @param record - Committed durable record.
 * @returns an immutable, browser-safe mode snapshot.
 */
export function workspaceModeConfig(workspaceId: WorkspaceId, record: WorkspaceRecord): WorkspaceModeConfig {
  return Object.freeze({
    workspaceId, mode: record.mode, revision: record.modeRevision,
    operationState: record.modeOperationState, modeLocked: record.firstSessionId !== null,
    lockReason: record.firstSessionId === null ? null : 'first-session-created', firstSessionId: record.firstSessionId,
  })
}
