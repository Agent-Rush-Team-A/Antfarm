/** Workspace command implementation and stable Remote failure mapping. */

import type { Context } from '@deepseek-ai/cordis'
import type { PrincipalMap } from '@deepseek-ai/dsh-typert-protocol'
import type { Workspace, WorkspaceModeOperationOptions } from '@deepseek-ai/dsh-workspace'
import {
  WorkspaceModeError,
  WorkspaceActiveSessionError,
  WorkspaceArchivedSessionPinError,
  WorkspaceId,
  WorkspaceMoveInvalidError,
  WorkspaceOrderInvalidError,
  WorkspaceUnknownSessionError,
} from '@deepseek-ai/dsh-workspace'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-multiuser'
import { workspaceView } from './feed.ts'
import type {
  WorkspaceGetModeRequest, WorkspaceSetModeRequest, WorkspaceModeValue,
  WorkspaceArchiveSessionRequest,
  WorkspaceArchiveValue,
  WorkspaceCreateRequest,
  WorkspaceCreateValue,
  WorkspaceDeleteRequest,
  WorkspaceDeleteValue,
  WorkspaceInsertBeforeRequest,
  WorkspaceInsertSessionBeforeRequest,
  WorkspaceOrderValue,
  WorkspacePinSessionRequest,
  WorkspacePinValue,
  WorkspaceRenameRequest,
  WorkspaceUnarchiveSessionRequest,
  WorkspaceUnpinSessionRequest,
  WorkspaceValue,
} from './types.ts'

/** One call's current visibility for response filtering. */
export interface WorkspaceVisibility {
  /**
   * @param workspaceId - candidate workspace.
   * @returns whether the caller may see it.
   */
  workspace(workspaceId: WorkspaceId): boolean
  /**
   * @param sessionId - candidate session.
   * @returns whether the caller may see it.
   */
  session(sessionId: import('@deepseek-ai/dsh-session/types').SessionId): boolean
}

/** Implements Workspace mutations against the authoritative registry. */
export class WorkspaceCommands {
  private operationTail = Promise.resolve()

  /** @param ctx - Host context containing the Workspace registry. */
  constructor(private readonly ctx: Context) {}

  /**
   * Read committed mode metadata and map domain failures.
   * @param request - Original registration.
   * @returns committed mode metadata or a stable domain failure.
   */
  getMode(request: WorkspaceGetModeRequest): WorkspaceModeValue {
    try { return { config: this.ctx.workspaceRegistry.modes.get(request.workspaceId) } } catch (error) { rejectModeError(error) }
  }

