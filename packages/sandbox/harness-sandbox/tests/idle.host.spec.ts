/** Native candidate discovery and bounded, reloadable idle sweeps over real Runner HTTP. */
import { clearTimeout as clearNativeTimeout, setTimeout as setNativeTimeout } from 'node:timers'
import { expect, onTestFinished, test, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RunnerSandboxStatus, SandboxContainerId } from '../src/index.ts'
import WorkspaceSandbox from '../src/index.ts'
import type { ServerResponse } from 'node:http'
import type { Call } from './fixtures/management.ts'
import * as Idle from '../src/idle.ts'
import { bashFixture } from './fixtures/bash.ts'

const interval = 60_000
const timeout = 1_000

interface Tick {
  timer: ReturnType<typeof setTimeout>
  run: () => void
  cleared: boolean
  fired: boolean
}

function scheduler() {
  const ticks: Tick[] = []
  const waiters = new Map<number, (tick: Tick) => void>()
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
    const timer = setNativeTimeout(callback, delay, ...args)
    if (delay === interval) {
      const tick = { timer, run: () => { callback(...args) }, cleared: false, fired: false }
      ticks.push(tick)
      waiters.get(ticks.length - 1)?.(tick)
      waiters.delete(ticks.length - 1)
    }
    return timer
  })
  vi.spyOn(globalThis, 'clearTimeout').mockImplementation((timer) => {
    const tick = ticks.find(entry => entry.timer === timer)
    if (tick) tick.cleared = true
    clearNativeTimeout(timer)
  })
  onTestFinished(() => { for (const tick of ticks) clearNativeTimeout(tick.timer) })
  return {
    ticks,
    wait: (index: number) => ticks[index] ? Promise.resolve(ticks[index]) : new Promise<Tick>((resolve) => { waiters.set(index, resolve) }),
    fire: (index: number) => {
      const tick = ticks[index]
      if (!tick || tick.fired || tick.cleared) throw new Error('Expected one pending sweep timer')
      clearTimeout(tick.timer)
      tick.fired = true
      tick.run()
    },
  }
}

async function idleFixture() {
  const f = await bashFixture(1000, 10_000)
  let now = 100
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const timers = scheduler()
  const remote = new Map<string, RunnerSandboxStatus>()
  const running = { state: 'running' as const, containerId: brandString<SandboxContainerId>('a'.repeat(64)) }
  const respond = f.control.respond
  f.control.respond = (response, method, call) => {
    if (!call.path?.endsWith('/sandbox')) { respond(response, method, call); return }
    const id = call.path.split('/')[3]!
    if (method === 'PUT') remote.set(id, running)
    if (method === 'DELETE') remote.set(id, { state: 'closed' })
    response.end(JSON.stringify(remote.get(id) ?? { state: 'closed' }))
  }
  const fibers: Array<ReturnType<typeof f.ctx.plugin>> = []
  const stop = async () => { await Promise.all(fibers.splice(0).map(fiber => fiber.dispose())) }
  onTestFinished(stop)
  return {
    ...f, remote, running, timers, stop,
    advance: (milliseconds: number) => { now += milliseconds },
    activity: () => f.ctx.workspaceSandbox.activityForUser(f.alice.user.userId, f.alice.id),
    load: async () => {
      const fiber = f.ctx.plugin(Idle, { idleTimeoutMs: timeout, sweepIntervalMs: interval })
      fibers.push(fiber)
      await fiber
      return fiber
    },
    round: async () => {
      const index = timers.ticks.length
      timers.fire(index - 1)
      await timers.wait(index)
    },
  }
}

type Fixture = Awaited<ReturnType<typeof idleFixture>>

function hold(f: Fixture, method = 'GET', workspaceId = f.alice.id) {
  const entered = Promise.withResolvers<ServerResponse>()
  const respond = f.control.respond
  let captured: { response: ServerResponse; call: Call; method: string | undefined } | undefined
  f.control.respond = (response, current, call) => {
    if (!captured && current === method && call.path?.includes(workspaceId)) {
      captured = { response, call, method: current }
      entered.resolve(response)
    } else respond(response, current, call)
  }
  const release = () => {
    if (captured && !captured.response.writableEnded) respond(captured.response, captured.method, captured.call)
  }
  onTestFinished(release)
  return { entered: entered.promise, release }
}

