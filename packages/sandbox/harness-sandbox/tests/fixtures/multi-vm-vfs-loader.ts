/** Opt-in real VFS/SSH composition; only the external model response stream is scripted. */
import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId, WorkspaceMode, WorkspaceModeChange, WorkspaceModeChangeId } from '@deepseek-ai/dsh-workspace/types'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-api-multiuser'
import type {} from '@deepseek-ai/dsh-api-workspace-controller'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '../../src/index.ts'
import WorkspaceModeBackend from '../../src/mode-backend.ts'
import { WorkspaceModeRuntimeAdapter, type WorkspaceModeResources } from '../../src/mode-runtime.ts'
import type { WorkspaceModeTarget } from '../../src/mode-routing.ts'
import { SingleVmWorkspaces } from '../../src/single-vm-workspaces.ts'
import { createMultiVmVultrBackend, singleVmAllocation, type SingleVmVultrBackend } from '../../src/single-vm-vultr.ts'
import { Config, type ResolvedConfig } from '../../src/vultr-config.ts'
import { VultrApi, vultrVolumeId } from '../../src/vultr-api.ts'
import { executionRequest } from '../../src/execution.ts'
import { WorkspaceFixtureModel } from './ssh-loader.ts'

/** Private opt-in test assets; state roots and deployment identity are replaced by the owning test. */
export const multiVmVfsTestConfig = z.object({
  webUid: z.number().int().positive(), webGid: z.number().int().positive(),
  taskIds: z.array(z.number().int().positive()).min(2), mountPoint: z.string(), mountTag: z.string().regex(/^[0-9]+$/u),
  cloud: z.object({
    apiKeyFile: z.string(), sshKeyFile: z.string(), helperArchive: z.string(),
    helperArchiveHash: z.string(), helperHash: z.string(), region: z.string(), plan: z.string(), osId: z.number().int().positive(),
    volumeId: vultrVolumeId, vfsScriptsRoot: z.string(), apiEndpoint: z.string().optional(),
    requestTimeoutMs: z.number().int().positive().optional(), operationTimeoutMs: z.number().int().positive().optional(),
    pollIntervalMs: z.number().int().positive().optional(), maxInventoryPages: z.number().int().positive().optional(),
    maxApiResponseBytes: z.number().int().positive().optional(),
  }),
})

/**
 * Resolve supplied cloud values through the provider schema, omitting absent optional settings.
 * @param cloud - Validated private test assets and explicitly supplied provider settings.
 * @param deploymentId - This test's unique cloud ownership tag.
 * @param stateRoot - This test's private allocation directory.
 * @returns Provider defaults applied to supplied values without retaining undefined optional properties.
 */
export function resolveMultiVmVfsTestCloud(cloud: z.infer<typeof multiVmVfsTestConfig>['cloud'],
  deploymentId: string, stateRoot: string): ResolvedConfig {
  return Config({
    apiKeyFile: cloud.apiKeyFile, sshKeyFile: cloud.sshKeyFile, helperArchive: cloud.helperArchive,
    helperArchiveHash: cloud.helperArchiveHash, helperHash: cloud.helperHash, region: cloud.region, plan: cloud.plan,
    osId: cloud.osId, deploymentId, stateRoot,
    ...cloud.apiEndpoint === undefined ? {} : { apiEndpoint: cloud.apiEndpoint },
    ...cloud.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: cloud.requestTimeoutMs },
    ...cloud.operationTimeoutMs === undefined ? {} : { operationTimeoutMs: cloud.operationTimeoutMs },
    ...cloud.pollIntervalMs === undefined ? {} : { pollIntervalMs: cloud.pollIntervalMs },
    ...cloud.maxInventoryPages === undefined ? {} : { maxInventoryPages: cloud.maxInventoryPages },
    ...cloud.maxApiResponseBytes === undefined ? {} : { maxApiResponseBytes: cloud.maxApiResponseBytes },
  })
}

