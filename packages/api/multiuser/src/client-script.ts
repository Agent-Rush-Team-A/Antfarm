/** Browser helper served at `/auth/client.js` for the multiuser login document and account control. */

/** Product copy and styles for the login document and account badge. */
export const MULTIUSER_CLIENT_STYLE = `
body{--af-page:var(--dsw-alias-bg-base,#f4f6f5);--af-sheet:var(--dsw-alias-bg-layer-1,#fff);--af-soft:var(--dsw-alias-bg-layer-2,#edf3ef);--af-ink:var(--dsw-alias-label-primary,#182c27);--af-muted:var(--dsw-alias-label-secondary,#62746b);--af-line:var(--dsw-alias-border-l3,#dce6e0);--af-accent:var(--dsw-alias-brand-primary,#167a61);--af-accent-hover:var(--dsw-alias-button-primary-hover,#116b53);--af-on-accent:var(--dsw-alias-label-primary-foreground,#fff);--af-error:#b43a3a}
body[data-ds-dark-theme]{--af-page:var(--dsw-alias-bg-base,#111a16);--af-sheet:var(--dsw-alias-bg-layer-1,#17241d);--af-soft:var(--dsw-alias-bg-layer-2,#1d2e24);--af-ink:var(--dsw-alias-label-primary,#edf5ef);--af-muted:var(--dsw-alias-label-secondary,#b2c6b9);--af-line:var(--dsw-alias-border-l3,#354a3d);--af-accent:var(--dsw-alias-brand-primary,#9bd7b5);--af-accent-hover:var(--dsw-alias-button-primary-hover,#b6e4ca);--af-on-accent:var(--dsw-alias-label-primary-foreground,#12291c);--af-error:#ffaca7}
.dsh-account{position:fixed;top:16px;right:20px;z-index:10;display:flex;flex-wrap:wrap;align-items:center;gap:12px;max-width:calc(100vw - 24px);box-sizing:border-box;padding:8px 12px;border:1px solid var(--af-line);border-radius:10px;background:var(--af-sheet);color:var(--af-ink);font:13px/1.4 system-ui,sans-serif}
.dsh-account>span[role=alert]:not(:empty){flex-basis:100%;color:var(--af-error);overflow-wrap:anywhere}
.dsh-account>span[role=alert]:empty{display:none}
.dsh-account button{border:0;border-left:1px solid var(--af-line);background:transparent;color:var(--af-muted);font:inherit;padding:2px 0 2px 12px;cursor:pointer}
.dsh-language{border:1px solid var(--af-line);border-radius:8px;background:var(--af-sheet);color:var(--af-ink);font:inherit;padding:5px 8px;min-height:32px;cursor:pointer}
.dsh-login-language{align-self:flex-end;margin-bottom:24px}
.dsh-login{min-height:100vh;margin:0;display:grid;place-items:center;background:var(--af-page);color:var(--af-ink);font:14px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei","WenQuanYi Zen Hei",sans-serif}
.dsh-login *{box-sizing:border-box}
.dsh-login-shell{width:min(1120px,calc(100vw - 64px));display:grid;grid-template-columns:1.15fr 1fr;min-height:650px;background:var(--af-sheet);border:1px solid var(--af-line);border-radius:24px;overflow:hidden;box-shadow:0 24px 80px -48px rgba(25,50,40,.28)}
.dsh-login-story{position:relative;padding:48px;display:flex;flex-direction:column;justify-content:space-between;background:#153c30;color:#f4f8f5;overflow:hidden}
.dsh-login-story:after{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(circle at 80% 75%,rgba(82,190,126,.16),transparent 48%)}
.dsh-login-brand{font-size:24px;letter-spacing:-.7px;font-weight:500;display:flex;align-items:center;gap:12px}
.dsh-login-brand>span:first-child{display:grid;place-items:center;width:36px;height:36px;border:1px solid #507463;border-radius:10px;font-size:22px}
.dsh-login-story h1{position:relative;z-index:1;font-size:42px;line-height:1.3;font-weight:500;letter-spacing:-1.3px;margin:0 0 22px;max-width:400px}
.dsh-login-story p{color:#c0d6c9;line-height:1.8;max-width:380px;margin:0}
.dsh-login-pill{display:inline-flex;align-items:center;gap:8px;font-size:12px;letter-spacing:1px;color:#afd9ba;margin-bottom:24px}
.dsh-login-pill:before{content:"";width:6px;height:6px;border-radius:50%;background:#a2d8b3}
.dsh-login-features{position:relative;z-index:1;display:grid;gap:14px;border-top:1px solid #416553;padding-top:24px;font-size:13px;color:#dae9e1}
.dsh-login-feature{display:flex;gap:12px;align-items:center}
.dsh-login-feature span:first-child{display:grid;place-items:center;border:1px solid #537564;width:26px;height:26px;border-radius:8px;font-size:12px;color:#b6d6c0}
.dsh-login-card{padding:48px;display:flex;flex-direction:column;justify-content:center}
.dsh-login-card h2{margin:0 0 10px;font-size:26px;line-height:1.35;font-weight:500;letter-spacing:-.5px}
.dsh-login-card p{margin:0 0 24px;color:var(--af-muted);line-height:1.7}
.dsh-guest-access{padding:22px;border:1px solid var(--af-line);border-radius:14px;background:var(--af-soft);margin-bottom:28px}
.dsh-guest-access p{font-size:13px;margin:10px 0 0}
.dsh-login-card label{display:block;margin:16px 0 7px;color:var(--af-muted);font-size:13px}
.dsh-login-card input{width:100%;padding:12px 13px;border:1px solid var(--af-line);border-radius:9px;background:var(--af-sheet);color:var(--af-ink);font:inherit}
.dsh-login-card input:focus{outline:2px solid var(--af-accent);outline-offset:2px;border-color:var(--af-accent)}
.dsh-login-card button{width:100%;padding:12px 18px;border:1px solid transparent;border-radius:9px;background:var(--af-accent);color:var(--af-on-accent);font:inherit;font-weight:500;cursor:pointer;transition:background .15s}
.dsh-login-card form button{margin-top:22px}
.dsh-login-card .dsh-secondary{background:var(--af-sheet);color:var(--af-ink);border-color:var(--af-line)}
.dsh-login-card button:disabled{opacity:.6;cursor:wait}
.dsh-login-card button:focus-visible,.dsh-login-card summary:focus-visible,.dsh-language:focus-visible,.dsh-account button:focus-visible{outline:2px solid var(--af-accent);outline-offset:4px}
.dsh-login-card summary{color:var(--af-muted);cursor:pointer;font-size:13px}
.dsh-login-error{min-height:18px;margin-top:10px;color:var(--af-error);font-size:13px}
.dsh-login-foot{font-size:12px;color:var(--af-muted);margin-top:28px;display:flex;gap:8px;align-items:center}
.dsh-login-foot:before{content:"";width:6px;height:6px;border-radius:50%;background:var(--af-accent)}
@media(hover:hover){.dsh-login-card button:hover{background:var(--af-accent-hover)}.dsh-login-card .dsh-secondary:hover{background:var(--af-page)}}
@media(max-width:760px){.dsh-login-shell{width:100%;border:0;border-radius:0;min-height:100vh;grid-template-columns:1fr}.dsh-login-story{padding:28px 24px;gap:28px}.dsh-login-story h1{font-size:30px;margin-bottom:12px}.dsh-login-story p{font-size:13px}.dsh-login-features{display:none}.dsh-login-pill{margin-bottom:12px}.dsh-login-brand{font-size:21px}.dsh-login-card{padding:30px 24px}.dsh-login-card h2{font-size:23px}.dsh-account{right:12px;top:12px;font-size:12px;padding:7px 10px}}
@media(pointer:coarse){.dsh-login-card input,.dsh-language{font-size:16px}.dsh-login-card button,.dsh-language,.dsh-account button{min-height:44px}}
@media(prefers-reduced-motion:reduce){.dsh-login-card button{transition:none}}
`


