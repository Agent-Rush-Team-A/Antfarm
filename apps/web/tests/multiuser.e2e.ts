/** Multiuser browser acceptance through the shipped Web Loader composition. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page, type APIRequestContext } from 'playwright'
import { expect, it } from 'vitest'
import type { LoginValue } from '@deepseek-ai/dsh-api-multiuser'
import type { SessionListValue } from '@deepseek-ai/dsh-api-session-controller'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { launchWebScaffold, compareOrRefreshGolden, webSnapshotMode } from './scaffold.ts'

it('logs in separate accounts, creates private workspaces, revokes all tabs, and switches accounts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multiuser-browser-'))
  const overlay = join(root, 'multiuser.yml')
  await writeFile(overlay, `- id: connection\n  config:\n    multiuser: true\n- insert:\n    - id: multiuser\n      name: '@deepseek-ai/dsh-api-multiuser'\n      config:\n        workspaceRoot: ${JSON.stringify(join(root, 'workspaces'))}\n        sessionSweepIntervalMs: 1000\n`)
  const scaffold = await launchWebScaffold({ firstUse: true, accountAuthentication: true, extraOverlayPath: overlay,
    compareReplaySession: false,
    replayFixture: fileURLToPath(new URL('../../../snapshots/web/lifecycle-chrome/session.v4.jsonl', import.meta.url)) })
  const failures: unknown[] = []
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  try {
    const password = randomUUID()
    await scaffold.ctx.multiuser.provisionUser('alice', password)
    await scaffold.ctx.multiuser.provisionUser('bob', password)
    const alice = await browser.newContext({ locale: 'en-US' })
    const bob = await browser.newContext({ locale: 'en-US' })
    const alicePage = await alice.newPage()
    const bobPage = await bob.newPage()
    const base = new URL(scaffold.authenticatedUrl).origin
    async function protectedListStatus(cookie?: string) {
      const response = await fetch(`${base}/api/session/list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base, ...(cookie === undefined ? {} : { cookie }) },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'session/list', payload: { args: { _request: {} } } }),
      })
      await response.arrayBuffer()
      return response.status
    }
    expect(await protectedListStatus()).toBe(401)
    const errors: string[] = []
    for (const page of [alicePage, bobPage]) page.on('pageerror', error => errors.push(error.message))
    async function signIn(page: Page, username: string) {
      await page.goto(base)
      expect(errors, await page.locator('body').innerText()).toEqual([])
      if (username === 'alice') await compareOrRefreshGolden(
        fileURLToPath(new URL('./expected/multiuser/login.expected.md', import.meta.url)),
        await page.locator('main').ariaSnapshot(), webSnapshotMode())
      await page.getByLabel('Username', { exact: true }).fill(username)
      await page.getByLabel('Password', { exact: true }).fill(password)
      await page.getByRole('button', { name: 'Sign in', exact: true }).click()
      await page.locator('.dsh-account').getByText(username, { exact: true }).waitFor({ timeout: 10000 }).catch(async () => {
        throw new Error(JSON.stringify({ url: page.url(), errors, body: await page.locator('body').innerText() }))
      })
      await page.getByRole('button', { name: 'Choose workspace', exact: true }).waitFor()
    }
    await signIn(alicePage, 'alice')
    await signIn(bobPage, 'bob')
    await alicePage.getByRole('button', { name: 'Choose workspace', exact: true }).click()
    await alicePage.locator('[data-composer-input][contenteditable="true"]').first().waitFor()
    expect(scaffold.ctx.workspaceRegistry.list()).toHaveLength(1)
    const aliceWorkspaceId = scaffold.ctx.workspaceRegistry.list()[0]!.id
    await bobPage.getByRole('button', { name: 'Choose workspace', exact: true }).click()
    await bobPage.locator('[data-composer-input][contenteditable="true"]').first().waitFor()
    expect(scaffold.ctx.workspaceRegistry.list()).toHaveLength(2)
    const bobWorkspaceId = scaffold.ctx.workspaceRegistry.list().find(workspace => workspace.id !== aliceWorkspaceId)!.id
    for (const page of [alicePage, bobPage]) {
      await page.reload()
      await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor().catch(async (error: unknown) => {
        throw new Error(`Workspace restoration failed: ${String(error)}; ${await page.locator('body').innerText()}`)
      })
      await expect.poll(() => page.getByRole('button', { name: 'Choose workspace', exact: true }).innerText()).toBe('Workspace')
    }
    const accounts = await Promise.all([alice.request.get(`${base}/auth/me`), bob.request.get(`${base}/auth/me`)])
    const [aliceUser, bobUser] = await Promise.all(accounts.map(async response => (await response.json() as LoginValue).user))
    if (aliceUser === undefined || bobUser === undefined) throw new Error('Both accounts must be authenticated')
    expect(aliceUser.userId).not.toBe(bobUser.userId)
    expect(scaffold.ctx.multiuser.ownedWorkspaces(aliceUser.userId)).toEqual([aliceWorkspaceId])
    expect(scaffold.ctx.multiuser.ownedWorkspaces(bobUser.userId)).toEqual([bobWorkspaceId])
    async function rpc(client: APIRequestContext, method: string, args: unknown) {
      const response = await client.post(`${base}/api/${method}`, {
        headers: { origin: base },
        data: { type: 'client-request', rpcId: randomUUID(), method, payload: { args } },
      })
      expect(response.status()).toBe(200)
      const envelope = await response.json() as { result: { ok: true; value: unknown } | { ok: false; error: { code: string } } }
      return envelope.result
    }
    const aliceSession = scaffold.ctx.multiuser.ownedSessions(aliceUser.userId)[0]!
    const bobSession = scaffold.ctx.multiuser.ownedSessions(bobUser.userId)[0]!
    const before = scaffold.ctx.sessions.get(bobSession)!.snapshotEvents()
    const denied: Array<[string, unknown]> = [
      ['session/create', { workspaceId: bobWorkspaceId }],
      ['session/events', { address: { kind: 'session', sessionId: bobSession } }],
      ['session/page', { address: { kind: 'session', sessionId: bobSession } }],
      ['session/prompt', { sessionId: bobSession, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'FORBIDDEN' }] }],
      ['session/updateQueue', { sessionId: bobSession, itemId: 'other-item', action: { kind: 'remove' } }],
      ['session/cancel', { sessionId: bobSession }],
      ['session/rename', { sessionId: bobSession, title: 'FORBIDDEN' }],
      ['session/fork', { sessionId: bobSession }],
      ['workspace/rename', { workspaceId: bobWorkspaceId, title: 'FORBIDDEN' }],
      ['workspace/delete', { workspaceId: bobWorkspaceId }],
      ['workspace/insertBefore', { workspaceId: aliceWorkspaceId, beforeWorkspaceId: bobWorkspaceId }],
      ['workspace/insertSessionBefore', { workspaceId: aliceWorkspaceId, sessionId: aliceSession, beforeSessionId: bobSession }],
      ['workspace/pinSession', { sessionId: bobSession }],
      ['workspace/archiveSession', { sessionId: bobSession }],
    ]
    for (const [method, request] of denied) {
      expect(await rpc(alice.request, method, { request }), method).toMatchObject({ ok: false, error: { code: 'remote-access/denied' } })
    }
    expect(scaffold.ctx.sessions.get(bobSession)!.snapshotEvents()).toEqual(before)
    for (const request of [{ cwd: '/' }, {}, { workspaceId: aliceWorkspaceId, sessionId: bobSession }]) {
      expect(await rpc(alice.request, 'session/create', { request })).toMatchObject({ ok: false })
    }
    for (const path of ['/', '../bob', scaffold.ctx.workspaceRegistry.get(bobWorkspaceId)!.path]) {
      expect(await rpc(alice.request, 'workspace/create', { request: { path } })).toMatchObject({ ok: false })
    }
    for (const [client, sessionId] of [[alice.request, aliceSession], [bob.request, bobSession]] as const) {
      const list = await rpc(client, 'session/list', { _request: {} })
      expect(list.ok).toBe(true)
      if (!list.ok) throw new Error('Account session list failed')
      expect((list.value as SessionListValue).items.map(item => item.sessionId)).toEqual([sessionId])
    }
    const input = alicePage.locator('[data-composer-input][contenteditable="true"]').first()
    await input.fill('Reply with the single word LIGHTHOUSE and stop.')
    const settled = scaffold.whenTurnSettled()
    await input.press('Enter')
    expect(await settled).toBe(aliceSession)
    await alicePage.getByText('LIGHTHOUSE', { exact: true }).waitFor()
    expect(await bobPage.getByText('LIGHTHOUSE', { exact: true }).count()).toBe(0)
    const accepted = scaffold.ctx.sessions.get(aliceSession)!.snapshotEvents().find(event =>
      event.type === 'user/message' && event.data.source.kind === 'user')
    expect(accepted).toMatchObject({ data: { source: { principal: { kind: 'user', userId: aliceUser.userId } } } })
    expect(await rpc(bob.request, 'session/search', { request: { query: 'LIGHTHOUSE' } }))
      .toMatchObject({ ok: true, value: { items: [], hasMore: false } })
    const guarded = await scaffold.ctx.tools.execute({
      signal: new AbortController().signal,
      calls: [{ type: 'tool-call', id: ToolCallId('multiuser-denied'), name: 'bash', arguments: '{"command":"echo SHOULD_NOT_EXECUTE"}' }],
    })
    expect(guarded.results[0]?.result.isError).toBe(true)
    expect(JSON.stringify(guarded.results)).toContain('Tool execution is unavailable')
    const oldCookie = (await alice.cookies()).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
    expect(await protectedListStatus(oldCookie)).toBe(200)
    const otherTab = await alice.newPage()
    await otherTab.goto(base)
    await otherTab.locator('.dsh-account').waitFor()
    await alicePage.evaluate(() => { localStorage.setItem('dsh.multiuser.test-marker', 'ALICE_PRIVATE') })
    await alicePage.getByRole('button', { name: 'Sign out', exact: true }).click()
    await alicePage.getByRole('button', { name: 'Sign in', exact: true }).waitFor()
    await otherTab.getByRole('button', { name: 'Sign in', exact: true }).waitFor()
    expect((await fetch(`${base}/auth/me`, { headers: { cookie: oldCookie } })).status).toBe(401)
    expect(await protectedListStatus(oldCookie)).toBe(401)
    await signIn(alicePage, 'bob')
    expect(await alicePage.locator('.dsh-account').textContent()).toContain('bob')
    expect(await alicePage.evaluate(() => localStorage.getItem('dsh.multiuser.test-marker'))).toBeNull()
    expect(await alicePage.getByText('LIGHTHOUSE', { exact: true }).count()).toBe(0)
    expect((await bob.request.get(`${base}/auth/me`)).status()).toBe(200)
    expect(errors).toEqual([])
  } catch (error) {
    failures.push(error)
  } finally {
    await browser.close()
    await scaffold.close().catch((error: unknown) => { failures.push(error) })
    await rm(root, { recursive: true, force: true })
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Multiuser browser acceptance failed')
}, 180_000)
