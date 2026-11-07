/** Workspace-mode presentation decisions derived from authoritative metadata. */
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** @param workspace - Authoritative row. @returns Whether it permits multiple ordinary Sessions. */
export function multipleSessions(workspace: WorkspaceView): boolean {
  return workspace.modeConfig.mode === 'multi-vm' || workspace.modeConfig.mode === 'multi-docker'
}

/** @param workspace - Authoritative row. @returns Whether a new ordinary Session may be offered. */
export function canCreateSession(workspace: WorkspaceView): boolean {
  return workspace.modeConfig.operationState === 'ready'
    && (multipleSessions(workspace) || workspace.modeConfig.firstSessionId === null)
}

/** @param workspaces - Current Workspace rows. @param id - Session identity. @returns Its permanent or current Workspace account. */
export function sessionWorkspace(workspaces: readonly WorkspaceView[], id: SessionId): WorkspaceView | undefined {
  return workspaces.find(row => row.modeConfig.firstSessionId === id || row.sessionIds.includes(id))
}
