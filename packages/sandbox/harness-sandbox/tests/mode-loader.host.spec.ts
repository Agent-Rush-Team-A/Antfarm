/** Opt-in real Docker and authenticated HTTP acceptance through the supported dsh Launcher. */
import { execFile, spawn } from 'node:child_process'
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'

const exec = promisify(execFile)
const reportSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), checks: z.array(z.string()), generations: z.array(z.string()), output: z.unknown(),
    realDocker: z.literal(true), realLoader: z.literal(true), substituted: z.array(z.string()) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
describe.skipIf(process.env.DSH_WORKSPACE_MODES_DOCKER_TEST !== '1' || process.platform !== 'linux')('Workspace modes Docker Loader acceptance', () => {
  test('native inputs, commands, files and teardown share real Docker generations', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-mode-loader-'))
    const root = resolve(import.meta.dirname, '../../../..')
    const deployment = 'mode-' + randomUUID()
    const tag = 'antfarm-mode-test:' + randomUUID()
    const docker = async (...args: string[]) => (await exec('docker', args, {
      timeout: args[0] === 'build' ? 90_000 : 30_000, maxBuffer: 1024 * 1024,
    })).stdout.trim()
    let child: ReturnType<typeof spawn> | undefined
    let stopped: Promise<void> | undefined
    let diagnostics = ''
    let failure: unknown
    let imageCreated = false
    let report: z.infer<typeof reportSchema> | undefined
    try {
      const build = join(home, 'image')
      await mkdir(build)
      await mkdir(join(home, 'workspaces'))
      await copyFile(join(root, 'packages/sandbox/sandbox-runner/assets/supervisor.py'), join(build, 'supervisor.py'))
      const base = z.array(z.object({ RepoDigests: z.array(z.string()) })).parse(JSON.parse(await docker('image', 'inspect', 'node:22-bookworm')))[0]!.RepoDigests[0]!
      await writeFile(join(build, 'Dockerfile'), `FROM ${base}\nCOPY supervisor.py /opt/agentrush/sandbox-runner/supervisor.py\nRUN chmod 0444 /opt/agentrush/sandbox-runner/supervisor.py && test -x /usr/bin/python3 && ln -sf /usr/bin/python3 /usr/local/bin/python3 && chmod 0555 /opt/agentrush /opt/agentrush/sandbox-runner\nUSER 1000:1000\nWORKDIR /workspace\nENTRYPOINT ["/usr/bin/sleep"]\nCMD ["infinity"]\n`)
      await docker('build', '--network=none', '-t', tag, build)
      imageCreated = true
      const image = z.array(z.object({ Id: z.string() })).parse(JSON.parse(await docker('image', 'inspect', tag)))[0]!.Id
      const profile = join(home, 'profiles', 'workspace-modes-test')
      await mkdir(profile, { recursive: true })
      await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-workspace-modes-test', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }))
      const row = (id: string, name: string, config?: Record<string, unknown>) => `    - id: ${id}\n      name: '${name}'\n${config === undefined ? '' : `      config: ${JSON.stringify(config)}\n`}`
      const patch = [
        '- insert:\n',
        row('storage', '@deepseek-ai/dsh-storage'),
        row('storage-json', '@deepseek-ai/dsh-storage-json', { root: join(home, 'storage') }),
        row('storage-domain', '@deepseek-ai/dsh-storage-domain', { backend: 'json' }),
        row('credentials', '@deepseek-ai/dsh-credentials-local', { dshHome: home, watch: false }),
        row('session-persistence', '@deepseek-ai/dsh-session-persistence-jsonl', { root: join(home, 'sessions'), compression: 'none' }),
        row('workspace', '@deepseek-ai/dsh-workspace', { defaultMode: 'multi-docker' }), row('typert', '@deepseek-ai/dsh-typert-registry'),
        row('remote-access', '@deepseek-ai/dsh-api-remote-access'), row('gateway', '@deepseek-ai/dsh-api-gateway'),
        row('web-server', '@deepseek-ai/dsh-host-webserver', { host: '127.0.0.1', port: 0 }),
        row('connection', '@deepseek-ai/dsh-client-connection', { multiuser: true }),
        row('multiuser', '@deepseek-ai/dsh-api-multiuser', { workspaceRoot: join(home, 'workspaces') }),
        row('workspace-controller', '@deepseek-ai/dsh-api-workspace-controller', {}),
        row('runner', '@deepseek-ai/dsh-sandbox-runner', { dockerSocket: '/var/run/docker.sock', runnerSocket: join(home, 'runner.sock'),
          deploymentId: deployment, workspaceRoot: join(home, 'workspaces'), image: `${tag}@${image}`, uid: 1000, gid: 1000, cleanupTimeoutMs: 5000 }),
        row('mode-fixture', pathToFileURL(join(import.meta.dirname, 'fixtures/mode-loader.ts')).href),
        "    - id: mode-backend\n      name: '@deepseek-ai/dsh-harness-sandbox/modes'\n      inject: [workspaceModeFixture]\n      config:\n        modes: !!js ctx.workspaceRegistry.modes\n        targets: !!js ctx.workspaceModeFixture.targets\n        runtime: !!js ctx.workspaceModeFixture.runtime\n",
        "    - id: workspace-sandbox\n      name: '@deepseek-ai/dsh-harness-sandbox'\n      inject: [sandboxRunnerClient]\n",
        `      config: ${JSON.stringify({ backend: 'provided', workspaceRoot: join(home, 'workspaces') })}\n`,
        row('llm', '@deepseek-ai/dsh-llm'), row('session', '@deepseek-ai/dsh-session'), row('session-projection', '@deepseek-ai/dsh-session-projection'),
        row('system-prompt', '@deepseek-ai/dsh-system-prompt', {}), row('fs', '@deepseek-ai/dsh-fs-local'),
        row('fs-observation', '@deepseek-ai/dsh-fs-observation-policy'), row('working-directory', '@deepseek-ai/dsh-working-directory', { modelDirectory: '/workspace' }),
        row('tools', '@deepseek-ai/dsh-tools'), row('native-executor', '@deepseek-ai/dsh-tool-executor-native'),
        row('agent', '@deepseek-ai/dsh-agent'), row('agent-loop', '@deepseek-ai/dsh-agent-loop', { agents: [] }),
        row('agent-default-model', '@deepseek-ai/dsh-agent-default-model', { provider: 'mode-fixture', model: 'fixture' }),
        row('commands', '@deepseek-ai/dsh-commands'), row('attachment', '@deepseek-ai/dsh-attachment-local', { dshHome: home }),
        row('file-uploads', '@deepseek-ai/dsh-client-file-upload'),
        row('session-query', '@deepseek-ai/dsh-session-query-sqlite', { openAt: 'never', path: ':memory:' }),
        row('session-controller', '@deepseek-ai/dsh-api-session-controller', { nativeOpen: false }),
        row('sandbox-conversation', '@deepseek-ai/dsh-harness-sandbox/conversation'), row('sandbox-bash', '@deepseek-ai/dsh-harness-sandbox/bash'),
        row('sandbox-files', '@deepseek-ai/dsh-harness-sandbox/files'),
        "    - id: workspace-upload\n      name: '@deepseek-ai/dsh-api-workspace-upload'\n      inject: [workspaceFileAccess]\n      config: {storage: provided}\n",
        "    - id: workspace-artifacts\n      name: '@deepseek-ai/dsh-api-workspace-artifacts'\n      inject: [workspaceFileAccess]\n      config: {storage: provided}\n",
        row('acceptance', pathToFileURL(join(import.meta.dirname, 'fixtures/mode-acceptance.ts')).href),
      ].join('')
      await writeFile(join(profile, 'cordis.patch.yml'), patch)
      const reportFile = join(home, 'report.json')
      child = spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'workspace-modes-test'], {
        cwd: root, env: { ...process.env, DSH_HOME: home, DSH_MODE_TEST_HOME: home, DSH_MODE_TEST_REPORT: reportFile }, stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout!.on('data', (chunk) => { diagnostics += String(chunk) })
      child.stderr!.on('data', (chunk) => { diagnostics += String(chunk) })
      stopped = new Promise<void>((done, reject) => { child!.once('error', reject); child!.once('close', () => { done() }) })
      const until = performance.now() + 70_000
      while (report === undefined && performance.now() < until) {
        const raw = await readFile(reportFile, 'utf8').catch(() => undefined)
        if (raw !== undefined) report = reportSchema.parse(JSON.parse(raw))
        if (report === undefined && child.exitCode !== null) throw new Error('dsh stopped before mode acceptance: ' + diagnostics)
        if (report === undefined) await new Promise<void>(done => setTimeout(done, 50))
      }
      if (report === undefined || !report.ok) throw new Error(`${report?.error ?? 'No report'}\n${diagnostics}`)
      expect(report.checks.length).toBeGreaterThanOrEqual(20)
      expect(report.generations.length).toBeGreaterThanOrEqual(4)
      const evidence = join(root, '.artifacts/issue42/mode-loader.json')
      await writeFile(evidence, JSON.stringify(report, null, 2) + '\n')
    } catch (error) { failure = error; throw error }
    finally {
      await writeFile(join(root, '.artifacts/issue42/mode-loader-diagnostics.log'), diagnostics + '\n'
        + (failure instanceof Error ? failure.stack ?? failure.message : ''))
      if (child !== undefined) {
        child.kill('SIGTERM')
        const force = setTimeout(() => { child!.kill('SIGKILL') }, 10_000)
        try { await stopped } finally { clearTimeout(force) }
      }
      const remaining = await docker('ps', '-aq', '--filter', `label=org.agentrush.sandbox.deployment=${deployment}`)
      for (const id of remaining.split('\n').filter(Boolean)) await docker('rm', '-f', id)
      if (imageCreated) await docker('image', 'rm', tag)
      await rm(home, { recursive: true, force: true })
      if (remaining !== '') {
        const cleanup = new Error('Loader teardown left test-owned Docker containers: ' + remaining)
        throw failure === undefined ? cleanup : new AggregateError([failure, cleanup], 'Mode acceptance and Loader teardown failed')
      }
    }
  }, 240_000)
})