/** Locale-owned copy for the standalone account UI before the application boots. */
const ACCOUNT_COPY = {
  en: {
    signIn: 'Sign in', team: 'Use your team account.', username: 'Username', password: 'Password', language: 'Language', english: 'English', chinese: '中文',
    limited: 'Too many attempts. Try again later.', forbidden: 'This origin is not allowed to sign in.', guestCapacity: 'The guest demo has reached its capacity. Please contact the demo team.',
    invalid: 'Username or password is incorrect.', unavailable: 'Sign-in request failed. Try again.',
    brand: 'Antfarm', headline: 'Real work. A workspace of its own.', introduction: 'Give your agent files and a task. See the work happen in an isolated environment, then keep the results when that environment is gone.', positioning: 'YOUR AI WORKSPACE', featureOne: 'Files stay inside their own workspace', featureTwo: 'Execution environments clean up automatically', featureThree: 'Your results stay ready to download', welcome: 'A little help. A lot less busywork.', accessHint: 'Start with a sample task or bring your own files.', guest: 'Try as a guest', guestHint: 'No account or API key needed. Your demo workspace is separate from other visitors.', guestPending: 'Preparing your workspace…', guestUnavailable: 'The demo is busy. Please try again shortly.', account: 'Already have an account? Sign in', connection: 'Powered by Vultr inference', guestIdentity: 'Guest workspace', signOut: 'Sign out', logoutFailed: 'Sign-out failed. Try again.', signedIn: 'Signed in',
  },
  zh: {
    signIn: '登录', team: '使用你的团队账号。', username: '用户名', password: '密码', language: '语言', english: 'English', chinese: '中文',
    limited: '尝试次数过多，请稍后重试。', forbidden: '不允许从此来源登录。', guestCapacity: '游客演示已达到容量上限，请联系演示团队',
    invalid: '用户名或密码错误。', unavailable: '登录请求失败，请重试。',
    brand: 'Antfarm', headline: '让 AI 完成工作，\n让环境保持隔离', introduction: '交给 AI 一份文件和一个任务。看它在独立环境里执行，把成果留下，再放心继续下一步。', positioning: '你的 AI 工作空间', featureOne: '每个工作区拥有独立的文件', featureTwo: '执行环境按需启动、自动回收', featureThree: '环境回收，成果依然可以下载', welcome: '把繁琐的工作，交给 AI', accessHint: '从一个示例开始，或者上传你自己的文件', guest: '游客体验', guestHint: '无需账号和模型密钥，为你创建独立的演示工作区', guestPending: '正在准备你的工作区…', guestUnavailable: '演示暂时繁忙，请稍后重试', account: '已有账号？登录', connection: '由 Vultr 模型提供支持', guestIdentity: '游客工作区', signOut: '退出登录', logoutFailed: '退出失败，请重试。', signedIn: '已登录',
  },
} satisfies Record<'en' | 'zh', Record<string, string>>

