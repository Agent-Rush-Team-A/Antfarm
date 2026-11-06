/** Per-user Remote access policy and the synchronous ownership index it reads. */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {
  RemoteAccessBinding,
  RemoteAccessCondition,
  RemoteAccessPolicy,
  RemoteAccessRequest,
  RemoteAccessRole,
} from '@deepseek-ai/dsh-api-remote-access'
import type { PrincipalMap } from '@deepseek-ai/dsh-typert-protocol'

/** Read-only ownership state the policy consults synchronously. */
export interface MultiuserAccessIndex {
  /**
   * Whether one user currently owns one workspace.
   * @param userId - account identity.
   * @param workspaceId - workspace identity from the wire.
   * @returns true only for a persisted ownership row.
   */
  ownsWorkspace(userId: PrincipalMap['user']['userId'], workspaceId: WorkspaceId): boolean

  /**
   * Whether one user currently owns the workspace accounting a session.
   * @param userId - account identity.
   * @param sessionId - session identity from the wire.
   * @returns true only when the session belongs to an owned workspace.
   */
  ownsSession(userId: PrincipalMap['user']['userId'], sessionId: SessionId): boolean

  /**
   * List the user's owned workspace identities.
   * @param userId - account identity.
   * @returns current owned workspaces.
   */
  ownedWorkspaces(userId: PrincipalMap['user']['userId']): readonly WorkspaceId[]

  /**
   * List sessions accounted by the user's owned workspaces.
   * @param userId - account identity.
   * @returns current owned session identities.
   */
  ownedSessions(userId: PrincipalMap['user']['userId']): readonly SessionId[]
}

/** Actions every authenticated account may call on the global resource. */
const GLOBAL_ACTIONS = [
  'workspace/create',
  'workspace/follow',
  'session/list',
  'session/search',
  'session/control',
  'session/modelCatalog',
  'session/canOpenWorkspacePath',
] as const

/** Actions allowed on a workspace the account owns. */
const WORKSPACE_ACTIONS = [
  'workspace/follow',
  'session/create',
  'workspace/rename',
  'workspace/delete',
  'workspace/insertBefore',
  'workspace/insertSessionBefore',
  'workspaceUpload/limits',
  'workspaceUpload/upload',
] as const

/** Actions allowed on a session accounted by an owned workspace. */
const SESSION_ACTIONS = [
  'workspace/follow',
  'session/create',
  'session/list',
  'session/search',
  'session/control',
  'workspace/insertSessionBefore',
  'workspace/archiveSession',
  'workspace/unarchiveSession',
  'workspace/pinSession',
  'workspace/unpinSession',
  'session/page',
  'session/events',
  'session/observeEvent',
  'session/observeProjections',
  'session/state',
  'session/observeState',
  'session/wait',
  'session/follow',
  'session/projections',
  'session/prompt',
  'session/updateQueue',
  'session/cancel',
  'session/rename',
  'session/fork',
  'session/selectModel',
  'event:api-session/added',
  'event:api-session/removed',
  'event:api-session/status',
  'event:api-session/error',
  'event:api-session/activity',
] as const

const GLOBAL_ROLE: RemoteAccessRole<'global'> = {
  name: 'multiuser:account',
  resource: 'global',
  actions: GLOBAL_ACTIONS,
}
const WORKSPACE_ROLE: RemoteAccessRole<'workspace'> = {
  name: 'multiuser:workspace-owner',
  resource: 'workspace',
  actions: WORKSPACE_ACTIONS,
}
const SESSION_ROLE: RemoteAccessRole<'session'> = {
  name: 'multiuser:session-member',
  resource: 'session',
  actions: SESSION_ACTIONS,
}

/** Allow only the resources the account currently owns, rechecked at decision time. */
export class MultiuserPolicy implements RemoteAccessPolicy<PrincipalMap['user']> {
  /**
   * @param index - synchronous ownership source owned by the multiuser service.
   */
  constructor(private readonly index: MultiuserAccessIndex) {}

  /** @param principal - the authenticated account. @returns its current bindings. */
  bindings(principal: PrincipalMap['user']): readonly RemoteAccessBinding[] {
    const userId = principal.userId
    const bindings: RemoteAccessBinding[] = [{
      role: GLOBAL_ROLE,
      resource: { kind: 'global' },
    }]
    const workspaceCondition: RemoteAccessCondition<'workspace'> = ({ resource }) =>
      this.checkWorkspace(userId, resource.id)
    const sessionCondition: RemoteAccessCondition<'session'> = ({ resource }) =>
      this.checkSession(userId, resource.id)
    for (const workspaceId of this.index.ownedWorkspaces(userId)) {
      bindings.push({
        role: WORKSPACE_ROLE,
        resource: { kind: 'workspace', id: workspaceId },
        condition: workspaceCondition,
      })
    }
    for (const sessionId of this.index.ownedSessions(userId)) {
      bindings.push({
        role: SESSION_ROLE,
        resource: { kind: 'session', id: sessionId },
        condition: sessionCondition,
      })
    }
    return bindings
  }

  /**
   * @param request - the refused request.
   * @returns a stable reason that does not disclose another account's resource.
   */
  explain(request: RemoteAccessRequest<PrincipalMap['user']>): string {
    return request.resources.some(resource => resource.kind !== 'global') ? 'not-found' : 'no-allow'
  }

  private checkWorkspace(userId: PrincipalMap['user']['userId'], workspaceId: WorkspaceId) {
    return this.index.ownsWorkspace(userId, workspaceId)
      ? { kind: 'allow' as const }
      : { kind: 'deny' as const, reason: 'not-found' }
  }

  private checkSession(userId: PrincipalMap['user']['userId'], sessionId: SessionId) {
    return this.index.ownsSession(userId, sessionId)
      ? { kind: 'allow' as const }
      : { kind: 'deny' as const, reason: 'not-found' }
  }
}
