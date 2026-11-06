/** Real Loader and prefix-proxied browser acceptance for retained workspace outputs. */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { chown, chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { chromium, type Browser, type Page, type BrowserContext } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, compareOrRefreshGolden, webSnapshotMode, type WebScaffold } from './scaffold.ts'

it.skipIf(process.platform !== 'linux')('loads the documented file overlay with its default limits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-artifact-overlay-'))
  let scaffold: WebScaffold | undefined
  try {
    await writeFile(join(root, 'result'), 'abc')
    scaffold = await launchWebScaffold({ extraOverlayPath:
      fileURLToPath(new URL('../../cli/config/examples/workspace-artifacts.patch.yml', import.meta.url)) })
    const workspace = await scaffold.ctx.workspaceRegistry.create(root)
    const listing = await scaffold.ctx.workspaceArtifacts.list({ workspaceId: workspace.id }, '', new AbortController().signal)
    expect(listing.maxDownloadBytes).toBe(33554432)
    expect(listing.entries).toEqual([{ name: 'result', kind: 'file', bytes: 3 }])
    const entry = [...scaffold.ctx.loader.entries()].find(row => row.options.id === 'workspace-artifacts')
    expect(entry?.options.config).toMatchObject({ maxEntries: 2000, maxDownloadBytes: 33554432 })
  } finally {
    try { await scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
  }
})

