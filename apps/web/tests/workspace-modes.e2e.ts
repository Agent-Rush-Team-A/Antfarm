/** Workspace modes through the shipped Loader, authenticated browser, and HTTP Remote boundary. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type APIRequestContext, type Page } from 'playwright'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { WorkspaceCreateValue, WorkspaceModeValue } from '@deepseek-ai/dsh-api-workspace-controller'
import type { SessionCreateValue, SessionRenameValue } from '@deepseek-ai/dsh-api-session-controller'
import type { WorkspaceModeRuntime, WorkspaceModeChangeDecision } from '@deepseek-ai/dsh-workspace/types'
import { launchWebScaffold, compareOrRefreshGolden, webSnapshotMode } from './scaffold.ts'

type Reply<T> = { ok: true; value: T } | { ok: false; error: { code: string; details: Record<string, unknown> } }

function value<T>(reply: Reply<T>): T {
  if (!reply.ok) throw new Error(`Unexpected Remote failure: ${JSON.stringify(reply.error)}`)
  return reply.value
}

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

it('enforces mode revisions, single-session admission, ownership, and creation races through Web Remote', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-modes-web-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const overlay = join(root, 'modes.yml')
  await writeFile(overlay, `- id: multiuser\n  config:\n    workspaceRoot: ${JSON.stringify(join(root, 'workspaces'))}\n`)
  const scaffold = await launchWebScaffold({
    firstUse: true, accountAuthentication: true, compareReplaySession: false,
    extraOverlayPath: [fileURLToPath(new URL('../../cli/config/antfarm-web.patch.yml', import.meta.url)), overlay],
  })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await scaffold.close()
  }
  onTestFinished(close)
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  const releases: Array<() => void> = []
  const work: Promise<unknown>[] = []
  const track = <T>(pending: Promise<T>): Promise<T> => {
    work.push(pending)
    void pending.catch(() => {})
    return pending
  }
  try {
    const password = randomUUID()
    await scaffold.ctx.multiuser.provisionUser('alice', password)
    await scaffold.ctx.multiuser.provisionUser('bob', password)
    const alice = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
    const bob = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
    const base = new URL(scaffold.authenticatedUrl).origin
    const pageErrors: string[] = []
    async function signIn(page: Page, username: string) {
      page.on('pageerror', (error) => { pageErrors.push(error.message) })
      await page.goto(base)
      await page.getByLabel('Username', { exact: true }).fill(username)
      await page.getByLabel('Password', { exact: true }).fill(password)
      await page.getByRole('button', { name: 'Sign in', exact: true }).click()
      await page.locator('.dsh-account').getByText(username, { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Choose workspace', exact: true }).waitFor()
    }
    await signIn(await alice.newPage(), 'alice')
    await signIn(await bob.newPage(), 'bob')
    async function rpc<T>(client: APIRequestContext, method: string, request: unknown): Promise<Reply<T>> {
      const response = await client.post(`${base}/api/${method}`, {
        headers: { origin: base },
        data: { type: 'client-request', rpcId: randomUUID(), method, payload: { args: { request } } },
      })
      expect(response.status()).toBe(200)
      return (await response.json() as { result: Reply<T> }).result
    }
    const createWorkspace = async (client: APIRequestContext, title: string) =>
      value(await rpc<WorkspaceCreateValue>(client, 'workspace/create', { title })).workspace
    const single = await createWorkspace(alice.request, 'single')
    expect(single.modeConfig).toMatchObject({ mode: 'multi-vm', revision: 0, modeLocked: false, firstSessionId: null })
    const unavailable = await rpc(alice.request, 'workspace/setMode', {
      workspaceId: single.workspaceId, mode: 'single-vm', expectedRevision: 0,
    })
    expect(unavailable).toMatchObject({ ok: false, error: { code: 'workspace/mode-runtime-unavailable' } })
    const decisions = new Map<string, WorkspaceModeChangeDecision>()
    const runtime: WorkspaceModeRuntime = {
      supportedModes: ['single-vm', 'multi-vm', 'single-docker', 'multi-docker'],
      prepare: vi.fn(async (_change, signal) => { signal.throwIfAborted() }),
      settle: vi.fn(async (change, decision, signal) => {
        signal.throwIfAborted()
        const previous = decisions.get(change.changeId)
        if (previous !== undefined) expect(previous).toBe(decision)
        decisions.set(change.changeId, decision)
      }),
    }
    scaffold.ctx.effect(() => scaffold.ctx.workspaceRegistry.modes.registerRuntime(runtime))
    const observed: unknown[] = []
    let config = single.modeConfig
    for (const mode of ['single-vm', 'single-docker', 'multi-docker', 'multi-vm', 'single-vm'] as const) {
      config = value(await rpc<WorkspaceModeValue>(alice.request, 'workspace/setMode', {
        workspaceId: single.workspaceId, mode, expectedRevision: config.revision,
      })).config
      observed.push({ mode: config.mode, revision: config.revision, operationState: config.operationState })
    }
    expect(await rpc(alice.request, 'workspace/setMode', {
      workspaceId: single.workspaceId, mode: 'single-docker', expectedRevision: 0,
    })).toMatchObject({ ok: false, error: { code: 'workspace/mode-revision-conflict' } })
    const competing = await Promise.all([
      rpc<SessionCreateValue>(alice.request, 'session/create', { workspaceId: single.workspaceId }),
      rpc<SessionCreateValue>(alice.request, 'session/create', { workspaceId: single.workspaceId }),
    ])
    expect(competing.filter(reply => reply.ok)).toHaveLength(1)
    expect(competing.filter(reply => !reply.ok)).toMatchObject([{ error: { code: 'workspace/session-limit' } }])
    const accepted = competing.find(reply => reply.ok)
    if (accepted === undefined) throw new Error('Single-mode creation did not succeed')
    const first = value(accepted).sessionId
    const locked = value(await rpc<WorkspaceModeValue>(alice.request, 'workspace/getMode', { workspaceId: single.workspaceId })).config
    expect(locked).toMatchObject({ modeLocked: true, lockReason: 'first-session-created', firstSessionId: first })
    const stored = await scaffold.ctx.sessionPersistence.list()
    expect(stored.filter(item => item.header.cwd === single.path && item.header.origin !== 'subagent')).toHaveLength(1)
    expect(value(await rpc<SessionCreateValue>(alice.request, 'session/create', {
      workspaceId: single.workspaceId, sessionId: first,
    })).sessionId).toBe(first)
    const forbidden: string[] = []
    for (const [method, request] of [
      ['workspace/setMode', { workspaceId: single.workspaceId, mode: locked.mode, expectedRevision: locked.revision }],
      ['session/fork', { sessionId: first, atSeq: 0 }],
      ['workspace/archiveSession', { sessionId: first, stopActivity: true }],
    ] as const) {
      const reply = await rpc(alice.request, method, request)
      expect(reply.ok).toBe(false)
      if (!reply.ok) forbidden.push(reply.error.code)
    }
    expect(forbidden).toEqual(['workspace/mode-locked', 'workspace/session-operation-forbidden', 'workspace/session-operation-forbidden'])
    const foreign = await createWorkspace(bob.request, 'private')
    for (const id of [foreign.workspaceId, 'missing-workspace']) {
      expect(await rpc(alice.request, 'workspace/getMode', { workspaceId: id }))
        .toMatchObject({ ok: false, error: { code: 'remote-access/denied' } })
      expect(await rpc(alice.request, 'workspace/setMode', { workspaceId: id, mode: 'single-docker', expectedRevision: 0 }))
        .toMatchObject({ ok: false, error: { code: 'remote-access/denied' } })
    }
    const multi = await createWorkspace(alice.request, 'multi')
    const roots = await Promise.all([0, 1].map(async () =>
      value(await rpc<SessionCreateValue>(alice.request, 'session/create', { workspaceId: multi.workspaceId })).sessionId))
    expect(new Set(roots).size).toBe(2)
    const original = roots[0]
    if (original === undefined) throw new Error('Multi-mode creation did not succeed')
    const renamed = value(await rpc<SessionRenameValue>(alice.request, 'session/rename', { sessionId: original, title: 'fork source' }))
    const fork = value(await rpc<SessionCreateValue>(alice.request, 'session/fork', { sessionId: original, atSeq: renamed.seq }))
    expect(await rpc(alice.request, 'workspace/archiveSession', { sessionId: fork.sessionId }))
      .toMatchObject({ ok: true })
    expect(scaffold.ctx.workspaceRegistry.get(multi.workspaceId)?.sessionIds).toHaveLength(3)

    const switched = await createWorkspace(alice.request, 'switch-before-create')
    const entered = barrier(), finish = barrier()
    releases.push(finish.resolve)
    runtime.prepare = vi.fn(async () => { entered.resolve(); await finish.promise })
    const switching = track(rpc<WorkspaceModeValue>(alice.request, 'workspace/setMode', {
      workspaceId: switched.workspaceId, mode: 'single-docker', expectedRevision: 0,
    }))
    await entered.promise
    const queued = track(rpc<SessionCreateValue>(alice.request, 'session/create', { workspaceId: switched.workspaceId }))
    finish.resolve(); await switching; await queued
    expect(scaffold.ctx.workspaceRegistry.get(switched.workspaceId)?.modeConfig)
      .toMatchObject({ mode: 'single-docker', modeLocked: true })

    const pending = await createWorkspace(alice.request, 'create-before-switch')
    const setupEntered = barrier(), finishSetup = barrier()
    releases.push(finishSetup.resolve)
    const mount = scaffold.ctx.agentPresets.mount.bind(scaffold.ctx.agentPresets)
    const setup = vi.spyOn(scaffold.ctx.agentPresets, 'mount').mockImplementationOnce(async (...args) => {
      setupEntered.resolve(); await finishSetup.promise
      return mount(...args)
    })
    const creating = track(rpc<SessionCreateValue>(alice.request, 'session/create', { workspaceId: pending.workspaceId }))
    await setupEntered.promise
    const candidate = scaffold.ctx.sessions.list().find(session => session.header.cwd === pending.path)
    if (candidate === undefined) throw new Error('Creation did not reserve its Session before setup')
    expect(await rpc(alice.request, 'session/prompt', {
      sessionId: candidate.id, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'too early' }],
    })).toMatchObject({ ok: false, error: { code: 'workspace/mode-recovery-required' } })
    expect(candidate.snapshotEvents().some(event => event.type === 'user/message')).toBe(false)
    const edit = track(rpc(alice.request, 'workspace/setMode', {
      workspaceId: pending.workspaceId, mode: 'single-vm', expectedRevision: 0,
    }))
    finishSetup.resolve(); await creating
    expect(await edit).toMatchObject({ ok: false, error: { code: 'workspace/mode-locked' } })
    setup.mockRestore()
    expect(pageErrors).toEqual([])

    const interrupted = await createWorkspace(alice.request, 'recover-after-loader-restart')
    const failing = vi.fn<WorkspaceModeRuntime['settle']>(async () => { throw new Error('runtime unavailable') })
    runtime.settle = failing
    expect(await rpc(alice.request, 'workspace/setMode', {
      workspaceId: interrupted.workspaceId, mode: 'single-docker', expectedRevision: 0,
    })).toMatchObject({ ok: false, error: { code: 'workspace/mode-switch-failed', details: { recoveryRequired: true } } })
    const originalChange = failing.mock.calls[0]?.[0]
    if (originalChange === undefined) throw new Error('Failed settlement did not retain its transition identity')
    const previousRegistry = scaffold.ctx.workspaceRegistry
    const entry = [...scaffold.ctx.loader.entries()].find(row => row.options.id === 'workspace')
    if (entry === undefined) throw new Error('Shipped Workspace Loader entry is missing')
    await entry.update({ disabled: true }); await scaffold.ctx.loader.await()
    await entry.update({ disabled: false }); await scaffold.ctx.loader.await()
    expect(scaffold.ctx.workspaceRegistry).not.toBe(previousRegistry)
    expect(scaffold.ctx.workspaceRegistry.modes.get(interrupted.workspaceId).operationState).toBe('recovery-required')
    expect(scaffold.ctx.workspaceRegistry.modes.get(single.workspaceId).firstSessionId).toBe(first)
    const options = { signal: new AbortController().signal, admit: () => {} }
    const retry = vi.fn<WorkspaceModeRuntime['settle']>(async () => { throw new Error('retry offline') })
    const unregister = scaffold.ctx.workspaceRegistry.modes.registerRuntime({ ...runtime, settle: retry })
    await expect(scaffold.ctx.workspaceRegistry.modes.recover(interrupted.workspaceId, options)).rejects.toThrow('retry offline')
    expect(retry.mock.calls[0]?.[0]).toEqual(originalChange)
    await unregister()
    const recovered = vi.fn<WorkspaceModeRuntime['settle']>(async () => {})
    scaffold.ctx.effect(() => scaffold.ctx.workspaceRegistry.modes.registerRuntime({ ...runtime, settle: recovered }))
    const recovery = await Promise.all([0, 1].map(() =>
      scaffold.ctx.workspaceRegistry.modes.recover(interrupted.workspaceId, options)))
    expect(recovery).toEqual([recovery[0], recovery[0]])
    expect(recovery[0]).toMatchObject({ mode: 'single-docker', operationState: 'ready' })
    expect(recovered).toHaveBeenCalledExactlyOnceWith(originalChange, 'commit', expect.any(AbortSignal))
    await compareOrRefreshGolden(
      fileURLToPath(new URL('./expected/workspace-modes/api.expected.md', import.meta.url)),
      JSON.stringify({ modes: observed, singleOrdinaryLogs: 1, singleLocked: true, forbidden,
        foreignRead: 'remote-access/denied', multiOrdinarySessions: 3,
        switchBeforeCreate: 'single-docker', createBeforeSwitch: 'workspace/mode-locked',
        earlyMessage: 'workspace/mode-recovery-required', loaderPendingRecovery: 'ready' }, null, 2), webSnapshotMode(),
    )
  } finally {
    for (const release of releases) release()
    vi.restoreAllMocks()
    try { await browser.close() } finally {
      await Promise.allSettled(work)
      await close()
    }
  }
})
