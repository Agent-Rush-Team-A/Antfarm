/** Browser helper served at `/auth/client.js` for the multiuser login document and account control. */

/** Product copy and styles for the login document and account badge. */
export const MULTIUSER_CLIENT_STYLE = `
body{--af-page:var(--dsw-alias-bg-base,#fff);--af-sheet:var(--dsw-alias-bg-layer-1,#fff);--af-soft:var(--dsw-alias-interactive-bg-hover-solid,#f2f3f5);--af-ink:var(--dsw-alias-label-primary,#0f1115);--af-ink-hover:var(--dsw-alias-button-primary-hover,#2e3138);--af-muted:var(--dsw-alias-label-secondary,#5f646b);--af-line:var(--dsw-alias-border-l2,#e4e6ea);--af-on-ink:var(--dsw-alias-label-primary-foreground,#fff);--af-sand:#a35f0b;--af-sand-tint:#f8eedd;--af-soil-1:#f4ead9;--af-soil-2:#ecdcc2;--af-soil-3:#e2cba7;--af-chamber:#fdfaf4;--af-ant:#3a2914;--af-glass:rgba(255,255,255,.62);--af-error:#b42318;--af-font:-apple-system,BlinkMacSystemFont,"Segoe UI Variable Text","Segoe UI",system-ui,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif;--af-mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace}
body[data-ds-dark-theme]{--af-page:var(--dsw-alias-bg-base,#151517);--af-sheet:var(--dsw-alias-bg-layer-1,#1c1c1f);--af-soft:var(--dsw-alias-interactive-bg-hover-solid,#26272b);--af-ink:var(--dsw-alias-label-primary,#f6f7f8);--af-ink-hover:var(--dsw-alias-button-primary-hover,#d9dce0);--af-muted:var(--dsw-alias-label-secondary,#aeb3ba);--af-line:var(--dsw-alias-border-l2,#2d2e33);--af-on-ink:var(--dsw-alias-label-primary-foreground,#0f1115);--af-sand:#f0b45e;--af-sand-tint:#2c2417;--af-soil-1:#221d16;--af-soil-2:#28221a;--af-soil-3:#30291e;--af-chamber:#17161a;--af-ant:#f2d2a0;--af-glass:rgba(255,255,255,.05);--af-error:#ff8a80}
.dsh-account{position:fixed;top:12px;right:16px;z-index:10;display:flex;flex-wrap:wrap;align-items:center;gap:2px;max-width:calc(100vw - 24px);box-sizing:border-box;min-height:34px;padding:2px;border:1px solid var(--af-line);border-radius:10px;background:var(--af-sheet);color:var(--af-ink);font:13px/1.4 var(--af-font);box-shadow:0 1px 2px rgba(15,17,21,.05)}
.dsh-account>span:not([role]){display:inline-flex;align-items:center;gap:7px;padding:0 10px;color:var(--af-ink)}
.dsh-account>span:not([role]):before{content:"";width:7px;height:7px;border-radius:50%;background:var(--af-sand)}
.dsh-account>span[role=alert]:not(:empty){flex-basis:100%;padding:4px 10px 6px;color:var(--af-error);overflow-wrap:anywhere}
.dsh-account>span[role=alert]:empty{display:none}
.dsh-account button{min-height:28px;border:0;border-radius:7px;background:transparent;color:var(--af-muted);font:inherit;padding:0 10px;cursor:pointer}
.dsh-account .dsh-language{border:0;min-height:28px;padding:0 6px}
.dsh-language{border:1px solid var(--af-line);border-radius:8px;background:var(--af-sheet);color:var(--af-ink);font:inherit;padding:0 8px;min-height:34px;cursor:pointer}
.dsh-login{min-height:100vh;margin:0;background:var(--af-page);color:var(--af-ink);font:15px/1.6 var(--af-font);-webkit-font-smoothing:antialiased}
.dsh-login *{box-sizing:border-box}
.dsh-login-shell{width:min(1200px,100%);min-height:100vh;margin:0 auto;padding:24px clamp(20px,5vw,56px) 28px;display:grid;grid-template-rows:auto 1fr auto;gap:clamp(28px,5vh,56px)}
.dsh-login-top{display:flex;align-items:center;justify-content:space-between;gap:16px}
.dsh-login-brand{display:flex;align-items:center;gap:10px;font-size:17px;font-weight:600;letter-spacing:-.01em}
.dsh-login-brand svg{width:28px;height:28px;flex:none}
.dsh-login-main{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.08fr);gap:clamp(36px,6vw,96px);align-items:center}
.dsh-login-copy{max-width:540px}
.dsh-login-copy h1{margin:0;font-size:clamp(46px,6.4vw,80px);line-height:1;font-weight:650;letter-spacing:-.04em}
.dsh-login-copy h1:lang(zh){letter-spacing:.01em;line-height:1.08}
.dsh-login-sub{margin:20px 0 0;max-width:22em;text-wrap:balance;font-size:clamp(19px,1.9vw,23px);line-height:1.4;font-weight:500;letter-spacing:-.012em}
.dsh-login-intro{margin:14px 0 0;max-width:32em;color:var(--af-muted);line-height:1.7;text-wrap:pretty}
.dsh-login-card{margin-top:32px;max-width:400px}
.dsh-guest-access{display:grid;gap:10px}
.dsh-guest-access p{margin:0;font-size:13px;color:var(--af-muted)}
.dsh-login-card button{display:inline-flex;align-items:center;justify-content:center;width:100%;min-height:46px;padding:0 20px;border:1px solid transparent;border-radius:10px;background:var(--af-ink);color:var(--af-on-ink);font:inherit;font-weight:550;cursor:pointer;transition:background .15s}
.dsh-login-card details{margin-top:22px;padding-top:18px;border-top:1px solid var(--af-line)}
.dsh-login-card summary{display:flex;align-items:center;gap:8px;width:max-content;color:var(--af-ink);font-size:14px;cursor:pointer;list-style:none}
.dsh-login-card summary::-webkit-details-marker{display:none}
.dsh-login-card summary:before{content:"";width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform .15s}
.dsh-login-card details[open] summary:before{transform:rotate(45deg) translate(-2px,-1px)}
.dsh-login-card label{display:block;margin:16px 0 6px;color:var(--af-muted);font-size:13px}
.dsh-login-card input{width:100%;min-height:44px;padding:0 13px;border:1px solid var(--af-line);border-radius:10px;background:var(--af-sheet);color:var(--af-ink);font:inherit}
.dsh-login-card input:focus{outline:2px solid var(--af-ink);outline-offset:1px}
.dsh-login-card form button{margin-top:20px}
.dsh-login-card .dsh-secondary{background:var(--af-sheet);color:var(--af-ink);border-color:var(--af-line)}
.dsh-login-card button:disabled{opacity:.6;cursor:wait}
.dsh-login-card button:focus-visible,.dsh-login-card summary:focus-visible,.dsh-language:focus-visible,.dsh-account button:focus-visible{outline:2px solid var(--af-sand);outline-offset:3px}
.dsh-login-card details:first-child{margin-top:0;padding-top:0;border-top:0}
.dsh-login-error{min-height:18px;color:var(--af-error);font-size:13px}
.dsh-login-error:empty{min-height:0}
.dsh-farm{margin:0}
.dsh-farm-glass{position:relative;display:grid;gap:16px;padding:58px 22px 28px;border:1px solid var(--af-line);border-radius:22px;overflow:hidden;background:radial-gradient(color-mix(in srgb,var(--af-ant) 14%,transparent) .8px,transparent 1.2px) 0 0/11px 11px,linear-gradient(180deg,transparent 0 30px,var(--af-soil-1) 30px 40%,var(--af-soil-2) 40% 72%,var(--af-soil-3) 72%);background-color:var(--af-sheet);box-shadow:inset 0 0 0 6px var(--af-glass),inset 0 0 0 7px var(--af-line)}
.dsh-farm-glass:before{content:"";position:absolute;left:7px;right:7px;top:30px;border-top:1px dashed color-mix(in srgb,var(--af-ant) 22%,transparent)}
.dsh-chamber{position:relative;display:flex;align-items:center;min-height:70px;padding:12px 140px 12px 24px;border-radius:999px;background:var(--af-chamber);box-shadow:inset 0 2px 5px rgba(58,41,20,.16),inset 0 -1px 0 rgba(255,255,255,.4)}
.dsh-chamber:nth-child(2){margin-left:10%}
.dsh-chamber:nth-child(3){margin-right:14%}
.dsh-chamber b{display:block;font:500 13px/1.35 var(--af-mono);color:var(--af-ink);overflow-wrap:anywhere}
.dsh-chamber b[data-dsh-account-copy]{font:600 14px/1.35 var(--af-font)}
.dsh-chamber small{display:flex;align-items:center;gap:7px;margin-top:4px;font-size:12.5px;color:var(--af-muted)}
.dsh-chamber small:before{content:"";flex:none;width:7px;height:7px;border-radius:50%;border:1.5px solid var(--af-muted)}
.dsh-chamber[data-state=running] small:before{border-color:var(--af-sand);background:var(--af-sand)}
.dsh-chamber[data-state=done] small:before{border-color:var(--af-ink);background:var(--af-ink)}
.dsh-ants{position:absolute;right:22px;top:50%;width:104px;height:40px;transform:translateY(-50%)}
.dsh-ant{position:absolute;left:0;top:0;width:6px;height:5px;border-radius:50%;background:var(--af-ant);box-shadow:-5px 0 0 -.5px var(--af-ant),-10.5px 0 0 .8px var(--af-ant);offset-path:path("M12 20C26 5 58 4 76 12S104 32 86 35 34 37 12 20Z");offset-rotate:auto;animation:dsh-ant 9s linear infinite}
.dsh-ant:nth-child(2){animation-delay:-4.6s}
.dsh-ant[data-rest]{animation:none;offset-distance:38%}
@keyframes dsh-ant{to{offset-distance:100%}}
.dsh-farm figcaption{margin-top:14px;text-wrap:pretty;font-size:13.5px;line-height:1.6;color:var(--af-muted)}
.dsh-login-facts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr)) auto;gap:20px 28px;align-items:start;padding-top:22px;border-top:1px solid var(--af-line)}
.dsh-login-facts dl{display:contents;margin:0}
.dsh-fact{margin:0}
.dsh-fact dt{font-size:13.5px;font-weight:600}
.dsh-fact dd{margin:3px 0 0;font-size:13px;line-height:1.5;color:var(--af-muted)}
.dsh-login-foot{align-self:end;font-size:12.5px;color:var(--af-muted);white-space:nowrap}
@media(hover:hover){.dsh-login-card button:hover{background:var(--af-ink-hover)}.dsh-login-card .dsh-secondary:hover{background:var(--af-soft)}.dsh-account button:hover{background:var(--af-soft);color:var(--af-ink)}}
.dsh-account.dsh-account-docked{position:static;top:auto;right:auto;bottom:auto;left:auto;max-width:100%;width:100%;display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"name out" "lang lang" "err err";padding:4px}.dsh-account-docked>span:not([role]){grid-area:name;min-height:30px}.dsh-account-docked button{grid-area:out}.dsh-account-docked .dsh-language{grid-area:lang;justify-self:start;margin:0 0 0 4px;color:var(--af-muted)}.dsh-account-docked>span[role=alert]{grid-area:err}
@media(max-width:980px){.dsh-login-main{grid-template-columns:1fr}.dsh-login-copy{max-width:620px}.dsh-farm{max-width:620px}.dsh-login-facts{grid-template-columns:repeat(2,minmax(0,1fr))}.dsh-login-foot{grid-column:1/-1}}
@media(max-width:560px){.dsh-login-shell{padding:16px 16px 24px;gap:28px}.dsh-login-copy h1{font-size:44px}.dsh-login-sub{font-size:18px}.dsh-login-card{margin-top:24px}.dsh-farm-glass{padding:48px 14px 20px;gap:12px}.dsh-chamber{padding:10px 104px 10px 18px;min-height:62px}.dsh-chamber:nth-child(2),.dsh-chamber:nth-child(3){margin:0}.dsh-ants{right:10px;transform:translateY(-50%) scale(.8);transform-origin:right center}.dsh-login-facts{grid-template-columns:1fr;gap:14px}.dsh-account{right:12px;top:12px;font-size:12px}}
@media(pointer:coarse){.dsh-login-card input,.dsh-language{font-size:16px}.dsh-login-card button,.dsh-language,.dsh-account button{min-height:44px}}
@media(prefers-reduced-motion:reduce){.dsh-login-card button,.dsh-login-card summary:before{transition:none}.dsh-ant{animation:none;offset-distance:22%}.dsh-ant:nth-child(2){offset-distance:68%}}
`


