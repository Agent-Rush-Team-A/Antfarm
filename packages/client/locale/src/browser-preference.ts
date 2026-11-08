/** Opt-in browser locale persistence for deployments without writable Host preferences. */
import { LOCALE_ID_PATTERN } from './locale-settings.ts'

/** Public initialization for one browser page; no credentials belong in this value. */
export interface BrowserLocaleBootstrap {
  /** Browser storage entry shared by the login document and Client locale service. */
  readonly storageKey: string
  /** Deployment default; null delegates to the browser's languages. */
  readonly preference: string | null
}

/**
 * Validate the public browser initialization before reading storage.
 * @param value - Data supplied through the Web index bootstrap.
 * @returns Validated locale settings for the current page.
 */
export function parseBrowserLocaleBootstrap(value: unknown): BrowserLocaleBootstrap {
  if (typeof value !== 'object' || value === null
    || !('storageKey' in value) || typeof value.storageKey !== 'string' || !/^dsh\.[A-Za-z0-9._-]+$/u.test(value.storageKey)
    || !('preference' in value) || (value.preference !== null
      && (typeof value.preference !== 'string' || !LOCALE_ID_PATTERN.test(value.preference)))) {
    throw new TypeError('locale: invalid browser initialization data')
  }
  return { storageKey: value.storageKey, preference: value.preference }
}

/**
 * Read a browser preference; unavailable storage preserves the deployment default.
 * @param settings - Public browser initialization.
 * @returns A valid stored locale id, or undefined.
 */
export function readBrowserLocalePreference(settings: BrowserLocaleBootstrap): string | undefined {
  if (typeof window === 'undefined') return undefined
  let value: string | null
  try { value = window.localStorage.getItem(settings.storageKey) }
  catch (_error) { return undefined }
  return value !== null && LOCALE_ID_PATTERN.test(value) ? value : undefined
}
