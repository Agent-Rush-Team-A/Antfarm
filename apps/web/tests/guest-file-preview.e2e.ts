/** Guest file previews and cross-workspace denials through the shipped Web profile. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type APIRequestContext, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { createMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { launchWebScaffold, compareOrRefreshGolden, webSnapshotMode, type WebScaffold } from './scaffold.ts'

it('lets visitors preview their own retained report and rejects another workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guest-file-preview-'))
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page | undefined
  try {
    const overlay = join(root, 'guest.yml')
    await writeFile(overlay, `- id: multiuser\n  config:\n    workspaceRoot: ${JSON.stringify(join(root, 'workspaces'))}\n    guestAccess: true\n`)
    scaffold = await launchWebScaffold({ firstUse: true, accountAuthentication: true, extraOverlayPath: [
      fileURLToPath(new URL('../../cli/config/antfarm-web.patch.yml', import.meta.url)), overlay,
      fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
    ] })
    browser = await chromium.launch({ args: ['--no-sandbox'] })
    const visitor = await browser.newContext({ locale: 'en-US' })
    const other = await browser.newContext({ locale: 'en-US' })
    page = await visitor.newPage()
    const base = new URL(scaffold.authenticatedUrl).origin
    async function rpc(client: APIRequestContext, method: string, args: object) {
      const response = await client.post(`${base}/api/${method}`, { headers: { origin: base },
        data: { type: 'client-request', rpcId: randomUUID(), method, payload: { args } },
      })
      expect(response.status()).toBe(200)
      return (await response.json() as { result: { ok: boolean; error?: { code: string } } }).result
    }
    await page.goto(base)
    await page.getByRole('button', { name: 'Try it as a guest', exact: true }).click()
    await page.getByRole('button', { name: 'Choose workspace', exact: true }).click()
    await page.getByRole('dialog', { name: 'Workspace configuration', exact: true })
      .getByRole('button', { name: 'Start session', exact: true }).click()
    await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor()
    const workspace = scaffold.ctx.workspaceRegistry.list()[0]
    const agent = scaffold.ctx.agents.list().find(value => value.session.header.cwd === workspace?.path)
    if (workspace === undefined || agent === undefined) throw new Error('Guest session did not open')
    await writeFile(join(workspace.path, 'report.md'), '# Guest revenue\n\nTotal: 814\n')
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Show the sales report.' }],
      source: { kind: 'user' } }), { surfaceOp: 'append' })
    agent.session.append('step/start', { turn: 1, step: 1 })
    const callId = ToolCallId('guest-write-report')
    agent.session.append('tool/call', { turn: 1, step: 1, callId, name: 'write',
      arguments: JSON.stringify({ file_path: 'report.md', content: '# Guest revenue\n\nTotal: 814\n' }),
    })
    agent.session.append('tool/result', { turn: 1, step: 1, message: createMessage({ role: 'tool',
      source: { kind: 'tool', callId }, toolCallId: callId, isError: false,
      content: [{ type: 'text', text: 'Created report.md' }],
    }) }, { surfaceOp: 'append' })
    agent.session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createMessage({
      role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      content: [{ type: 'text', text: 'The report is ready: `report.md`.' }],
    }) }, { surfaceOp: 'append' })
    agent.session.append('step/end', { turn: 1, step: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await scaffold.ctx.sessions.flush(agent.session)
    await page.reload()
    await page.getByRole('button', { name: 'Open report.md in sidebar', exact: true }).first().click()
    const column = page.locator('[data-rightbar-col]')
    await column.getByRole('heading', { name: 'Guest revenue', exact: true }).waitFor()
    expect(await column.innerText()).toContain('Total: 814')
    expect(await column.innerText()).not.toContain('access denied')
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/guest-file-preview/report.expected.md', import.meta.url)),
      (await column.locator('[data-textpreview-state="text"]').ariaSnapshot()).replaceAll(workspace.path, '<workspace>'),
      webSnapshotMode())
    const guest = await other.request.post(`${base}/auth/guest`, { headers: { origin: base }, data: {} })
    expect(guest.status()).toBe(200)
    const sessionId = String(agent.session.id)
    expect(await rpc(other.request, 'workspaceFiles/read', { workspaceFileScopeId: sessionId, path: 'report.md', range: {} }))
      .toMatchObject({ ok: false, error: { code: 'remote-access/denied' } })
    expect(await rpc(visitor.request, 'workspaceFiles/read', { workspaceFileScopeId: sessionId, path: '../secret.txt', range: {} }))
      .toMatchObject({ ok: false, error: { code: 'workspace-file/outside-workspace' } })
    expect(await rpc(visitor.request, 'workspaceFiles/read', { workspaceFileScopeId: sessionId, path: '/workspace/report.md', range: {} }))
      .toMatchObject({ ok: true })
  } catch (cause) {
    await page?.screenshot({ path: '/tmp/guest-file-preview-failure.png' })
    if (page !== undefined) await writeFile('/tmp/guest-file-preview-failure.txt', await page.locator('body').ariaSnapshot())
    throw cause
  } finally {
    try { await browser?.close() } finally {
      try { await scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
    }
  }
})
