/** Conditional close admission through real workspaces, message permits and controlled Runner HTTP. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ServerResponse } from 'node:http'
import { expect, onTestFinished, test, vi } from 'vitest'
import WorkspaceSandbox, { type SandboxIdleCloseTarget } from '../src/index.ts'
import { fixture, running } from './fixtures/management.ts'
import { bashFixture } from './fixtures/bash.ts'

const idleTimeoutMs = 1_800_000
type Fixture = Awaited<ReturnType<typeof fixture>>

function clock() {
  let now = 100
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  return (elapsed: number) => { now = 100 + elapsed }
}

function target(f: Fixture): SandboxIdleCloseTarget {
  const current = f.ctx.workspaceSandbox.activityForUser(f.alice.user.userId, f.alice.id)
  if (current.idleSince === null || current.sandbox.state !== 'running') throw new Error('Expected a running idle test workspace')
  return { revision: current.revision, idleSince: current.idleSince, version: current.version, containerId: current.sandbox.containerId }
}

function close(f: Fixture, observed: SandboxIdleCloseTarget, signal = new AbortController().signal) {
  return f.ctx.workspaceSandbox.closeIfIdleForUser(f.alice.user.userId, f.alice.id, observed, idleTimeoutMs, signal)
}

function holdGet(f: Fixture, ordinal = 1) {
  const entered = Promise.withResolvers<ServerResponse>()
  const respond = f.control.respond
  let queries = 0
  let held: ServerResponse | undefined
  f.control.respond = (response, method, call) => {
    if (method === 'GET' && call.path?.endsWith('/sandbox') && ++queries === ordinal) {
      held = response
      entered.resolve(response)
    } else respond(response, method, call)
  }
  const release = (value: unknown = running) => { if (held !== undefined && !held.writableEnded) held.end(JSON.stringify(value)) }
  onTestFinished(() => { release() })
  return { entered: entered.promise, release }
}

test('an expired idle observation closes its original container while retaining workspace files and session', async () => {
  const f = await bashFixture()
  const advance = clock()
  await f.run()
  const original = target(f)
  const marker = join(f.alice.workspace.path, 'idle-close-marker.txt')
  await writeFile(marker, 'retained')
  const before = f.calls.length
  advance(idleTimeoutMs)
  await expect(f.ctx.workspaceSandbox.closeIfIdleForUser(f.alice.user.userId, f.alice.id, original,
    idleTimeoutMs, new AbortController().signal)).resolves.toEqual({ state: 'closed' })
  expect(f.calls.slice(before).map(call => call.method)).toEqual(['GET', 'GET', 'DELETE'])
  expect(await readFile(marker, 'utf8')).toBe('retained')
  expect(f.ctx.workspaceRegistry.get(f.alice.id)?.sessionIds).toContain(f.agent.id)
  expect(f.ctx.workspaceSandboxState.activity(f.alice.id)).toMatchObject({ sandbox: { state: 'closed' }, idleSince: null,
    version: original.version + 1 })
})

test.each([0, idleTimeoutMs - 1])('idle elapsed %s cannot revoke work or query Runner, including after a wall-clock jump', async (elapsed) => {
  const f = await bashFixture()
  const advance = clock()
  await f.run()
  const original = target(f)
  const before = f.calls.length
  const cancel = vi.spyOn(f.agent, 'cancel')
  const revoke = vi.spyOn(f.ctx.workspaceSandboxState.permits, 'revokeWorkspace')
  vi.spyOn(Date, 'now').mockReturnValue(1)
  advance(elapsed)
  await expect(close(f, original)).resolves.toEqual({ state: 'skipped' })
  expect(target(f)).toEqual(original)
  expect(f.calls).toHaveLength(before)
  expect(cancel).not.toHaveBeenCalled()
  expect(revoke).not.toHaveBeenCalled()
})

test('an already stopped scan skips without querying or revoking input', async () => {
  const f = await bashFixture()
  const advance = clock()
  await f.run()
  const original = target(f)
  const before = f.calls.length
  const cancel = vi.spyOn(f.agent, 'cancel')
  const lifetime = new AbortController()
  lifetime.abort()
  advance(idleTimeoutMs)
  await expect(close(f, original, lifetime.signal)).resolves.toEqual({ state: 'skipped' })
  expect(f.calls).toHaveLength(before)
  expect(cancel).not.toHaveBeenCalled()
})

test('work admitted before conditional close makes it skip before a Runner query', async () => {
  const f = await bashFixture()
  const advance = clock()
  await f.run()
  const original = target(f)
  advance(idleTimeoutMs)
  f.hold()
  try {
    await f.prompt('admitted-first')
    const before = f.calls.length
    const cancel = vi.spyOn(f.agent, 'cancel')
    await expect(close(f, original)).resolves.toEqual({ state: 'skipped' })
    expect(f.calls).toHaveLength(before)
    expect(cancel).not.toHaveBeenCalled()
    expect(f.ctx.workspaceSandboxState.activity(f.alice.id)).toMatchObject({ requests: 1, closing: false })
  } finally { f.release(); await f.agent.whenIdle() }
})

test.each(['active', 'finished'] as const)('new work %s during GET makes the old close skip without cancellation', async (work) => {
  // These gates intentionally span a real prompt and model/tool settlement, rather than testing a query deadline.
  const f = await bashFixture(1000, 10_000)
  const advance = clock()
  await f.run()
  const original = target(f)
  advance(idleTimeoutMs)
  const gate = holdGet(f)
  const pending = Promise.allSettled([close(f, original)])
  try {
    await gate.entered
    const cancel = vi.spyOn(f.agent, 'cancel')
    if (work === 'active') { f.hold(); await f.prompt('during-get') }
    else await f.run()
    const current = f.ctx.workspaceSandboxState.activity(f.alice.id)
    gate.release()
    expect(await pending).toMatchObject([{ status: 'fulfilled', value: { state: 'skipped' } }])
    expect(cancel).not.toHaveBeenCalled()
    expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(0)
    expect(f.ctx.workspaceSandboxState.activity(f.alice.id)).toEqual(current)
    if (work === 'active') expect(current).toMatchObject({ requests: 1, closing: false })
    else expect(current).toMatchObject({ busy: false, idleSince: 100 + idleTimeoutMs })
  } finally { gate.release(); f.release(); await pending; await f.agent.whenIdle() }
})

test('the admitted close barrier rejects new messages and outlives the scan that admitted it', async () => {
  const f = await bashFixture(1000, 10_000)
  const advance = clock()
  await f.run()
  const original = target(f)
  advance(idleTimeoutMs)
  const lifetime = new AbortController()
  const gate = holdGet(f, 2)
  const pending = Promise.allSettled([close(f, original, lifetime.signal)])
  try {
    await gate.entered
    expect(f.ctx.workspaceSandboxState.activity(f.alice.id)).toMatchObject({ closing: true, version: original.version + 1 })
    const puts = f.calls.filter(call => call.method === 'PUT').length
    await expect(f.prompt('after-barrier')).rejects.toMatchObject({ code: 'gateway/cancelled' })
    lifetime.abort()
    gate.release()
    expect(await pending).toMatchObject([{ status: 'fulfilled', value: { state: 'closed' } }])
    await expect(f.prompt('after-barrier')).rejects.toMatchObject({ code: 'gateway/cancelled' })
    expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(puts)
    expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(1)
    await f.run()
    expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(puts + 1)
  } finally { gate.release(); await pending }
})

test('stopping a scan during its first GET cannot admit a late close', async () => {
  const f = await fixture(1000, false, 1000, 10_000)
  const advance = clock()
  await f.ctx.workspaceSandbox.openForUser(f.alice.user.userId, f.alice.id)
  const original = target(f)
  advance(idleTimeoutMs)
  const lifetime = new AbortController()
  const gate = holdGet(f)
  const pending = Promise.allSettled([close(f, original, lifetime.signal)])
  try {
    await gate.entered
    lifetime.abort()
    gate.release()
    expect(await pending).toMatchObject([{ status: 'fulfilled', value: { state: 'skipped' } }])
    expect(target(f)).toEqual(original)
    expect(f.calls.map(call => call.method)).toEqual(['PUT', 'GET'])
  } finally { gate.release(); await pending }
})

test.each(['closed', 'starting', 'cleanup_required', 'replacement'] as const)('a fresh %s observation skips before revocation', async (state) => {
  const f = await bashFixture()
  const advance = clock()
  await f.run()
  const original = target(f)
  const cancel = vi.spyOn(f.agent, 'cancel')
  f.control.respond = (response) => {
    response.end(JSON.stringify(state === 'replacement' ? { state: 'running', containerId: 'b'.repeat(64) } : { state }))
  }
  advance(idleTimeoutMs)
  await expect(close(f, original)).resolves.toEqual({ state: 'skipped' })
  expect(cancel).not.toHaveBeenCalled()
  expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(0)
  expect(f.ctx.workspaceSandboxState.activity(f.alice.id)).toMatchObject({ closing: false, version: original.version })
})

test('a failed preflight GET preserves the Runner failure without cancelling work', async () => {
  const f = await bashFixture()
  const advance = clock()
  await f.run()
  const original = target(f)
  const cancel = vi.spyOn(f.agent, 'cancel')
  f.control.respond = (response) => { response.writeHead(503).end(JSON.stringify({ error: 'docker_unavailable' })) }
  advance(idleTimeoutMs)
  await expect(close(f, original)).rejects.toMatchObject({ code: 'sandbox/failed' })
  expect(cancel).not.toHaveBeenCalled()
  expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(0)
  expect(f.ctx.workspaceSandboxState.activity(f.alice.id)).toMatchObject({ idleSince: null, closing: false })
})

test('a manual close and reopen during GET cannot reuse the old idle target', async () => {
  const f = await fixture(1000, false, 1000, 10_000)
  const advance = clock()
  await f.ctx.workspaceSandbox.openForUser(f.alice.user.userId, f.alice.id)
  const original = target(f)
  advance(idleTimeoutMs)
  const gate = holdGet(f)
  const pending = Promise.allSettled([close(f, original)])
  try {
    await gate.entered
    await f.ctx.workspaceSandbox.closeForUser(f.alice.user.userId, f.alice.id)
    const respond = f.control.respond
    f.control.respond = (response, method, call) => {
      if (method === 'PUT') response.end(JSON.stringify({ state: 'running', containerId: 'b'.repeat(64) }))
      else respond(response, method, call)
    }
    await f.ctx.workspaceSandbox.openForUser(f.alice.user.userId, f.alice.id)
    const current = target(f)
    gate.release()
    expect(await pending).toMatchObject([{ status: 'fulfilled', value: { state: 'skipped' } }])
    expect(target(f)).toEqual(current)
    expect(current.containerId).not.toBe(original.containerId)
    expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(1)
  } finally { gate.release(); await pending }
})

test('replaced management rejects its pending and future idle closes without touching the new generation', async () => {
  const f = await fixture(1000, false, 1000, 10_000)
  const advance = clock()
  const manager = f.ctx.workspaceSandbox
  await manager.openForUser(f.alice.user.userId, f.alice.id)
  const original = target(f)
  advance(idleTimeoutMs)
  const gate = holdGet(f)
  const pending = Promise.allSettled([close(f, original)])
  try {
    await gate.entered
    await f.sandboxFiber.dispose()
    await f.ctx.plugin(WorkspaceSandbox, { socketPath: f.socketPath, workspaceRoot: f.workspaceRoot })
    await f.ctx.workspaceSandbox.statusForUser(f.alice.user.userId, f.alice.id)
    const current = target(f)
    gate.release()
    expect(await pending).toMatchObject([{ status: 'rejected', reason: { code: 'sandbox/failed' } }])
    await expect(manager.closeIfIdleForUser(f.alice.user.userId, f.alice.id, original,
      idleTimeoutMs, new AbortController().signal)).rejects.toMatchObject({ code: 'sandbox/failed' })
    expect(target(f)).toEqual(current)
    expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(0)
  } finally { gate.release(); await pending }
})

test.each(['disabled', 'deleted'] as const)('authorization becoming %s during GET is rechecked before close admission', async (change) => {
  const f = await fixture(1000, false, 1000, 10_000)
  const advance = clock()
  await f.ctx.workspaceSandbox.openForUser(f.alice.user.userId, f.alice.id)
  const original = target(f)
  advance(idleTimeoutMs)
  const gate = holdGet(f)
  const pending = Promise.allSettled([close(f, original)])
  try {
    await gate.entered
    if (change === 'disabled') await f.ctx.multiuser.disableUser(f.alice.user.userId)
    else {
      const respond = f.control.respond
      f.control.respond = (response, method, call) => {
        if (method === 'GET') response.end(JSON.stringify({ state: 'closed' }))
        else respond(response, method, call)
      }
      await f.ctx.workspaceRegistry.delete(f.alice.id)
    }
    gate.release()
    expect(await pending).toMatchObject([{ status: 'rejected', reason: { code: 'remote-access/denied' } }])
    expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(0)
    expect(f.ctx.workspaceSandboxState.activity(f.alice.id)).toMatchObject({ closing: false })
  } finally { gate.release(); await pending }
})

test('repeated idle requests and an ordinary close share one admitted close and one DELETE', async () => {
  const f = await fixture(1000, false, 1000, 10_000)
  const advance = clock()
  await f.ctx.workspaceSandbox.openForUser(f.alice.user.userId, f.alice.id)
  const original = target(f)
  advance(idleTimeoutMs)
  const gate = holdGet(f, 2)
  const pending = Promise.allSettled([close(f, original)])
  try {
    await gate.entered
    const ordinary = Promise.allSettled([f.ctx.workspaceSandbox.closeForUser(f.alice.user.userId, f.alice.id)])
    await expect(close(f, original)).resolves.toEqual({ state: 'skipped' })
    gate.release()
    expect(await pending).toMatchObject([{ status: 'fulfilled', value: { state: 'closed' } }])
    expect(await ordinary).toMatchObject([{ status: 'fulfilled', value: { state: 'closed' } }])
    expect(f.calls.map(call => call.method)).toEqual(['PUT', 'GET', 'GET', 'DELETE'])
  } finally { gate.release(); await pending }
})

test('overlapping preflight queries admit only one conditional close', async () => {
  const f = await fixture(1000, false, 1000, 10_000)
  const advance = clock()
  await f.ctx.workspaceSandbox.openForUser(f.alice.user.userId, f.alice.id)
  const original = target(f)
  advance(idleTimeoutMs)
  const gate = holdGet(f)
  const first = Promise.allSettled([close(f, original)])
  try {
    await gate.entered
    await expect(close(f, original)).resolves.toEqual({ state: 'closed' })
    gate.release()
    expect(await first).toMatchObject([{ status: 'fulfilled', value: { state: 'skipped' } }])
    expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(1)
    expect(f.ctx.workspaceSandboxState.activity(f.alice.id).version).toBe(original.version + 1)
  } finally { gate.release(); await first }
})

test('a generation change after admission retains the original close guard without deleting it', async () => {
  const f = await fixture()
  const advance = clock()
  await f.ctx.workspaceSandbox.openForUser(f.alice.user.userId, f.alice.id)
  const original = target(f)
  let queries = 0
  f.control.respond = (response) => {
    response.end(JSON.stringify(++queries === 1 ? running : { state: 'running', containerId: 'b'.repeat(64) }))
  }
  advance(idleTimeoutMs)
  await expect(close(f, original)).rejects.toMatchObject({ code: 'sandbox/failed', details: { reason: 'sandbox_workspace_conflict' } })
  expect(f.calls.map(call => call.method)).toEqual(['PUT', 'GET', 'GET'])
  expect(f.ctx.workspaceSandboxState.activity(f.alice.id)).toMatchObject({ closing: true, idleSince: null })
})

test('a failed DELETE keeps the barrier and later idle requests cannot retry the mutation', async () => {
  const f = await fixture()
  const advance = clock()
  await f.ctx.workspaceSandbox.openForUser(f.alice.user.userId, f.alice.id)
  const original = target(f)
  f.control.respond = (response, method) => {
    if (method === 'DELETE') response.writeHead(503).end(JSON.stringify({ error: 'docker_unavailable' }))
    else response.end(JSON.stringify(running))
  }
  advance(idleTimeoutMs)
  await expect(close(f, original)).rejects.toMatchObject({ code: 'sandbox/failed' })
  const before = f.calls.length
  await expect(close(f, original)).resolves.toEqual({ state: 'skipped' })
  expect(f.calls).toHaveLength(before)
  expect(f.ctx.workspaceSandboxState.activity(f.alice.id)).toMatchObject({ closing: true, idleSince: null })
  expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(1)
})

test('another user cannot submit an idle close target or affect its owner', async () => {
  const f = await fixture()
  const advance = clock()
  await f.ctx.workspaceSandbox.openForUser(f.alice.user.userId, f.alice.id)
  const original = target(f)
  advance(idleTimeoutMs)
  const before = f.calls.length
  await expect(f.ctx.workspaceSandbox.closeIfIdleForUser(f.bob.user.userId, f.alice.id, original,
    idleTimeoutMs, new AbortController().signal)).rejects.toMatchObject({ code: 'remote-access/denied' })
  expect(f.calls).toHaveLength(before)
  expect(target(f)).toEqual(original)
})
