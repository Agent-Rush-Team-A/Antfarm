/** Host registration for the browser locale preference. */
import type {} from '@deepseek-ai/dsh-settings'

import type { Volatile, Context } from '@deepseek-ai/cordis'

import z from '@deepseek-ai/schemastery'
import { LOCALE_PREFERENCE_FIELD } from './locale-settings.ts'

import { LocaleSettingsFields } from './locale-settings.ts'
import type {} from '@deepseek-ai/dsh-host-webserver'

export {
  LOCALE_IDS, LOCALE_PREFERENCE_FIELD, LOCALE_SETTINGS_NAMESPACE,
  type BuiltInLocaleId, type LocaleId, type LocaleSettings,
} from './locale-settings.ts'

/** Runtime preferences projected to the browser. */
export interface Config {
  /** Explicit locale; omission follows the browser. */
  preference: Volatile<string | undefined>
  /** Opt-in browser preference entry for deployments that deny Host settings writes. */
  browserPreferenceKey?: string
}

/** Live preferences projected to the browser. */
export const Config = z.object({
  preference: LocaleSettingsFields[LOCALE_PREFERENCE_FIELD].volatile(),
  browserPreferenceKey: z.string().pattern(/^dsh\.[A-Za-z0-9._-]+$/u).required(false),
})

/** Host preferences are consumed through the configuration form projection.
 * @param ctx Plugin context used for optional settings presentation.
 */
export function apply(ctx: Context, config?: Config): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  if (config?.browserPreferenceKey !== undefined) {
    ctx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'global', name: '__DSH_BROWSER_LOCALE__', value: {
        storageKey: config.browserPreferenceKey,
        preference: config.preference.get() ?? null,
      } })
    })
  }
}
