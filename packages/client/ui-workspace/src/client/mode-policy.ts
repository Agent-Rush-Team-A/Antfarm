/** Workspace-mode presentation decisions derived from authoritative metadata. */
import type { WorkspaceId, WorkspaceView, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Identify the two modes that admit multiple ordinary Sessions.
 * @param workspace - Authoritative row.
 * @returns Whether it permits multiple ordinary Sessions.
 */
export function multipleSessions(workspace: WorkspaceView): boolean {
  return workspace.modeConfig.mode === 'multi-vm' || workspace.modeConfig.mode === 'multi-docker'
}

/**
 * Offer creation only while admission is ready and single-mode capacity remains unused.
 * @param workspace - Authoritative row.
 * @returns Whether a new ordinary Session may be offered.
 */
export function canCreateSession(workspace: WorkspaceView): boolean {
  return !workspace.archived && workspace.modeConfig.operationState === 'ready'
    && (multipleSessions(workspace) || workspace.modeConfig.firstSessionId === null)
}

/**
 * Resolve permanent membership before following descendant ancestry.
 * @param workspaces - Current Workspace rows.
 * @param id - Session identity.
 * @param sessions - Optional catalog for descendants whose Workspace belongs to an ancestor.
 * @returns Its permanent or current Workspace account.
 */
export function sessionWorkspace(workspaces: readonly WorkspaceView[], id: SessionId,
  sessions: SessionListState['byId'] = {}): WorkspaceView | undefined {
  const seen = new Set<SessionId>()
  let current: SessionId | undefined = id
  while (current !== undefined && !seen.has(current)) {
    const target: SessionId = current
    seen.add(target)
    const row = workspaces.find(row => row.modeConfig.firstSessionId === target || row.sessionIds.includes(target))
    if (row !== undefined) return row
    current = sessions[target]?.parentId
  }
  return undefined
}

/**
 * Select a Workspace by Session activity, falling back to its registration time.
 * @param workspaces - Current rows.
 * @param sessions - Catalog activity.
 * @returns Most recent Workspace, retaining Host order on ties.
 */
export function recentWorkspace(workspaces: readonly WorkspaceView[], sessions: SessionListState['byId']): WorkspaceId | undefined {
  let selected: WorkspaceId | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of workspaces) {
    if (workspace.archived) continue
    let latest = Number.NEGATIVE_INFINITY
    for (const sessionId of workspace.sessionIds) {
      const session = sessions[sessionId]
      if (session !== undefined) latest = Math.max(latest, session.updatedAt)
    }
    if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt)
    if (selected === undefined || latest > selectedTime) {
      selected = workspace.workspaceId
      selectedTime = latest
    }
  }
  return selected
}

/**
 * Evaluate global New Session admission from the current or most recent Workspace.
 * @param workspaces - Authoritative Workspace snapshot.
 * @param sessions - Current Session catalog and selection.
 * @returns Whether the current or most recent Workspace admits New Session.
 */
export function newSessionAvailable(workspaces: WorkspaceSnapshot, sessions: SessionListState): boolean {
  const current = Object.values(sessions.byId).find(row => (row.retainedBy.mainView ?? 0) > 0)
  const target = current === undefined ? undefined : sessionWorkspace(workspaces.items, current.id, sessions.byId)?.workspaceId
  const id = target ?? recentWorkspace(workspaces.items, sessions.byId)
  const row = workspaces.items.find(value => value.workspaceId === id)
  return row === undefined || canCreateSession(row)
}