function whenAborted(signal: AbortSignal) {
  return signal.aborted ? Promise.resolve() : new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

test('startup discovers owned running containers, waits a full idle interval and removes confirmed closed candidates', async () => {
  const f = await idleFixture()
  f.remote.set(f.alice.id, f.running)
  await f.load()
  await f.timers.wait(0)
  expect(f.activity()).toMatchObject({ idleSince: 100, sandbox: f.running })
  expect(f.calls.map(call => call.method)).toEqual(['GET', 'GET'])
  expect(f.ctx.workspaceSandboxState.candidateWorkspaces()).toEqual([f.alice.id])
  f.advance(timeout - 1)
  await f.round()
  expect(f.calls).toHaveLength(2)
  f.advance(1)
  await f.round()
  expect(f.calls.map(call => call.method)).toEqual(['GET', 'GET', 'GET', 'GET', 'DELETE'])
  expect(f.activity()).toMatchObject({ idleSince: null, sandbox: { state: 'closed' } })
  const count = f.calls.length
  await f.round()
  expect(f.calls).toHaveLength(count)
  await f.stop()
  expect(f.timers.ticks.filter(tick => !tick.fired && !tick.cleared)).toHaveLength(0)
})

test('failed discovery retains its candidate and recovery establishes a new full interval without closing in that round', async () => {
  const f = await idleFixture()
  f.remote.set(f.alice.id, f.running)
  const respond = f.control.respond
  let fail = true
  f.control.respond = (response, method, call) => {
    if (fail && method === 'GET' && call.path?.includes(f.alice.id)) {
      fail = false
      response.writeHead(503).end(JSON.stringify({ error: 'docker_unavailable' }))
    } else respond(response, method, call)
  }
  await f.load()
  await f.timers.wait(0)
  expect(f.activity()).toMatchObject({ idleSince: null, sandbox: { state: 'unconfirmed' } })
  expect(f.ctx.workspaceSandboxState.candidateWorkspaces()).toContain(f.alice.id)
  f.advance(timeout * 2)
  await f.round()
  expect(f.activity().idleSince).toBe(100 + timeout * 2)
  expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(0)
  f.advance(timeout - 1)
  await f.round()
  expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(0)
  f.advance(1)
  await f.round()
  expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(1)
})

test('normal message preparation registers a candidate after startup confirmed every workspace closed', async () => {
  const f = await idleFixture()
  await f.load()
  await f.timers.wait(0)
  expect(f.ctx.workspaceSandboxState.candidateWorkspaces()).toEqual([])
  expect((await f.run()).isError).not.toBe(true)
  expect(f.ctx.workspaceSandboxState.candidateWorkspaces()).toContain(f.alice.id)
  const before = f.calls.length
  await f.round()
  expect(f.calls).toHaveLength(before)
  f.advance(timeout)
  await f.round()
  expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(1)
})

test('one slow workspace cannot overlap another sweep or prevent the next workspace from being inspected', async () => {
  const f = await idleFixture()
  f.remote.set(f.alice.id, f.running)
  f.remote.set(f.bob.id, f.running)
  const gate = hold(f, 'GET', f.ctx.workspaceRegistry.list()[0]!.id)
  await f.load()
  try {
    await gate.entered
    f.advance(interval * 4)
    expect(f.timers.ticks).toHaveLength(0)
    expect(f.calls).toHaveLength(1)
    gate.release()
    await f.timers.wait(0)
    expect(f.calls.filter(call => call.method === 'GET')).toHaveLength(2)
    expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(0)
    expect(f.timers.ticks).toHaveLength(1)
  } finally { gate.release(); await f.stop() }
})

test('a failing workspace is retried only once per round while another due workspace closes', async () => {
  const f = await idleFixture()
  f.remote.set(f.bob.id, f.running)
  const respond = f.control.respond
  f.control.respond = (response, method, call) => {
    if (method === 'GET' && call.path?.includes(f.alice.id)) response.writeHead(503).end(JSON.stringify({ error: 'docker_unavailable' }))
    else respond(response, method, call)
  }
  await f.load()
  await f.timers.wait(0)
  f.advance(timeout)
  await f.round()
  expect(f.calls.filter(call => call.method === 'GET' && call.path?.includes(f.alice.id))).toHaveLength(2)
  expect(f.calls.filter(call => call.method === 'DELETE').map(call => call.path)).toEqual([`/v1/workspaces/${f.bob.id}/sandbox`])
  expect(f.activity()).toMatchObject({ idleSince: null, sandbox: { state: 'unconfirmed' } })
})

test('in-flight model work blocks reclamation and its final settlement starts a complete idle interval', async () => {
  const f = await idleFixture()
  f.hold()
  try {
    await f.prompt('held-model')
    await f.load()
    await f.timers.wait(0)
    f.advance(timeout * 2)
    await f.round()
    expect(f.activity()).toMatchObject({ busy: true, requests: 1, idleSince: null })
    expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(0)
    f.release()
    await f.agent.whenIdle()
    expect(f.activity().idleSince).toBe(100 + timeout * 2)
    f.advance(timeout - 1)
    await f.round()
    expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(0)
    f.advance(1)
    await f.round()
    expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(1)
  } finally { f.release(); await f.agent.whenIdle() }
})

test('a short request during an expired GET preserves the new idle interval and cannot be cancelled by the sweep', async () => {
  const f = await idleFixture()
  f.remote.set(f.alice.id, f.running)
  await f.load()
  await f.timers.wait(0)
  f.advance(timeout)
  const gate = hold(f)
  const round = Promise.allSettled([f.round()])
  try {
    await gate.entered
    const cancel = vi.spyOn(f.agent, 'cancel')
    await f.run()
    const current = f.activity()
    gate.release()
    expect(await round).toMatchObject([{ status: 'fulfilled' }])
    expect(cancel).not.toHaveBeenCalled()
    expect(f.activity()).toEqual(current)
    expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(0)
    f.advance(timeout)
    await f.round()
    expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(1)
  } finally { gate.release(); await round }
})

test.each(['starting', 'closing', 'cleanup_required'] as const)('%s is reobserved without PUT or DELETE; recovery starts fresh', async (state) => {
  const f = await idleFixture()
  f.remote.set(f.alice.id, { state })
  await f.load()
  await f.timers.wait(0)
  f.advance(timeout * 2)
  await f.round()
  expect(f.calls.every(call => call.method === 'GET')).toBe(true)
  expect(f.activity()).toMatchObject({ idleSince: null, sandbox: { state: 'unconfirmed' } })
  f.remote.set(f.alice.id, f.running)
  await f.round()
  expect(f.activity().idleSince).toBe(100 + timeout * 2)
  expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(0)
  f.advance(timeout)
  await f.round()
  expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(1)
})

test('a failed DELETE retains the closing barrier and future scans cannot retry the mutation', async () => {
  const f = await idleFixture()
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  f.remote.set(f.alice.id, f.running)
  const respond = f.control.respond
  f.control.respond = (response, method, call) => {
    if (method === 'DELETE') response.writeHead(503).end(JSON.stringify({ error: 'docker_unavailable' }))
    else respond(response, method, call)
  }
  await f.load()
  await f.timers.wait(0)
  f.advance(timeout)
  await f.round()
  expect(f.activity()).toMatchObject({ closing: true, idleSince: null })
  expect(warning).toHaveBeenCalledWith(expect.stringContaining('maintenance required'), expect.anything())
  expect(warning.mock.calls.at(-1)?.[1]).toMatchObject({ workspaceId: f.alice.id, error: { code: 'sandbox/failed' } })
  const count = f.calls.length
  await f.round()
  await f.round()
  expect(f.calls).toHaveLength(count)
  expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(1)
})

test('the warning sink belongs to the reclaimer and excludes other loggers and debug output', async () => {
  const f = await idleFixture()
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const exporters = f.ctx.logger.exporters.size
  await f.load()
  await f.timers.wait(0)
  const logger = f.ctx.logger('sandbox-idle')
  logger.warn('maintenance probe')
  expect(warning).toHaveBeenCalledExactlyOnceWith('maintenance probe')
  f.ctx.logger('another-plugin').warn('unrelated warning')
  logger.debug('debug probe')
  expect(warning).toHaveBeenCalledTimes(1)
  await f.stop()
  expect(f.ctx.logger.exporters.size).toBe(exporters)
  logger.warn('after unload')
  expect(warning).toHaveBeenCalledTimes(1)
})

test('unload keeps the warning sink until an admitted close reports its unknown outcome', async () => {
  const f = await idleFixture()
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const exporters = f.ctx.logger.exporters.size
  f.remote.set(f.alice.id, f.running)
  const observed = vi.spyOn(f.ctx.workspaceSandbox, 'statusForUser')
  await f.load()
  await f.timers.wait(0)
  f.advance(timeout)
  const gate = hold(f, 'DELETE')
  f.timers.fire(0)
  try {
    const response = await gate.entered
    const signal = observed.mock.calls.filter(([, id]) => id === f.alice.id).at(-1)?.[2]
    if (!signal) throw new Error('Expected the admitted close lifetime')
    const stopping = f.stop()
    await whenAborted(signal)
    expect(f.ctx.logger.exporters.size).toBeGreaterThan(exporters)
    response.writeHead(503).end(JSON.stringify({ error: 'sandbox_outcome_unknown' }))
    await stopping
    expect(f.activity()).toMatchObject({ closing: true, idleSince: null })
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('maintenance required'), expect.anything())
    expect(warning.mock.calls.at(-1)?.[1]).toMatchObject({ workspaceId: f.alice.id, error: { details: { outcomeUnknown: true } } })
    expect(f.ctx.logger.exporters.size).toBe(exporters)
    expect(f.timers.ticks.filter(tick => !tick.fired && !tick.cleared)).toHaveLength(0)
    expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(1)
  } finally { gate.release(); await f.stop() }
})

