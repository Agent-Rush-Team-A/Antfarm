/** Published idle plugin through dsh Web, native authentication, real Agents and controlled external services. */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { idleRunner, withIdleWeb } from './fixtures/idle-web.ts'

const ttl = 1_800_000

test('published idle overlay preserves active and queued work, reclaims at thirty minutes and reopens the same Session', async (t) => {
  const runner = await idleRunner(t)
  await withIdleWeb(t, runner, async ({ rpc, control, model, account }) => {
    await control({ op: 'ready' })
    expect(await control({ op: 'definition' })).toMatchObject({ named: true, entries: 1,
      defaults: { idleTimeoutMs: ttl, sweepIntervalMs: 10_000 } })
    const alice = await account('alice')
    const bob = await account('bob')
    const state = () => control({ op: 'state', workspaceId: alice.id })
    const round = (advance = 0, wallJump = 0) => control({ op: 'round', workspaceId: alice.id, advance, wallJump })
    const deletions = () => runner.calls.filter(call => call.method === 'DELETE' && call.id === alice.id)
    const session = async () => {
      const created = await rpc(alice.cookie, 'session/create', { workspaceId: alice.id })
      expect(created.ok).toBe(true)
      return created.value.sessionId as string
    }
    const first = await session()
    const second = await session()
    const prompt = async (label: string, sessionId = first, extra = {}) => {
      const result = await rpc(alice.cookie, 'session/prompt', { sessionId, requestId: label, mode: 'queue',
        content: [{ type: 'text', text: JSON.stringify({ label, ...extra }) }] })
      expect(result).toMatchObject({ ok: true, value: { accepted: true } })
    }
    const settled = async (label: string, sessionId = first) => {
      await model({ op: 'wait', label })
      return control({ op: 'idle', sessionId, workspaceId: alice.id })
    }
    expect((await rpc(alice.cookie, 'workspaceSandbox/open', { workspaceId: alice.id })).ok).toBe(true)
    const original = runner.states.get(alice.id)
    const mount = runner.calls.find(call => call.method === 'PUT')!.body.workspaceDir!
    await writeFile(join(mount, 'retained.txt'), 'persistent-file')
    const initial = (await state()).activity
    expect(initial).toMatchObject({ busy: false, idleSince: 100 })
    await round(ttl - 1000, 86_400_000)
    expect(deletions()).toHaveLength(0)
    expect((await state()).activity).toEqual(initial)
    expect(await readFile(join(mount, 'retained.txt'), 'utf8')).toBe('persistent-file')
    expect((await rpc(alice.cookie, 'workspaceSandbox/status', { workspaceId: alice.id })).ok).toBe(true)
    const beforeDenied = runner.calls.length
    expect(await rpc(bob.cookie, 'workspaceSandbox/status', { workspaceId: alice.id })).toMatchObject({ ok: false,
      error: { code: 'remote-access/denied' } })
    expect(runner.calls).toHaveLength(beforeDenied)
    expect((await state()).activity).toEqual(initial)
    expect((await round(1000, -86_400_000)).activity.sandbox).toEqual({ state: 'closed' })
    await round(1000)
    expect(deletions()).toHaveLength(1)
    expect(await readFile(join(mount, 'retained.txt'), 'utf8')).toBe('persistent-file')
    await prompt('reopened', first, { bash: true })
    const reopened = await settled('reopened')
    expect(reopened.activity).toMatchObject({ busy: false, sandbox: { state: 'running' } })
    expect(runner.states.get(alice.id)).not.toEqual(original)
    expect(JSON.stringify(await rpc(alice.cookie, 'session/events', { address: { kind: 'session', sessionId: first }, maxMessages: 100 })))
      .toContain('PROFILE_IDLE_OK')
    await control({ op: 'clock', advance: 500 })
    await prompt('short-between-sweeps')
    const short = await settled('short-between-sweeps')
    expect(short.activity.idleSince).toBe(short.now)
    expect(short.activity.revision).toBeGreaterThan(reopened.activity.revision)

    await prompt('active-first', first, { hold: true })
    await model({ op: 'wait', label: 'active-first' })
    await prompt('queued-first')
    await prompt('active-second', second, { hold: true })
    await model({ op: 'wait', label: 'active-second' })
    try {
      expect((await round(ttl * 2)).activity).toMatchObject({ busy: true, requests: 3, idleSince: null })
      expect(deletions()).toHaveLength(1)
      await model({ op: 'release', label: 'active-first' })
      await settled('queued-first')
      expect((await state()).activity).toMatchObject({ requests: 1, idleSince: null })
      await control({ op: 'clock', advance: 500 })
      await model({ op: 'release', label: 'active-second' })
      const final = await settled('active-second', second)
      expect(final.activity).toMatchObject({ busy: false, requests: 0, idleSince: final.now })
    } finally {
      await model({ op: 'release', label: 'active-first' })
      await model({ op: 'release', label: 'active-second' })
    }
    await round(ttl - 1)
    expect(deletions()).toHaveLength(1)

    const exec = runner.hold('POST', alice.id, '/exec')
    await prompt('cancel-cleanup', first, { bash: true })
    try {
      const pending = await exec.entered
      expect((await rpc(alice.cookie, 'session/cancel', { sessionId: first })).ok).toBe(true)
      await runner.seen('POST', alice.id, '/exec/cancel')
      expect((await round(ttl * 2)).activity).toMatchObject({ busy: true, executions: 1, idleSince: null })
      expect(deletions()).toHaveLength(1)
      pending.response.writeHead(409).end(JSON.stringify({ error: 'execution_cancelled', executionId: pending.call.body.executionId,
        containerId: pending.call.body.expectedContainerId, reason: 'cancelled', cleanup: 'processes_cleaned' }))
      const clean = await control({ op: 'idle', sessionId: first, workspaceId: alice.id })
      expect(clean.activity).toMatchObject({ busy: false, executions: 0, idleSince: clean.now })
    } finally { exec.release() }

    const due = runner.hold('GET', alice.id)
    const pendingRound = Promise.allSettled([round(ttl)])
    try {
      await due.entered
      const before = (await state()).activity.revision
      await prompt('during-query', first, { bash: true })
      const current = await settled('during-query')
      expect(current.activity.revision).toBeGreaterThan(before)
      due.release()
      expect(await pendingRound).toMatchObject([{ status: 'fulfilled' }])
      expect((await state()).activity).toEqual(current.activity)
      expect(deletions()).toHaveLength(1)
      const records = await model({ op: 'state' })
      expect(records.filter(record => record.label === 'during-query').every(record => !record.cancelled)).toBe(true)
      expect(records.every(record => record.tools.join(',') === 'bash')).toBe(true)
      await round(ttl)
      await round()
      expect(deletions()).toHaveLength(2)
    } finally { due.release(); await pendingRound }
  })
})