/** Login document, account controls, and cross-tab authentication refresh. */
export const MULTIUSER_CLIENT_SCRIPT = `(() => {
  'use strict'
  var appRoot = new URL('../', document.currentScript.src).href
  var state = globalThis.__DSH_MULTIUSER__
  var localeBoot = globalThis.__DSH_BROWSER_LOCALE__
  var localeStorageKey = localeBoot && typeof localeBoot.storageKey === 'string' && localeBoot.storageKey.length > 0 ? localeBoot.storageKey : undefined
  // Clear persisted application views before a different account boots.
  try {
    var account = state && state.authenticated ? state.user.userId : ''
    if (localStorage.getItem('dsh.multiuser.account') !== account) {
      for (var storage of [localStorage, sessionStorage]) {
        for (var key of Object.keys(storage)) if (key.startsWith('dsh.') && key !== localeStorageKey) storage.removeItem(key)
      }
      localStorage.setItem('dsh.multiuser.account', account)
    }
  } catch (failure) { /* Browser storage can be disabled; no stored views can then be read. */ }
  var dictionaries = ${JSON.stringify(ACCOUNT_COPY)}
  function supportedLanguage(value) {
    if (typeof value !== 'string') return undefined
    var primary = value.toLowerCase().split('-')[0]
    return primary === 'en' || primary === 'zh' ? primary : undefined
  }
  var savedLanguage
  try { if (localeStorageKey) savedLanguage = supportedLanguage(localStorage.getItem(localeStorageKey)) } catch (failure) { /* The in-page language choice still works without browser storage. */ }
  var browserLanguage = (navigator.languages || [navigator.language]).map(supportedLanguage).find(Boolean)
  var language = savedLanguage || supportedLanguage(localeBoot && localeBoot.preference) || browserLanguage || 'en'
  var copy = dictionaries[language]
  function applyCopy(next) {
    language = next
    copy = dictionaries[next]
    if (!state || state.authenticated !== true) {
      document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en'
      document.title = copy.brand + ' · ' + copy.signIn
    }
    for (var element of document.querySelectorAll('[data-dsh-account-copy]')) {
      element.textContent = copy[element.getAttribute('data-dsh-account-copy')] + (element.getAttribute('data-dsh-account-suffix') || '')
    }
    for (var select of document.querySelectorAll('[data-dsh-account-language]')) {
      select.value = next
      select.setAttribute('aria-label', copy.language)
    }
  }
  function languageControl(extraClass) {
    if (!localeStorageKey) return ''
    return '<select class="dsh-language ' + extraClass + '" data-dsh-account-language aria-label="' + copy.language + '"><option value="en" data-dsh-account-copy="english">' + copy.english + '</option><option value="zh" data-dsh-account-copy="chinese">' + copy.chinese + '</option></select>'
  }
  function bindLanguageControls() {
    for (var select of document.querySelectorAll('[data-dsh-account-language]')) select.addEventListener('change', function (event) {
      var next = supportedLanguage(event.currentTarget.value)
      if (!next) return
      try { if (localeStorageKey) localStorage.setItem(localeStorageKey, next) } catch (failure) { /* Storage is optional; keep the live selection usable. */ }
      applyCopy(next)
      window.dispatchEvent(new CustomEvent('dsh:locale-preference', { detail: next }))
    })
    applyCopy(language)
  }
  function showProblem(element, key) {
    if (key) element.setAttribute('data-dsh-account-copy', key)
    else element.removeAttribute('data-dsh-account-copy')
    element.textContent = key ? copy[key] : ''
  }
  var channel
  try { channel = new BroadcastChannel('dsh-multiuser') } catch (failure) { /* focus refresh remains available */ }
  function changed() { if (channel) channel.postMessage('changed') }
  if (channel) channel.addEventListener('message', function () { location.replace(appRoot) })
  if (!state || state.authenticated !== true) {
    var media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined
    if (media) {
      var syncTheme = function () {
        if (document.documentElement.dataset.dsThemeSource !== 'system') return
        document.body.toggleAttribute('data-ds-dark-theme', media.matches)
        document.documentElement.style.colorScheme = media.matches ? 'dark' : 'light'
      }
      media.addEventListener('change', syncTheme)
      window.addEventListener('pagehide', function () { media.removeEventListener('change', syncTheme) }, { once: true })
      syncTheme()
    }
    var guestEnabled = state && state.guestAccess === true
    var html = '<main class="dsh-login-shell">'
      + '<aside class="dsh-login-story"><div class="dsh-login-brand"><span aria-hidden="true">a</span><span data-dsh-account-copy="brand">' + copy.brand + '</span></div>'
      + '<div><div class="dsh-login-pill" data-dsh-account-copy="positioning">' + copy.positioning + '</div><h1 data-dsh-account-copy="headline">' + copy.headline + '</h1><p data-dsh-account-copy="introduction">' + copy.introduction + '</p></div>'
      + '<div class="dsh-login-features">' + ['featureOne', 'featureTwo', 'featureThree'].map(function (key, i) { return '<div class="dsh-login-feature"><span>' + (i + 1) + '</span><span data-dsh-account-copy="' + key + '">' + copy[key] + '</span></div>' }).join('') + '</div></aside>'
      + '<section class="dsh-login-card">' + languageControl('dsh-login-language') + '<h2 data-dsh-account-copy="welcome">' + copy.welcome + '</h2><p data-dsh-account-copy="accessHint">' + copy.accessHint + '</p>'
      + (guestEnabled ? '<div class="dsh-guest-access"><button id="dsh-guest-submit" type="button" data-dsh-account-copy="guest" data-dsh-account-suffix=" →">' + copy.guest + ' →</button><p data-dsh-account-copy="guestHint">' + copy.guestHint + '</p><div id="dsh-guest-error" class="dsh-login-error" role="alert"></div></div>' : '')
      + '<details' + (guestEnabled ? '' : ' open') + '><summary data-dsh-account-copy="account">' + copy.account + '</summary>'
      + '<form id="dsh-login-form"><label for="dsh-username" data-dsh-account-copy="username">' + copy.username + '</label><input id="dsh-username" name="username" autocomplete="username" required>'
      + '<label for="dsh-password" data-dsh-account-copy="password">' + copy.password + '</label><input id="dsh-password" name="password" type="password" autocomplete="current-password" required>'
      + '<button id="dsh-login-submit" data-dsh-account-copy="signIn"' + (guestEnabled ? ' class="dsh-secondary"' : '') + ' type="submit">' + copy.signIn + '</button><div id="dsh-login-error" class="dsh-login-error" role="alert"></div></form></details>'
      + '<div class="dsh-login-foot" data-dsh-account-copy="connection">' + copy.connection + '</div></section></main>'
    document.title = copy.brand + ' · ' + copy.signIn
    document.body.className = 'dsh-login'
    document.body.innerHTML = html
    bindLanguageControls()
    if (guestEnabled) {
      var guestButton = document.getElementById('dsh-guest-submit')
      var guestError = document.getElementById('dsh-guest-error')
      guestButton.addEventListener('click', async function () {
        guestButton.disabled = true
        guestButton.setAttribute('data-dsh-account-copy', 'guestPending')
        guestButton.removeAttribute('data-dsh-account-suffix')
        guestButton.textContent = copy.guestPending
        showProblem(guestError)
        try {
          var response = await fetch(new URL('auth/guest', appRoot), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          if (response.ok) { changed(); location.replace(appRoot); return }
          var refusal
          if (response.status === 503) {
            try { refusal = await response.json() } catch (failure) { /* Proxy failures may not include the API's JSON refusal. */ }
          }
          showProblem(guestError, response.status === 429 ? 'limited' : refusal && refusal.error === 'guest-capacity' ? 'guestCapacity' : 'guestUnavailable')
        } catch (failure) { showProblem(guestError, 'unavailable') }
        guestButton.disabled = false
        guestButton.setAttribute('data-dsh-account-copy', 'guest')
        guestButton.setAttribute('data-dsh-account-suffix', ' →')
        guestButton.textContent = copy.guest + ' →'
      })
    }
    var form = document.getElementById('dsh-login-form')
    var error = document.getElementById('dsh-login-error')
    var submit = document.getElementById('dsh-login-submit')
    form.addEventListener('submit', async function (event) {
      event.preventDefault()
      showProblem(error)
      submit.disabled = true
      try {
        var response = await fetch(new URL('auth/login', appRoot), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: form.username.value, password: form.password.value })
        })
        if (response.ok) { changed(); location.replace(appRoot); return }
        showProblem(error, response.status === 429 ? 'limited' : response.status === 403 ? 'forbidden' : 'invalid')
      } catch (failure) { showProblem(error, 'unavailable') }
      submit.disabled = false
    })
    return
  }
  async function verifyIdentity() {
    try {
      var response = await fetch(new URL('auth/me', appRoot), { cache: 'no-store' })
      if (response.status === 401) { location.replace(appRoot); return }
      if (!response.ok) return
      var current = await response.json()
      if (current.user.userId !== state.user.userId) location.replace(appRoot)
    } catch (failure) { /* A network failure does not assert that the login was revoked. */ }
  }
  window.addEventListener('focus', verifyIdentity)
  document.addEventListener('visibilitychange', function () { if (!document.hidden) verifyIdentity() })
  var timer = setInterval(verifyIdentity, state.refreshIntervalMs)
  window.addEventListener('pagehide', function () { clearInterval(timer); if (channel) channel.close() }, { once: true })
  function mount() {
    var badge = document.createElement('div')
    badge.className = 'dsh-account'
    var name = document.createElement('span')
    name.textContent = state.user.guest === true ? copy.guestIdentity : state.user.username
    if (state.user.guest === true) name.setAttribute('data-dsh-account-copy', 'guestIdentity')
    var button = document.createElement('button')
    button.type = 'button'
    button.textContent = copy.signOut
    button.setAttribute('data-dsh-account-copy', 'signOut')
    var error = document.createElement('span')
    error.setAttribute('role', 'alert')
    button.addEventListener('click', async function () {
      button.disabled = true
      showProblem(error)
      try {
        var response = await fetch(new URL('auth/logout', appRoot), {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
        })
        if (!response.ok) throw new Error('logout rejected')
        changed()
        location.replace(appRoot)
      } catch (failure) {
        showProblem(error, 'logoutFailed')
        button.disabled = false
      }
    })
    badge.innerHTML = languageControl('')
    badge.append(name, button, error)
    document.body.appendChild(badge)
    bindLanguageControls()
    var updateLanguage = function () { applyCopy(supportedLanguage(document.documentElement.lang) || language) }
    var observer = new MutationObserver(updateLanguage)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    updateLanguage()
    window.addEventListener('pagehide', function () { observer.disconnect() }, { once: true })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true })
  else mount()
})();
`