test('manager offline time is excluded and recovery starts a full new interval', async () => {
  const f = await idleFixture()
  f.remote.set(f.alice.id, f.running)
  await f.load()
  await f.timers.wait(0)
  await f.sandboxFiber.dispose()
  const count = f.calls.length
  f.advance(timeout * 3)
  await f.round()
  expect(f.calls).toHaveLength(count)
  expect(f.ctx.workspaceSandboxState.activity(f.alice.id).idleSince).toBeNull()
  await f.ctx.plugin(WorkspaceSandbox, { socketPath: f.socketPath, workspaceRoot: f.workspaceRoot })
  await f.round()
  expect(f.activity().idleSince).toBe(100 + timeout * 3)
  expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(0)
  f.advance(timeout)
  await f.round()
  expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(1)
})

test.each(['disabled', 'unowned'] as const)('%s ownership cannot authorize a scan or retain idle qualification', async (change) => {
  const f = await idleFixture()
  f.remote.set(f.alice.id, f.running)
  await f.load()
  await f.timers.wait(0)
  if (change === 'disabled') await f.ctx.multiuser.disableUser(f.alice.user.userId)
  else await f.ctx.multiuser.forgetWorkspace(f.alice.id)
  f.advance(timeout)
  const count = f.calls.length
  await f.round()
  expect(f.calls).toHaveLength(count)
  expect(f.ctx.workspaceSandboxState.activity(f.alice.id)).toMatchObject({ idleSince: null, sandbox: { state: 'unconfirmed' } })
  expect(f.ctx.workspaceSandboxState.candidateWorkspaces()).toContain(f.alice.id)
})