test('published idle lifecycle retains failed candidates, excludes offline time and preserves uncertain close barriers', async (t) => {
  const runner = await idleRunner(t)
  await withIdleWeb(t, runner, async ({ rpc, control, account, output }) => {
    await control({ op: 'ready' })
    const alice = await account('alice')
    const bob = await account('bob')
    const round = (advance = 0) => control({ op: 'round', workspaceId: alice.id, advance })
    const state = () => control({ op: 'state', workspaceId: alice.id })
    expect((await rpc(alice.cookie, 'workspaceSandbox/open', { workspaceId: alice.id })).ok).toBe(true)
    const history = (await state()).activity
    expect((await control({ op: 'entry', id: 'sandbox-idle', disabled: true, workspaceId: alice.id })).timers).toBe(0)
    await control({ op: 'clock', advance: ttl - 1 })
    const retained = await control({ op: 'entry', id: 'sandbox-idle', disabled: false, workspaceId: alice.id })
    expect(retained.activity).toEqual(history)
    expect(retained.timers).toBe(1)
    await control({ op: 'entry', id: 'workspace-sandbox', disabled: true, workspaceId: alice.id })
    const count = runner.calls.length
    expect((await round(ttl)).activity.idleSince).toBeNull()
    expect(runner.calls).toHaveLength(count)
    await control({ op: 'entry', id: 'workspace-sandbox', disabled: false })
    runner.errors.set(`GET:${alice.id}`, 'docker_unavailable')
    expect((await round()).activity.idleSince).toBeNull()
    expect((await state()).candidates).toContain(alice.id)
    runner.errors.delete(`GET:${alice.id}`)
    const recovered = await round()
    expect(recovered.activity.idleSince).toBe(recovered.now)
    expect(runner.calls.filter(call => call.method === 'DELETE')).toHaveLength(0)
    expect((await rpc(bob.cookie, 'workspaceSandbox/open', { workspaceId: bob.id })).ok).toBe(true)
    const orphan = (await rpc(alice.cookie, 'workspace/create', { title: 'owner-removed' })).value.workspace as { workspaceId: string }
    expect((await rpc(alice.cookie, 'workspaceSandbox/open', { workspaceId: orphan.workspaceId })).ok).toBe(true)
    await control({ op: 'forget-owner', workspaceId: orphan.workspaceId })
    await control({ op: 'disable-user', userId: bob.userId })
    await control({ op: 'clock', advance: ttl })
    const beforeBob = runner.calls.filter(call => call.id === bob.id).length
    const beforeOrphan = runner.calls.filter(call => call.id === orphan.workspaceId).length
    runner.errors.set(`DELETE:${alice.id}`, 'sandbox_outcome_unknown')
    expect((await round()).activity).toMatchObject({ closing: true, idleSince: null })
    await expect.poll(() => output().stderr).toContain('maintenance required')
    expect(output().stderr).toContain('sandbox_outcome_unknown')
    expect(output().stderr).toContain(alice.id)
    expect(output().stderr).toContain('automatic close will not be retried')
    expect(runner.calls.filter(call => call.id === bob.id)).toHaveLength(beforeBob)
    expect(runner.calls.filter(call => call.id === orphan.workspaceId)).toHaveLength(beforeOrphan)
    const failedCalls = runner.calls.length
    await round(ttl)
    await round(ttl)
    expect(runner.calls).toHaveLength(failedCalls)
    expect(runner.calls.filter(call => call.method === 'DELETE')).toHaveLength(1)
    expect((await rpc(alice.cookie, 'workspaceSandbox/status', { workspaceId: alice.id })).value).toMatchObject({ state: 'closing' })
    expect((await rpc(alice.cookie, 'workspaceSandbox/open', { workspaceId: alice.id })).ok).toBe(false)
    const stopped = await control({ op: 'entry', id: 'sandbox-idle', disabled: true, workspaceId: alice.id })
    expect(stopped.timers).toBe(0)
    expect(stopped.cleared).toBe(stopped.scheduled)
  })
})