/** Test-only VFS provider loaded from an owned source profile. */
export const name = 'multi-vm-vfs-loader-fixture'
/** Registry initialization precedes the fixture's private VM and mode providers. */
export const inject = ['workspaceRegistry']

function safeBackendCauses(error: unknown) {
  const causes: {
    name: string
    reason: string
    code?: string | number | undefined
    status?: number | undefined
    outcomeUnknown?: boolean | undefined
  }[] = []
  const knownMessages = new Set([
    'Single VM VFS volume does not match the active volume in the selected region',
    'Single VM allocation does not match the original request', 'Single VM lacks verified Shared Memory Backing',
    'Single VM disappeared during preparation', 'Single VM attachment does not match the requested volume and instance',
    'Single VM attachment has no usable Mount Tag', 'Single VM helper has a different workspace root',
    'Persistent VM VFS volume differs from the original active volume', 'Original VFS Mount Tag has changed',
    'Single VM workspace has no bound task identity', 'Single VM VFS directory has unexpected task ownership or permissions',
  ])
  const seen = new Set<unknown>()
  let current = error
  while (current instanceof Error && causes.length < 8 && !seen.has(current)) {
    seen.add(current)
    const fields = z.object({ code: z.union([z.string().regex(/^[A-Z0-9_]{1,64}$/u), z.number()]).optional(),
      status: z.number().optional(), outcomeUnknown: z.boolean().optional() }).safeParse(current)
    let reason = knownMessages.has(current.message) ? current.message : 'Operation failed; unsafe message omitted'
    if (current.message.startsWith('Command failed:')) {
      const program = current.message.match(/^Command failed:\s*(\S+)/u)?.[1]
      const leaf = program === undefined ? undefined : basename(program)
      reason = leaf !== undefined && ['ssh-keygen', 'ssh', 'ssh-keyscan', 'scp', 'tar', 'node'].includes(leaf)
        ? 'Subprocess failed: ' + leaf : 'Subprocess failed'
    }
    const stderr = z.object({ stderr: z.string() }).safeParse(current)
    if (stderr.success) {
      const kinds = [['Permission denied', 'permission'], ['No such file or directory', 'missing-file'],
        ['No user exists for uid', 'missing-host-user'],
        ['invalid format', 'invalid-key-format'], ['UNPROTECTED PRIVATE KEY FILE', 'unsafe-key-mode'],
        ['Connection refused', 'connection-refused'], ['Connection timed out', 'connection-timeout'],
        ['Host key verification failed', 'host-key-verification']] as const
      const kind = kinds.find(([text]) => stderr.data.stderr.includes(text))
      if (kind !== undefined) reason += '; stderr category: ' + kind[1]
    }
    causes.push({ name: current.name, reason, ...fields.success ? fields.data : {} })
    current = current.cause
  }
  return causes
}

/**
 * Register the real factory and run authenticated native-tool checks after Loader readiness.
 * @param ctx - The test profile's exclusive provider owner.
 * @returns Provider initialization; teardown awaits acceptance before cloud runtime disposal.
 */
