/** Deterministic clock and Loader observations inside the isolated published Web profile. */
export const inject = ['webServer', 'loader', 'agents', 'multiuser', 'workspaceRegistry', 'workspaceSandboxState']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Built test composition; no product route uses this control. */
export function apply(ctx) {
  const interval = 60_001
  const nativeSet = globalThis.setTimeout
  const nativeClear = globalThis.clearTimeout
  const descriptor = Object.getOwnPropertyDescriptor(performance, 'now')
  let now = 100
  const timers = new Map()
  const waiters = new Map()
  let scheduled = 0
  let cleared = 0
  const wait = count => scheduled >= count ? Promise.resolve() : new Promise(resolve => waiters.set(count, resolve))
  ctx.effect(() => {
    Object.defineProperty(performance, 'now', { configurable: true, value: () => now })
    // Only this scenario's unique sweep delay is controlled; HTTP and cleanup deadlines remain real.
    globalThis.setTimeout = (callback, delay, ...args) => {
      if (delay !== interval) return nativeSet(callback, delay, ...args)
      const timer = nativeSet(() => {}, 2_147_483_647)
      timers.set(timer, () => callback(...args))
      scheduled++
      waiters.get(scheduled)?.()
      waiters.delete(scheduled)
      return timer
    }
    globalThis.clearTimeout = timer => {
      if (timers.delete(timer)) cleared++
      nativeClear(timer)
    }
    return () => {
      globalThis.setTimeout = nativeSet
      globalThis.clearTimeout = nativeClear
      if (descriptor) Object.defineProperty(performance, 'now', descriptor)
      else delete performance.now
      for (const timer of timers.keys()) nativeClear(timer)
    }
  })
  ctx.provide('sandboxIdleTestClock', { ready: true })
  const entry = id => {
    const entries = [...ctx.loader.entries()].filter(item => item.options.id === id)
    if (entries.length !== 1) throw new Error(`Expected exactly one ${id} entry, got ${entries.length}`)
    return entries[0]
  }
  const snapshot = workspaceId => ({ now, scheduled, cleared, timers: timers.size,
    activity: workspaceId ? ctx.workspaceSandboxState.activity(workspaceId) : undefined,
    candidates: ctx.workspaceSandboxState.candidateWorkspaces(),
    registered: ctx.workspaceRegistry.list().map(workspace => ({ id: workspace.id, owner: ctx.multiuser.ownerOfWorkspace(workspace.id) })),
  })
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/__test/sandbox-idle', handler: async (request, response) => {
    try {
      let raw = ''
      for await (const chunk of request) raw += chunk
      const control = JSON.parse(raw)
      if (control.op === 'round') {
        now += control.advance ?? 0
        const clock = Date.now
        if (control.wallJump) Date.now = () => clock() + control.wallJump
        try {
          const pending = [...timers]
          if (pending.length !== 1) throw new Error(`Expected one sweep timer, got ${pending.length}`)
          const count = scheduled + 1
          clearTimeout(pending[0][0])
          pending[0][1]()
          await wait(count)
        } finally { Date.now = clock }
      } else if (control.op === 'ready') await wait(1)
      else if (control.op === 'clock') now += control.advance
      else if (control.op === 'entry') {
        const target = entry(control.id)
        await target.update({ disabled: control.disabled })
        await ctx.loader.await()
        if (!control.disabled && control.id === 'sandbox-idle') await wait(scheduled + (timers.size ? 0 : 1))
      } else if (control.op === 'idle') await ctx.agents.get(control.sessionId).whenIdle()
      else if (control.op === 'disable-user') await ctx.multiuser.disableUser(control.userId)
      else if (control.op === 'forget-owner') await ctx.multiuser.forgetWorkspace(control.workspaceId)
      else if (control.op === 'definition') {
        const target = entry('sandbox-idle')
        const namespace = target.moduleNamespace
        const plugin = ctx.loader.unwrapExports(namespace)
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ defaults: namespace.Config({}), config: target.options.config,
          named: !('default' in namespace) && plugin.apply === namespace.apply, state: target.fiber.state,
          entries: [...ctx.loader.entries()].filter(item => item.options.name === '@deepseek-ai/dsh-harness-sandbox/idle').length }))
        return
      } else if (control.op !== 'state') throw new Error(`Unknown test operation ${control.op}`)
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(snapshot(control.workspaceId)))
    } catch (error) { response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String(error) })) }
  } }))
}
