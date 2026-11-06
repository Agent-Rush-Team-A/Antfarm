/** Multiuser browser acceptance through the shipped Web Loader composition. */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { chromium, type Page, type APIRequestContext } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import type { Context, RegistryService } from '@deepseek-ai/cordis'
import type { ClientModuleLoaderTarget } from '@deepseek-ai/dsh-client-modules/client'
import type { LoginValue } from '@deepseek-ai/dsh-api-multiuser'
import { z } from 'zod'
import type { SessionListValue } from '@deepseek-ai/dsh-api-session-controller'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { launchWebScaffold, compareOrRefreshGolden, webSnapshotMode } from './scaffold.ts'

it('logs in separate accounts, creates private workspaces, revokes all tabs, and switches accounts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multiuser-browser-'))
  const overlay = join(root, 'multiuser.yml')
  const credentialKey = join(root, 'credential-key')
  const inferenceCalls: Array<{ authorization: string; body: unknown }> = []
  const inference = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      inferenceCalls.push({ authorization: request.headers.authorization ?? '', body })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const choice of [
        { index: 0, delta: { role: 'assistant', content: 'PERSONAL-INFERENCE' }, finish_reason: null },
        { index: 0, delta: {}, finish_reason: 'stop' },
      ]) response.write('data: ' + JSON.stringify({ id: 'personal-test', object: 'chat.completion.chunk',
        created: 1, model: 'personal-model', choices: [choice] }) + '\n\n')
      response.end('data: [DONE]\n\n')
    })
  })
  onTestFinished(async () => {
    inference.closeAllConnections()
    await new Promise<void>((resolve, reject) => { inference.close((error) => { if (error) reject(error); else resolve() }) })
  })
  await new Promise<void>((resolve) => { inference.listen(0, '127.0.0.1', resolve) })
  const address = inference.address()
  if (address === null || typeof address === 'string') throw new Error('Inference fixture must listen on TCP')
  const inferenceBase = `http://127.0.0.1:${address.port}/v1`
  await writeFile(credentialKey, randomBytes(32), { flag: 'wx', mode: 0o600 })
  await writeFile(overlay, `- id: connection\n  config:\n    multiuser: true\n- insert:\n    - id: multiuser\n      name: '@deepseek-ai/dsh-api-multiuser'\n      config:\n        workspaceRoot: ${JSON.stringify(join(root, 'workspaces'))}\n        sessionSweepIntervalMs: 1000\n`)
  await writeFile(overlay, `- insert:\n    - id: user-credentials\n      name: '@deepseek-ai/dsh-api-user-credentials'\n      config:\n        encryptionKeyFile: ${JSON.stringify(credentialKey)}\n        allowLoopbackHttp: true\n        inferenceBindings:\n          - provider: personal-fixture\n            baseURL: ${JSON.stringify(inferenceBase)}\n            credentialName: Test key\n`, { flag: 'a' })
  await writeFile(overlay, `- id: llm-pi-ai\n  config:\n    providers:\n      personal-fixture:\n        displayName: Personal fixture\n        credentialScope: request\n        apiKeyEnv: PERSONAL_FIXTURE_API_KEY\n        api: openai-completions\n        baseURL: ${JSON.stringify(inferenceBase)}\n        models:\n          - id: personal-model\n            name: Personal model\n`, { flag: 'a' })
  await writeFile(overlay, '- id: ui-user-credentials\n  disabled: false\n', { flag: 'a' })
  const scaffold = await launchWebScaffold({ firstUse: true, accountAuthentication: true, extraOverlayPath: overlay,
    compareReplaySession: false,
    replayFixture: fileURLToPath(new URL('../../../snapshots/web/lifecycle-chrome/session.v4.jsonl', import.meta.url)) })
  expect([...scaffold.ctx.loader.entries()].filter(entry => entry.options.name.includes('user-credentials'))
    .map(entry => ({ name: entry.options.name, disabled: entry.disabled, state: entry.fiber?.state })))
    .toEqual(expect.arrayContaining([expect.objectContaining({ name: '@deepseek-ai/dsh-client-ui-user-credentials', disabled: false })]))
  expect(scaffold.ctx.clientModules.graph().entries.map(entry => entry.id)).toContain('@deepseek-ai/dsh-client-ui-user-credentials')
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
    for (const page of [alicePage, bobPage]) await page.addInitScript(() => {
      Object.defineProperty(globalThis, '__ModuleLoader__', { configurable: true, set(target: ClientModuleLoaderTarget) {
        Object.defineProperty(globalThis, '__ModuleLoader__', { configurable: true, writable: true, value: target })
        const create = target.create.bind(target)
        target.create = function (options) {
          const cordis = options.staticModules['@deepseek-ai/cordis'] as { RegistryService: typeof RegistryService }
          const prototype = cordis.RegistryService.prototype
          // eslint-disable-next-line @typescript-eslint/unbound-method -- apply preserves the real registry receiver.
          const plugin = prototype.plugin
          prototype.plugin = function (...args: Parameters<RegistryService['plugin']>) {
            prototype.plugin = plugin
            Reflect.set(globalThis, '__issue13Client', this.ctx.root)
            return plugin.apply(this, args)
          }
          return create(options)
        }
      } })
    })
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
      await page.evaluate(async () => {
        const ctx = Reflect.get(globalThis, '__issue13Client') as Context
        const entry = [...ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-client-ui-user-credentials')
        if (entry?.fiber === undefined) throw new Error('Personal credential Client entry is missing')
        await entry.fiber.await()
        if (!ctx.get('remote.userCredentials')) throw new Error('Personal credential Client namespace is missing')
      })
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
    // Personal credentials remain separate even when both accounts choose the same name.
    expect(await rpc(alice.request, 'userCredentials/list', {})).toEqual({ ok: true, value: [] })
    const credentialSecrets = [randomUUID(), randomUUID()]
    for (const [index, page] of [alicePage, bobPage].entries()) {
      await page.getByRole('button', { name: 'My credentials', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'My credentials', exact: true })
      await dialog.getByText('No credentials saved.', { exact: true }).waitFor()
      await dialog.getByLabel('Name', { exact: true }).fill('Test key')
      await dialog.getByLabel('Credential value', { exact: true }).fill(credentialSecrets[index]!)
      await dialog.getByRole('button', { name: 'Save credential', exact: true }).click()
      await dialog.getByText('Test key', { exact: true }).waitFor()
      expect(await dialog.getByLabel('Credential value', { exact: true }).inputValue()).toBe('')
      await dialog.getByRole('button', { name: 'Check storage', exact: true }).click()
      await page.getByRole('alert').getByText('The saved credential can be read by the server.', { exact: true }).waitFor()
      if (index === 0) await compareOrRefreshGolden(
        fileURLToPath(new URL('./expected/multiuser/credentials.expected.md', import.meta.url)),
        await dialog.ariaSnapshot(), webSnapshotMode())
      if (index === 0) {
        for (const colorScheme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme })
          await page.screenshot({ path: join(tmpdir(), `issue13-credentials-${colorScheme}.png`) })
        }
        await page.setViewportSize({ width: 390, height: 844 })
        await page.screenshot({ path: join(tmpdir(), 'issue13-credentials-mobile.png') })
        for (const control of [dialog.getByLabel('Credential value', { exact: true }), dialog.getByRole('button', { name: 'Save credential', exact: true })]) {
          const box = await control.boundingBox()
          if (box === null) throw new Error('Credential controls must remain visible at 390px')
          expect(box.x).toBeGreaterThanOrEqual(0)
          expect(box.x + box.width).toBeLessThanOrEqual(390)
        }
        await page.setViewportSize({ width: 1280, height: 720 })
      }
      expect(await page.locator('body').innerText()).not.toContain(credentialSecrets[index]!)
      await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    }
    const credentialLists = await Promise.all([
      rpc(alice.request, 'userCredentials/list', {}),
      rpc(bob.request, 'userCredentials/list', {}),
    ])
    const [aliceCredentials, bobCredentials] = credentialLists
    if (!aliceCredentials.ok || !bobCredentials.ok) throw new Error('Credential lists must be readable')
    const metadata = z.array(z.object({ id: z.uuid(), name: z.string(), configured: z.literal(true),
      createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() }).strict())
    const aliceCredential = metadata.parse(aliceCredentials.value)[0]
    const bobCredential = metadata.parse(bobCredentials.value)[0]
    if (aliceCredential === undefined || bobCredential === undefined) throw new Error('Both accounts must have one credential')
    expect(aliceCredential.id).not.toBe(bobCredential.id)
    for (const method of ['check', 'delete', 'replace']) {
      const request = { id: aliceCredential.id, ...(method === 'replace' ? { value: 'forbidden' } : {}) }
      expect(await rpc(bob.request, `userCredentials/${method}`, { request })).toMatchObject({ ok: false, error: { code: 'user-credentials/not-found' } })
    }
    for (const secret of credentialSecrets) {
      expect(JSON.stringify(credentialLists)).not.toContain(secret)
      for (const session of scaffold.ctx.sessions.list()) expect(JSON.stringify(session.snapshotEvents())).not.toContain(secret)
    }
    const aliceSession = scaffold.ctx.multiuser.ownedSessions(aliceUser.userId)[0]!
    const bobSession = scaffold.ctx.multiuser.ownedSessions(bobUser.userId)[0]!
    for (const [index, [client, sessionId]] of ([[alice.request, aliceSession], [bob.request, bobSession]] as const).entries()) {
      const selected = await rpc(client, 'session/selectModel', { request: {
        sessionId, provider: 'personal-fixture', model: 'personal-model',
      } })
      expect(selected, JSON.stringify(selected)).toMatchObject({ ok: true })
      const settled = scaffold.whenTurnSettled()
      expect(await rpc(client, 'session/prompt', { request: {
        sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Test personal inference.' }],
      } })).toMatchObject({ ok: true })
      expect(await settled).toBe(sessionId)
      expect(inferenceCalls[index]?.authorization).toBe('Bearer ' + credentialSecrets[index]!)
    }
    for (const secret of credentialSecrets) {
      expect(JSON.stringify(inferenceCalls.map(call => call.body))).not.toContain(secret)
      for (const session of scaffold.ctx.sessions.list()) expect(JSON.stringify(session.snapshotEvents())).not.toContain(secret)
    }
    // A selected model must not borrow the other account's key after deletion.
    expect(await rpc(bob.request, 'userCredentials/delete', { request: { id: bobCredential.id } })).toMatchObject({ ok: true })
    const deniedTurn = scaffold.whenTurnSettled()
    expect(await rpc(bob.request, 'session/prompt', { request: {
      sessionId: bobSession, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Must not use Alice credentials.' }],
    } })).toMatchObject({ ok: true })
    expect(await deniedTurn).toBe(bobSession)
    expect(inferenceCalls).toHaveLength(2)
    expect(JSON.stringify(scaffold.ctx.sessions.get(bobSession)!.snapshotEvents())).toContain('MISSING_CREDENTIAL')
    const fallback = scaffold.ctx.agentDefaultModel.currentSelection()
    expect(await rpc(alice.request, 'session/selectModel', { request: { sessionId: aliceSession, ...fallback } })).toMatchObject({ ok: true })
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