export async function apply(ctx: Context): Promise<void> {
  const configFile = process.env.DSH_MULTI_VM_VFS_TEST_CONFIG
  const home = process.env.DSH_MULTI_VM_VFS_TEST_HOME
  const report = process.env.DSH_MULTI_VM_VFS_TEST_REPORT
  if (configFile === undefined || home === undefined || report === undefined) throw new Error('VFS fixture needs private test coordinates')
  const config = multiVmVfsTestConfig.extend({ deploymentId: z.string(), workspaceRoot: z.string() }).parse(JSON.parse(await readFile(configFile, 'utf8')))
  if (process.getuid?.() !== config.webUid || process.getgid?.() !== config.webGid
    || !config.taskIds.every(id => process.getgroups?.().includes(id))) throw new Error('VFS test Web identity or supplementary groups differ')
  const projectRoot = join(home, 'workspaces')
  const workspaces = new SingleVmWorkspaces({ projectRoot, mountPoint: config.mountPoint, mountTag: config.mountTag,
    workspaceRoot: config.workspaceRoot, stateRoot: join(home, 'identities'), taskIds: config.taskIds }, id => ctx.workspaceRegistry.get(id))
  const settings = resolveMultiVmVfsTestCloud(config.cloud, config.deploymentId, join(home, 'allocations'))
  const backend = await createMultiVmVultrBackend(ctx, { ...settings, maxInstances: 2,
    volumeId: config.cloud.volumeId, vfsScriptsRoot: config.cloud.vfsScriptsRoot }, workspaces)
  const backendCauses: ReturnType<typeof safeBackendCauses>[] = []
  const originalOpen = backend.open.bind(backend)
  backend.open = async (id, project) => {
    try { return await originalOpen(id, project) }
    catch (error) { backendCauses.push(safeBackendCauses(error)); throw error }
  }
  const lifetime = new AbortController()
  const ownedWorkspaceIds = new Set<WorkspaceId>()
  let keeper: ReturnType<typeof setInterval> | undefined
  let work: Promise<void> | undefined
  try {
    ctx.effect(() => async () => {
      lifetime.abort(new Error('VFS acceptance stopped'))
      if (keeper !== undefined) clearInterval(keeper)
      try { await work } finally {
        const closed = await Promise.allSettled([...ownedWorkspaceIds].map(id => backend.close(id)))
        const failures: unknown[] = closed.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
        try { await backend.dispose() } catch (error) { failures.push(error) }
        if (failures.length > 0) throw new AggregateError(failures,
          'Owned VFS test guest retirement did not complete; allocation records remain available')
      }
    })
  } catch (error) { await backend.dispose(); throw error }
  const resources = workspaces.resources('multi-vm', backend, { maxFiles: 1000, maxBytes: 1024 * 1024 })
  await ctx.plugin(WorkspaceModeBackend, { modes: ctx.workspaceRegistry.modes,
    targets: new Map<WorkspaceMode, WorkspaceModeTarget>([['multi-vm', { execution: backend, files: workspaces.files }]]),
    runtime: new WorkspaceModeRuntimeAdapter(new Map<WorkspaceMode, WorkspaceModeResources>([['multi-vm', resources]])),
  })
  ctx.inject(['multiuser', 'workspaceRegistry', 'sandboxRunnerClient', 'workspaceSandbox', 'agentLoop', 'llm', 'webServer'], (ready) => {
    keeper = setInterval(() => {}, 1000)
    const publishReport = async (value: unknown): Promise<void> => {
      const temporary = report + '.' + randomUUID()
      await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' })
      await rename(temporary, report)
    }
    work = ready.loader.await().then(() => run(ready, backend, workspaces, config, home, lifetime.signal, ownedWorkspaceIds)).then(
      result => publishReport({ ok: true, ...result }),
      (error: unknown) => publishReport({ ok: false, error: error instanceof Error ? error.stack : String(error), backendCauses }),
    )
    void work.catch(() => {}) // The owning teardown awaits and propagates report publication failures.
  })
}