/** Locale-owned copy for the standalone account UI before the application boots. */
const ACCOUNT_COPY = {
  en: {
    signIn: 'Sign in', team: 'Use your team account.', username: 'Username', password: 'Password', language: 'Language', english: 'English', chinese: '中文',
    limited: 'Too many attempts. Try again later.', forbidden: 'This origin is not allowed to sign in.', guestCapacity: 'The guest demo has reached its capacity. Please contact the demo team.',
    invalid: 'Username or password is incorrect.', unavailable: 'Sign-in request failed. Try again.',
    brand: 'Antfarm', headline: 'From good to better', positioning: 'A general-purpose agent for every task, built on Vultr secure sandboxes',
    introduction: 'Give it files and a task. It runs commands and edits files inside a sealed sandbox, and the results stay in your workspace.',
    guest: 'Try it as a guest', guestHint: 'No account or API key needed. You get a demo workspace of your own.', guestPending: 'Preparing your workspace…', guestUnavailable: 'The demo is busy. Please try again shortly.',
    account: 'Sign in with an account', connection: 'Models by Vultr Serverless Inference',
    farmRunning: 'Running in its sandbox', farmDone: 'Finished, files kept', farmOwn: 'Your files', farmWaiting: 'Waiting for a task',
    farmCaption: 'Each workspace has its own execution environment. Your inputs and results stay in the workspace.',
    factNetwork: 'No network', factNetworkHint: 'Commands in the sandbox can’t reach the internet.',
    factSystem: 'Read-only system', factSystemHint: 'System files can’t be changed.',
    factLimits: 'Hard limits', factLimitsHint: '1 CPU, 512 MB of memory and 64 processes.',
    factCleanup: 'Cleaned up after use', factCleanupHint: 'The environment is removed. Your files stay.',
    guestIdentity: 'Guest workspace', signOut: 'Sign out', logoutFailed: 'Sign-out failed. Try again.', signedIn: 'Signed in',
  },
  zh: {
    signIn: '登录', team: '使用你的团队账号。', username: '用户名', password: '密码', language: '语言', english: 'English', chinese: '中文',
    limited: '尝试次数过多，请稍后重试。', forbidden: '不允许从此来源登录。', guestCapacity: '游客演示已达到容量上限，请联系演示团队',
    invalid: '用户名或密码错误。', unavailable: '登录请求失败，请重试。',
    brand: 'Antfarm', headline: '从好到更好', positioning: '基于 Vultr 安全沙箱的全场景通用 Agent',
    introduction: '交给它文件和任务。它在密封的沙箱里执行命令、修改文件，成果留在你的工作区。',
    guest: '游客体验', guestHint: '无需账号和模型密钥，为你单独创建演示工作区', guestPending: '正在准备你的工作区…', guestUnavailable: '演示暂时繁忙，请稍后重试',
    account: '使用账号登录', connection: '模型由 Vultr Serverless Inference 提供',
    farmRunning: '正在沙箱中运行', farmDone: '已完成，文件已保留', farmOwn: '你的文件', farmWaiting: '等待任务',
    farmCaption: '每个工作区都有独立的执行环境，输入文件与成果保留在工作区。',
    factNetwork: '断网执行', factNetworkHint: '沙箱里的命令无法访问网络',
    factSystem: '系统只读', factSystemHint: '系统文件无法被修改',
    factLimits: '资源上限', factLimitsHint: '1 个 CPU、512 MB 内存、64 个进程',
    factCleanup: '用完即回收', factCleanupHint: '环境随即销毁，文件留在工作区',
    guestIdentity: '游客工作区', signOut: '退出登录', logoutFailed: '退出失败，请重试。', signedIn: '已登录',
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
    var mark = '<svg viewBox="0 0 28 28" fill="none" aria-hidden="true"><rect x="1.75" y="1.75" width="24.5" height="24.5" rx="7" stroke="currentColor" stroke-width="1.5"/><rect x="6.5" y="8" width="10" height="4.5" rx="2.25" fill="var(--af-sand)"/><rect x="11.5" y="15.5" width="10" height="4.5" rx="2.25" fill="currentColor"/></svg>'
    var farm = '<figure class="dsh-farm"><div class="dsh-farm-glass" aria-hidden="true">'
      + '<div class="dsh-chamber" data-state="running"><div><b>sales.csv → report.md</b><small data-dsh-account-copy="farmRunning">' + copy.farmRunning + '</small></div><span class="dsh-ants"><i class="dsh-ant"></i><i class="dsh-ant"></i></span></div>'
      + '<div class="dsh-chamber" data-state="done"><div><b>brief.md → plan.md</b><small data-dsh-account-copy="farmDone">' + copy.farmDone + '</small></div><span class="dsh-ants"><i class="dsh-ant" data-rest></i></span></div>'
      + '<div class="dsh-chamber" data-state="idle"><div><b data-dsh-account-copy="farmOwn">' + copy.farmOwn + '</b><small data-dsh-account-copy="farmWaiting">' + copy.farmWaiting + '</small></div></div>'
      + '</div><figcaption data-dsh-account-copy="farmCaption">' + copy.farmCaption + '</figcaption></figure>'
    var facts = '<footer class="dsh-login-facts"><dl>' + ['Network', 'System', 'Limits', 'Cleanup'].map(function (key) {
      return '<div class="dsh-fact"><dt data-dsh-account-copy="fact' + key + '">' + copy['fact' + key] + '</dt><dd data-dsh-account-copy="fact' + key + 'Hint">' + copy['fact' + key + 'Hint'] + '</dd></div>'
    }).join('') + '</dl><div class="dsh-login-foot" data-dsh-account-copy="connection">' + copy.connection + '</div></footer>'
    var html = '<main class="dsh-login-shell">'
      + '<header class="dsh-login-top"><div class="dsh-login-brand">' + mark + '<span data-dsh-account-copy="brand">' + copy.brand + '</span></div>' + languageControl('dsh-login-language') + '</header>'
      + '<div class="dsh-login-main"><section class="dsh-login-copy"><h1 data-dsh-account-copy="headline">' + copy.headline + '</h1>'
      + '<p class="dsh-login-sub" data-dsh-account-copy="positioning">' + copy.positioning + '</p><p class="dsh-login-intro" data-dsh-account-copy="introduction">' + copy.introduction + '</p>'
      + '<div class="dsh-login-card">'
      + (guestEnabled ? '<div class="dsh-guest-access"><button id="dsh-guest-submit" type="button" data-dsh-account-copy="guest">' + copy.guest + '</button><p data-dsh-account-copy="guestHint">' + copy.guestHint + '</p><div id="dsh-guest-error" class="dsh-login-error" role="alert"></div></div>' : '')
      + '<details' + (guestEnabled ? '' : ' open') + '><summary data-dsh-account-copy="account">' + copy.account + '</summary>'
      + '<form id="dsh-login-form"><label for="dsh-username" data-dsh-account-copy="username">' + copy.username + '</label><input id="dsh-username" name="username" autocomplete="username" required>'
      + '<label for="dsh-password" data-dsh-account-copy="password">' + copy.password + '</label><input id="dsh-password" name="password" type="password" autocomplete="current-password" required>'
      + '<button id="dsh-login-submit" data-dsh-account-copy="signIn"' + (guestEnabled ? ' class="dsh-secondary"' : '') + ' type="submit">' + copy.signIn + '</button><div id="dsh-login-error" class="dsh-login-error" role="alert"></div></form></details>'
      + '</div></section>' + farm + '</div>' + facts + '</main>'
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
        guestButton.textContent = copy.guest
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
    var dockSelector = '[data-dsh-account-dock]'
    function place() {
      var dock = document.querySelector(dockSelector)
      var parent = dock || document.body
      if (badge.parentNode !== parent) parent.appendChild(badge)
      badge.classList.toggle('dsh-account-docked', dock !== null)
    }
    place()
    var docking = new MutationObserver(function (records) {
      if (badge.isConnected && badge.parentNode !== document.body) return
      if (!badge.isConnected) { place(); return }
      for (var record of records) for (var node of record.addedNodes) {
        if (node.nodeType === 1 && (node.matches(dockSelector) || node.querySelector(dockSelector))) { place(); return }
      }
    })
    docking.observe(document.body, { childList: true, subtree: true })
    bindLanguageControls()
    var updateLanguage = function () { applyCopy(supportedLanguage(document.documentElement.lang) || language) }
    var observer = new MutationObserver(updateLanguage)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    updateLanguage()
    window.addEventListener('pagehide', function () { observer.disconnect(); docking.disconnect() }, { once: true })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true })
  else mount()
})();
`
