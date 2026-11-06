/** Opt-in real SSH acceptance through an isolated dsh profile and its Loader tree. */
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, test } from 'vitest'

const bindings = process.env.DSH_WORKSPACE_SSH_TEST_BINDINGS
describe.skipIf(bindings === undefined || process.platform === 'win32')('Workspace SSH Loader acceptance', () => {
  test('native multiuser Bash and files share the captured remote generation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-workspace-ssh-profile-'))
    const profile = join(home, 'profiles', 'workspace-ssh-test')
    const reportFile = join(home, 'report.json')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-workspace-ssh-test', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }))
    const row = (id: string, name: string, config?: Record<string, unknown>) => `    - id: ${id}\n      name: '${name}'\n${config === undefined ? '' : `      config: ${JSON.stringify(config)}\n`}`
    const root = resolve(import.meta.dirname, '../../../..')
    const patch = [
      '- insert:\n',
      row('storage', '@deepseek-ai/dsh-storage'),
      row('storage-json', '@deepseek-ai/dsh-storage-json', { root: join(home, 'storage') }),
      row('storage-domain', '@deepseek-ai/dsh-storage-domain', { backend: 'json' }),
      row('credentials', '@deepseek-ai/dsh-credentials-local', { dshHome: home, watch: false }),
      row('session-persistence', '@deepseek-ai/dsh-session-persistence-jsonl', { root: join(home, 'sessions'), compression: 'none' }),
      row('workspace', '@deepseek-ai/dsh-workspace'),
      row('typert', '@deepseek-ai/dsh-typert-registry'),
      row('remote-access', '@deepseek-ai/dsh-api-remote-access'),
      row('gateway', '@deepseek-ai/dsh-api-gateway'),
      row('web-server', '@deepseek-ai/dsh-host-webserver', { host: '127.0.0.1', port: 0 }),
      row('connection', '@deepseek-ai/dsh-client-connection', { multiuser: true }),
      row('multiuser', '@deepseek-ai/dsh-api-multiuser', { workspaceRoot: join(home, 'workspaces') }),
      row('ssh-fixture', pathToFileURL(join(import.meta.dirname, 'fixtures/ssh-accounts.ts')).href),
      "    - id: ssh-backend\n      name: '@deepseek-ai/dsh-harness-sandbox/ssh'\n      inject: [workspaceSshFixture]\n      config:\n        bindings: !!js ctx.workspaceSshFixture.bindings\n        graceMs: 500\n        maxOutputBytes: 256\n",
      "    - id: workspace-sandbox\n      name: '@deepseek-ai/dsh-harness-sandbox'\n      inject: [sandboxRunnerClient]\n",
      `      config: ${JSON.stringify({ backend: 'provided', workspaceRoot: join(home, 'workspaces') })}\n`,
      row('llm', '@deepseek-ai/dsh-llm'),
      row('session', '@deepseek-ai/dsh-session'),
      row('session-projection', '@deepseek-ai/dsh-session-projection'),
      row('system-prompt', '@deepseek-ai/dsh-system-prompt', {}),
      row('fs', '@deepseek-ai/dsh-fs-local'),
      row('working-directory', '@deepseek-ai/dsh-working-directory', { modelDirectory: '/workspace' }),
      row('tools', '@deepseek-ai/dsh-tools'),
      row('native-executor', '@deepseek-ai/dsh-tool-executor-native'),
      row('agent', '@deepseek-ai/dsh-agent'),
      row('agent-loop', '@deepseek-ai/dsh-agent-loop', { agents: [] }),
      row('agent-default-model', '@deepseek-ai/dsh-agent-default-model', { provider: 'ssh-fixture', model: 'fixture' }),
      row('commands', '@deepseek-ai/dsh-commands'),
      row('attachment', '@deepseek-ai/dsh-attachment-local', { dshHome: home }),
      row('file-uploads', '@deepseek-ai/dsh-client-file-upload'),
      row('session-query', '@deepseek-ai/dsh-session-query-sqlite', { openAt: 'never', path: ':memory:' }),
      row('session-controller', '@deepseek-ai/dsh-api-session-controller', { nativeOpen: false }),
      row('sandbox-conversation', '@deepseek-ai/dsh-harness-sandbox/conversation'),
      row('sandbox-bash', '@deepseek-ai/dsh-harness-sandbox/bash'),
      row('acceptance', pathToFileURL(join(import.meta.dirname, 'fixtures/ssh-loader.ts')).href),
    ].join('')
    await writeFile(join(profile, 'cordis.patch.yml'), patch)
    const child = spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'workspace-ssh-test'], {
      cwd: root, env: { ...process.env, DSH_HOME: home, DSH_WORKSPACE_SSH_TEST_BINDINGS: bindings, DSH_WORKSPACE_SSH_TEST_REPORT: reportFile }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let diagnostics = ''
    child.stdout.on('data', (chunk) => { diagnostics += String(chunk) })
    child.stderr.on('data', (chunk) => { diagnostics += String(chunk) })
    const stopped = new Promise<void>((done, reject) => { child.once('error', reject); child.once('close', () => { done() }) })
    let unload: { host: string; pid: number } | undefined
    try {
      let report: { ok: boolean; error?: string; checks: string[]; output: unknown; unload: { host: string; pid: number } } | undefined
      for (let attempt = 0; attempt < 1500; attempt++) {
        const raw = await readFile(reportFile, 'utf8').catch(() => undefined)
        if (raw !== undefined) { report = JSON.parse(raw); break }
        if (child.exitCode !== null) throw new Error(`dsh stopped before SSH acceptance: ${diagnostics}`)
        await new Promise<void>(done => setTimeout(done, 50))
      }
      expect(report, diagnostics).toBeDefined()
      expect(report?.ok, `${report?.error ?? ''}\n${diagnostics}`).toBe(true)
      expect(report?.checks.length).toBeGreaterThanOrEqual(20)
      expect(report?.output).toEqual([{ type: 'text', text: 'output\n[stderr]\ndiagnostic\n[exit code: 7]' }])
      unload = report?.unload
      console.info('SSH acceptance:', report?.checks)
    } finally {
      child.kill('SIGTERM')
      const force = setTimeout(() => { child.kill('SIGKILL') }, 10_000)
      try { await stopped } finally { clearTimeout(force); await rm(home, { recursive: true, force: true }) }
    }
    expect(unload).toBeDefined()
    if (unload === undefined) throw new Error('Missing owned process identity')
    expect(Number.isSafeInteger(unload.pid) && unload.pid > 1).toBe(true)
    await promisify(execFile)('ssh', ['-T', unload.host, `if kill -0 ${unload.pid} 2>/dev/null; then exit 1; fi`], { timeout: 10_000 })
  }, 100_000)
})
