/** Opt-in real Web, Vultr inference and VM acceptance; all cloud resources belong to one disposable deployment. */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, glob } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { expect, test } from 'vitest'
import { z } from 'zod'
import { REPO_ROOT, requireDist, writeComposerDraft } from './support.ts'

const configPath = process.env.DSH_VULTR_TEST_CONFIG
const inferenceKeyPath = process.env.DSH_VULTR_INFERENCE_KEY_FILE
const fixture = fileURLToPath(new URL('./fixtures/workspace-spreadsheet/', import.meta.url))
const configuration = z.looseObject({ apiKeyFile: z.string(), apiEndpoint: z.string().default('https://api.vultr.com/v2') })
const workspaceResult = z.object({ workspace: z.object({ workspaceId: z.string(), title: z.string() }) })
const cloudRecord = z.looseObject({ state: z.string(), instanceId: z.string().optional(), snapshotId: z.string().optional(),
  generation: z.string() })
const normalizeCsv = (text: string): string => text.replace(/^\uFEFF/u, '').replaceAll('\r\n', '\n').trim()

function completion(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0 || signal === 'SIGTERM') resolve()
      else reject(new Error(`Acceptance child exited with code ${String(code)} and signal ${String(signal)}`))
    })
  })
}

async function rpc(context: BrowserContext, base: string, method: string, args: object): Promise<unknown> {
  const response = await context.request.post(new URL('api/' + method, base).href, {
    headers: { origin: new URL(base).origin },
    data: { type: 'client-request', rpcId: randomUUID(), method, payload: { args } },
  })
  expect(response.ok(), `${method}: HTTP ${response.status()}`).toBe(true)
  const result = z.object({ result: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value: z.unknown() }),
    z.object({ ok: z.literal(false), error: z.looseObject({ code: z.string() }) }),
  ]) }).parse(await response.json()).result
  if (!result.ok) throw new Error(`${method}: ${result.error.code}`)
  return result.value
}

