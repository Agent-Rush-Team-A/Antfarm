// @vitest-environment jsdom
/** Account UI behavior before and after the application adopts its browser locale. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MULTIUSER_CLIENT_SCRIPT, MULTIUSER_CLIENT_STYLE } from '../src/client-script.ts'

const storageKey = 'dsh.locale.preference'
const windowListeners: [string, EventListenerOrEventListenerObject][] = []
const documentListeners: [string, EventListenerOrEventListenerObject][] = []

function boot(options: {
  authenticated?: boolean
  guestAccess?: boolean
  browserLocale?: string
  preference?: string | null
  browserPersistence?: boolean
} = {}) {
  vi.stubGlobal('navigator', { language: options.browserLocale ?? 'en-US', languages: [options.browserLocale ?? 'en-US'] })
  vi.stubGlobal('__DSH_MULTIUSER__', {
    authenticated: options.authenticated ?? false, guestAccess: options.guestAccess ?? true, refreshIntervalMs: 60000,
    user: { userId: 'review-guest', username: 'guest-review', guest: true },
  })
  vi.stubGlobal('__DSH_BROWSER_LOCALE__', options.browserPersistence === false ? undefined : { storageKey, preference: options.preference ?? 'en' })
  const script = document.createElement('script')
  script.src = 'http://localhost/auth/client.js'
  vi.spyOn(document, 'currentScript', 'get').mockReturnValue(script)
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
  const style = document.createElement('style')
  style.textContent = MULTIUSER_CLIENT_STYLE
  document.head.append(style)
  new Function(MULTIUSER_CLIENT_SCRIPT)()
}

function selector(): HTMLSelectElement {
  return document.querySelector<HTMLSelectElement>('[data-dsh-account-language]')!
}
function selectLanguage(value: string): void {
  selector().value = value
  selector().dispatchEvent(new Event('change', { bubbles: true }))
}

describe('standalone account presentation', () => {
  beforeEach(() => {
    document.head.innerHTML = ''
    document.body.innerHTML = ''
    document.body.className = ''
    document.body.removeAttribute('data-ds-dark-theme')
    document.documentElement.removeAttribute('data-ds-theme-source')
    document.documentElement.lang = 'en'
    localStorage.clear()
    sessionStorage.clear()
    vi.useFakeTimers()
    vi.stubGlobal('BroadcastChannel', undefined)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
    const addWindowListener = window.addEventListener.bind(window)
    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
      windowListeners.push([type, listener])
      addWindowListener(type, listener, options)
    })
    const addDocumentListener = document.addEventListener.bind(document)
    vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
      documentListeners.push([type, listener])
      addDocumentListener(type, listener, options)
    })
  })

  afterEach(() => {
    window.dispatchEvent(new Event('pagehide'))
    for (const [type, listener] of windowListeners.splice(0)) window.removeEventListener(type, listener)
    for (const [type, listener] of documentListeners.splice(0)) document.removeEventListener(type, listener)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    localStorage.clear()
    sessionStorage.clear()
    document.head.innerHTML = ''
    document.body.innerHTML = ''
    document.body.className = ''
    document.body.removeAttribute('data-ds-dark-theme')
    document.documentElement.removeAttribute('data-ds-theme-source')
    document.documentElement.style.removeProperty('color-scheme')
    document.documentElement.lang = 'en'
  })

  it.each([
    ['en-US', 'Try as a guest →', 'en'],
    ['zh-CN', '游客体验 →', 'zh-CN'],
    ['fr-FR', 'Try as a guest →', 'en'],
  ])('uses the browser locale without a configured preference: %s', (browserLocale, button, lang) => {
    boot({ browserLocale, browserPersistence: false })
    expect(document.getElementById('dsh-guest-submit')!.textContent).toBe(button)
    expect(document.documentElement.lang).toBe(lang)
    expect(document.querySelector('[data-dsh-account-language]')).toBeNull()
  })

  it('starts the competition preview in English while allowing an explicit Chinese preference', () => {
    boot({ browserLocale: 'zh-CN', preference: 'en' })
    expect(document.documentElement.lang).toBe('en')
    expect(selector().getAttribute('aria-label')).toBe('Language')
    selectLanguage('zh')
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(document.title).toBe('Antfarm · 登录')
    expect(selector().getAttribute('aria-label')).toBe('语言')
    expect(localStorage.getItem(storageKey)).toBe('zh')
  })

  it('keeps the chosen language when switching accounts while clearing their persisted views', () => {
    localStorage.setItem('dsh.multiuser.account', 'previous-user')
    localStorage.setItem(storageKey, 'zh')
    localStorage.setItem('dsh.layout.review', 'private-view')
    sessionStorage.setItem('dsh.conversation.review', 'private-draft')
    boot()
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(localStorage.getItem(storageKey)).toBe('zh')
    expect(localStorage.getItem('dsh.layout.review')).toBeNull()
    expect(sessionStorage.getItem('dsh.conversation.review')).toBeNull()
  })

  it('switches all login copy without losing typed credentials or expanding the account form', () => {
    boot()
    const username = document.getElementById('dsh-username') as HTMLInputElement
    const password = document.getElementById('dsh-password') as HTMLInputElement
    username.value = 'reviewer'
    password.value = 'test-password'
    const event = vi.fn()
    window.addEventListener('dsh:locale-preference', event)
    selectLanguage('zh')
    expect(username.value).toBe('reviewer')
    expect(password.value).toBe('test-password')
    expect(document.getElementById('dsh-guest-submit')!.textContent).toBe('游客体验 →')
    expect(document.getElementById('dsh-login-submit')!.textContent).toBe('登录')
    expect(document.querySelector('details')!.open).toBe(false)
    expect(event.mock.calls[0]![0].detail).toBe('zh')
    selectLanguage('en')
    expect(document.getElementById('dsh-guest-submit')!.textContent).toBe('Try as a guest →')
    expect(document.querySelector('h2')!.textContent).toBe('A little help. A lot less busywork.')
  })

  it('posts an empty guest request and translates the retained error on language change', async () => {
    const request = vi.fn(async () => new Response(null, { status: 429 }))
    vi.stubGlobal('fetch', request)
    boot()
    const button = document.getElementById('dsh-guest-submit') as HTMLButtonElement
    button.click()
    expect(button.disabled).toBe(true)
    expect(button.textContent).toBe('Preparing your workspace…')
    await vi.waitFor(() => { expect(button.disabled).toBe(false) })
    expect(request).toHaveBeenCalledWith(expect.any(URL), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(document.getElementById('dsh-guest-error')!.textContent).toBe('Too many attempts. Try again later.')
    selectLanguage('zh')
    expect(document.getElementById('dsh-guest-error')!.textContent).toBe('尝试次数过多，请稍后重试。')
    expect(button.textContent).toBe('游客体验 →')
  })

  it('translates a pending guest request and a subsequent busy response', async () => {
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve })))
    boot()
    const button = document.getElementById('dsh-guest-submit') as HTMLButtonElement
    button.click()
    selectLanguage('zh')
    expect(button.textContent).toBe('正在准备你的工作区…')
    finish(new Response(null, { status: 503 }))
    await vi.waitFor(() => { expect(button.disabled).toBe(false) })
    expect(document.getElementById('dsh-guest-error')!.textContent).toBe('演示暂时繁忙，请稍后重试')
  })

  it('distinguishes capacity exhaustion from a transient busy demo in both languages', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'guest-capacity' }), { status: 503 })))
    boot()
    const button = document.getElementById('dsh-guest-submit') as HTMLButtonElement
    button.click()
    await vi.waitFor(() => { expect(button.disabled).toBe(false) })
    expect(document.getElementById('dsh-guest-error')!.textContent).toBe('The guest demo has reached its capacity. Please contact the demo team.')
    selectLanguage('zh')
    expect(document.getElementById('dsh-guest-error')!.textContent).toBe('游客演示已达到容量上限，请联系演示团队')
  })

  it('keeps language switching usable when browser storage is disabled', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage unavailable') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable') })
    boot()
    selectLanguage('zh')
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(document.getElementById('dsh-guest-submit')!.textContent).toBe('游客体验 →')
  })

  it('opens ordinary sign-in without offering disabled guest access', () => {
    boot({ guestAccess: false })
    expect(document.getElementById('dsh-guest-submit')).toBeNull()
    expect(document.querySelector('details')!.open).toBe(true)
    expect(document.getElementById('dsh-login-form')).not.toBeNull()
  })

  it('keeps the guest badge and sign-out errors aligned with the application language', async () => {
    boot({ authenticated: true })
    const badge = document.querySelector('.dsh-account')!
    const button = badge.querySelector('button')!
    expect(badge.textContent).toContain('Guest workspace')
    document.documentElement.lang = 'zh-CN'
    await Promise.resolve()
    expect(badge.textContent).toContain('游客工作区')
    expect(button.textContent).toBe('退出登录')
    button.click()
    await vi.waitFor(() => { expect(button.disabled).toBe(false) })
    expect(badge.querySelector('[role=alert]')!.textContent).toBe('退出失败，请重试。')
    document.documentElement.lang = 'en'
    await Promise.resolve()
    expect(button.textContent).toBe('Sign out')
    expect(badge.querySelector('[role=alert]')!.textContent).toBe('Sign-out failed. Try again.')
    window.dispatchEvent(new Event('pagehide'))
    document.documentElement.lang = 'zh-CN'
    await Promise.resolve()
    expect(button.textContent).toBe('Sign out')
  })

  it('tracks operating-system theme changes only when the shared preference is system', () => {
    let changed = (): void => {}
    const media = {
      matches: true,
      addEventListener: vi.fn((_type: string, listener: () => void) => { changed = listener }),
      removeEventListener: vi.fn(),
    }
    vi.stubGlobal('matchMedia', () => media)
    document.documentElement.dataset.dsThemeSource = 'system'
    boot()
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(true)
    media.matches = false
    changed()
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(false)
    document.documentElement.dataset.dsThemeSource = 'light'
    media.matches = true
    changed()
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(false)
    window.dispatchEvent(new Event('pagehide'))
    expect(media.removeEventListener).toHaveBeenCalledWith('change', changed)
  })
})
