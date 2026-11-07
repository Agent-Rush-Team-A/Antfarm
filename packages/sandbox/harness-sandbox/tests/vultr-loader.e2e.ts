/** Opt-in paid-cloud acceptance with one owned deployment and unconditional resource cleanup. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { VultrApi } from '../src/vultr-api.ts'
import { Config } from '../src/vultr-config.ts'

const suppliedConfig = process.env.DSH_VULTR_TEST_CONFIG
describe.skipIf(suppliedConfig === undefined || process.platform !== 'linux')('Vultr Workspace Loader acceptance', () => {
  test('two real VMs share native tools and HTTP files and preserve a workspace through a disk snapshot', { timeout: 3_600_000, retry: 0 }, async () => {
    if (suppliedConfig === undefined) throw new Error('Missing opt-in cloud deployment file')
    const initial = Config(JSON.parse(await readFile(suppliedConfig, 'utf8')) as Config)
    const home = await mkdtemp(join(tmpdir(), 'antfarm-vultr-profile-'))
    const deploymentId = 'validation-' + randomUUID().slice(0, 12)
    const config = { ...initial, stateRoot: join(home, 'cloud'), deploymentId, maxInstances: 2 }
    const key = (await readFile(config.apiKeyFile, 'utf8')).trim()
    const api = new VultrApi(key, config.apiEndpoint, config.requestTimeoutMs, config.maxInventoryPages, config.maxApiResponseBytes)
    const signal = AbortSignal.timeout(3_500_000)
    const beforeInstances = await api.instances(signal)
    const beforeSnapshots = await api.snapshots(signal)
    const profile = join(home, 'profiles', 'vultr-test')
    const reportFile = join(home, 'report.json')
    const configFile = join(home, 'cloud-config.json')
    await mkdir(profile, { recursive: true })
    await writeFile(configFile, JSON.stringify(config))
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'antfarm-vultr-test', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }))
    const row = (id: string, name: string, values?: Record<string, unknown>, inject?: string[]) => `    - id: ${id}\n      name: '${name}'\n${inject === undefined ? '' : `      inject: ${JSON.stringify(inject)}\n`}${values === undefined ? '' : `      config: ${JSON.stringify(values)}\n`}`
    const root = resolve(import.meta.dirname, '../../../..')
    const patch = ['- insert:\n',
      row('storage', '@deepseek-ai/dsh-storage'), row('storage-json', '@deepseek-ai/dsh-storage-json', { root: join(home, 'storage') }),
      row('storage-domain', '@deepseek-ai/dsh-storage-domain', { backend: 'json' }),
      row('session-persistence', '@deepseek-ai/dsh-session-persistence-jsonl', { root: join(home, 'sessions'), compression: 'none' }),
      row('workspace', '@deepseek-ai/dsh-workspace'), row('typert', '@deepseek-ai/dsh-typert-registry'),
      row('remote-access', '@deepseek-ai/dsh-api-remote-access'), row('gateway', '@deepseek-ai/dsh-api-gateway'),
      row('web-server', '@deepseek-ai/dsh-host-webserver', { host: '127.0.0.1', port: 0 }),
      row('connection', '@deepseek-ai/dsh-client-connection', { multiuser: true }),
      row('multiuser', '@deepseek-ai/dsh-api-multiuser', { workspaceRoot: join(home, 'workspaces') }),
      row('vultr-backend', '@deepseek-ai/dsh-harness-sandbox/vultr', config),
      row('workspace-sandbox', '@deepseek-ai/dsh-harness-sandbox', { backend: 'provided', workspaceRoot: join(home, 'workspaces') }, ['sandboxRunnerClient']),
      row('llm', '@deepseek-ai/dsh-llm'), row('session', '@deepseek-ai/dsh-session'),
      row('session-projection', '@deepseek-ai/dsh-session-projection'), row('system-prompt', '@deepseek-ai/dsh-system-prompt', {}),
      row('fs', '@deepseek-ai/dsh-fs-local'), row('fs-observation-policy', '@deepseek-ai/dsh-fs-observation-policy'),
      row('working-directory', '@deepseek-ai/dsh-working-directory', { modelDirectory: '/workspace' }),
      row('tools', '@deepseek-ai/dsh-tools'), row('native-executor', '@deepseek-ai/dsh-tool-executor-native'),
      row('agent', '@deepseek-ai/dsh-agent'), row('agent-loop', '@deepseek-ai/dsh-agent-loop', { agents: [] }),
      row('agent-default-model', '@deepseek-ai/dsh-agent-default-model', { provider: 'ssh-fixture', model: 'fixture' }),
      row('commands', '@deepseek-ai/dsh-commands'), row('credentials', '@deepseek-ai/dsh-credentials-local', { dshHome: home, watch: false }),
      row('attachment', '@deepseek-ai/dsh-attachment-local', { dshHome: home }), row('file-uploads', '@deepseek-ai/dsh-client-file-upload'),
      row('session-query', '@deepseek-ai/dsh-session-query-sqlite', { openAt: 'never', path: ':memory:' }),
      row('session-controller', '@deepseek-ai/dsh-api-session-controller', { nativeOpen: false }),
      row('workspace-controller', '@deepseek-ai/dsh-api-workspace-controller'),
      row('workspace-upload', '@deepseek-ai/dsh-api-workspace-upload', { storage: 'provided' }, ['workspaceFileAccess']),
      row('workspace-artifacts', '@deepseek-ai/dsh-api-workspace-artifacts', { storage: 'provided' }, ['workspaceFileAccess']),
      row('sandbox-conversation', '@deepseek-ai/dsh-harness-sandbox/conversation'),
      row('sandbox-bash', '@deepseek-ai/dsh-harness-sandbox/bash'), row('sandbox-files', '@deepseek-ai/dsh-harness-sandbox/files'),
      row('acceptance', pathToFileURL(join(import.meta.dirname, 'fixtures/vultr-loader.ts')).href),
    ].join('')
    await writeFile(join(profile, 'cordis.patch.yml'), patch)
    const child = spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'vultr-test'], {
      cwd: root, env: { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'), DSH_TELEMETRY_DISABLED: '1', DSH_VULTR_TEST_CONFIG: configFile, DSH_VULTR_TEST_REPORT: reportFile }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let diagnostics = ''
    const output = (chunk: Buffer): void => { const text = chunk.toString().replaceAll(key, '[redacted]'); diagnostics += text; if (text.includes('Vultr acceptance:')) process.stdout.write(text) }
    child.stdout.on('data', output); child.stderr.on('data', output)
    const exited = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', () => { resolve() }) })
    try {
      let report: { ok: true; checks: string[]; saveMs: number; restoreMs: number } | undefined
      while (!signal.aborted) {
        const raw = await readFile(reportFile, 'utf8').catch(() => undefined)
        if (raw !== undefined) {
          const parsed = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), checks: z.array(z.string()), saveMs: z.number(), restoreMs: z.number() }), z.object({ ok: z.literal(false), error: z.string() })]).parse(JSON.parse(raw))
          if (!parsed.ok) throw new Error(parsed.error + '\n' + diagnostics)
          report = parsed
          break
        }
        if (child.exitCode !== null) throw new Error('Harness exited before cloud acceptance:\n' + diagnostics)
        await new Promise<void>(resolve => setTimeout(resolve, 500))
      }
      expect(report, diagnostics).toBeDefined()
      expect(report?.checks.length).toBeGreaterThanOrEqual(25)
      const evidence = process.env.DSH_VULTR_TEST_EVIDENCE
      if (evidence !== undefined && report !== undefined) await writeFile(evidence, JSON.stringify(report, null, 2) + '\n')
      console.info('Vultr Loader acceptance:', report)
    } finally {
      child.kill('SIGTERM')
      const force = setTimeout(() => child.kill('SIGKILL'), 20_000)
      try { await exited } finally { clearTimeout(force) }
      const cleanupSignal = AbortSignal.timeout(120_000)
      const instances = (await api.instances(cleanupSignal)).filter(instance => instance.tags.includes('antfarm-' + deploymentId))
      for (const instance of instances) await api.deleteInstance(instance.id, cleanupSignal)
      const snapshots = (await api.snapshots(cleanupSignal)).filter(snapshot => snapshot.description.startsWith('antfarm-' + deploymentId + '-'))
      for (const snapshot of snapshots) await api.deleteSnapshot(snapshot.id, cleanupSignal)
      const afterInstances = await api.instances(cleanupSignal)
      const afterSnapshots = await api.snapshots(cleanupSignal)
      expect(afterInstances.some(instance => instance.tags.includes('antfarm-' + deploymentId))).toBe(false)
      expect(afterSnapshots.some(snapshot => snapshot.description.startsWith('antfarm-' + deploymentId + '-'))).toBe(false)
      expect(beforeInstances.every(instance => afterInstances.some(current => current.id === instance.id))).toBe(true)
      expect(beforeSnapshots.every(snapshot => afterSnapshots.some(current => current.id === snapshot.id))).toBe(true)
      await rm(home, { recursive: true, force: true })
      console.info('Vultr acceptance cleanup: all owned test resources removed; existing account resources preserved')
    }
  })
})
