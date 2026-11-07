/** Private ordinary Session reservation, permanent locking, and recovery. */
import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from './types.ts'
import type { WorkspaceEntity } from './entity.ts'
import type { WorkspaceModes } from './modes.ts'
import { WorkspaceModeError } from './mode-errors.ts'
import type { WorkspaceMode, WorkspaceModeOperationOptions } from './mode-types.ts'

/** Trusted creation arguments while the coordinator holds exclusive admission. */
export interface WorkspaceSessionAdmission {
  /** Stable initial identity, reserved before any Session persistence. */
  readonly sessionId: SessionId
  /** Captured mode, retained throughout creation. */
  readonly mode: WorkspaceMode
  /** Whether automatic identity fallback is forbidden. */
  readonly single: boolean
  /** Existing permanent identity must be reused; a missing log cannot be recreated. */
  readonly reuseOnly: boolean
  /** Coordinator-owned lifetime, including runtime withdrawal. */
  readonly signal: AbortSignal
  /** @param id - Replacement identity reserved before a multi-mode fallback creates its log. */
  reserve(id: SessionId): Promise<void>
}

/** Facilities owned by the registry rather than a transient API provider. */
export interface WorkspaceModeSessionsHost {
  /** Read permanent or pending ownership before reserving an identity. */
  owner(id: SessionId): WorkspaceId | undefined
  /**
   * @param id - Identity to inspect.
   * @returns a fresh durable or live header, or undefined for a definite miss.
   */
  header(id: SessionId): Promise<SessionHeader | undefined>
  /**
   * @param id - Pending identity.
   * @returns whether a current lifecycle provider has resumed or taken over it.
   */
  recover(id: SessionId): Promise<boolean>
  /** @param error - Retained internal recovery diagnostic. */
  report(error: unknown): void
}

/** Coordinates ordinary Sessions; subagents keep their existing independent lifecycle. */
export class WorkspaceModeSessions {
  /**
   * @param modes - Registry-owned exclusive coordination.
   * @param host - Fresh persistence and trusted recovery.
   */
  constructor(private readonly modes: WorkspaceModes, private readonly host: WorkspaceModeSessionsHost) {
    modes.registerSessionRecovery(entity => this.recover(entity))
  }

  /**
   * Reserve, create or reuse, attach, and permanently lock one ordinary Session.
   * @param workspaceId - Original Workspace registration.
   * @param requested - Optional identity selected for reuse.
   * @param create - Trusted creation callback; reserve every fallback before writing it.
   * @param options - Captured authority and cancellation.
   * @returns the callback's value only after complete durable attachment and locking.
   */
  async create<T>(workspaceId: WorkspaceId, requested: SessionId | undefined,
    create: (admission: WorkspaceSessionAdmission) => Promise<{ sessionId: SessionId; value: T }>,
    options: WorkspaceModeOperationOptions): Promise<T> {
    return this.modes.exclusive(workspaceId, options, async (entity, signal) => {
      this.modes.assertReady(entity)
      const config = entity.modeConfig
      const single = config.mode.startsWith('single-')
      if (single && config.firstSessionId !== null && requested !== config.firstSessionId) {
        throw new WorkspaceModeError('workspace/session-limit', { workspaceId, firstSessionId: config.firstSessionId })
      }
      const sessionId = requested ?? brandString<SessionId>(`session-${randomUUID()}`)
      const reusingFirst = single && config.firstSessionId === sessionId
      let reserved = sessionId
      if (!reusingFirst) await this.reserve(entity, reserved, config.mode)
      try {
        const result = await create({
          sessionId, mode: config.mode, single, reuseOnly: reusingFirst, signal,
          reserve: async (id) => {
            signal.throwIfAborted()
            options.admit()
            if (id === reserved) return
            if (single) throw new WorkspaceModeError('session/reuse-unavailable', { workspaceId, sessionId })
            await this.reserve(entity, id, config.mode)
            reserved = id
          },
        })
        if (result.sessionId !== reserved) throw new Error('ordinary Session created outside its reserved identity')
        signal.throwIfAborted()
        options.admit()
        await entity.completeSession(reserved, () => {
          signal.throwIfAborted()
          options.admit()
        })
        return result.value
      } catch (error) {
        if (reusingFirst) throw error
        // A failed setup or attachment can leave a log. Only a definite fresh miss releases its reservation.
        let existing: SessionHeader | undefined
        try { existing = await this.host.header(reserved) } catch (inspectionError) {
          this.host.report(inspectionError)
          await this.requireRecovery(entity)
          throw new WorkspaceModeError('workspace/mode-recovery-required', { workspaceId, operation: 'create-session' }, { cause: error })
        }
        if (existing === undefined) {
          await entity.updateMode(record => ({ ...record, modeIntent: undefined, modeOperationState: 'ready' }))
          throw error
        }
        this.host.report(error)
        await this.requireRecovery(entity)
        throw new WorkspaceModeError('workspace/mode-recovery-required', { workspaceId, operation: 'create-session' }, { cause: error })
      }
    })
  }

  /** Reconcile a pending Session through its lifecycle provider.
   * @param entity - Original registration whose pending Session must be reconciled.
   */
  async recover(entity: WorkspaceEntity): Promise<void> {
    const intent = entity.modeRecord().modeIntent
    if (intent?.operation !== 'create-session') return
    const header = await this.host.header(intent.sessionId)
    if (header === undefined) {
      await entity.updateMode(record => ({ ...record, modeIntent: undefined, modeOperationState: 'ready' }))
      return
    }
    if (header.origin === 'subagent' || !await this.host.recover(intent.sessionId)) {
      throw new WorkspaceModeError('workspace/mode-recovery-required', { workspaceId: entity.id, operation: 'create-session' })
    }
    await entity.completeSession(intent.sessionId)
  }

  private async reserve(entity: WorkspaceEntity, sessionId: SessionId, mode: WorkspaceMode): Promise<void> {
    await entity.updateMode((record) => {
      const owner = this.host.owner(sessionId)
      if (owner !== undefined && owner !== entity.id) throw new Error('Session identity belongs to another Workspace')
      return { ...record, modeIntent: { operation: 'create-session', sessionId, mode }, modeOperationState: 'creating-session' }
    })
  }

  private async requireRecovery(entity: WorkspaceEntity): Promise<void> {
    await entity.updateMode(record => ({ ...record, modeOperationState: 'recovery-required' }))
  }
}