test('a new dsh process discovers persisted running workspaces with a new complete monotonic interval', async (t) => {
  const runner = await idleRunner(t)
  const seed = await mkdtemp(join(tmpdir(), 'dsh-idle-restart-'))
  t.onTestFinished(async () => { await rm(seed, { recursive: true, force: true }) })
  let id = ''
  await withIdleWeb(t, runner, async ({ root, rpc, control, account }) => {
    await control({ op: 'ready' })
    const alice = await account('alice')
    id = alice.id
    await control({ op: 'clock', advance: ttl * 5 })
    expect((await rpc(alice.cookie, 'workspaceSandbox/open', { workspaceId: id })).ok).toBe(true)
    expect((await control({ op: 'state', workspaceId: id })).activity.idleSince).toBe(100 + ttl * 5)
    await cp(join(root, 'home', 'storages'), join(seed, 'storages'), { recursive: true })
  })
  const beforeRestart = runner.calls.length
  await withIdleWeb(t, runner, async ({ control }) => {
    const discovered = await control({ op: 'ready', workspaceId: id })
    expect(discovered).toMatchObject({ registered: [{ id }] })
    // Management may finish attaching after startup discovery; an explicit next sweep must recover the retained candidate.
    const fresh = await control({ op: 'round', workspaceId: id })
    expect(fresh.activity).toMatchObject({ busy: false, idleSince: 100, sandbox: { state: 'running' } })
    expect(runner.calls.slice(beforeRestart).map(call => call.method)).toEqual(['GET'])
    await control({ op: 'round', workspaceId: id, advance: ttl - 1 })
    expect(runner.calls.filter(call => call.method === 'DELETE')).toHaveLength(0)
    await control({ op: 'round', workspaceId: id, advance: 1 })
    expect(runner.calls.filter(call => call.method === 'DELETE')).toHaveLength(1)
  }, join(seed, 'storages'))
})
