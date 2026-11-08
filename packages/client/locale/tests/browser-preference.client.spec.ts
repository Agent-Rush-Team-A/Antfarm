// @vitest-environment jsdom
/** Browser preferences remain local when a deployment denies Host settings writes. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { parseBrowserLocaleBootstrap } from '../src/browser-preference.ts'

const storageKey = 'dsh.locale.preference'

async function boot() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  const mutate = vi.fn()
  new TestRemote(ctx, { settings: {
    describe: async () => ({ ok: true, value: { writable: false, hasDocument: false, namespaces: [] } }),
    mutate,
  } })
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber, mutate, locale: ctx.locale }
}

describe('browser locale preference', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('navigator', { language: 'zh-CN', languages: ['zh-CN'] })
    vi.stubGlobal('__DSH_BROWSER_LOCALE__', { storageKey, preference: 'en' })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
    document.documentElement.removeAttribute('lang')
  })

  it('uses the deployment English default and persists a local choice across new page boots', async () => {
    const first = await boot()
    expect(first.locale.getLocale().active).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    first.locale.setLocale('zh')
    expect(localStorage.getItem(storageKey)).toBe('zh')
    expect(document.documentElement.lang).toBe('zh-CN')
    await first.ctx.fiber.dispose()
    const second = await boot()
    expect(second.locale.getLocale().active).toBe('zh')
    expect(first.mutate).not.toHaveBeenCalled()
    expect(second.mutate).not.toHaveBeenCalled()
  })

  it('accepts the login control language and ignores unregistered selections', async () => {
    const fixture = await boot()
    window.dispatchEvent(new CustomEvent('dsh:locale-preference', { detail: 'zh' }))
    expect(fixture.locale.getLocale().active).toBe('zh')
    expect(document.documentElement.lang).toBe('zh-CN')
    window.dispatchEvent(new CustomEvent('dsh:locale-preference', { detail: 'not-a-language' }))
    expect(fixture.locale.getLocale().active).toBe('zh')
    expect(fixture.mutate).not.toHaveBeenCalled()
  })

  it('follows changes from another tab and releases its DOM listeners on unload', async () => {
    const fixture = await boot()
    window.dispatchEvent(new StorageEvent('storage', { key: storageKey, newValue: 'zh' }))
    expect(fixture.locale.getLocale().active).toBe('zh')
    await fixture.fiber.dispose()
    window.dispatchEvent(new CustomEvent('dsh:locale-preference', { detail: 'en' }))
    window.dispatchEvent(new StorageEvent('storage', { key: storageKey, newValue: 'en' }))
    expect(fixture.locale.getLocale().active).toBe('zh')
  })

  it('keeps browser-language behavior when browser persistence is absent', async () => {
    vi.stubGlobal('__DSH_BROWSER_LOCALE__', undefined)
    const fixture = await boot()
    expect(fixture.locale.getLocale().active).toBe('zh')
    expect(localStorage.getItem(storageKey)).toBeNull()
  })

  it('rejects malformed boot data and ignores malformed persisted values', async () => {
    expect(() => parseBrowserLocaleBootstrap({ storageKey: 'credentials', preference: 'en' })).toThrow()
    expect(() => parseBrowserLocaleBootstrap({ storageKey, preference: 'bad locale' })).toThrow()
    localStorage.setItem(storageKey, 'bad locale')
    const fixture = await boot()
    expect(fixture.locale.getLocale().active).toBe('en')
  })
})
