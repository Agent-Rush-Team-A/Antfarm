/** Built browser controls against an independent Runner, with optional real Docker verification. */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { chown, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-api-multiuser'
import { launchWebScaffold, compareOrRefreshGolden, webSnapshotMode, type WebScaffold } from './scaffold.ts'

const repository = fileURLToPath(new URL('../../../', import.meta.url))

it('keeps sandbox controls out of the default Web composition', async () => {
  const scaffold = await launchWebScaffold({ profile: { hmr: false, packages: [] } })
  try {
    expect(scaffold.ctx.clientModules.graph().entries.some(row => row.id === '@deepseek-ai/dsh-client-ui-workspace-sandbox')).toBe(false)
  } finally {
    await scaffold.close()
  }
})

async function json(socketPath: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, agent: false, signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json' } }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.on('error', reject)
      response.on('end', () => {
        try {
          const raw = Buffer.concat(chunks)
          const body: unknown = raw.length === 0 ? undefined : JSON.parse(raw.toString())
          resolve({ status: response.statusCode ?? 0, body })
        }
        catch (error) { reject(error instanceof Error ? error : new Error(String(error))) }
      })
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

it.skipIf(process.platform !== 'linux')('opens and closes from both entries, shows capacity, and retains workspace files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-sandbox-browser-'))
  const socketPath = join(root, 'runner.sock')
  const workspaceRoot = join(root, 'workspaces')
  const deploymentId = 'issue9-' + randomUUID().slice(0, 8)
  const dockerSocket = process.env.DSH_SANDBOX_UI_DOCKER_SOCKET
  const image = process.env.DSH_SANDBOX_UI_DOCKER_IMAGE
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let runner: Server | undefined
  let child: ChildProcess | undefined
  let exited: Promise<unknown> | undefined
  let logs = ''
  const calls: Array<{ method: string | undefined; path: string | undefined }> = []
  const running = new Set<string>()
  const pending = new Set<Promise<void>>()
  let gate: PromiseWithResolvers<undefined> | undefined
  const gates: Array<PromiseWithResolvers<undefined>> = []
  let statusFails = false
  const engine = (method: string, path: string, body?: unknown) => {
    if (dockerSocket === undefined) throw new Error('Docker verification needs its private socket')
    return json(dockerSocket, method, '/v1.51' + path, body)
  }
  async function containers(): Promise<Array<{ Id: string; Labels: Record<string, string> }>> {
    const filters = encodeURIComponent(JSON.stringify({ label: ['org.agentrush.sandbox.deployment=' + deploymentId] }))
    const result = await engine('GET', '/containers/json?all=1&filters=' + filters)
    expect(result.status).toBe(200)
    return result.body as Array<{ Id: string; Labels: Record<string, string> }>
  }
  try {
    await mkdir(workspaceRoot)
    if (dockerSocket !== undefined) {
      expect(image).toMatch(/^[^\s@]+@sha256:[a-f0-9]{64}$/u)
      const home = join(root, 'runner-home')
      const profile = join(home, 'profiles/sandbox-runner')
      await mkdir(join(profile, 'node_modules/@deepseek-ai'), { recursive: true })
      await symlink(join(repository, 'packages/sandbox/sandbox-runner'), join(profile, 'node_modules/@deepseek-ai/dsh-sandbox-runner'))
      await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'issue9-runner-browser', private: true,
        dependencies: { '@deepseek-ai/dsh-sandbox-runner': '*' }, dsh: { profile: { bundles: [] } } }))
      await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'sandbox-runner',
        name: '@deepseek-ai/dsh-sandbox-runner', config: { dockerSocket, runnerSocket: socketPath, workspaceRoot,
          deploymentId, image, uid: 10001, gid: 10001 } }] }]))
      child = spawn(process.execPath, [join(repository, 'apps/cli/lib/bin.js'), '--profile', 'sandbox-runner'],
        { env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] })
      exited = once(child, 'close')
      child.stdout?.on('data', (data: Buffer) => { logs = (logs + data.toString()).slice(-20000) })
      child.stderr?.on('data', (data: Buffer) => { logs = (logs + data.toString()).slice(-20000) })
      await expect.poll(async () => {
        if (child?.exitCode !== null) throw new Error('Runner exited: ' + logs)
        try { return (await json(socketPath, 'GET', '/v1/workspaces/readiness/sandbox')).status }
        catch { return 0 }
      }, { timeout: 60000 }).toBe(200)
    } else {
      runner = createServer((req, response) => {
        req.resume()
        req.on('end', () => {
          const operation = (async () => {
            const path = req.url ?? ''
            calls.push({ method: req.method, path })
            if (req.method !== 'GET' && gate !== undefined) {
              const held = gate; gate = undefined; await held.promise
            }
            if (req.method === 'GET' && statusFails) {
              response.statusCode = 503; response.end(JSON.stringify({ error: 'docker_unavailable' })); return
            }
            if (req.method === 'PUT' && !running.has(path) && running.size >= 2) {
              response.statusCode = 409; response.end(JSON.stringify({ error: 'sandbox_capacity' })); return
            }
            if (req.method === 'PUT') running.add(path)
            if (req.method === 'DELETE') running.delete(path)
            response.end(JSON.stringify(running.has(path) ? { state: 'running', containerId: 'a'.repeat(64) } : { state: 'closed' }))
          })()
          pending.add(operation)
          void operation.then(() => { pending.delete(operation) }, (error: unknown) => {
            pending.delete(operation); response.destroy(error instanceof Error ? error : new Error(String(error)))
          })
        })
      })
      await once(runner.listen(socketPath), 'listening')
    }
    const overlay = join(root, 'sandbox.yml')
    await writeFile(overlay, JSON.stringify([
      { id: 'connection', config: { multiuser: true } },
      { id: 'ui-workspace-sandbox', disabled: false, config: { pollIntervalMs: 200 } },
      { id: 'workspace-sandbox', config: { workspaceRoot, socketPath } },
      { insert: [
        { id: 'multiuser', name: '@deepseek-ai/dsh-api-multiuser', config: { workspaceRoot } },
      ] },
    ]))
    scaffold = await launchWebScaffold({ firstUse: true, accountAuthentication: true, profile: { hmr: false, packages: [] },
      publicMount: { prefix: '/tools/dsh/' }, extraOverlayPath: [
        join(repository, 'apps/cli/config/examples/harness-sandbox.patch.yml'), overlay,
      ] })
    browser = await chromium.launch({ args: ['--no-sandbox'] })
    const host = scaffold, browserHost = browser
    expect(host.ctx.clientModules.graph().entries.some(row => row.id === '@deepseek-ai/dsh-client-ui-workspace-sandbox')).toBe(true)
    const password = randomUUID()
    const errors: string[] = []
    const urls: string[] = []
    for (const name of ['alice', 'bob', 'carol']) await host.ctx.multiuser.provisionUser(name, password)
    async function account(name: string) {
      const context = await browserHost.newContext({ locale: 'en-US' })
      const page = await context.newPage()
      page.setDefaultTimeout(30000)
      page.on('pageerror', (error) => { errors.push(error.message) })
      page.on('request', (req) => { urls.push(req.url()) })
      await page.goto(host.authenticatedUrl)
      await page.locator('input[name="username"]').fill(name)
      await page.locator('input[name="password"]').fill(password)
      await page.locator('button[type="submit"]').click()
      const previous = new Set(host.ctx.workspaceRegistry.list().map(workspace => workspace.id))
      await page.getByRole('button', { name: 'Choose workspace', exact: true }).click()
      await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor()
      await page.getByRole('treeitem').first().hover()
      await page.getByRole('button', { name: /^Workspace actions for /u }).waitFor()
      const workspace = host.ctx.workspaceRegistry.list().find(workspace => !previous.has(workspace.id))
      if (workspace === undefined) throw new Error('Native workspace creation did not register a workspace')
      if (dockerSocket !== undefined) await chown(workspace.path, 10001, 10001)
      return { page, workspace }
    }
    async function panel(page: Page, entry: 'menu' | 'conversation' = 'menu') {
      await page.bringToFront()
      if (entry === 'menu') {
        await page.getByRole('treeitem').first().hover()
        await page.getByRole('button', { name: /^Workspace actions for /u }).click()
        await page.getByRole('menuitem', { name: 'Workspace sandbox', exact: true }).click()
      } else await page.getByRole('button', { name: 'Workspace sandbox', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Workspace sandbox', exact: true })
      await dialog.getByRole('status').getByText('Closed', { exact: true }).waitFor()
      return dialog
    }
    const alice = await account('alice'), bob = await account('bob'), carol = await account('carol')
    const a = await panel(alice.page)
    expect(calls.filter(call => call.method === 'PUT')).toHaveLength(0)
    if (dockerSocket !== undefined) expect(await containers()).toHaveLength(0)
    if (dockerSocket === undefined) { gate = Promise.withResolvers<undefined>(); gates.push(gate) }
    await a.getByRole('button', { name: 'Open sandbox', exact: true }).click()
    if (dockerSocket === undefined) {
      await a.getByRole('status').getByText('Starting…', { exact: true }).waitFor()
      expect(await a.getByRole('button', { name: 'Close sandbox', exact: true }).isDisabled()).toBe(true)
      gates.at(-1)?.resolve(undefined)
    }
    await a.getByRole('status').getByText('Running', { exact: true }).waitFor()
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/workspace-sandbox/running.expected.md', import.meta.url)),
      await a.ariaSnapshot(), webSnapshotMode())
    const b = await panel(bob.page)
    await b.getByRole('button', { name: 'Open sandbox', exact: true }).click()
    await b.getByRole('status').getByText('Running', { exact: true }).waitFor()
    const c = await panel(carol.page)
    await c.getByRole('button', { name: 'Open sandbox', exact: true }).click()
    await c.getByRole('alert').getByText('Sandbox capacity is full. Close one or try again later.', { exact: true }).waitFor()
    if (dockerSocket !== undefined) expect(await containers()).toHaveLength(2)
    const denied = await alice.page.evaluate(async ({ base, workspaceId }) => {
      const response = await fetch(new URL('api/workspaceSandbox/close', base), { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'sandbox-denial',
          method: 'workspaceSandbox/close', payload: { args: { request: { workspaceId } } } }) })
      return await response.json() as { result: { ok: boolean } }
    }, { base: host.baseUrl, workspaceId: bob.workspace.id })
    expect(denied.result.ok).toBe(false)
    await alice.page.bringToFront()
    if (dockerSocket === undefined) {
      expect(calls.some(call => call.method === 'DELETE')).toBe(false)
      statusFails = true
      await a.getByRole('button', { name: 'Refresh status', exact: true }).click()
      await a.getByRole('status').getByText('Last known status: Running', { exact: true }).waitFor()
      expect(await a.getByRole('button', { name: 'Close sandbox', exact: true }).isDisabled()).toBe(true)
      statusFails = false
      await a.getByRole('button', { name: 'Refresh status', exact: true }).click()
      await a.getByRole('status').getByText('Running', { exact: true }).waitFor()
      await writeFile(join(alice.workspace.path, 'retained.txt'), 'retained')
    } else {
      const container = (await containers()).find(row => row.Labels['org.agentrush.sandbox.workspace'] === alice.workspace.id)
      if (container === undefined) throw new Error('No real container for Alice')
      const created = await engine('POST', '/containers/' + container.Id + '/exec', { AttachStdout: false, AttachStderr: false,
        User: '10001:10001', WorkingDir: '/workspace', Cmd: ['bash', '-c', 'printf retained > retained.txt'] })
      expect(created.status).toBe(201)
      const id = (created.body as { Id: string }).Id
      expect((await engine('POST', '/exec/' + id + '/start', { Detach: true, Tty: false })).status).toBe(200)
      await expect.poll(async () => (await engine('GET', '/exec/' + id + '/json')).body).toMatchObject({ Running: false, ExitCode: 0 })
    }
    await a.getByRole('button', { name: 'Close sandbox', exact: true }).click()
    await a.getByRole('button', { name: 'Cancel', exact: true }).click()
    await a.getByRole('status').getByText('Running', { exact: true }).waitFor()
    await a.getByRole('button', { name: 'Close sandbox', exact: true }).click()
    if (dockerSocket === undefined) { gate = Promise.withResolvers<undefined>(); gates.push(gate) }
    await a.getByRole('button', { name: 'Confirm close', exact: true }).click()
    if (dockerSocket === undefined) {
      await a.getByRole('status').getByText('Closing…', { exact: true }).waitFor()
      gates.at(-1)?.resolve(undefined)
    }
    await a.getByRole('status').getByText('Closed', { exact: true }).waitFor()
    expect(await readFile(join(alice.workspace.path, 'retained.txt'), 'utf8')).toBe('retained')
    if (dockerSocket !== undefined) expect((await containers()).some(row => row.Labels['org.agentrush.sandbox.workspace'] === alice.workspace.id)).toBe(false)
    await a.getByRole('button', { name: 'Close panel', exact: true }).click()
    await alice.page.getByRole('treeitem').first().hover()
    await alice.page.getByRole('button', { name: /^New session in /u }).click()
    const reopened = await panel(alice.page, 'conversation')
    await reopened.getByRole('button', { name: 'Open sandbox', exact: true }).click()
    await reopened.getByRole('status').getByText('Running', { exact: true }).waitFor()
    expect(await readFile(join(alice.workspace.path, 'retained.txt'), 'utf8')).toBe('retained')
    await alice.page.setViewportSize({ width: 390, height: 844 })
    await alice.page.emulateMedia({ colorScheme: 'dark' })
    const geometry = await reopened.evaluate(element => ({ width: element.getBoundingClientRect().width,
      scroll: element.scrollWidth, client: element.clientWidth }))
    expect(geometry.width).toBeLessThanOrEqual(390)
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.client)
    expect(errors).toEqual([])
    expect(urls.some(url => new URL(url).pathname.startsWith('/api/'))).toBe(false)
    console.log(dockerSocket === undefined ? 'Controlled Runner browser acceptance passed' : 'Real Docker browser acceptance passed: capacity, removal and retained files')
  } finally {
    const failures: unknown[] = []
    const cleanup = async (operation: () => Promise<unknown>): Promise<void> => {
      try { await operation() } catch (error) { failures.push(error) }
    }
    for (const held of gates) held.resolve(undefined)
    await Promise.allSettled([...pending])
    await cleanup(async () => { await browser?.close() })
    await cleanup(async () => { await scaffold?.close() })
    await cleanup(async () => {
      if (child !== undefined && child.exitCode === null) {
        child.kill('SIGTERM')
        try { await once(child, 'close', { signal: AbortSignal.timeout(10000) }) }
        catch { child.kill('SIGKILL'); await exited }
      }
    })
    await cleanup(async () => {
      if (dockerSocket !== undefined) {
        for (const row of await containers()) expect((await engine('DELETE', '/containers/' + row.Id + '?force=true')).status).toBe(204)
        expect(await containers()).toHaveLength(0)
      }
    })
    await cleanup(async () => {
      if (runner !== undefined) await new Promise<void>((resolve, reject) => {
        runner?.close((error) => { if (error) reject(error); else resolve() }); runner?.closeAllConnections()
      })
    })
    await cleanup(async () => { await rm(root, { recursive: true, force: true }) })
    if (failures.length > 0) throw new AggregateError(failures, 'Sandbox browser fixture cleanup failed')
  }
})
