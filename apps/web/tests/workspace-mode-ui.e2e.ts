/** Workspace mode UI through the shipped Loader and durable coordinator; only external execution is a test adapter. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type APIRequestContext } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import type { WorkspaceCreateValue, WorkspaceModeValue } from '@deepseek-ai/dsh-api-workspace-controller'
import type { WorkspaceModeRuntime } from '@deepseek-ai/dsh-workspace/types'
import { compareOrRefreshGolden, launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { requireBuilt } from './support.ts'

it('configures four modes, preserves permanent locks, and keeps Workspace admission independent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-mode-ui-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const overlay = join(root, 'workspace-mode-ui.yml')
  await writeFile(overlay, JSON.stringify([{ id: 'multiuser', config: { workspaceRoot: join(root, 'workspaces') } }]))
  const scaffold = await launchWebScaffold({ firstUse: true, accountAuthentication: true, compareReplaySession: false,
    extraOverlayPath: [fileURLToPath(new URL('../../cli/config/antfarm-web.patch.yml', import.meta.url)), overlay] })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  try {
    const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => { errors.push(error.message) })
    const password = randomUUID()
    await scaffold.ctx.multiuser.provisionUser('alice', password)
    const base = new URL(scaffold.authenticatedUrl).origin
    await page.goto(base)
    await page.getByLabel('Username', { exact: true }).fill('alice')
    await page.getByLabel('Password', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.getByRole('button', { name: 'Choose workspace', exact: true }).waitFor()
    expect(scaffold.ctx.workspaceRegistry.list()).toHaveLength(0)
    await page.getByRole('button', { name: 'Choose workspace', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Workspace configuration', exact: true })
    await dialog.waitFor()
    const a = scaffold.ctx.workspaceRegistry.list()[0]
    if (a === undefined) throw new Error('Workspace creation did not register a row')
    const defaultMode = dialog.getByRole('radio', { name: 'Single session · VM (default)', exact: true })
    const committedMode = dialog.getByRole('radio', { name: 'Multiple sessions · VM', exact: true })
    await dialog.getByRole('alert').getByText('The execution environment is unavailable. Contact the administrator.', { exact: true }).waitFor()
    expect(await committedMode.isChecked()).toBe(true)
    expect(await dialog.getByRole('radio').count()).toBe(1)
    expect(await page.title()).toBe('Antfarm')
    expect(a.modeConfig.mode).toBe('multi-vm')
    expect(scaffold.ctx.sessions.list()).toHaveLength(0)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await page.reload()
    await page.getByRole('button', { name: 'Choose workspace', exact: true }).waitFor()
    expect(scaffold.ctx.sessions.list()).toHaveLength(0)
    const workspaceRow = (title: string) => page.getByRole('treeitem').filter({ has: page.getByText(title, { exact: true }) }).first()
    async function configure(title: string) {
      const row = workspaceRow(title)
      await row.hover()
      await row.getByRole('button', { name: 'Workspace configuration', exact: true }).click()
      await dialog.waitFor()
    }
    const { WorkspaceModeError } = requireBuilt('@deepseek-ai/dsh-workspace') as typeof import('@deepseek-ai/dsh-workspace')
    let capacityExhausted = true
    const runtime: WorkspaceModeRuntime = { supportedModes: ['single-vm', 'multi-vm', 'single-docker', 'multi-docker'],
      prepare: async (change, signal) => {
        signal.throwIfAborted()
        if (capacityExhausted && change.to === 'single-vm') {
          throw new WorkspaceModeError('workspace/mode-single-vm-capacity', { workspaceId: change.workspaceId })
        }
      },
      settle: async (_change, _decision, signal) => { signal.throwIfAborted() } }
    scaffold.ctx.effect(() => scaffold.ctx.workspaceRegistry.modes.registerRuntime(runtime))
    await configure(a.title)
    await defaultMode.waitFor()
    expect(await defaultMode.isChecked()).toBe(true)
    await dialog.getByRole('button', { name: 'Save mode', exact: true }).click()
    await dialog.getByRole('alert').getByText('No single-session VM slots are available.', { exact: false }).waitFor()
    await expect.poll(() => committedMode.isChecked()).toBe(true)
    expect(a.modeConfig).toMatchObject({ mode: 'multi-vm', operationState: 'ready' })
    capacityExhausted = false
    const tooltip = page.getByRole('tooltip')
    for (const [mode, label, detail] of [
      ['single-docker', 'Single session · Docker', 'lightweight Docker container'],
      ['multi-docker', 'Multiple sessions · Docker', 'share one Docker container'],
      ['multi-vm', 'Multiple sessions · VM', 'disk snapshot'],
      ['single-vm', 'Single session · VM', 'stored separately in the cloud'],
    ] as const) {
      await dialog.getByRole('button', { name: `About ${label}`, exact: true }).hover()
      await tooltip.waitFor()
      const items = tooltip.getByRole('listitem')
      expect(await items.allTextContents()).toHaveLength(4)
      expect(await items.locator('strong').allTextContents()).toEqual(['Sessions', 'How it runs', 'Benefit', 'Best for'])
      expect(await tooltip.getByRole('list').evaluate(element => getComputedStyle(element).rowGap)).toBe('6px')
      expect(await tooltip.innerText()).toContain(detail)
      await dialog.getByRole('radio', { name: label, exact: true }).check()
      await dialog.getByRole('button', { name: 'Save mode', exact: true }).click()
      await expect.poll(() => a.modeConfig.mode).toBe(mode)
      await expect.poll(() => dialog.getByRole('button', { name: 'Save mode', exact: true }).isDisabled()).toBe(true)
    }
    const expected = fileURLToPath(new URL('./expected/workspace-mode-ui/', import.meta.url))
    const scrub = (text: string) => text.replaceAll(`  - paragraph: ${a.title}\n`, '  - paragraph: Workspace A\n').replaceAll(a.id, '<workspace-a>')
      .replaceAll(a.modeConfig.firstSessionId ?? '\0', '<first-session>')
    await compareOrRefreshGolden(join(expected, 'configurable.expected.md'), scrub(await dialog.ariaSnapshot()), webSnapshotMode())
    await page.keyboard.press('Escape')
    async function rpc<T>(client: APIRequestContext, method: string, request: unknown): Promise<T> {
      const response = await client.post(`${base}/api/${method}`, { headers: { origin: base },
        data: { type: 'client-request', rpcId: randomUUID(), method, payload: { args: { request } } } })
      expect(response.status()).toBe(200)
      const reply = await response.json() as { result: { ok: boolean; value: T; error?: unknown } }
      if (!reply.result.ok) throw new Error(`Remote rejected: ${JSON.stringify(reply.result.error)}`)
      return reply.result.value
    }
    const b = (await rpc<WorkspaceCreateValue>(context.request, 'workspace/create', { title: 'Workspace B' })).workspace
    await configure(a.title)
    await dialog.getByRole('radio', { name: 'Single session · Docker', exact: true }).check()
    const changed = await rpc<WorkspaceModeValue>(context.request, 'workspace/setMode', {
      workspaceId: a.id, mode: 'multi-docker', expectedRevision: a.modeConfig.revision })
    await dialog.getByRole('alert').getByText('Configuration changed. Refresh before choosing again.', { exact: true }).waitFor()
    expect(await dialog.getByRole('button', { name: 'Save mode', exact: true }).isDisabled()).toBe(true)
    await dialog.getByRole('button', { name: 'Refresh configuration', exact: true }).click()
    await dialog.getByRole('radio', { name: 'Single session · VM', exact: true }).check()
    await dialog.getByRole('button', { name: 'Save mode', exact: true }).click()
    await expect.poll(() => a.modeConfig.revision).toBeGreaterThan(changed.config.revision)
    await page.keyboard.press('Escape')
    // New Session on a fresh Workspace asks for explicit confirmation through the same mode form.
    await workspaceRow(a.title).hover()
    await workspaceRow(a.title).getByRole('button', { name: `New session in ${a.title}`, exact: true }).click()
    await dialog.getByRole('button', { name: 'Start session', exact: true }).click()
    await expect.poll(() => a.modeConfig.firstSessionId).not.toBeNull()
    const first = a.modeConfig.firstSessionId
    await dialog.waitFor({ state: 'hidden' })
    await configure(a.title)
    await dialog.getByText('The first session has been created. The mode is permanently locked.', { exact: true }).waitFor()
    expect(await dialog.getByRole('radio', { name: 'Single session · VM', exact: true }).isDisabled()).toBe(true)
    await compareOrRefreshGolden(join(expected, 'locked.expected.md'), scrub(await dialog.ariaSnapshot()), webSnapshotMode())
    await dialog.getByRole('button', { name: 'About Multiple sessions · VM', exact: true }).click()
    await tooltip.getByText(/disk snapshot/).waitFor()
    await page.keyboard.press('Escape')
    await tooltip.waitFor({ state: 'hidden' })
    expect(await dialog.isVisible()).toBe(true)
    await page.keyboard.press('Escape')
    await workspaceRow(a.title).hover()
    expect(await workspaceRow(a.title).getByRole('button', { name: `New session in ${a.title}`, exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'New session', exact: true }).count()).toBe(0)
    await page.keyboard.press('Control+Alt+n')
    expect(a.sessionIds).toEqual([first])
    await page.reload()
    await configure(a.title)
    await dialog.getByText('The first session has been created. The mode is permanently locked.', { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await configure('Workspace B')
    await dialog.getByRole('radio', { name: 'Multiple sessions · Docker', exact: true }).check()
    await dialog.getByRole('button', { name: 'Save mode', exact: true }).click()
    const multi = scaffold.ctx.workspaceRegistry.get(b.workspaceId)
    if (multi === undefined) throw new Error('Second Workspace disappeared')
    await expect.poll(() => multi.modeConfig.mode).toBe('multi-docker')
    expect(a.modeConfig.mode).toBe('single-vm')
    await page.keyboard.press('Escape')
    await workspaceRow('Workspace B').hover()
    await workspaceRow('Workspace B').getByRole('button', { name: 'New session in Workspace B', exact: true }).click()
    await dialog.getByRole('button', { name: 'Start session', exact: true }).click()
    await expect.poll(() => multi.sessionIds.length).toBe(1)
    await dialog.waitFor({ state: 'hidden' })
    await workspaceRow('Workspace B').hover()
    await expect.poll(() => workspaceRow('Workspace B')
      .getByRole('button', { name: 'New session in Workspace B', exact: true }).count()).toBe(1)
    expect(a.sessionIds).toEqual([first])
    // Narrow viewports keep the row's configuration entry reachable and the modal inside the window.
    await page.setViewportSize({ width: 390, height: 844 })
    if (!await page.getByRole('dialog', { name: 'Navigation', exact: true }).isVisible()) {
      await page.locator('[data-sidebar-opener]').click()
    }
    await configure(a.title)
    const bounds = await dialog.boundingBox()
    expect(bounds).not.toBeNull()
    if (bounds !== null) { expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(390) }
    await mkdir(fileURLToPath(new URL('../../../.playwright-mcp/', import.meta.url)), { recursive: true })
    const shots = await mkdtemp(fileURLToPath(new URL('../../../.playwright-mcp/issue45-', import.meta.url)))
    await page.screenshot({ path: join(shots, 'light.png') })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: join(shots, 'dark.png') })
    await page.mouse.click(1, 1)
    await dialog.waitFor({ state: 'hidden' })
    await configure(a.title)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    expect(errors).toEqual([])
  } finally { await browser.close() }
})

it.runIf(process.platform === 'linux')('lets an Antfarm visitor choose any sandbox mode before the first session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'antfarm-guest-modes-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const overlay = join(root, 'guest.yml')
  await writeFile(overlay, JSON.stringify([
    { id: 'multiuser', config: { workspaceRoot: join(root, 'workspaces'), guestAccess: true } },
    { id: 'antfarm-workbench', config: { workbench: true } },
  ]))
  const scaffold = await launchWebScaffold({ firstUse: true, accountAuthentication: true, compareReplaySession: false,
    extraOverlayPath: [fileURLToPath(new URL('../../cli/config/antfarm-web.patch.yml', import.meta.url)), overlay] })
  onTestFinished(() => scaffold.close())
  scaffold.ctx.effect(() => scaffold.ctx.workspaceRegistry.modes.registerRuntime({
    supportedModes: ['single-vm', 'multi-vm', 'single-docker', 'multi-docker'],
    prepare: async () => {},
    settle: async () => {},
  }))
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage({ locale: 'en-US' })
    await page.goto(new URL(scaffold.authenticatedUrl).origin)
    await page.getByRole('button', { name: 'Try it as a guest', exact: true }).click()
    await page.getByRole('heading', { name: 'What should your agent work on?' }).waitFor()
    expect(await page.title()).toBe('Antfarm')
    await page.getByRole('button', { name: 'New workspace', exact: true }).first().click()
    const setup = page.getByRole('dialog', { name: 'Your workspace, your way' })
    await setup.getByRole('textbox', { name: 'Workspace name' }).fill('Visitor VM test')
    await setup.getByRole('button', { name: 'Create workspace', exact: true }).click()
    const mode = page.getByRole('dialog', { name: 'Workspace configuration', exact: true })
    await expect.poll(() => mode.getByRole('radio').count()).toBe(4)
    const recommended = mode.getByRole('radio', { name: 'Single session · VM (default)', exact: true })
    expect(await recommended.isChecked()).toBe(true)
    expect(scaffold.ctx.sessions.list()).toHaveLength(0)
    await mode.getByRole('button', { name: 'Save mode', exact: true }).click()
    const start = mode.getByRole('button', { name: 'Start session', exact: true })
    await expect.poll(() => start.isEnabled()).toBe(true)
    await start.click()
    await mode.waitFor({ state: 'hidden' })
    await expect.poll(() => scaffold.ctx.workspaceRegistry.list()[0]?.modeConfig).toMatchObject({
      mode: 'single-vm', modeLocked: true,
    })
  } finally { await browser.close() }
})