test('deleting a workspace during discovery removes its history and a late response cannot recreate it', async () => {
  const f = await idleFixture()
  f.remote.set(f.alice.id, f.running)
  const gate = hold(f)
  await f.load()
  try {
    await gate.entered
    f.remote.set(f.alice.id, { state: 'closed' })
    await f.ctx.workspaceRegistry.delete(f.alice.id)
    gate.release()
    await f.timers.wait(0)
    expect(f.ctx.workspaceSandboxState.candidateWorkspaces()).not.toContain(f.alice.id)
    const count = f.calls.length
    await f.round()
    expect(f.calls).toHaveLength(count)
    expect(f.ctx.workspaceRegistry.get(f.alice.id)).toBeUndefined()
    expect(f.ctx.workspaceSandboxState.activity(f.alice.id)).toMatchObject({ revision: 0, idleSince: null })
  } finally { gate.release(); await f.stop() }
})

test('reclaimer reload keeps reliable application history and clears the departing timer', async () => {
  const f = await idleFixture()
  f.remote.set(f.alice.id, f.running)
  await f.load()
  const first = await f.timers.wait(0)
  f.advance(timeout - 1)
  await f.stop()
  expect(first.cleared).toBe(true)
  const count = f.calls.length
  await f.load()
  await f.timers.wait(1)
  expect(f.activity().idleSince).toBe(100)
  expect(f.calls).toHaveLength(count)
  f.advance(1)
  await f.round()
  expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(1)
})

