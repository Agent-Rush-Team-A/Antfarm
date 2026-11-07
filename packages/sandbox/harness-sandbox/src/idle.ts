/** Application-level idle reclamation through native ownership and conditional sandbox management. */
import { LoggerLevel, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { remoteErrorOf, type UserId } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-api-multiuser'
import type {} from './index.ts'

/** Optional application plugin; one loop belongs to its Cordis lifetime. */
export const name = 'sandbox-idle'
/** Activity history survives management reload; each check resolves the optional current manager. */
export const inject = ['multiuser', 'workspaceRegistry', 'workspaceSandboxState']

/** Trusted deployment timing; neither value is a browser or model parameter. */
export interface Config {
  /** Continuous idle threshold in milliseconds; defaults to 30 minutes. */
  idleTimeoutMs?: number
  /** Delay after a completed sweep in milliseconds; defaults to 10 seconds. */
  sweepIntervalMs?: number
}

/** Positive integer timings; the timer interval fits Node's supported delay range. */
export const Config: Schema<Config, Required<Config>> = Schema.object({
  idleTimeoutMs: Schema.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(1_800_000),
  sweepIntervalMs: Schema.natural().min(1).max(2_147_483_647).default(10_000),
})

/**
 * Discover native candidates, run non-overlapping sweeps and drain admitted management on unload.
 * @param ctx - Application-owned activity, registry and native ownership services.
 * @param config - Validated deployment timings, with defaults applied when fields are omitted.
 */
export function apply(ctx: Context, config: Config): void {
  const settings = Config(config)
  const logger = ctx.logger('sandbox-idle')
  const state = ctx.workspaceSandboxState
  ctx.effect(function* () {
    yield ctx.logger.exporter({
      levels: { default: LoggerLevel.WARN },
      export: (message) => {
        const args: readonly unknown[] = message.args
        if (message.name === logger.name) console.warn(...args)
      },
    })
    const lifetime = new AbortController()
    const stopped = () => lifetime.signal.aborted
    const candidates = new Set(ctx.workspaceRegistry.list()
      .filter(workspace => ctx.multiuser.ownerOfWorkspace(workspace.id) !== undefined).map(workspace => workspace.id))
    let timer: ReturnType<typeof setTimeout> | undefined
    let pending: Promise<void>

    const inspect = async (id: WorkspaceId) => {
      if (stopped()) return
      if (ctx.workspaceRegistry.get(id) === undefined) { candidates.delete(id); return }
      const before = state.activity(id)
      const owner = ctx.multiuser.ownerOfWorkspace(id)
      if (owner === undefined) {
        state.invalidateObservation(id, before.revision)
        logger.warn('sandbox-idle: workspace owner unavailable; candidate retained for maintenance %o', { workspaceId: id })
        return
      }
      // Context-bound service proxies are not provider identities; management checks its own token.
      const manager = ctx.get('workspaceSandbox')
      if (manager === undefined) return
      const userId = brandString<UserId>(owner)
      try {
        const activity = manager.activityForUser(userId, id)
        if (activity.sandbox.state === 'closed') { candidates.delete(id); return }
        if (activity.busy) return
        if (activity.sandbox.state !== 'running' || activity.idleSince === null) {
          const observed = await manager.statusForUser(userId, id, lifetime.signal)
          if (stopped()) return
          if (observed.state === 'cleanup_required') {
            logger.warn('sandbox-idle: workspace cleanup requires maintenance; no automatic close %o', { workspaceId: id })
          }
        } else if (performance.now() - activity.idleSince >= settings.idleTimeoutMs) {
          const result = await manager.closeIfIdleForUser(userId, id, {
            revision: activity.revision, idleSince: activity.idleSince, version: activity.version,
            containerId: activity.sandbox.containerId,
          }, settings.idleTimeoutMs, lifetime.signal)
          if (stopped()) return
          logger.debug('sandbox-idle: conditional close %o', { workspaceId: id, state: result.state })
        }
        if (stopped()) return
        if (ctx.workspaceRegistry.get(id) === undefined || manager.activityForUser(userId, id).sandbox.state === 'closed') {
          candidates.delete(id)
        }
      } catch (error) {
        const closing = state.activity(id).closing
        if (stopped() && !closing) return
        if (!stopped()) state.invalidateObservation(id, before.revision)
        logger.warn(closing
          ? 'sandbox-idle: closure unconfirmed; closing retained; automatic close will not be retried; maintenance required %o'
          : 'sandbox-idle: workspace check failed; candidate retained for a later scan %o', {
          workspaceId: id, error: remoteErrorOf(error) ?? error,
        })
      }
    }

    const sweep = async () => {
      if (stopped()) return
      for (const id of state.candidateWorkspaces()) candidates.add(id)
      for (const id of candidates) {
        if (stopped()) return
        await inspect(id)
      }
      if (stopped()) return
      timer = setTimeout(() => { timer = undefined; pending = sweep() }, settings.sweepIntervalMs)
      timer.unref()
    }
    pending = sweep()
    yield async () => {
      lifetime.abort()
      clearTimeout(timer)
      timer = undefined
      await pending
    }
  })
}
