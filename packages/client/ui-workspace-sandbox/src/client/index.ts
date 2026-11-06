/** Mount optional Harness management and a workspace-scoped live resource. */
import type { Context } from '@deepseek-ai/cordis'
import sandboxRemote from '@deepseek-ai/dsh-harness-sandbox/remote'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { Config } from '../config.ts'
import { SandboxModel } from './model.ts'
import { parseSandboxAddress } from './address.ts'
export { Config } from '../config.ts'

/** The browser never reaches Runner or Docker directly. */
export const inject = ['remote', 'connection', 'resources']

/** @param ctx - Browser-owned services. @param config - Validated polling cadence. @returns Ordered resource, model and Remote teardown. */
export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(sandboxRemote)
  const ui = ctx.inject(['remote.workspaceSandbox', 'connection', 'resources'], (scope) => {
    const remote = scope.remote.workspaceSandbox
    // Existing management calls settle on the wire; the model discards stale replies.
    const model = new SandboxModel({
      open: (workspaceId, signal) => { signal.throwIfAborted(); return remote.open({ workspaceId }) },
      status: (workspaceId, signal) => { signal.throwIfAborted(); return remote.status({ workspaceId }) },
      close: (workspaceId, signal) => { signal.throwIfAborted(); return remote.close({ workspaceId }) },
    }, (scope.get('connection') as ConnectionHandle).generation, config.pollIntervalMs)
    scope.effect(() => () => model.dispose(), 'workspace sandbox: observations')
    scope.effect(() => scope.resources.register({ protocol: 'workspacesandbox',
      async *open(address, { signal }) {
        const workspaceId = parseSandboxAddress(address)
        if (workspaceId === undefined) {
          yield { ok: false, error: new RemoteError('gateway/bad-request', 'Invalid sandbox resource address', {}) }
          return
        }
        yield* model.watch(workspaceId, signal)
      },
    }), 'workspace sandbox: resource provider')
  })
  try { await ui } catch (error) { await ui.dispose(); await unmount(); throw error }
  return async () => { await ui.dispose(); await unmount() }
}
