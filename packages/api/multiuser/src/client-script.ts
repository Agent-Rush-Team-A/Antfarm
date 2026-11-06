/** Browser helper served at `/auth/client.js` for the multiuser login document and account control. */

/** Product copy and styles for the login document and account badge. */
export const MULTIUSER_CLIENT_STYLE = `
.dsh-account{position:fixed;top:12px;right:12px;z-index:2147483000;display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:999px;background:rgba(28,28,30,.88);color:#fff;font:12px/1.4 system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25)}
.dsh-account button{border:1px solid rgba(255,255,255,.35);border-radius:999px;background:transparent;color:inherit;font:inherit;padding:3px 8px;cursor:pointer}
.dsh-login{min-height:100vh;margin:0;display:grid;place-items:center;background:#101114;color:#f5f5f7;font:14px/1.5 system-ui,sans-serif}
.dsh-login-card{width:min(360px,calc(100vw - 48px));padding:28px;border:1px solid #2c2d33;border-radius:16px;background:#191a1f}
.dsh-login-card h1{margin:0 0 6px;font-size:20px}
.dsh-login-card p{margin:0 0 18px;color:#a4a5ad}
.dsh-login-card label{display:block;margin:12px 0 6px;color:#c9cad1}
.dsh-login-card input{box-sizing:border-box;width:100%;padding:9px 10px;border:1px solid #3a3b43;border-radius:8px;background:#111216;color:#fff;font:inherit}
.dsh-login-card button{width:100%;margin-top:18px;padding:10px;border:0;border-radius:8px;background:#4c8dff;color:#fff;font:inherit;font-weight:600;cursor:pointer}
.dsh-login-card button:disabled{opacity:.6;cursor:default}
.dsh-login-error{min-height:18px;margin-top:10px;color:#ff8a8a}
`

/** Locale-owned copy for the standalone account UI before the application boots. */
const ACCOUNT_COPY = {
  en: {
    signIn: 'Sign in', team: 'Use your team account.', username: 'Username', password: 'Password',
    limited: 'Too many attempts. Try again later.', forbidden: 'This origin is not allowed to sign in.',
    invalid: 'Username or password is incorrect.', unavailable: 'Sign-in request failed. Try again.',
    signOut: 'Sign out', logoutFailed: 'Sign-out failed. Try again.', signedIn: 'Signed in',
  },
  zh: {
    signIn: '登录', team: '使用你的团队账号。', username: '用户名', password: '密码',
    limited: '尝试次数过多，请稍后重试。', forbidden: '不允许从此来源登录。',
    invalid: '用户名或密码错误。', unavailable: '登录请求失败，请重试。',
    signOut: '退出登录', logoutFailed: '退出失败，请重试。', signedIn: '已登录',
  },
} satisfies Record<'en' | 'zh', Record<string, string>>

/** Login document, account controls, and cross-tab authentication refresh. */
export const MULTIUSER_CLIENT_SCRIPT = `(() => {
  'use strict'
  var state = globalThis.__DSH_MULTIUSER__
  // Clear persisted application views before a different account boots.
  try {
    var account = state && state.authenticated ? state.user.userId : ''
    if (localStorage.getItem('dsh.multiuser.account') !== account) {
      for (var storage of [localStorage, sessionStorage]) {
        for (var key of Object.keys(storage)) if (key.startsWith('dsh.')) storage.removeItem(key)
      }
      localStorage.setItem('dsh.multiuser.account', account)
    }
  } catch (failure) { /* Browser storage can be disabled; no stored views can then be read. */ }
  var dictionaries = ${JSON.stringify(ACCOUNT_COPY)}
  var copy = navigator.language.toLowerCase().startsWith('zh') ? dictionaries.zh : dictionaries.en
  var channel
  try { channel = new BroadcastChannel('dsh-multiuser') } catch (failure) { /* focus refresh remains available */ }
  function changed() { if (channel) channel.postMessage('changed') }
  if (channel) channel.addEventListener('message', function () { location.replace('/') })
  if (!state || state.authenticated !== true) {
    var html = ''
      + '<main class="dsh-login-card"><h1>' + copy.signIn + '</h1><p>' + copy.team + '</p>'
      + '<form id="dsh-login-form"><label for="dsh-username">' + copy.username + '</label><input id="dsh-username" name="username" autocomplete="username" required>'
      + '<label for="dsh-password">' + copy.password + '</label><input id="dsh-password" name="password" type="password" autocomplete="current-password" required>'
      + '<button id="dsh-login-submit" type="submit">' + copy.signIn + '</button><div id="dsh-login-error" class="dsh-login-error" role="alert"></div></form></main>'
    document.title = copy.signIn + ' - DeepSeek Harness'
    document.body.className = 'dsh-login'
    document.body.innerHTML = html
    var form = document.getElementById('dsh-login-form')
    var error = document.getElementById('dsh-login-error')
    var submit = document.getElementById('dsh-login-submit')
    form.addEventListener('submit', async function (event) {
      event.preventDefault()
      error.textContent = ''
      submit.disabled = true
      try {
        var response = await fetch('/auth/login', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: form.username.value, password: form.password.value })
        })
        if (response.ok) { changed(); location.replace('/'); return }
        error.textContent = response.status === 429 ? copy.limited : response.status === 403 ? copy.forbidden : copy.invalid
      } catch (failure) { error.textContent = copy.unavailable }
      submit.disabled = false
    })
    return
  }
  async function verifyIdentity() {
    try {
      var response = await fetch('/auth/me', { cache: 'no-store' })
      if (response.status === 401) { location.replace('/'); return }
      if (!response.ok) return
      var current = await response.json()
      if (current.user.userId !== state.user.userId) location.replace('/')
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
    name.textContent = state.user.username
    var button = document.createElement('button')
    button.type = 'button'
    button.textContent = copy.signOut
    var error = document.createElement('span')
    error.setAttribute('role', 'alert')
    button.addEventListener('click', async function () {
      button.disabled = true
      error.textContent = ''
      try {
        var response = await fetch('/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        if (!response.ok) throw new Error('logout rejected')
        changed()
        location.replace('/')
      } catch (failure) {
        error.textContent = copy.logoutFailed
        button.disabled = false
      }
    })
    badge.append(name, button, error)
    document.body.appendChild(badge)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true })
  else mount()
})();
`