test('an observed replacement generation receives a full interval and keeps its candidate', async () => {
  const f = await idleFixture()
  f.remote.set(f.alice.id, f.running)
  await f.load()
  await f.timers.wait(0)
  const replacement = { state: 'running' as const, containerId: brandString<SandboxContainerId>('b'.repeat(64)) }
  f.remote.set(f.alice.id, replacement)
  f.advance(timeout)
  await f.round()
  expect(f.activity()).toMatchObject({ idleSince: 100 + timeout, sandbox: replacement })
  expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(0)
  expect(f.ctx.workspaceSandboxState.candidateWorkspaces()).toContain(f.alice.id)
  f.advance(timeout)
  await f.round()
  expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(1)
})

test('a departing discovery cannot erase a new scan instance history or candidate', async () => {
  const f = await idleFixture()
  f.remote.set(f.alice.id, f.running)
  const observed = vi.spyOn(f.ctx.workspaceSandbox, 'statusForUser')
  const gate = hold(f)
  const old = await f.load()
  let disposing: Promise<PromiseSettledResult<void>[]> | undefined
  try {
    const response = await gate.entered
    const signal = observed.mock.calls.find(([, id]) => id === f.alice.id)?.[2]
    if (!signal) throw new Error('Expected the departing observation lifetime')
    disposing = Promise.allSettled([old.dispose()])
    await whenAborted(signal)
    f.advance(timeout)
    await f.load()
    await f.timers.wait(0)
    const current = f.activity()
    expect(current.idleSince).toBe(100 + timeout)
    response.end(JSON.stringify({ state: 'closed' }))
    await disposing
    expect(f.activity()).toEqual(current)
    expect(f.ctx.workspaceSandboxState.candidateWorkspaces()).toContain(f.alice.id)
    f.advance(timeout)
    await f.round()
    expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(1)
  } finally { gate.release(); await disposing; await f.stop() }
})

test('unload during discovery prevents late history updates, timers and DELETE', async () => {
  const f = await idleFixture()
  f.remote.set(f.alice.id, f.running)
  const observed = vi.spyOn(f.ctx.workspaceSandbox, 'statusForUser')
  const gate = hold(f)
  await f.load()
  try {
    await gate.entered
    const signal = observed.mock.calls.find(([, id]) => id === f.alice.id)?.[2]
    if (!signal) throw new Error('Expected the production observation lifetime')
    const stopping = f.stop()
    await whenAborted(signal)
    f.advance(timeout * 3)
    gate.release()
    await stopping
    expect(f.activity()).toMatchObject({ idleSince: null, sandbox: { state: 'unconfirmed' } })
    expect(f.timers.ticks).toHaveLength(0)
    expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(0)
  } finally { gate.release(); await f.stop() }
})

test('unload drains an already admitted close without closing another candidate or scheduling again', async () => {
  const f = await idleFixture()
  f.remote.set(f.alice.id, f.running)
  f.remote.set(f.bob.id, f.running)
  const observed = vi.spyOn(f.ctx.workspaceSandbox, 'statusForUser')
  await f.load()
  await f.timers.wait(0)
  f.advance(timeout)
  const firstId = f.ctx.workspaceRegistry.list()[0]!.id
  const otherId = firstId === f.alice.id ? f.bob.id : f.alice.id
  const gate = hold(f, 'DELETE', firstId)
  f.timers.fire(0)
  try {
    await gate.entered
    expect(f.ctx.workspaceSandboxState.activity(firstId).closing).toBe(true)
    const signal = observed.mock.calls.filter(([, id]) => id === firstId).at(-1)?.[2]
    if (!signal) throw new Error('Expected the conditional close lifetime')
    let stopped = false
    const stopping = f.stop().then(() => { stopped = true })
    await whenAborted(signal)
    expect(stopped).toBe(false)
    gate.release()
    await stopping
    expect(f.ctx.workspaceSandboxState.activity(firstId).sandbox).toEqual({ state: 'closed' })
    expect(f.remote.get(otherId)).toEqual(f.running)
    expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(1)
    expect(f.timers.ticks).toHaveLength(1)
  } finally { gate.release(); await f.stop() }
})

test('timing defaults are declared and invalid deployment values fail validation', () => {
  expect(Idle.Config({})).toEqual({ idleTimeoutMs: 1_800_000, sweepIntervalMs: 10_000 })
  expect('default' in Idle).toBe(false)
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => Idle.Config({ idleTimeoutMs: value })).toThrow()
    expect(() => Idle.Config({ sweepIntervalMs: value })).toThrow()
  }
  expect(() => Idle.Config({ sweepIntervalMs: 2_147_483_648 })).toThrow()
})