test.skipIf(configPath === undefined || inferenceKeyPath === undefined || process.platform !== 'linux')(
  'real sales workflow preserves files across sessions, isolation, closure, restoration and idle reclamation',
  { timeout: 7_200_000, retry: 0 }, async () => {
    if (configPath === undefined || inferenceKeyPath === undefined) throw new Error('Both credential configuration paths are required')
    requireDist()
    const initial = configuration.parse(JSON.parse(await readFile(configPath, 'utf8')))
    const cloudKey = (await readFile(initial.apiKeyFile, 'utf8')).trim()
    const deploymentId = 'issue12-' + randomUUID().slice(0, 12)
    const root = await mkdtemp(join(tmpdir(), 'antfarm-spreadsheet-'))
    const runDir = join(REPO_ROOT, '.playwright-mcp', deploymentId)
    const home = join(root, 'home')
    const agents = join(root, 'agents')
    const state = join(root, 'cloud')
    const overlay = join(root, 'acceptance.patch.yml')
    const settings = { ...initial, deploymentId, stateRoot: state, maxInstances: 2 }
    const password = randomUUID()
    const username = 'spreadsheet-acceptance'
    const nodeImport = pathToFileURL(createRequire(join(REPO_ROOT, 'package.json')).resolve('tsx/esm')).href
    const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: agents,
      DSH_MULTIUSER_WORKSPACE_ROOT: join(root, 'workspaces'), DSH_VULTR_CONFIG_JSON: JSON.stringify(settings),
      TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.json') }
    const events: { step: string; at: string; details?: unknown }[] = []
    const failures: unknown[] = []
    let server: { child: ChildProcess; done: Promise<void>; base: string } | undefined
    let browser: Browser | undefined
    let context: BrowserContext | undefined
    let page: Page | undefined
    let success = false
    await mkdir(runDir, { recursive: true })
    await mkdir(home, { recursive: true, mode: 0o700 })
    await writeFile(join(runDir, 'run.json'), JSON.stringify({ deploymentId, root, runDir,
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim() !== '',
      provider: 'vultr', model: 'deepseek-v4.1-flash-1017', maxInstances: 2, initialIdleTimeoutMs: 3_600_000,
      finalIdleTimeoutMs: 5000, realModel: true, realCloud: true, browser: 'isolated headless Playwright',
      overlays: ['antfarm-web', 'harness-vultr', 'pin-browse-picker', 'acceptance timing'] }, null, 2) + '\n')

    async function record(step: string, details?: unknown): Promise<void> {
      events.push({ step, at: new Date().toISOString(), details })
      await writeFile(join(runDir, 'steps.json'), JSON.stringify(events, null, 2) + '\n')
      console.log(`spreadsheet acceptance: ${step}`)
    }
    async function cloud(path: string, method = 'GET'): Promise<unknown> {
      const response = await fetch(initial.apiEndpoint.replace(/\/$/u, '') + path, {
        method, headers: { Authorization: 'Bearer ' + cloudKey }, signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok && response.status !== 404) throw new Error(`Cloud ${method} ${path}: HTTP ${response.status}`)
      return response.status === 204 || response.status === 404 ? undefined : await response.json() as unknown
    }
    async function inventory(kind: 'instances' | 'snapshots') {
      const items: { id: string; tags?: string[]; description?: string }[] = []
      let cursor: string | undefined
      const seen = new Set<string>()
      do {
        const response = await cloud('/' + kind + '?per_page=100' + (cursor === undefined ? '' : '&cursor=' + encodeURIComponent(cursor)))
        const value = z.object({ meta: z.object({ links: z.object({ next: z.string().nullable() }) }) }).parse(response)
        items.push(...(kind === 'instances'
          ? z.object({ instances: z.array(z.object({ id: z.string(), tags: z.array(z.string()) })) }).parse(response).instances
          : z.object({ snapshots: z.array(z.object({ id: z.string(), description: z.string() })) }).parse(response).snapshots))
        cursor = value.meta.links.next || undefined
        if (cursor !== undefined) {
          if (seen.has(cursor) || seen.size >= 100) throw new Error('Cloud inventory pagination did not complete')
          seen.add(cursor)
        }
      } while (cursor !== undefined)
      return items.filter(item => kind === 'instances' ? item.tags?.includes('antfarm-' + deploymentId)
        : item.description?.startsWith('antfarm-' + deploymentId + '-'))
    }
    async function stopServer(): Promise<void> {
      if (server === undefined) return
      const captured = server
      server = undefined
      captured.child.kill('SIGTERM')
      await captured.done
    }
    async function startServer(idleTimeoutMs: number): Promise<string> {
      await writeFile(overlay, `- id: sandbox-idle\n  config:\n    idleTimeoutMs: ${idleTimeoutMs}\n    sweepIntervalMs: 1000\n`)
      const child = spawn(process.execPath, ['--import', nodeImport, join(REPO_ROOT, 'apps/cli/src/bin.ts'),
        'web', '--patch', join(REPO_ROOT, 'apps/cli/config/antfarm-web.patch.yml'),
        '--patch', join(REPO_ROOT, 'apps/cli/config/examples/harness-vultr.patch.yml'),
        '--patch', join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml'), '--patch', overlay,
        '--no-open', '--port', '0'],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
      const done = completion(child)
      void done.catch(() => {}) // The owning startup or teardown awaits and reports this failure.
      server = { child, done, base: '' }
      let output = ''
      const ready = Promise.withResolvers<string>()
      const deadline = setTimeout(() => { ready.reject(new Error('Web startup exceeded three minutes')) }, 180_000)
      const collect = (chunk: Buffer): void => {
        output += chunk.toString()
        const address = /dsh web: (http:\/\/[^\s]+)/u.exec(output)?.[1]
        if (address !== undefined) ready.resolve(address)
      }
      child.stdout?.on('data', collect)
      child.stderr?.on('data', collect)
      void done.then(() => { ready.reject(new Error('Web process exited before startup completed')) }, (error: unknown) => { ready.reject(error) })
      try {
        const address = await ready.promise
        server.base = new URL(address).origin + '/'
        await record('server-ready', { origin: server.base, idleTimeoutMs })
        return server.base
      } finally {
        clearTimeout(deadline)
        await writeFile(join(runDir, `startup-${idleTimeoutMs}.log`), output.replace(/token=[^\s&]+/gu, 'token=<redacted>'))
      }
    }
    async function screenshot(name: string): Promise<void> {
      if (page === undefined) throw new Error('Browser has not started')
      await page.screenshot({ path: join(runDir, name + '.png') })
      await writeFile(join(runDir, name + '.aria.txt'), await page.locator('body').ariaSnapshot())
    }
    async function stateOf(id: string) { return cloudRecord.parse(JSON.parse(await readFile(join(state, id, 'state.json'), 'utf8'))) }

    try {
      const provision = spawn(process.execPath, ['--import', nodeImport, join(REPO_ROOT, 'scripts/multiuser-provision.ts'),
        '--storage-root', join(home, 'storages'), '--username', username],
      { cwd: REPO_ROOT, env: { ...env, DSH_MULTIUSER_PASSWORD: password }, stdio: 'ignore' })
      await completion(provision)
      let base = await startServer(3_600_000)
      browser = await chromium.launch({ args: ['--no-sandbox'] })
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 },
        recordVideo: { dir: join(runDir, 'videos'), size: { width: 1440, height: 900 } } })
      page = await context.newPage()
      const currentPage = page
      const currentContext = context
      currentPage.setDefaultTimeout(30_000)
      async function login(): Promise<void> {
        await currentContext.clearCookies()
        await currentPage.goto(base)
        await currentPage.getByLabel('Username', { exact: true }).fill(username)
        await currentPage.getByLabel('Password', { exact: true }).fill(password)
        await currentPage.getByRole('button', { name: 'Sign in', exact: true }).click()
        await currentPage.locator('.dsh-account').getByText(username, { exact: true }).waitFor()
      }
      await login()
      const inferenceKey = (await readFile(inferenceKeyPath, 'utf8')).trim()
      await rpc(currentContext, base, 'userCredentials/create', { request: { name: 'Vultr API Key', value: inferenceKey } })
      function workspaceRow(title: string) {
        return currentPage.getByRole('treeitem').filter({ has: currentPage.getByRole('button', {
          name: 'Workspace actions for ' + title, exact: true, includeHidden: true,
        }) }).first()
      }
      async function workspace(title: string, first = false) {
        const created = currentPage.waitForResponse(response => new URL(response.url()).pathname.endsWith('/api/workspace/create'))
        await currentPage.getByRole('button', { name: first ? 'Choose workspace' : 'Add workspace', exact: true }).click()
        const response = await created
        const envelope = z.object({ result: z.object({ ok: z.literal(true), value: workspaceResult }) }).parse(await response.json())
        await currentPage.locator('[data-composer-input][contenteditable="true"]').first().waitFor()
        const createdWorkspace = envelope.result.value.workspace
        await rpc(currentContext, base, 'workspace/rename', { request: { workspaceId: createdWorkspace.workspaceId, title } })
        await workspaceRow(title).hover()
        await currentPage.getByRole('button', { name: 'New session in ' + title, exact: true }).waitFor()
        return { ...createdWorkspace, title }
      }
      async function choose(title: string, sessionId: string): Promise<void> {
        const row = workspaceRow(title)
        if (await row.getAttribute('aria-expanded') !== 'true') await row.click()
        await currentPage.locator(`[data-row-key="session:${sessionId}"]`).click()
        await currentPage.locator(`[data-conversation-session="${sessionId}"]`).waitFor()
      }
      async function prompt(text: string, done: string): Promise<void> {
        const input = currentPage.locator('[data-composer-input][contenteditable="true"]').first()
        await writeComposerDraft(currentPage, input, text)
        await input.press('Enter')
        await Promise.race([
          currentPage.getByText(done, { exact: true }).last().waitFor({ timeout: 600_000 }),
          currentPage.getByText('The model service rejected the credential. Check your personal API key and its permissions.', { exact: true })
            .waitFor({ timeout: 600_000 }).then(() => { throw new Error('Real inference rejected the configured personal credential') }),
        ])
      }
      async function panel() {
        await currentPage.getByRole('button', { name: 'Workspace sandbox', exact: true }).click()
        const dialog = currentPage.getByRole('dialog', { name: 'Workspace sandbox', exact: true })
        await dialog.waitFor()
        return dialog
      }
      async function download(name: string): Promise<Buffer> {
        await currentPage.getByRole('button', { name: 'Workspace files', exact: true }).click()
        const dialog = currentPage.getByRole('dialog', { name: 'Workspace files', exact: true })
        await dialog.getByText(name, { exact: true }).waitFor()
        const downloading = currentPage.waitForEvent('download')
        await dialog.getByRole('button', { name: 'Download “' + name + '”', exact: true }).click()
        const item = await downloading
        expect(item.suggestedFilename()).toBe(name)
        const path = join(runDir, name)
        await item.saveAs(path)
        await screenshot(`files-${events.length}`)
        await currentPage.keyboard.press('Escape')
        return readFile(path)
      }
      const a = await workspace('Sales A', true)
      await record('workspace-a', a)
      await currentPage.locator('input[type="file"][aria-label="Upload to workspace"]').setInputFiles({
        name: '销售明细.csv', mimeType: 'text/csv', buffer: await readFile(join(fixture, 'sales.csv')),
      })
      await currentPage.getByText('Uploaded “销售明细.csv” to workspace', { exact: true }).waitFor({ timeout: 1_200_000 })
      await record('upload-complete', await stateOf(a.workspaceId))
      await prompt('请使用 bash 处理工作区内的销售明细.csv。只统计状态为已完成的订单，负数量表示退货。按日期中的年月升序汇总，订单数按记录数计算，净销量为数量之和，净销售额为数量乘单价之和，金额用十进制精确计算并保留两位小数。生成 UTF-8 的月度汇总.csv，表头严格为：月份,订单数,净销量,净销售额。完成后只回复：销售汇总已完成', '销售汇总已完成')
      const expected = await readFile(join(fixture, 'monthly.expected.csv'), 'utf8')
      const monthly = await download('月度汇总.csv')
      expect(normalizeCsv(monthly.toString())).toBe(normalizeCsv(expected))
      const original = await stateOf(a.workspaceId)
      await record('monthly-summary-matches', { sha256: createHash('sha256').update(monthly).digest('hex'), instanceId: original.instanceId })
      const firstSession = await currentPage.locator('[data-conversation-session]').first().getAttribute('data-conversation-session')
      await workspaceRow(a.title).hover()
      await currentPage.getByRole('button', { name: 'New session in ' + a.title, exact: true }).click()
      await expect.poll(() => currentPage.locator('[data-conversation-session]').first().getAttribute('data-conversation-session')).not.toBe(firstSession)
      const sharedSession = await currentPage.locator('[data-conversation-session]').first().getAttribute('data-conversation-session')
      if (sharedSession === null) throw new Error('The shared Workspace Session is missing')
      await prompt('请使用 bash 读取工作区已有的月度汇总.csv，合计所有月份，生成年度汇总.json，键名为 orders、quantity、amount；前两项为整数，amount 为保留两位小数的字符串。不要重新生成月度汇总.csv。完成后只回复：同工作区续接已完成', '同工作区续接已完成')
      expect(JSON.parse((await download('年度汇总.json')).toString())).toEqual({ orders: 9, quantity: 16, amount: '1719.50' })
      expect((await stateOf(a.workspaceId)).instanceId).toBe(original.instanceId)
      await record('second-session-shares-files-and-vm')
      await prompt('请测试 bash 超时：执行 echo $$ > timeout.pid; sleep 20，timeoutMs 必须设为 1000。收到超时错误后，再用 bash 检查 timeout.pid 中的进程已经退出，并创建 timeout-confirmed.txt，内容为 TIMEOUT_PROCESS_GONE。不要重复 sleep 命令。检查成功后只回复：超时清理已确认', '超时清理已确认')
      await currentPage.getByRole('button', { name: /^Completed in /u }).last().click()
      const timeout = currentPage.locator('[data-tool="bash"][data-state="error"]').filter({ hasText: 'Command timed out after 1000ms.' }).first()
      await timeout.waitFor()
      await timeout.scrollIntoViewIfNeeded()
      await screenshot('timeout-tool-error')
      expect((await download('timeout-confirmed.txt')).toString().trim()).toBe('TIMEOUT_PROCESS_GONE')
      await record('timeout-and-process-cleanup')
      const b = await workspace('Isolated B')
      await record('workspace-b', b)
      await prompt('请使用 bash 检查当前工作区的销售明细.csv、月度汇总.csv 和年度汇总.json 均不存在。检查通过后创建 isolation.txt，内容为 WORKSPACE_ISOLATED。完成后只回复：工作区隔离已确认', '工作区隔离已确认')
      expect((await download('isolation.txt')).toString().trim()).toBe('WORKSPACE_ISOLATED')
      for (const name of ['销售明细.csv', '月度汇总.csv', '年度汇总.json']) {
        const missing = await currentContext.request.get(new URL('api/workspace/downloadFileBinary?'
          + new URLSearchParams({ workspaceId: b.workspaceId, path: name }).toString(), base).href)
        expect(missing.status()).toBe(404)
      }
      expect((await stateOf(b.workspaceId)).instanceId).not.toBe(original.instanceId)
      await record('separate-workspace-files-and-vm')
      const c = await workspace('Capacity C')
      const capacity = await panel()
      await capacity.getByRole('button', { name: 'Open sandbox', exact: true }).click()
      await capacity.getByRole('alert').getByText('Sandbox capacity is full. Close one or try again later.', { exact: true }).waitFor()
      expect(await inventory('instances')).toHaveLength(2)
      await screenshot('capacity-full')
      await record('capacity-rejected', { workspaceId: c.workspaceId })
      await currentPage.keyboard.press('Escape')
      await choose(a.title, sharedSession)
      const closing = await panel()
      await closing.getByRole('button', { name: 'Close sandbox', exact: true }).click()
      await closing.getByRole('button', { name: 'Confirm close', exact: true }).click()
      await closing.getByRole('status').getByText('Closed', { exact: true }).waitFor({ timeout: 2_400_000 })
      const saved = await stateOf(a.workspaceId)
      expect(saved.instanceId).toBeUndefined()
      expect(saved.snapshotId).toBeDefined()
      await screenshot('closed-with-snapshot')
      await record('manual-close-saved-and-removed-vm', saved)
      await currentPage.keyboard.press('Escape')
      expect(await download('月度汇总.csv')).toEqual(monthly)
      const reopening = await panel()
      await reopening.getByRole('button', { name: 'Open sandbox', exact: true }).click()
      await reopening.getByRole('status').getByText('Running', { exact: true }).waitFor({ timeout: 1_800_000 })
      const restored = await stateOf(a.workspaceId)
      expect(restored.instanceId).not.toBe(original.instanceId)
      expect(restored.generation).not.toBe(original.generation)
      await currentPage.keyboard.press('Escape')
      expect(await download('销售明细.csv')).toEqual(await readFile(join(fixture, 'sales.csv')))
      expect(await download('月度汇总.csv')).toEqual(monthly)
      await prompt('请使用 bash 读取工作区内的销售明细.csv、月度汇总.csv 和年度汇总.json，确认都可用且年度金额与月度汇总一致。成功后只回复：恢复后任务已验证', '恢复后任务已验证')
      await screenshot('restored-model-confirmation')
      await record('restored-files-and-real-model', restored)
      await stopServer()
      base = await startServer(5000)
      await login()
      await choose(a.title, sharedSession)
      await prompt('请使用 bash 执行 true，成功后只回复：空闲计时已开始', '空闲计时已开始')
      const idle = await panel()
      await expect.poll(async () => (await stateOf(a.workspaceId)).state, { timeout: 2_400_000, interval: 1000 }).toBe('closed')
      await idle.getByRole('button', { name: 'Refresh status', exact: true }).click()
      await idle.getByRole('status').getByText('Closed', { exact: true }).waitFor()
      await screenshot('idle-reclaimed')
      await currentPage.keyboard.press('Escape')
      expect(await download('月度汇总.csv')).toEqual(monthly)
      await record('idle-reclaimed-and-download-preserved')
      const logs: string[] = []
      for await (const path of glob(['**/*.jsonl', '**/*.jsonl.zstd'], { cwd: root })) {
        const bytes = await readFile(join(root, path))
        logs.push((path.endsWith('.zstd') ? zstdDecompressSync(bytes) : bytes).toString('utf8'))
      }
      await writeFile(join(runDir, 'sessions.jsonl'), logs.join('\n'))
      expect(logs.join('\n')).toContain('SANDBOX_EXECUTION_TIMEOUT')
      success = true
    } catch (error) {
      failures.push(error)
      if (page !== undefined) await screenshot('failure').catch((capture: unknown) => failures.push(capture))
    } finally {
      try { await context?.close() } catch (error) { failures.push(error) }
      try { await browser?.close() } catch (error) { failures.push(error) }
      try { await stopServer() } catch (error) { failures.push(error) }
      try {
        for (const item of await inventory('instances')) await cloud('/instances/' + item.id, 'DELETE')
        for (const item of await inventory('snapshots')) await cloud('/snapshots/' + item.id, 'DELETE')
        await expect.poll(() => inventory('instances'), { timeout: 180_000, interval: 1000 }).toEqual([])
        await expect.poll(() => inventory('snapshots'), { timeout: 180_000, interval: 1000 }).toEqual([])
        await record('owned-cloud-resources-removed')
      } catch (error) { failures.push(error) }
      await writeFile(join(runDir, 'result.json'), JSON.stringify({ success: success && failures.length === 0,
        completed: events.map(event => event.step), errors: failures.map(error => error instanceof Error ? error.message : String(error)) }, null, 2) + '\n')
      console.log('spreadsheet acceptance evidence:', runDir)
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Real spreadsheet acceptance did not complete')
  },
)
