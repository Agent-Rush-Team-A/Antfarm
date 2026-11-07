/** Real cloud and SSH acceptance through authenticated Harness HTTP and native tool execution. */
import { randomUUID, createHash } from 'node:crypto'
import { readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-api-multiuser'
import type {} from '@deepseek-ai/dsh-api-workspace-controller'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-api-workspace-artifacts'
import type {} from '@deepseek-ai/dsh-api-workspace-upload'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '../../src/index.ts'
import { WorkspaceFixtureModel } from './ssh-loader.ts'
import { executionRequest } from '../../src/execution.ts'
import { z } from 'zod'

export const name = 'vultr-workspace-acceptance'
export const inject = ['multiuser', 'workspaceRegistry', 'workspaceController', 'sandboxRunnerClient', 'workspaceSandbox', 'sandboxConversation', 'agentLoop', 'sessionController', 'llm', 'webServer', 'workspaceUpload', 'workspaceArtifacts']

export function apply(ctx: Context): void {
  const report = process.env.DSH_VULTR_TEST_REPORT
  if (report === undefined) throw new Error('Vultr acceptance needs an owned report file')
  const lifetime = new AbortController()
  const keeper = setInterval(() => {}, 1000)
  const task = ctx.loader.await().then(() => run(ctx, lifetime.signal)).then(
    result => writeFile(report, JSON.stringify({ ok: true, ...result })),
    (error: unknown) => writeFile(report, JSON.stringify({ ok: false, error: error instanceof Error ? error.stack : String(error) })),
  )
  ctx.effect(() => async () => { lifetime.abort(); clearInterval(keeper); await task })
}

async function run(ctx: Context, signal: AbortSignal) {
  const checks: string[] = []
  const check = (ok: boolean, message: string): void => {
    if (!ok) throw new Error(message)
    checks.push(message)
    console.info('Vultr acceptance:', message)
  }
  const model = new WorkspaceFixtureModel()
  ctx.effect(() => ctx.llm.registerAdapter(['ssh-fixture'], model))
  const base = `http://127.0.0.1:${ctx.webServer.port}`
  const account = async (username: string) => {
    const password = randomUUID()
    const user = await ctx.multiuser.provisionUser(username, password)
    const workspace = await ctx.multiuser.createUserWorkspace(user.userId, username)
    const login = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ username, password }), signal })
    check(login.ok, 'Native account login succeeds')
    const cookie = login.headers.getSetCookie()[0]?.split(';', 1)[0]
    if (cookie === undefined) throw new Error('Login did not return a cookie')
    return { user, workspace, cookie }
  }
  const a = await account('cloud-alice')
  const b = await account('cloud-bob')
  const rpc = async (cookie: string, method: string, args: unknown) => {
    const response = await fetch(base + '/api/' + method, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }), signal })
    return z.object({ result: z.object({ ok: z.boolean(), value: z.unknown().optional() }).loose() }).parse(await response.json()).result
  }
  const agent = await ctx.agentLoop.create(SessionId(randomUUID()), { provider: 'ssh-fixture', model: 'fixture' }, { cwd: a.workspace.path })
  await a.workspace.attachSession(agent.id)
  const results: SessionEvent<'tool/result'>[] = []
  ctx.on('session/event', (_session, event) => { if (event.type === 'tool/result') results.push(event) }, { global: true })
  const native = async (script: { name: string; args: unknown }[], target = agent) => {
    const before = results.length
    const request = { sessionId: target.id, requestId: randomUUID(), content: [{ type: 'text', text: 'files:' + JSON.stringify(script) }], mode: 'queue' }
    check((await rpc(a.cookie, 'session/prompt', { request })).ok, 'Authenticated native tool prompt enters Harness')
    await target.whenIdle()
    const settled = results.slice(before)
    check(settled.length === script.length && settled.every(event => !event.data.message.isError), 'Native tool calls have successful durable results')
    return settled
  }
  const [opened, shared, other] = await Promise.all([
    ctx.workspaceSandbox.openForUser(a.user.userId, a.workspace.id),
    ctx.workspaceSandbox.openForUser(a.user.userId, a.workspace.id),
    ctx.workspaceSandbox.openForUser(b.user.userId, b.workspace.id),
  ])
  check(opened.containerId === shared.containerId && opened.containerId !== other.containerId, 'Concurrent opens share one Workspace VM and separate another Workspace')
  check(!(await rpc(b.cookie, 'workspaceSandbox/open', { request: { workspaceId: a.workspace.id } })).ok, 'Another account cannot open this Workspace')
  const configFile = process.env.DSH_VULTR_TEST_CONFIG
  if (configFile === undefined) throw new Error('Cloud test settings did not load')
  const config = z.object({ stateRoot: z.string() }).parse(JSON.parse(await readFile(configFile, 'utf8')))
  const state = async (id: typeof a.workspace.id) => z.object({ instanceId: z.string().optional(), snapshotId: z.string().optional(), generation: z.string() }).parse(JSON.parse(await readFile(join(config.stateRoot, id, 'state.json'), 'utf8')))
  const original = await state(a.workspace.id)
  const second = await state(b.workspace.id)
  check(original.instanceId !== undefined && second.instanceId !== undefined && original.instanceId !== second.instanceId, 'Persisted instance identities identify two distinct real Vultr VMs')
  const backend = ctx.sandboxRunnerClient
  const execute = (command: string, timeoutMs = 5000, target = opened) => backend.execute(a.workspace.id,
    executionRequest.parse({ executionId: randomUUID(), expectedContainerId: target.containerId, command, workdir: '.', timeoutMs }))
  check((await execute('if command -v docker >/dev/null 2>&1; then exit 1; fi; id -u')).stdout.text.trim() === '10001', 'Standalone helper executes as a non-root account on a VM without Docker')
  const upload = async (cookie: string, id: typeof a.workspace.id, name: string, body: Uint8Array) => fetch(base + '/api/workspace/uploadFileBinary?' + new URLSearchParams({ workspaceId: id, name }).toString(),
    { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/octet-stream' }, body: Buffer.from(body), signal })
  const bytes = Buffer.from('uploaded-through-http\n')
  check((await upload(a.cookie, a.workspace.id, 'input.txt', bytes)).ok, 'Real authenticated HTTP upload commits into the remote workspace')
  check(!(await upload(b.cookie, a.workspace.id, 'denied.txt', bytes)).ok, 'Another account cannot upload into this Workspace')
  check((await execute('cat input.txt')).stdout.text === bytes.toString(), 'Remote Bash reads the uploaded file')
  const nativeResults = await native([
    { name: 'read', args: { file_path: 'input.txt' } },
    { name: 'write', args: { file_path: 'output.txt', content: 'left target right\n' } },
    { name: 'edit', args: { file_path: 'output.txt', old_string: 'target', new_string: 'changed' } },
    { name: 'bash', args: { command: 'cat output.txt', description: 'Inspect remotely edited file' } },
  ])
  check(JSON.stringify(nativeResults).includes('uploaded-through-http') && JSON.stringify(nativeResults).includes('left changed right'), 'Native read/write/edit and Bash share the HTTP file environment')
  const session = await ctx.agentLoop.create(SessionId(randomUUID()), { provider: 'ssh-fixture', model: 'fixture' }, { cwd: a.workspace.path })
  await a.workspace.attachSession(session.id)
  await native([{ name: 'read', args: { file_path: 'output.txt' } }], session)
  check((await ctx.workspaceSandbox.openForUser(a.user.userId, a.workspace.id)).containerId === opened.containerId, 'Two native sessions share the same Workspace generation')
  const listing = await rpc(a.cookie, 'workspaceArtifacts/list', { request: { workspaceId: a.workspace.id }, path: '' })
  check(listing.ok && JSON.stringify(listing.value).includes('output.txt'), 'Real Gateway listing sees files generated by native tools')
  const download = async () => fetch(base + '/api/workspace/downloadFileBinary?' + new URLSearchParams({ workspaceId: a.workspace.id, path: 'output.txt' }).toString(), { headers: { cookie: a.cookie }, signal })
  check(await (await download()).text() === 'left changed right\n', 'Real HTTP download returns remotely edited bytes')
  check(await access(join(a.workspace.path, 'output.txt')).then(() => false, () => true), 'Remote writes never execute or persist into the registered Harness project')
  const otherFile = await backend.files(b.workspace.id, other.containerId, signal)
  const otherTarget = await otherFile.fs.resolve('output.txt', { cwd: otherFile.root, signal: otherFile.signal })
  check(await otherFile.fs.stat(otherTarget, otherFile.signal) === undefined, 'Another VM cannot read the first Workspace output')
  check((await execute("mkdir -p env; printf 'VALUE=42\\n' > env/proof.py; chmod 0600 env/proof.py; python3 -c 'import runpy; print(runpy.run_path(\"env/proof.py\")[\"VALUE\"])'" )).stdout.text.trim() === '42', 'An installed Python module and its permissions are prepared before preservation')
  const timed = execute('echo $$ > timed.pid; sleep 30', 500).then(() => false, (error: unknown) => z.object({ code: z.literal('execution_timeout'), execution: z.object({ cleanup: z.literal('processes_cleaned') }) }).safeParse(error).success)
  check(await timed, 'Command timeout confirms remote process cleanup')
  check((await execute('if kill -0 "$(cat timed.pid)" 2>/dev/null; then exit 1; fi')).exitCode === 0, 'The timed-out remote process is absent')
  const pendingRequest = executionRequest.parse({ executionId: randomUUID(), expectedContainerId: opened.containerId,
    command: 'echo $$ > closing.pid; sleep 1800', workdir: '.', timeoutMs: 60_000 })
  const pending = backend.execute(a.workspace.id, pendingRequest).then(() => false, (error: unknown) => z.object({ execution: z.object({ reason: z.literal('shutdown'), cleanup: z.literal('processes_cleaned') }) }).safeParse(error).success)
  const liveFiles = await backend.files(a.workspace.id, opened.containerId, signal)
  while (true) {
    const pid = await liveFiles.fs.resolve('closing.pid', { cwd: liveFiles.root, signal: liveFiles.signal })
    if (await liveFiles.fs.stat(pid, liveFiles.signal)) break
    await new Promise<void>(resolve => setTimeout(resolve, 25))
  }
  const started = performance.now()
  check((await ctx.workspaceSandbox.closeForUser(a.user.userId, a.workspace.id)).state === 'closed', 'Close preserves a complete disk snapshot and removes the original VM')
  const saveMs = Math.round(performance.now() - started)
  check(await pending, 'Close drains the original running command')
  check(liveFiles.signal.aborted, 'Close revokes old file capabilities')
  check(await (await download()).text() === 'left changed right\n', 'Closed Workspace downloads from its private read-only copy without a VM')
  check((await rpc(a.cookie, 'workspaceArtifacts/list', { request: { workspaceId: a.workspace.id }, path: '' })).ok, 'Closed Workspace listing remains available')
  const saved = await state(a.workspace.id)
  check(saved.instanceId === undefined && saved.snapshotId !== undefined, 'Completed save retains snapshot identity and confirms source VM absence')
  const resumedAt = performance.now()
  const reopened = await ctx.workspaceSandbox.openForUser(a.user.userId, a.workspace.id)
  const restoreMs = Math.round(performance.now() - resumedAt)
  const restored = await state(a.workspace.id)
  check(restored.instanceId !== original.instanceId && reopened.containerId !== opened.containerId, 'Restore creates a new VM and execution generation from the retained snapshot')
  check((await execute("cat output.txt; stat -c '%a' env/proof.py; python3 -c 'import runpy; print(runpy.run_path(\"env/proof.py\")[\"VALUE\"])'", 5000, reopened)).stdout.text === 'left changed right\n600\n42\n', 'Restored file contents, permissions and Python environment run again')
  check(await backend.cancel(a.workspace.id, pendingRequest).then(() => false, () => true), 'Old-generation cancellation cannot reach the restored VM')
  const hash = createHash('sha256').update(Buffer.from(await (await download()).arrayBuffer())).digest('hex')
  check(hash === createHash('sha256').update('left changed right\n').digest('hex'), 'Download after restore matches the preserved output hash')
  return { checks, saveMs, restoreMs, workspaceIds: [a.workspace.id, b.workspace.id], realCloud: true, realSsh: true, model: 'scripted external adapter' }
}