async function run(ctx: Context, backend: SingleVmVultrBackend, workspaces: SingleVmWorkspaces,
  config: z.infer<typeof multiVmVfsTestConfig> & { deploymentId: string; workspaceRoot: string }, home: string, signal: AbortSignal,
  ownedWorkspaceIds: Set<WorkspaceId>) {
  const checks: string[] = []
  const check = (ok: boolean, text: string): void => {
    if (!ok) throw new Error(text)
    checks.push(text)
    console.info('Multi VM VFS acceptance:', text)
  }
  const model = new WorkspaceFixtureModel()
  ctx.effect(() => ctx.llm.registerAdapter(['ssh-fixture'], model))
  const base = `http://127.0.0.1:${ctx.webServer.port}`
  const settings = resolveMultiVmVfsTestCloud(config.cloud, config.deploymentId, join(home, 'allocations'))
  const key = (await readFile(config.cloud.apiKeyFile, 'utf8')).trim()
  const api = new VultrApi(key, settings.apiEndpoint, settings.requestTimeoutMs, settings.maxInventoryPages, settings.maxApiResponseBytes)
  const account = async (username: string) => {
    const password = randomUUID()
    const user = await ctx.multiuser.provisionUser(username, password)
    const workspace = await ctx.multiuser.createUserWorkspace(user.userId, username)
    ownedWorkspaceIds.add(workspace.id)
    const change: WorkspaceModeChange = { changeId: brandString<WorkspaceModeChangeId>(randomUUID()), workspaceId: workspace.id,
      project: workspace.path, from: 'multi-vm', to: 'multi-vm', previousRevision: 0 }
    const initial = workspaces.importResources('multi-vm', backend, { maxFiles: 1000, maxBytes: 1024 * 1024 })
    await initial.stage(change, { root: workspace.path }, signal)
    await initial.publish(change, signal)
    const response = await fetch(base + '/auth/login', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }), signal })
    check(response.ok, 'Authenticated test account can log in')
    const cookie = response.headers.getSetCookie()[0]?.split(';', 1)[0]
    if (cookie === undefined) throw new Error('Login did not return a session cookie')
    const directory = workspaces.resolve({ workspaceId: workspace.id, project: workspace.path, signal, admit() {} })
    return { user, workspace, cookie, directory }
  }
  const a = await account('vfs-alice')
  const b = await account('vfs-bob')
  check(a.directory.uid !== b.directory.uid && a.directory.gid !== b.directory.gid, 'Two workspace directories retain distinct task UID/GID identities')
  const rpc = async (cookie: string, method: string, args: unknown) => {
    const response = await fetch(base + '/api/' + method, { method: 'POST', headers: { origin: base, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }), signal })
    return z.object({ result: z.object({ ok: z.boolean(), value: z.unknown().optional() }).loose() }).parse(await response.json()).result
  }
  const upload = (cookie: string, id: typeof a.workspace.id, name: string, body: string) => fetch(base + '/api/workspace/uploadFileBinary?'
    + new URLSearchParams({ workspaceId: id, name }).toString(), {
    method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/octet-stream' }, body, signal,
  })
  const download = () => fetch(base + '/api/workspace/downloadFileBinary?'
    + new URLSearchParams({ workspaceId: a.workspace.id, path: 'output.txt' }).toString(),
  { headers: { cookie: a.cookie }, signal })
  check((await upload(a.cookie, a.workspace.id, 'input.txt', 'persisted-before-vm\n')).ok, 'HTTP upload writes directly to verified VFS before a VM exists')
  check((await backend.status(a.workspace.id)).state === 'closed', 'Upload does not allocate a VM')
  check(await readFile(join(a.directory.root, 'input.txt'), 'utf8') === 'persisted-before-vm\n', 'Host VFS contains the uploaded bytes')
  check(!(await upload(b.cookie, a.workspace.id, 'denied.txt', 'denied')).ok, 'Other accounts cannot upload into this workspace')
  const openedAt = performance.now()
  const [opened, shared, other] = await Promise.all([
    ctx.workspaceSandbox.openForUser(a.user.userId, a.workspace.id), ctx.workspaceSandbox.openForUser(a.user.userId, a.workspace.id),
    ctx.workspaceSandbox.openForUser(b.user.userId, b.workspace.id),
  ])
  const openMs = Math.round(performance.now() - openedAt)
  check(opened.containerId === shared.containerId && opened.containerId !== other.containerId, 'Concurrent opens share one persistent VM per workspace')
  const state = async (id: typeof a.workspace.id) => singleVmAllocation.parse(JSON.parse(await readFile(join(home, 'allocations', id, 'state.json'), 'utf8')))
  const original = await state(a.workspace.id)
  const otherRecord = await state(b.workspace.id)
  check(original.instanceId !== undefined && otherRecord.instanceId !== undefined && original.instanceId !== otherRecord.instanceId,
    'Durable allocation records identify two distinct real VMs')
  const execute = (command: string, target = opened, workspaceId = a.workspace.id) => backend.execute(workspaceId,
    executionRequest.parse({ executionId: randomUUID(), expectedContainerId: target.containerId, command, workdir: '.', timeoutMs: 10_000 }), signal)
  check((await execute('id -u; id -g')).stdout.text === `${a.directory.uid}\n${a.directory.gid}\n`, 'Guest helper uses the workspace task UID/GID')
  check((await execute('cat input.txt')).stdout.text === 'persisted-before-vm\n', 'VM Bash reads files uploaded before allocation')
  const mounts = await execute("findmnt -n -o FSTYPE,TARGET,SOURCE -T /workspace; stat -c '%u:%g:%a' /workspace")
  check(mounts.exitCode === 0 && mounts.stdout.text.includes('virtiofs')
    && mounts.stdout.text.includes('/workspace') && mounts.stdout.text.includes(a.directory.volumePath)
    && original.attachment.state === 'attached' && mounts.stdout.text.includes(String(original.attachment.mountTag))
    && mounts.stdout.text.includes(`${config.webUid}:${a.directory.gid}:2770`),
  'Guest workspace is backed by virtiofs with the expected directory ownership and mode')
  check(original.attachment.state === 'attached' && (await api.attachment(original.volumeId, original.instanceId!, signal))?.mount_tag === original.attachment.mountTag,
    'Real cloud volume attachment matches its persisted mount tag')
  const results: SessionEvent<'tool/result'>[] = []
  ctx.on('session/event', (_session, event) => { if (event.type === 'tool/result') results.push(event) }, { global: true })
  const session = async () => {
    const agent = await ctx.agentLoop.create(SessionId(randomUUID()), { provider: 'ssh-fixture', model: 'fixture' }, { cwd: a.workspace.path })
    await a.workspace.attachSession(agent.id)
    return agent
  }
  const first = await session()
  const second = await session()
  const native = async (agent: typeof first, script: { name: string; args: unknown }[]) => {
    const before = results.length
    check((await rpc(a.cookie, 'session/prompt', { request: { sessionId: agent.id, requestId: randomUUID(), mode: 'queue',
      content: [{ type: 'text', text: 'files:' + JSON.stringify(script) }] } })).ok, 'Authenticated prompt enters the native agent loop')
    await agent.whenIdle()
    const settled = results.slice(before)
    check(settled.length === script.length && settled.every(event => !event.data.message.isError), 'Native tools emit successful durable Session results')
    return settled
  }
  await native(first, [{ name: 'read', args: { file_path: 'input.txt' } },
    { name: 'write', args: { file_path: 'output.txt', content: 'left target right\n' } },
    { name: 'edit', args: { file_path: 'output.txt', old_string: 'target', new_string: 'changed' } },
    { name: 'bash', args: { command: 'cat output.txt', description: 'Read the edited workspace result' } }])
  check((await backend.status(a.workspace.id)).state === 'running'
    && (await ctx.workspaceSandbox.openForUser(a.user.userId, a.workspace.id)).containerId === opened.containerId,
  'Finishing a native turn retains the persistent VM generation')
  const reused = await native(second, [{ name: 'read', args: { file_path: 'output.txt' } }])
  check(JSON.stringify(reused).includes('left changed right'), 'Another Session reads the same persistent workspace result')
  check((await state(a.workspace.id)).instanceId === original.instanceId, 'Two Sessions continue using the same real VM')
  check(await (await download()).text() === 'left changed right\n', 'Authenticated HTTP download returns the native edited bytes')
  const escape = `/srv/antfarm/vfs${a.directory.volumePath}/output.txt`
  const escapedPath = "'" + escape.replaceAll("'", "'\\''") + "'"
  const deniedRead = await execute('LC_ALL=C cat ' + escapedPath, other, b.workspace.id)
  check(deniedRead.exitCode !== 0 && deniedRead.stderr.text.includes('Permission denied'),
    'Another task UID receives a permission refusal through the full shared volume')
  const archiveAt = performance.now()
  check((await rpc(a.cookie, 'workspace/setArchived', { request: { workspaceId: a.workspace.id, archived: true } })).ok,
    'Archiving through the real Workspace API confirms resource release')
  check(await api.instance(original.instanceId!, signal) === undefined
    && await api.attachment(original.volumeId, original.instanceId!, signal) === undefined,
  'Archived workspace VM is absent and its volume attachment is detached')
  const archiveMs = Math.round(performance.now() - archiveAt)
  const archivedDownload = await download()
  check(!archivedDownload.ok, 'Archived workspace refuses authenticated HTTP file access')
  await archivedDownload.arrayBuffer()
  check(await readFile(join(a.directory.root, 'output.txt'), 'utf8') === 'left changed right\n', 'Archiving retains file bytes on VFS')
  check((await backend.status(a.workspace.id)).state === 'closed', 'Archived workspace remains closed after refused file access')
  check((await rpc(a.cookie, 'workspace/setArchived', { request: { workspaceId: a.workspace.id, archived: false } })).ok,
    'Restoring archival state succeeds without starting a VM')
  const unarchivedDownload = await download()
  check(unarchivedDownload.ok && await unarchivedDownload.text() === 'left changed right\n',
    'Unarchiving restores HTTP file access to preserved VFS bytes')
  check((await backend.status(a.workspace.id)).state === 'closed', 'Unarchiving and file download do not allocate a VM')
  const resumedAt = performance.now()
  const restored = await ctx.workspaceSandbox.openForUser(a.user.userId, a.workspace.id)
  const reopenMs = Math.round(performance.now() - resumedAt)
  const replacement = await state(a.workspace.id)
  check(replacement.instanceId !== original.instanceId && restored.containerId !== opened.containerId, 'Reopening creates a fresh VM generation using the existing volume directory')
  check((await execute('cat output.txt', restored)).stdout.text === 'left changed right\n', 'Fresh VM reads the durable VFS output without a disk snapshot')
  const restoredDirectory = workspaces.resolve({ workspaceId: a.workspace.id, project: a.workspace.path, signal, admit() {} })
  check(restoredDirectory.uid === a.directory.uid && (await stat(restoredDirectory.root)).gid === a.directory.gid, 'Reopening preserves the workspace task identity')
  const deleteAt = performance.now()
  check((await rpc(a.cookie, 'workspace/delete', { request: { workspaceId: a.workspace.id } })).ok, 'Deleting through the real Workspace API confirms resource release')
  check(await api.instance(replacement.instanceId!, signal) === undefined
    && await api.attachment(replacement.volumeId, replacement.instanceId!, signal) === undefined,
  'Deleted workspace VM is absent and its volume attachment is detached')
  const deleteMs = Math.round(performance.now() - deleteAt)
  check(ctx.workspaceRegistry.get(a.workspace.id) === undefined
    && await readFile(join(config.workspaceRoot, basename(a.workspace.path), 'output.txt'), 'utf8') === 'left changed right\n',
  'Deletion removes registration while retaining workspace file bytes')
  const closeAt = performance.now()
  check((await rpc(b.cookie, 'workspaceSandbox/close', { request: { workspaceId: b.workspace.id } })).ok,
    'Authenticated close explicitly reclaims the second owned test VM')
  check(await api.instance(otherRecord.instanceId!, signal) === undefined
    && await api.attachment(otherRecord.volumeId, otherRecord.instanceId!, signal) === undefined,
  'The second owned test VM and its volume attachment are absent')
  const closeMs = Math.round(performance.now() - closeAt)
  return { checks, openMs, reopenMs, archiveMs, deleteMs, closeMs, realCloud: true, realSsh: true, realVfs: true,
    model: 'scripted external adapter',
    workspaceIds: [a.workspace.id, b.workspace.id], generations: [opened.containerId, other.containerId, restored.containerId] }
}