it.skipIf(process.platform !== 'linux')('lists and downloads retained files under a mount prefix and rejects unauthorized paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-artifact-browser-'))
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let runner: Server | undefined
  try {
    const socketPath = join(root, 'runner.sock')
    const workspaceRoot = join(root, 'workspaces')
    const sandboxCalls: Array<{ method: string | undefined; path: string | undefined }> = []
    const running = new Set<string | undefined>()
    runner = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        sandboxCalls.push({ method: request.method, path: request.url })
        if (request.method === 'PUT') running.add(request.url)
        if (request.method === 'DELETE') running.delete(request.url)
        response.end(JSON.stringify(running.has(request.url)
          ? { state: 'running', containerId: 'a'.repeat(64) } : { state: 'closed' }))
      })
    })
    await once(runner.listen(socketPath), 'listening')
    const overlay = join(root, 'files.yml')
    await writeFile(overlay, `- id: connection\n  config:\n    multiuser: true\n- insert:\n    - id: multiuser\n      name: '@deepseek-ai/dsh-api-multiuser'\n      config:\n        workspaceRoot: ${JSON.stringify(workspaceRoot)}\n    - id: workspace-artifacts\n      name: '@deepseek-ai/dsh-api-workspace-artifacts'\n      config:\n        maxDownloadBytes: 64\n    - id: harness-sandbox\n      name: '@deepseek-ai/dsh-harness-sandbox'\n      config:\n        workspaceRoot: ${JSON.stringify(workspaceRoot)}\n        socketPath: ${JSON.stringify(socketPath)}\n`)
    // Loader lifecycle is driven explicitly below; native watch readiness belongs to the HMR lane.
    scaffold = await launchWebScaffold({ firstUse: true, accountAuthentication: true, profile: { hmr: false, packages: [] },
      publicMount: { prefix: '/tools/dsh/' }, extraOverlayPath: overlay })
    browser = await chromium.launch({ args: ['--no-sandbox'] })
    const host = scaffold
    const browserHost = browser
    const password = randomUUID()
    const errors: string[] = []
    const urls: string[] = []
    for (const name of ['alice', 'bob']) await host.ctx.multiuser.provisionUser(name, password)
    async function account(name: string) {
      const context = await browserHost.newContext({ locale: 'en-US' })
      const page = await context.newPage()
      page.setDefaultTimeout(30000)
      page.on('pageerror', (error) => { errors.push(error.message) })
      page.on('request', (request) => { urls.push(request.url()) })
      await page.goto(host.authenticatedUrl)
      await page.locator('input[name="username"]').fill(name)
      await page.locator('input[name="password"]').fill(password)
      await page.locator('button[type="submit"]').click()
      const previous = new Set(host.ctx.workspaceRegistry.list().map(workspace => workspace.id))
      await page.getByRole('button', { name: 'Choose workspace', exact: true }).click()
      await page.getByRole('button', { name: 'Workspace files', exact: true }).waitFor()
      const workspace = host.ctx.workspaceRegistry.list().find(workspace => !previous.has(workspace.id))!
      return { context, page, workspace }
    }
    const alice = await account('alice')
    const bob = await account('bob')
    async function sandbox(operation: 'open' | 'close') {
      const result = await alice.page.evaluate(async ({ base, workspaceId, operation }) => {
        const method = 'workspaceSandbox/' + operation
        const response = await fetch(new URL('api/' + method, base), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: operation, method,
            payload: { args: { request: { workspaceId } } } }),
        })
        return await response.json() as { result: { ok: boolean; value?: { state: string } } }
      }, { base: host.baseUrl, workspaceId: alice.workspace.id, operation })
      expect(result.result).toEqual({ ok: true,
        value: { workspaceId: alice.workspace.id, state: operation === 'open' ? 'running' : 'closed' } })
    }
    await sandbox('open')
    const bytes = Buffer.from([0, 255, 128, 114, 101, 115, 117, 108, 116, 10])
    const image = process.env.DSH_WORKSPACE_ARTIFACT_DOCKER_IMAGE
    if (image === undefined) {
      await promisify(execFile)('bash', ['-c', "mkdir -p outputs; printf '\\000\\377\\200result\\n' > 'outputs/月度汇总.bin'"],
        { cwd: alice.workspace.path, timeout: 30000 })
    } else {
      expect(image).toMatch(/^sha256:[a-f0-9]{64}$/u)
      await chown(alice.workspace.path, -1, 10001)
      await chmod(alice.workspace.path, 0o770)
      const container = 'artifact-' + randomUUID()
      const result = await promisify(execFile)('docker', ['run', '--rm', '--name', container, '--network', 'none', '--user', '10001:10001',
        '--mount', `type=bind,src=${alice.workspace.path},dst=/workspace`, '--workdir', '/workspace', image,
        'bash', '-c', "mkdir -p outputs; printf '\\000\\377\\200result\\n' > 'outputs/月度汇总.bin'"], { timeout: 30000 })
      expect(result.stderr).toBe('')
      const existing = await promisify(execFile)('docker', ['ps', '-aq', '--filter', 'name=^/' + container + '$'], { timeout: 30000 })
      expect(existing.stdout.trim()).toBe('')
      console.log('Non-root container exited and was removed before listing/download:', image)
    }
    await sandbox('close')
    expect(running.size).toBe(0)
    expect(sandboxCalls).toEqual([
      { method: 'PUT', path: `/v1/workspaces/${alice.workspace.id}/sandbox` },
      { method: 'DELETE', path: `/v1/workspaces/${alice.workspace.id}/sandbox` },
    ])
    expect(await readFile(join(alice.workspace.path, 'outputs', '月度汇总.bin'))).toEqual(bytes)
    await writeFile(join(alice.workspace.path, 'empty'), '')
    await writeFile(join(alice.workspace.path, 'large'), Buffer.alloc(65))
    await writeFile(join(bob.workspace.path, 'bob-only'), 'bob')
    await writeFile(join(root, 'secret'), 'SECRET')
    await symlink(join(root, 'secret'), join(alice.workspace.path, 'escape'))
    await symlink(root, join(alice.workspace.path, 'outside-directory'))

    const url = (workspaceId: string, path: string) => new URL('api/workspace/downloadFileBinary?'
      + new URLSearchParams({ workspaceId, path }).toString(), host.baseUrl).href
    async function response(page: Page, workspaceId: string, path: string) {
      return page.evaluate(async (url) => {
        const response = await fetch(url)
        return { status: response.status, text: await response.text() }
      }, url(workspaceId, path))
    }
    async function download(context: BrowserContext, page: Page, name: string) {
      const saved = page.waitForEvent('download')
      await page.getByRole('button', { name: 'Download “' + name + '”', exact: true }).click()
      const result = await saved
      expect(result.suggestedFilename()).toBe(name)
      const location = await result.path()
      expect(location).not.toBeNull()
      const content = await readFile(location)
      expect((await context.cookies()).length).toBeGreaterThan(0)
      return content
    }

    await alice.page.getByRole('button', { name: 'Workspace files', exact: true }).click()
    const dialog = alice.page.getByRole('dialog', { name: 'Workspace files', exact: true })
    await dialog.getByRole('button', { name: 'Open folder “outputs”', exact: true }).click()
    await dialog.getByText('月度汇总.bin', { exact: true }).waitFor()
    expect(await download(alice.context, alice.page, '月度汇总.bin')).toEqual(bytes)
    await dialog.getByRole('button', { name: 'Parent folder', exact: true }).click()
    await dialog.getByText('empty', { exact: true }).waitFor()
    expect(await download(alice.context, alice.page, 'empty')).toHaveLength(0)
    await dialog.getByRole('button', { name: 'Download “large”', exact: true }).click()
    await alice.page.getByText('File is too large. Choose a smaller file or contact your administrator.', { exact: true }).waitFor()
    expect(await dialog.getByText('large', { exact: true }).count()).toBe(1)
    expect(await dialog.getByText('escape', { exact: true }).count()).toBe(0)
    expect(await dialog.getByText('outside-directory', { exact: true }).count()).toBe(0)
    expect(await dialog.getByText('bob-only', { exact: true }).count()).toBe(0)
    await writeFile(join(alice.workspace.path, 'new-output'), 'new')
    await dialog.getByRole('button', { name: 'Refresh', exact: true }).click()
    await dialog.getByText('new-output', { exact: true }).waitFor()
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/workspace-artifacts/files.expected.md', import.meta.url)),
      await dialog.ariaSnapshot(), webSnapshotMode())

    const refusedListing = await alice.page.evaluate(async ({ base, workspaceId }) => {
      const response = await fetch(new URL('api/workspaceArtifacts/list', base), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'artifact-list-denial', method: 'workspaceArtifacts/list',
          payload: { args: { request: { workspaceId }, path: '' } } }),
      })
      return await response.json() as { result: { ok: boolean } }
    }, { base: host.baseUrl, workspaceId: bob.workspace.id })
    expect(refusedListing.result.ok).toBe(false)
    expect(JSON.stringify(refusedListing)).not.toContain('bob-only')
    expect((await response(alice.page, bob.workspace.id, 'bob-only')).status).toBe(403)
    expect((await response(bob.page, alice.workspace.id, 'outputs/月度汇总.bin')).status).toBe(403)
    for (const path of ['../secret', join(root, 'secret'), 'outputs/../empty', 'outputs\\file']) {
      const result = await response(alice.page, alice.workspace.id, path)
      expect(result.status).toBe(400)
      expect(result.text).not.toContain('SECRET')
      expect(result.text).not.toContain(root)
    }
    for (const path of ['escape', 'outside-directory/secret']) {
      const result = await response(alice.page, alice.workspace.id, path)
      expect(result.status).toBe(404)
      expect(result.text).not.toContain('SECRET')
    }
    const guest = await browserHost.newContext()
    const guestPage = await guest.newPage()
    await guestPage.goto(host.authenticatedUrl)
    expect((await response(guestPage, alice.workspace.id, 'empty')).status).toBe(401)

    await alice.page.setViewportSize({ width: 390, height: 844 })
    await alice.page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => alice.page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme'))).toBe(true)
    const geometry = await dialog.evaluate(element => ({ width: element.getBoundingClientRect().width,
      scroll: element.scrollWidth, client: element.clientWidth }))
    expect(geometry.width).toBeLessThanOrEqual(390)
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.client)
    if (process.env.DSH_WORKSPACE_ARTIFACT_SCREENSHOTS !== undefined) {
      await alice.page.screenshot({ path: join(process.env.DSH_WORKSPACE_ARTIFACT_SCREENSHOTS, 'files-mobile-dark.png'), fullPage: true })
      await alice.page.emulateMedia({ colorScheme: 'light' })
      await expect.poll(() => alice.page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme'))).toBe(false)
      await alice.page.screenshot({ path: join(process.env.DSH_WORKSPACE_ARTIFACT_SCREENSHOTS, 'files-mobile-light.png'), fullPage: true })
    }

    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await alice.page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await alice.page.locator('input[name="username"]').waitFor()
    expect((await response(alice.page, alice.workspace.id, 'empty')).status).toBe(401)
    await bob.page.getByRole('button', { name: 'Workspace files', exact: true }).click()
    await bob.page.getByText('bob-only', { exact: true }).waitFor()
    expect(await download(bob.context, bob.page, 'bob-only')).toEqual(Buffer.from('bob'))
    const entry = [...host.ctx.loader.entries()].find(row => row.options.id === 'workspace-artifacts')!
    await entry.update({ disabled: true })
    await host.ctx.loader.await()
    await bob.page.getByRole('button', { name: 'Workspace files', exact: true }).waitFor({ state: 'detached' })
    expect((await response(bob.page, bob.workspace.id, 'bob-only')).status).toBe(404)
    expect(urls.filter(url => url.startsWith('http') && !url.startsWith(host.baseUrl))).toEqual([])
    expect(errors).toEqual([])
    expect(sandboxCalls.map(call => call.method)).toEqual(['PUT', 'DELETE'])
  } finally {
    const cleanup = await Promise.allSettled([browser?.close()])
    try { await scaffold?.close() } finally {
      try {
        if (runner?.listening) await new Promise<void>((resolve, reject) => {
          runner!.close((error) => { if (error) reject(error); else resolve() })
          runner!.closeAllConnections()
        })
      } finally { await rm(root, { recursive: true, force: true }) }
    }
    const failures = cleanup.filter(result => result.status === 'rejected')
    if (failures.length > 0) throw new AggregateError(failures.map((result): unknown => result.reason))
  }
})