  /**
   * Change mode after wire validation and captured ownership checks.
   * @param request - Target mode and observed revision.
   * @param options - Original authority and cancellation.
   * @returns ready metadata after runtime and persistence settlement.
   */
  async setMode(request: WorkspaceSetModeRequest, options: WorkspaceModeOperationOptions): Promise<WorkspaceModeValue> {
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) {
      throw new RemoteError('gateway/bad-request', 'expectedRevision must be a nonnegative safe integer', {})
    }
    try { return { config: await this.ctx.workspaceRegistry.modes.setMode(request, options) } } catch (error) {
      if (options.signal.aborted && !(error instanceof WorkspaceModeError)) {
        throw new RemoteError('gateway/cancelled', 'Workspace mode change was cancelled', {})
      }
      rejectModeError(error)
    }
  }

  /**
   * Create a server-allocated Workspace for an account, or resolve an owner directory.
   * @param request - directory path to register.
   * @param principal - authenticated account requesting an allocated directory.
   * @returns the Workspace and whether this call created it.
   */
  create(request: WorkspaceCreateRequest, principal?: PrincipalMap['user']): Promise<WorkspaceCreateValue> {
    return this.enqueue(async () => {
      if (principal?.kind === 'user') {
        if (request.path !== undefined) {
          throw new RemoteError('workspace/invalid-path', 'multiuser accounts cannot choose a workspace directory', {
            path: request.path,
          })
        }
        const multiuser = this.ctx.get('multiuser')
        if (multiuser === undefined) {
          throw new RemoteError('gateway/internal', 'multiuser workspace creation is not composed', {})
        }
        const workspace = await multiuser.createUserWorkspace(principal.userId, request.title)
        return { workspace: workspaceView(workspace), created: true }
      }
      if (request.path === undefined) {
        throw new RemoteError('workspace/invalid-path', 'workspace creation requires a directory path', { path: '' })
      }
      try {
        const existing = await this.ctx.workspaceRegistry.resolveByPath(request.path)
        if (existing !== undefined) {
          return { workspace: workspaceView(existing), created: false }
        }
        const workspace = await this.ctx.workspaceRegistry.create(request.path)
        return { workspace: workspaceView(workspace), created: true }
      } catch (error) {
        if (remoteErrorOf(error) !== undefined) throw error
        throw new RemoteError(
          'workspace/invalid-path',
          `cannot create a Workspace at "${request.path}": ${errorMessage(error)}`,
          { path: request.path },
          { cause: error },
        )
      }
    })
  }

  /**
   * Rename one Workspace after serializing title ownership checks.
   * @param request - Workspace identity and proposed title.
   * @param visible - limits title conflict checks to visible workspaces.
   * @returns the updated Workspace projection.
   */
  rename(request: WorkspaceRenameRequest, visible?: (workspaceId: WorkspaceId) => boolean): Promise<WorkspaceValue> {
    const title = request.title.trim()
    if (title === '') {
      return Promise.reject(new RemoteError('gateway/bad-request', 'Workspace rename requires a non-blank title', {}))
    }
    return this.enqueue(async () => {
      const workspace = this.requireWorkspace(request.workspaceId)
      if (title !== workspace.title) {
        if (this.ctx.workspaceRegistry.list().some(candidate =>
          candidate.id !== workspace.id && candidate.title === title
          && (visible?.(candidate.id) ?? true))) {
          throw new RemoteError(
            'workspace/name-conflict',
            `Workspace name '${title}' is already in use`,
            { name: title },
          )
        }
        await workspace.setTitle(title)
      }
      return { workspace: workspaceView(workspace) }
    })
  }

  /**
   * Delete one Workspace registration without deleting its directory or Sessions.
   * @param request - Workspace identity to remove.
   * @returns deletion confirmation.
   */
  delete(request: WorkspaceDeleteRequest): Promise<WorkspaceDeleteValue> {
    return this.enqueue(async () => {
      if (!await this.ctx.workspaceRegistry.delete(WorkspaceId(request.workspaceId))) {
        throw workspaceNotFound(request.workspaceId)
      }
      const multiuser = this.ctx.get('multiuser')
      if (multiuser !== undefined) {
        try {
          await multiuser.forgetWorkspace(WorkspaceId(request.workspaceId))
        } catch (error) {
          this.ctx.logger.warn(`workspace: failed to remove ownership of deleted workspace ${request.workspaceId}: ${String(error)}`)
        }
      }
      return { deleted: true }
    })
  }

  /**
   * Move one Workspace within the durable registry order.
   * @param request - moved Workspace and optional anchor.
   * @param visibility - filters workspace identities returned to the caller.
   * @returns the complete resulting Workspace order.
   */
  async insertBefore(request: WorkspaceInsertBeforeRequest, visibility?: WorkspaceVisibility): Promise<WorkspaceOrderValue> {
    try {
      const workspaceIds = await this.ctx.workspaceRegistry.insertBefore(
        WorkspaceId(request.workspaceId),
        request.beforeWorkspaceId === undefined
          ? undefined
          : WorkspaceId(request.beforeWorkspaceId),
      )
      return {
        workspaceIds: workspaceIds.filter(workspaceId => visibility?.workspace(workspaceId) ?? true),
      }
    } catch (error) {
      if (!(error instanceof WorkspaceOrderInvalidError)) throw error
      throw workspaceNotFound(error.workspaceId)
    }
  }

  /**
   * Move one accounted Session within a Workspace's manual order.
   * @param request - Workspace, Session, and optional anchor identities.
   * @param visibility - filters Session identities returned to the caller.
   * @returns the updated Workspace projection.
   */
  async insertSessionBefore(request: WorkspaceInsertSessionBeforeRequest, visibility?: WorkspaceVisibility): Promise<WorkspaceValue> {
    const workspace = this.requireWorkspace(request.workspaceId)
    try {
      await workspace.insertSessionBefore(request.sessionId, request.beforeSessionId)
    } catch (error) {
      if (!(error instanceof WorkspaceMoveInvalidError)) throw error
      throw new RemoteError(
        'workspace/move-invalid',
        error.message,
        {
          workspaceId: request.workspaceId,
          sessionId: request.sessionId,
          ...request.beforeSessionId === undefined
            ? {}
            : { beforeSessionId: request.beforeSessionId },
        },
        { cause: error },
      )
    }
    return {
      workspace: {
        ...workspaceView(workspace),
        sessionIds: workspace.sessionIds.filter(sessionId => visibility?.session(sessionId) ?? true),
      },
    }
  }

  /**
   * Add one known Session to the registry-global archive set. Without
   * `stopActivity` a Session with running work is refused as
   * `workspace/session-active` with the activity the registry's providers
   * reported; with it, the providers stop that work first.
   * @param request - Session identity to archive and whether to stop its work.
   * @param visibility - filters the returned archive set.
   * @returns the complete resulting archive set.
   */
  async archiveSession(request: WorkspaceArchiveSessionRequest, visibility?: WorkspaceVisibility): Promise<WorkspaceArchiveValue> {
    try {
      await this.ctx.workspaceRegistry.archiveSession(
        request.sessionId,
        request.stopActivity === true ? { stopActivity: true } : {},
      )
    } catch (error) {
      if (error instanceof WorkspaceModeError) throw new RemoteError(error.code, error.code, error.details)
      if (error instanceof WorkspaceUnknownSessionError) {
        throw new RemoteError('session/not-found', error.message, { sessionId: request.sessionId }, { cause: error })
      }
      if (error instanceof WorkspaceActiveSessionError) {
        throw new RemoteError(
          'workspace/session-active',
          error.message,
          { sessionId: request.sessionId, activity: error.activity },
          { cause: error },
        )
      }
      throw error
    }
    return {
      archivedSessionIds: this.ctx.workspaceRegistry.archivedSessionIds.filter(sessionId =>
        visibility?.session(sessionId) ?? true),
    }
  }

  /**
   * Drop one Session from the registry-global archive set. An id that is not
   * archived is not an error: the call is idempotent, so a lost race with
   * another surface resolves as a no-op.
   * @param request - Session identity to unarchive.
   * @param visibility - filters the returned archive set.
   * @returns the complete resulting archive set.
   */
  async unarchiveSession(request: WorkspaceUnarchiveSessionRequest, visibility?: WorkspaceVisibility): Promise<WorkspaceArchiveValue> {
    await this.ctx.workspaceRegistry.unarchiveSession(request.sessionId)
    return {
      archivedSessionIds: this.ctx.workspaceRegistry.archivedSessionIds.filter(sessionId =>
        visibility?.session(sessionId) ?? true),
    }
  }

  /**
   * Add one known unarchived Session to the registry-global pin set.
   * @param request - Session identity to pin.
   * @param visibility - filters the returned pin set.
   * @returns the complete resulting pin set, most recently pinned first.
   */
  async pinSession(request: WorkspacePinSessionRequest, visibility?: WorkspaceVisibility): Promise<WorkspacePinValue> {
    try {
      await this.ctx.workspaceRegistry.pinSession(request.sessionId)
    } catch (error) {
      if (error instanceof WorkspaceUnknownSessionError) {
        throw new RemoteError('session/not-found', error.message, { sessionId: request.sessionId }, { cause: error })
      }
      if (error instanceof WorkspaceArchivedSessionPinError) {
        throw new RemoteError('gateway/bad-request', error.message, {}, { cause: error })
      }
      throw error
    }
    return {
      pinnedSessionIds: this.ctx.workspaceRegistry.pinnedSessionIds.filter(sessionId =>
        visibility?.session(sessionId) ?? true),
    }
  }

  /**
   * Drop one Session from the registry-global pin set. An id that is not
   * pinned is not an error: the call is idempotent, so a lost race with
   * another surface resolves as a no-op.
   * @param request - Session identity to unpin.
   * @param visibility - filters the returned pin set.
   * @returns the complete resulting pin set, most recently pinned first.
   */
  async unpinSession(request: WorkspaceUnpinSessionRequest, visibility?: WorkspaceVisibility): Promise<WorkspacePinValue> {
    await this.ctx.workspaceRegistry.unpinSession(request.sessionId)
    return {
      pinnedSessionIds: this.ctx.workspaceRegistry.pinnedSessionIds.filter(sessionId =>
        visibility?.session(sessionId) ?? true),
    }
  }

  private requireWorkspace(workspaceId: WorkspaceId): Workspace {
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(workspaceId))
    if (workspace === undefined) throw workspaceNotFound(workspaceId)
    return workspace
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function workspaceNotFound(workspaceId: WorkspaceId): RemoteError<'workspace/not-found'> {
  return new RemoteError(
    'workspace/not-found',
    `Workspace "${workspaceId}" not found`,
    { workspaceId },
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function rejectModeError(error: unknown): never {
  if (error instanceof WorkspaceModeError) throw new RemoteError(error.code, error.code, error.details, { cause: error })
  throw error
}
