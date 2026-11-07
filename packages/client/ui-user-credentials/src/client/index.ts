/** Register the private credential entry independently of global settings access. */
import type { Context } from '@deepseek-ai/cordis'
import credentialRemote from '@deepseek-ai/dsh-api-user-credentials/remote'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { CredentialsLauncher, type CredentialsInjected } from './Credentials.tsx'
import { en, zh } from './locales.ts'

/** Services captured before event handlers run outside the plugin context. */
export const inject = ['remote', 'remoteAccess', 'connection', 'slots', 'locale']

/**
 * Mounts the optional personal-credential API and its browser entry together.
 * @param ctx - Browser context carrying the Remote contribution service.
 * @returns Disposer withdrawing the UI before its Remote namespace.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(credentialRemote)
  const ui = ctx.inject(['remote.userCredentials'], registerUi)
  try { await ui } catch (error) { await ui.dispose(); await unmount(); throw error }
  return async () => { await ui.dispose(); await unmount() }
}

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('userCredentials', { en, zh }), 'user-credentials: dictionaries')
  const remote = ctx.remote.userCredentials
  const connection = (ctx.get('connection') as ConnectionHandle).state
  ctx.remoteAccess.whenAccess('userCredentials/list', () => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'user-credentials', locale: 'userCredentials',
    inject: (): CredentialsInjected => ({
      hooks: { connection },
      list: async (signal) => { const result = await remote.list(signal)
        if (!result.ok) throw result.error
        return result.value
      },
      refreshModels: async (id, force, signal) => {
        const result = await remote.refreshModels({ id, force }, signal)
        if (!result.ok) throw result.error
        return result.value
      },
      create: async (request, signal) => { const result = await remote.create(request, signal)
        if (!result.ok) throw result.error
        return result.value
      },
      replace: async (request, signal) => { const result = await remote.replace(request, signal)
        if (!result.ok) throw result.error
        return result.value
      },
      remove: async (id, signal) => { const result = await remote.delete({ id }, signal); if (!result.ok) throw result.error },
      check: async (id, signal) => { const result = await remote.check({ id }, signal); if (!result.ok) throw result.error },
    }),
  }, CredentialsLauncher)))
}
