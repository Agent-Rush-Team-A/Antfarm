/** Explicit paid-cloud opt-in: source Loader, real virtiofs, private test namespace and bounded cleanup. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, chown, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, onTestFinished, test } from 'vitest'
import { z } from 'zod'
import { VultrApi } from '../src/vultr-api.ts'
import { multiVmVfsTestConfig, resolveMultiVmVfsTestCloud } from './fixtures/multi-vm-vfs-loader.ts'

const supplied = process.env.DSH_MULTI_VM_VFS_TEST_CONFIG
const reportSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), checks: z.array(z.string()), openMs: z.number(), reopenMs: z.number(),
    archiveMs: z.number(), deleteMs: z.number(), closeMs: z.number(),
    realCloud: z.literal(true), realSsh: z.literal(true), realVfs: z.literal(true), model: z.literal('scripted external adapter'),
    workspaceIds: z.array(z.string()), generations: z.array(z.string()) }),
  z.object({ ok: z.literal(false), error: z.string(), backendCauses: z.array(z.array(z.object({
    name: z.string(), reason: z.string(), code: z.union([z.string(), z.number()]).optional(),
    status: z.number().optional(), outcomeUnknown: z.boolean().optional(),
  }))).optional() }),
])

describe.skipIf(supplied === undefined || process.platform !== 'linux')('Persistent multi VM VFS Loader acceptance', () => {
  test('Sessions share a VM and retain VFS files across archive, fresh allocation and deletion', { timeout: 3_600_000, retry: 0 }, async () => {
    if (supplied === undefined) throw new Error('Missing explicit VFS cloud test configuration')
    const initial = multiVmVfsTestConfig.parse(JSON.parse(await readFile(supplied, 'utf8')))
    const passwd = await readFile('/etc/passwd', 'utf8')
    if (!passwd.split('\n').some(line => line.split(':')[2] === String(initial.webUid))) {
      throw new Error('VFS test Web UID requires a dedicated local passwd entry for OpenSSH subprocesses')
    }
    if (new Set(initial.taskIds).size !== initial.taskIds.length || initial.taskIds.includes(initial.webUid)
      || initial.taskIds.includes(initial.webGid)) throw new Error('VFS test identity must have distinct reserved supplementary groups')
    if (process.getuid?.() !== 0 && (process.getuid?.() !== initial.webUid || process.getgid?.() !== initial.webGid
      || !initial.taskIds.every(id => process.getgroups?.().includes(id)))) throw new Error('Run as root or the explicitly configured test Web identity')
    if (!resolve(initial.mountPoint).startsWith('/') || await realpath(initial.mountPoint) !== initial.mountPoint) {
      throw new Error('Test mount point must be an existing canonical directory')
    }
    const home = await mkdtemp(join(tmpdir(), 'antfarm-multi-vfs-'))
    let cloudStarted = false
    onTestFinished(async () => { if (!cloudStarted) await rm(home, { recursive: true, force: true }) })
    const deploymentId = 'vfs-test-' + randomUUID().slice(0, 12)
    const workspaceRoot = join(initial.mountPoint, deploymentId)
    const cloud = resolveMultiVmVfsTestCloud(initial.cloud, deploymentId, join(home, 'allocations'))
    const key = (await readFile(cloud.apiKeyFile, 'utf8')).trim()
    if (!key || /[\r\n]/u.test(key)) throw new Error('VFS test API credential is empty or malformed')
    const api = new VultrApi(key, cloud.apiEndpoint, cloud.requestTimeoutMs, cloud.maxInventoryPages, cloud.maxApiResponseBytes)
    const operation = AbortSignal.timeout(3_400_000)
    const before = await api.instances(operation)
    const beforeSnapshots = await api.snapshots(operation)
    const volume = await api.volume(initial.cloud.volumeId, operation)
    if (volume.region !== cloud.region) throw new Error('Test volume and instance regions differ')
    let createdRoot = false
    let child: ReturnType<typeof spawn> | undefined
    let exited: Promise<void> | undefined
    let diagnostics = ''
    let failure: unknown
    let accepted: z.infer<typeof reportSchema> | undefined
    const reportFile = join(home, 'report.json')
    try {
      await mkdir(workspaceRoot, { mode: 0o711 })
      createdRoot = true
      await chown(workspaceRoot, initial.webUid, initial.webGid)
      await chmod(workspaceRoot, 0o711)
      await chown(home, initial.webUid, initial.webGid)
      const ownedMkdir = async (path: string): Promise<void> => {
        await mkdir(path, { mode: 0o700 })
        await chown(path, initial.webUid, initial.webGid)
      }
      await ownedMkdir(join(home, 'profiles'))
      const profile = join(home, 'profiles', 'multi-vfs-test')
      await ownedMkdir(profile)
      await ownedMkdir(join(home, 'workspaces'))
      const configFile = join(home, 'config.json')
      const ownedWrite = async (path: string, body: string): Promise<void> => {
        await writeFile(path, body, { mode: 0o600 })
        await chown(path, initial.webUid, initial.webGid)
      }
      await ownedWrite(configFile, JSON.stringify({ ...initial, deploymentId, workspaceRoot }) + '\n')
      await ownedWrite(join(profile, 'package.json'), JSON.stringify({ name: 'antfarm-multi-vfs-test', private: true,
        dependencies: {}, dsh: { profile: { bundles: [] } } }))
      const rows: [string, string, Record<string, unknown>?, string[]?][] = [
        ['storage', '@deepseek-ai/dsh-storage'], ['json', '@deepseek-ai/dsh-storage-json', { root: join(home, 'storage') }],
        ['domain', '@deepseek-ai/dsh-storage-domain', { backend: 'json' }],
        ['persistence', '@deepseek-ai/dsh-session-persistence-jsonl', { root: join(home, 'sessions'), compression: 'none' }],
        ['workspace', '@deepseek-ai/dsh-workspace', { defaultMode: 'multi-vm' }], ['typert', '@deepseek-ai/dsh-typert-registry'],
        ['access', '@deepseek-ai/dsh-api-remote-access'], ['gateway', '@deepseek-ai/dsh-api-gateway'],
        ['server', '@deepseek-ai/dsh-host-webserver', { host: '127.0.0.1', port: 0 }],
        ['connection', '@deepseek-ai/dsh-client-connection', { multiuser: true }],
        ['multiuser', '@deepseek-ai/dsh-api-multiuser', { workspaceRoot: join(home, 'workspaces') }],
        ['vfs-fixture', pathToFileURL(join(import.meta.dirname, 'fixtures/multi-vm-vfs-loader.ts')).href],
        ['sandbox', '@deepseek-ai/dsh-harness-sandbox', { backend: 'provided', workspaceRoot: join(home, 'workspaces') }, ['sandboxRunnerClient']],
        ['llm', '@deepseek-ai/dsh-llm'], ['session', '@deepseek-ai/dsh-session'], ['projection', '@deepseek-ai/dsh-session-projection'],
        ['prompt', '@deepseek-ai/dsh-system-prompt', {}], ['fs', '@deepseek-ai/dsh-fs-local'],
        ['fs-policy', '@deepseek-ai/dsh-fs-observation-policy'], ['directory', '@deepseek-ai/dsh-working-directory', { modelDirectory: '/workspace' }],
        ['tools', '@deepseek-ai/dsh-tools'], ['executor', '@deepseek-ai/dsh-tool-executor-native'], ['agent', '@deepseek-ai/dsh-agent'],
        ['loop', '@deepseek-ai/dsh-agent-loop', { agents: [] }],
        ['model', '@deepseek-ai/dsh-agent-default-model', { provider: 'ssh-fixture', model: 'fixture' }],
        ['commands', '@deepseek-ai/dsh-commands'], ['credentials', '@deepseek-ai/dsh-credentials-local', { dshHome: home, watch: false }],
        ['attachment', '@deepseek-ai/dsh-attachment-local', { dshHome: home }], ['upload-ui', '@deepseek-ai/dsh-client-file-upload'],
        ['query', '@deepseek-ai/dsh-session-query-sqlite', { openAt: 'never', path: ':memory:' }],
        ['session-api', '@deepseek-ai/dsh-api-session-controller', { nativeOpen: false }], ['workspace-api', '@deepseek-ai/dsh-api-workspace-controller'],
        ['upload', '@deepseek-ai/dsh-api-workspace-upload', { storage: 'provided' }, ['workspaceFileAccess']],
        ['artifacts', '@deepseek-ai/dsh-api-workspace-artifacts', { storage: 'provided' }, ['workspaceFileAccess']],
        ['conversation', '@deepseek-ai/dsh-harness-sandbox/conversation'], ['bash', '@deepseek-ai/dsh-harness-sandbox/bash'],
        ['files', '@deepseek-ai/dsh-harness-sandbox/files'],
      ]
      const patch = '- insert:\n' + rows.map(([id, name, values, inject]) => '    - id: ' + id + '\n      name: ' + JSON.stringify(name)
        + '\n' + (inject === undefined ? '' : '      inject: ' + JSON.stringify(inject) + '\n')
        + (values === undefined ? '' : '      config: ' + JSON.stringify(values) + '\n')).join('')
      await ownedWrite(join(profile, 'cordis.patch.yml'), patch)
      const root = resolve(import.meta.dirname, '../../../..')
      const launch = [process.execPath, '--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'multi-vfs-test']
      const command = process.getuid?.() === 0 ? '/usr/bin/setpriv' : launch[0]!
      const args = process.getuid?.() === 0 ? ['--reuid', String(initial.webUid), '--regid', String(initial.webGid),
        '--groups', initial.taskIds.join(','), '--', ...launch] : launch.slice(1)
      cloudStarted = true
      child = spawn(command, args, { cwd: root, env: { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'),
        DSH_TELEMETRY_DISABLED: '1', DSH_MULTI_VM_VFS_TEST_CONFIG: configFile, DSH_MULTI_VM_VFS_TEST_HOME: home,
        DSH_MULTI_VM_VFS_TEST_REPORT: reportFile }, stdio: ['ignore', 'pipe', 'pipe'] })
      const output = (chunk: Buffer): void => {
        const text = chunk.toString().replaceAll(key, '[redacted]')
        diagnostics = (diagnostics + text).slice(-32 * 1024)
        if (text.includes('Multi VM VFS acceptance:')) process.stdout.write(text)
      }
      child.stdout?.on('data', output)
      child.stderr?.on('data', output)
      const running = child
      exited = new Promise<void>((resolveExit, reject) => {
        running.once('error', reject)
        running.once('close', () => { resolveExit() })
      })
      void exited.catch(() => {}) // The cleanup owner awaits the spawn/exit result after stopping report polling.
      while (true) {
        operation.throwIfAborted()
        let raw: string | undefined
        try { raw = await readFile(reportFile, 'utf8') }
        catch (error) { if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error }
        if (raw !== undefined) { accepted = reportSchema.parse(JSON.parse(raw)); break }
        if (running.exitCode !== null || running.signalCode !== null) throw new Error('Source dsh exited before VFS acceptance:\n' + diagnostics)
        await delay(250, undefined, { signal: operation })
      }
      if (!accepted.ok) throw new Error(accepted.error + '\nSafe backend causes: ' + JSON.stringify(accepted.backendCauses) + '\n' + diagnostics)
      expect(accepted.checks.length).toBeGreaterThanOrEqual(30)
      expect(accepted.generations).toHaveLength(3)
    } catch (error) { failure = error }
    try {
      if (child !== undefined && exited !== undefined) {
        child.kill('SIGTERM')
        const force = setTimeout(() => child?.kill('SIGKILL'), 60_000)
        try { await exited } finally { clearTimeout(force) }
        if (child.exitCode !== null && child.exitCode !== 0 || child.signalCode === 'SIGKILL') {
          failure = failure === undefined ? new Error('VFS Loader teardown did not settle successfully:\n' + diagnostics) : failure
        }
      }
      const cleanup = AbortSignal.timeout(180_000)
      const owned = (await api.instances(cleanup)).filter(instance => instance.tags.includes('antfarm-' + deploymentId))
      const reclaimed = await Promise.allSettled(owned.map(async (instance) => {
        let current = await api.instance(instance.id, cleanup)
        if (current !== undefined && (!current.tags.includes('antfarm-' + deploymentId)
          || current.region !== cloud.region || current.plan !== cloud.plan)) throw new Error('Test VM ownership changed before cleanup')
        if (current !== undefined && current.power_status !== 'stopped') {
          await api.power(instance.id, 'halt', cleanup)
          while (current !== undefined && current.power_status !== 'stopped') {
            await delay(1000, undefined, { signal: cleanup })
            current = await api.instance(instance.id, cleanup)
          }
        }
        if (await api.attachment(volume.id, instance.id, cleanup) !== undefined) {
          await api.detach(volume.id, instance.id, cleanup)
          while (await api.attachment(volume.id, instance.id, cleanup) !== undefined) await delay(1000, undefined, { signal: cleanup })
        }
        if (current !== undefined) {
          await api.deleteInstance(instance.id, cleanup)
          while (await api.instance(instance.id, cleanup) !== undefined) await delay(1000, undefined, { signal: cleanup })
        }
      }))
      const rejected = reclaimed.filter(result => result.status === 'rejected')
      if (rejected.length > 0) throw new AggregateError(rejected.map((result): unknown => result.reason),
        'Owned test VM cleanup is unconfirmed; private allocation records and VFS files remain retained')
      const remaining = await api.instances(cleanup)
      expect(remaining.some(instance => instance.tags.includes('antfarm-' + deploymentId))).toBe(false)
      const snapshots = await api.snapshots(cleanup)
      expect(snapshots.some(snapshot => snapshot.description.startsWith('antfarm-' + deploymentId + '-'))).toBe(false)
      expect(before.every(instance => remaining.some(current => current.id === instance.id))).toBe(true)
      expect(beforeSnapshots.every(snapshot => snapshots.some(current => current.id === snapshot.id))).toBe(true)
      expect((await api.volume(volume.id, cleanup)).id).toBe(volume.id)
      if (createdRoot) await rm(workspaceRoot, { recursive: true })
      if (accepted?.ok && failure === undefined) {
        const evidence = process.env.DSH_MULTI_VM_VFS_TEST_EVIDENCE
        if (evidence !== undefined) await writeFile(evidence, JSON.stringify({ ...accepted, cleanupConfirmed: true }, null, 2) + '\n', { mode: 0o600 })
        console.info('Multi VM VFS Loader acceptance:', { checks: accepted.checks.length, openMs: accepted.openMs, reopenMs: accepted.reopenMs,
          archiveMs: accepted.archiveMs, deleteMs: accepted.deleteMs, closeMs: accepted.closeMs, realVfs: true, cleanupConfirmed: true })
      }
      await rm(home, { recursive: true })
    } catch (cleanup) { throw failure === undefined ? cleanup : new AggregateError([failure, cleanup], 'VFS acceptance and owned resource cleanup failed') }
    if (failure !== undefined) throw failure
  })
})
