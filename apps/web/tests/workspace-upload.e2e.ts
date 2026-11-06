/** Workspace upload acceptance through the real Web Loader, HTTP and browser. */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chown, chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { request as httpRequest, type ClientRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { chromium, type Page, type BrowserContext } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, compareOrRefreshGolden, webSnapshotMode } from './scaffold.ts'
import { connectFreshWorkspaceZh } from './support.ts'

it.skipIf(process.platform !== 'linux')('uploads to owned workspaces, preserves old files, and cancels revoked or unloaded intake', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-upload-browser-'))
  const overlay = join(root, 'upload.yml')
  await writeFile(overlay, `- id: connection\n  config:\n    multiuser: true\n- insert:\n    - id: multiuser\n      name: '@deepseek-ai/dsh-api-multiuser'\n      config:\n        workspaceRoot: ${JSON.stringify(join(root, 'workspaces'))}\n    - id: workspace-upload\n      name: '@deepseek-ai/dsh-api-workspace-upload'\n      config:\n        maxBytes: 64\n`)
  const scaffold = await launchWebScaffold({ firstUse: true, accountAuthentication: true, extraOverlayPath: overlay })
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  const failures: unknown[] = []
  const requests = new Set<ClientRequest>()
  try {
    const password = randomUUID()
    for (const name of ['alice', 'bob']) await scaffold.ctx.multiuser.provisionUser(name, password)
    const base = new URL(scaffold.authenticatedUrl).origin
    const errors: string[] = []
    async function account(name: string) {
      const context = await browser.newContext({ locale: 'en-US' })
      const page = await context.newPage()
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(base)
      await page.getByLabel('Username', { exact: true }).fill(name)
      await page.getByLabel('Password', { exact: true }).fill(password)
      await page.getByRole('button', { name: 'Sign in', exact: true }).click()
      const existing = new Set(scaffold.ctx.workspaceRegistry.list().map(workspace => workspace.id))
      await page.getByRole('button', { name: 'Choose workspace', exact: true }).click()
      await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor()
      await page.getByRole('button', { name: 'Upload to workspace', exact: true }).waitFor()
      return { context, page, workspace: scaffold.ctx.workspaceRegistry.list().find(workspace => !existing.has(workspace.id))! }
    }
    const alice = await account('alice')
    const bob = await account('bob')
    expect(alice.workspace.id).not.toBe(bob.workspace.id)
    const url = (workspaceId: string, name: string) => `${base}/api/workspace/uploadFileBinary?${new URLSearchParams({ workspaceId, name })}`
    async function upload(context: BrowserContext, workspaceId: string, name: string, data: Buffer) {
      return context.request.post(url(workspaceId, name), {
        headers: { origin: base, 'content-type': 'application/octet-stream' }, data,
      })
    }
    async function choose(page: Page, name: string, bytes: Buffer) {
      await page.locator('input[type="file"][aria-label="Upload to workspace"]').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: bytes })
    }
    const bytes = Buffer.from([0, 255, 1, 13, 10, 0, 128])
    await choose(alice.page, 'sample.bin', bytes)
    await alice.page.getByText('Uploaded “sample.bin” to workspace', { exact: true }).waitFor()
    expect(await readFile(join(alice.workspace.path, 'sample.bin'))).toEqual(bytes)
    expect(await readdir(bob.workspace.path)).not.toContain('sample.bin')
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/workspace-upload/success.expected.md', import.meta.url)),
      await alice.page.getByText('Uploaded “sample.bin” to workspace', { exact: true }).ariaSnapshot(), webSnapshotMode())
    await choose(alice.page, 'sample.bin', Buffer.from('replacement'))
    await alice.page.getByText('A file with this name already exists. Rename it before uploading.', { exact: true }).waitFor()
    expect(await readFile(join(alice.workspace.path, 'sample.bin'))).toEqual(bytes)
    await choose(alice.page, 'large.bin', Buffer.alloc(65))
    await alice.page.getByText('File is too large. Choose a smaller file.', { exact: true }).waitFor()
    expect(await readdir(alice.workspace.path)).not.toContain('large.bin')

    const guest = await fetch(url(alice.workspace.id, 'guest'), {
      method: 'POST', headers: { origin: base, 'content-type': 'application/octet-stream' }, body: 'bad',
    })
    expect(guest.status).toBe(401)
    await guest.arrayBuffer()
    expect((await upload(alice.context, bob.workspace.id, 'forbidden', Buffer.from('bad'))).status()).toBe(403)
    for (const name of ['../escape', '/absolute', 'sub/file', 'sub\\file', 'C:escape', '.', '..']) {
      const response = await upload(alice.context, alice.workspace.id, name, Buffer.from('bad'))
      expect(response.status()).toBe(400)
      expect(await response.json()).toMatchObject({ ok: false, error: { reason: 'invalid-name', stored: false } })
    }
    const outside = join(root, 'outside')
    await writeFile(outside, 'original')
    await symlink(outside, join(alice.workspace.path, 'link'))
    expect((await upload(alice.context, alice.workspace.id, 'link', Buffer.from('bad'))).status()).toBe(409)
    expect(await readFile(outside, 'utf8')).toBe('original')
    const oversized = await upload(alice.context, alice.workspace.id, 'server-large', Buffer.alloc(65))
    expect(oversized.status()).toBe(413)
    expect(await oversized.json()).toMatchObject({ error: { reason: 'too-large', stored: false } })
    expect((await upload(alice.context, alice.workspace.id, 'empty', Buffer.alloc(0))).status()).toBe(200)
    expect(await readFile(join(alice.workspace.path, 'empty'))).toHaveLength(0)

    const image = process.env.DSH_WORKSPACE_UPLOAD_DOCKER_IMAGE
    if (image !== undefined) {
      expect(image).toMatch(/^sha256:[a-f0-9]{64}$/u)
      await chown(alice.workspace.path, -1, 10001)
      await chmod(alice.workspace.path, 0o770)
      await choose(alice.page, 'container.bin', bytes)
      await alice.page.getByText('Uploaded “container.bin” to workspace', { exact: true }).waitFor()
      const result = await promisify(execFile)('docker', ['run', '--rm', '--network', 'none', '--user', '10001:10001',
        '--mount', `type=bind,src=${alice.workspace.path},dst=/workspace`, '--workdir', '/workspace', image,
        'bash', '-c', 'sha256sum container.bin; printf sandbox-wrote > sandbox-created'], { timeout: 30000 })
      expect(result.stdout.trim()).toBe(createHash('sha256').update(bytes).digest('hex') + '  container.bin')
      expect(await readFile(join(alice.workspace.path, 'sandbox-created'), 'utf8')).toBe('sandbox-wrote')
      console.log('Docker Bash read uploaded bytes and wrote through workspace group:', image)
    }

    async function pending(context: BrowserContext, workspaceId: string, path: string, name: string) {
      const cookie = (await context.cookies()).map(item => `${item.name}=${item.value}`).join('; ')
      const req = httpRequest(url(workspaceId, name), { method: 'POST', headers: {
        origin: base, cookie, 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked',
      } })
      requests.add(req)
      let completed = false
      req.on('error', () => { completed = true })
      req.on('response', (response) => { response.resume(); response.on('end', () => { completed = true }) })
      req.write('partial')
      await expect.poll(async () => (await readdir(dirname(path))).some(entry => entry.startsWith('.dsh-upload-'))).toBe(true)
      return { req, completed: () => completed }
    }
    const cancelled = await pending(alice.context, alice.workspace.id, alice.workspace.path, 'revoked')
    expect((await alice.context.request.post(`${base}/auth/logout`, { headers: { origin: base } })).status()).toBe(204)
    await expect.poll(cancelled.completed).toBe(true)
    cancelled.req.destroy()
    await expect.poll(async () => (await readdir(dirname(alice.workspace.path))).filter(entry => entry.startsWith('.dsh-upload-'))).toEqual([])
    expect(await readdir(alice.workspace.path)).not.toContain('revoked')

    const unloading = await pending(bob.context, bob.workspace.id, bob.workspace.path, 'unloaded')
    const entry = [...scaffold.ctx.loader.entries()].find(row => row.options.id === 'workspace-upload')!
    await entry.update({ disabled: true })
    await scaffold.ctx.loader.await()
    await expect.poll(unloading.completed).toBe(true)
    unloading.req.destroy()
    expect((await readdir(dirname(bob.workspace.path))).filter(name => name.startsWith('.dsh-upload-'))).toEqual([])
    expect(await readdir(bob.workspace.path)).not.toContain('unloaded')
    expect((await upload(bob.context, bob.workspace.id, 'after-unload', bytes)).status()).toBe(404)
    await expect.poll(() => bob.page.getByRole('button', { name: 'Upload to workspace', exact: true }).count()).toBe(0)
    expect(errors).toEqual([])
  } catch (error) {
    failures.push(error)
  } finally {
    for (const req of requests) req.destroy()
    try { await browser.close() } catch (error) { failures.push(error) }
    try { await scaffold.close() } catch (error) { console.error(error); failures.push(error) }
    try { await rm(root, { recursive: true, force: true }) } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures)
})

it.skipIf(process.platform !== 'linux')('offers localized workspace upload to the local owner in the assembled Web app', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('../../cli/config/examples/workspace-upload.patch.yml', import.meta.url)),
  })
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  const failures: unknown[] = []
  try {
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 390, height: 844 } })
    await page.goto(scaffold.authenticatedUrl)
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'owner-workspace')
    const button = page.getByRole('button', { name: '上传到工作区', exact: true })
    await button.waitFor()
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/workspace-upload/owner-zh.expected.md', import.meta.url)),
      await button.ariaSnapshot(), webSnapshotMode())
    await page.locator('input[type="file"][aria-label="上传到工作区"]').setInputFiles({
      name: '本地.txt', mimeType: 'text/plain', buffer: Buffer.from('owner bytes'),
    })
    await page.getByText('“本地.txt”已上传到工作区', { exact: true }).waitFor()
    expect(await readFile(join(scaffold.workspaceCwd, 'owner-workspace', '本地.txt'), 'utf8')).toBe('owner bytes')
  } catch (error) {
    failures.push(error)
  } finally {
    try { await browser.close() } catch (error) { failures.push(error) }
    try { await scaffold.close() } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures)
})
