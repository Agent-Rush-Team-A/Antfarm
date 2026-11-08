/** Native Loader composition with real Docker and the registry-owned mode coordinator. */
import { randomUUID } from 'node:crypto'
import { chown, readFile, symlink, unlink, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { MultiuserUser } from '@deepseek-ai/dsh-api-multiuser'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-sandbox-runner'
import type { SessionCreateValue } from '@deepseek-ai/dsh-api-session-controller'
import type { WorkspaceModeValue } from '@deepseek-ai/dsh-workspace/types'
import { WorkspaceModeError } from '@deepseek-ai/dsh-workspace'
import { WorkspaceFixtureModel } from './ssh-loader.ts'

interface Account { readonly user: MultiuserUser; readonly workspace: Workspace; readonly password: string }
declare module '@deepseek-ai/cordis' { interface Context { workspaceModeFixture: WorkspaceModeFixture } }

/** Creates native accounts before the authenticated Docker mode acceptance. */
export default class WorkspaceModeFixture extends Service {
  static inject = ['multiuser', 'workspaceRegistry', 'sandboxRunner']
  readonly accounts: Account[] = []
  constructor(ctx: Context) { super(ctx, 'workspaceModeFixture') }
  async [Service.init](): Promise<void> {
    const home = process.env.DSH_MODE_TEST_HOME
    if (home === undefined) throw new Error('Mode Loader fixture requires an owned home')
    for (const [index, mode] of (['single-docker', 'multi-docker'] as const).entries()) {
      const password = randomUUID()
      const user = await this.ctx.multiuser.provisionUser(`mode-user-${index}`, password)
      const workspace = await this.ctx.multiuser.createUserWorkspace(user.userId, mode)
      await chown(workspace.path, 1000, 1000)
      this.accounts.push({ user, workspace, password })
    }
  }
}

/** Runs the real user-facing flow after all Loader rows have initialized. */
export const acceptance = {
  name: 'workspace-mode-acceptance',
  // The controller outlives the providers it unloads; their teardown must not await this run.
  inject: ['workspaceModeFixture', 'workspaceRegistry', 'sandboxRunner', 'agents', 'llm', 'webServer'],
  apply(ctx: Context) {
    const report = process.env.DSH_MODE_TEST_REPORT
    if (report === undefined) throw new Error('Mode acceptance requires a report path')
    const lifetime = new AbortController()
    const keeper = setInterval(() => {}, 1000)
    const work = ctx.loader.await().then(() => run(ctx, lifetime.signal, report)).then(
      result => writeFile(report, JSON.stringify({ ok: true, ...result })),
      (error: unknown) => writeFile(report, JSON.stringify({ ok: false, error: error instanceof Error ? error.stack : String(error) })),
    )
    ctx.effect(() => async () => { lifetime.abort(); clearInterval(keeper); await work })
  },
}

async function run(ctx: Context, signal: AbortSignal, report: string) {
  const checks: string[] = []
  const generations: string[] = []
  const check = (valid: boolean, name: string): void => {
    if (!valid) throw new Error(name)
    checks.push(name)
    console.info('mode acceptance:', name)
    writeFileSync(report + '.progress', JSON.stringify({ checks, generations }))
  }
  const fixture = ctx.workspaceModeFixture
  const sandbox = ctx.get('workspaceSandbox')
  const conversation = ctx.get('sandboxConversation')
  if (sandbox === undefined || conversation === undefined) throw new Error('Mode runtime providers did not load')
  const [a, b] = fixture.accounts
  if (a === undefined || b === undefined) throw new Error('Mode fixture accounts did not load')
  const base = `http://127.0.0.1:${ctx.webServer.port}`
  const login = async (account: Account) => {
    const response = await fetch(base + '/auth/login', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ username: account.user.username, password: account.password }), signal })
    if (!response.ok) throw new Error('Native mode login failed')
    return response.headers.getSetCookie()[0]!.split(';', 1)[0]!
  }
  const [cookie, otherCookie] = await Promise.all([login(a), login(b)])
  type Reply<T> = { ok: true; value: T; error?: never } | { ok: false; error: { code: string }; value?: never }
  const rpc = async <T = unknown>(owner: string, method: string, args: unknown): Promise<Reply<T>> => {
    const response = await fetch(base + '/api/' + method, { method: 'POST', headers: { cookie: owner, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }), signal })
    return (await response.json() as { result: Reply<T> }).result
  }
  const opened = sandbox.openForUser(b.user.userId, b.workspace.id)
  const opening = sandbox.activityForUser(b.user.userId, b.workspace.id)
  check(opening.busy && opening.openings === 1 && opening.idleSince === null,
    'Manual open immediately counts preparation through the real mode coordinator')
  await opened
  const idle = sandbox.activityForUser(b.user.userId, b.workspace.id)
  if (idle.sandbox.state !== 'running' || idle.idleSince === null) throw new Error('Expected running idle Docker workspace')
  await delay(2)
  const scan = new AbortController()
  const cancelled = sandbox.closeIfIdleForUser(b.user.userId, b.workspace.id,
    { containerId: idle.sandbox.containerId, version: idle.version, revision: idle.revision, idleSince: idle.idleSince },
    1, scan.signal)
  scan.abort()
  const skipped = await cancelled
  const afterScan = sandbox.activityForUser(b.user.userId, b.workspace.id)
  check(skipped.state === 'skipped' && !afterScan.closing && afterScan.revision === idle.revision
    && (await ctx.sandboxRunner.status(b.workspace.id)).state === 'running',
  'Cancelling idle admission returns skipped and preserves the real Docker generation')
  await sandbox.closeForUser(b.user.userId, b.workspace.id)
  const upload = await fetch(base + '/api/workspace/uploadFileBinary?' + new URLSearchParams({ workspaceId: a.workspace.id, name: 'input.csv' }).toString(),
    { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/octet-stream' }, body: 'amount\n10\n15\n7\n', signal })
  check(upload.ok, 'Authenticated upload persists before any execution')
  check((await ctx.sandboxRunner.status(a.workspace.id)).state === 'closed', 'Upload does not create a single-session container')
  const model = new WorkspaceFixtureModel()
  ctx.effect(() => ctx.llm.registerAdapter(['mode-fixture'], model))
  const initial = ctx.workspaceRegistry.modes.get(a.workspace.id)
  check(initial.mode === 'multi-docker' && initial.revision === 0, 'Registry applies the configured Docker default')
  await ctx.sandboxRunner.open(a.workspace.id, a.workspace.path)
  await symlink('input.csv', join(a.workspace.path, 'invalid-link'))
  const rejected = await rpc(cookie, 'workspace/setMode', { request: {
    workspaceId: a.workspace.id, mode: 'single-docker', expectedRevision: initial.revision,
  } })
  check(!rejected.ok && rejected.error.code === 'workspace/mode-switch-failed', 'Incomplete directory preservation rejects a mode switch')
  const restored = ctx.workspaceRegistry.modes.get(a.workspace.id)
  check(restored.mode === 'multi-docker' && restored.operationState === 'ready'
    && (await ctx.sandboxRunner.status(a.workspace.id)).state === 'running', 'Failed switch restores the source mode and Docker environment')
  await unlink(join(a.workspace.path, 'invalid-link'))
  const switched = await rpc<WorkspaceModeValue>(cookie, 'workspace/setMode', { request: {
    workspaceId: a.workspace.id, mode: 'single-docker', expectedRevision: restored.revision,
  } })
  check(switched.ok && switched.value.config.mode === 'single-docker', 'Real coordinator publishes the selected mode before the first session')
  check((await ctx.sandboxRunner.status(a.workspace.id)).state === 'closed', 'Mode transition closes the previous Docker environment')
  const retained = await fetch(base + '/api/workspace/downloadFileBinary?' + new URLSearchParams({ workspaceId: a.workspace.id, path: 'input.csv' }).toString(), { headers: { cookie }, signal })
  check(retained.ok && await retained.text() === 'amount\n10\n15\n7\n', 'Mode transition retains uploaded files through publication')
  check((await rpc(cookie, 'workspace/setMode', { request: { workspaceId: a.workspace.id, mode: 'multi-docker', expectedRevision: 0 } })).error?.code === 'workspace/mode-revision-conflict', 'Stale mode revision is rejected')
  const competing = await Promise.all([
    rpc<SessionCreateValue>(cookie, 'session/create', { request: { workspaceId: a.workspace.id } }),
    rpc<SessionCreateValue>(cookie, 'session/create', { request: { workspaceId: a.workspace.id } }),
  ])
  const accepted = competing.find(reply => reply.ok)
  if (accepted === undefined || !accepted.ok) throw new Error('Native Session creation failed')
  const agent = ctx.agents.get(accepted.value.sessionId)
  if (agent === undefined) throw new Error('Native Session Agent was not published')
  check(competing.filter(reply => reply.ok).length === 1 && competing.some(reply => !reply.ok && reply.error.code === 'workspace/session-limit'), 'Concurrent Session creation retains only one single-mode identity')
  const locked = ctx.workspaceRegistry.modes.get(a.workspace.id)
  check(locked.modeLocked && locked.firstSessionId === agent.id, 'First Session permanently locks the mode')
  const forbidden = await rpc(cookie, 'workspace/setMode', { request: { workspaceId: a.workspace.id, mode: 'multi-docker', expectedRevision: locked.revision } })
  check(!forbidden.ok && forbidden.error.code === 'workspace/mode-locked', 'Locked mode cannot change through authenticated HTTP')
  const results: SessionEvent<'tool/result'>[] = []
  ctx.on('session/event', (_session, event) => { if (event.type === 'tool/result') results.push(event) }, { global: true })
  ctx.on('agent/pre-step', (event, next) => {
    if (event.agent === agent) {
      const id = conversation.forTurn(agent, event.turn).containerId
      if (!generations.includes(id)) generations.push(id)
    }
    return next()
  }, { global: true })
  const closed = async () => {
    const until = performance.now() + 10_000
    while ((await ctx.sandboxRunner.status(a.workspace.id)).state !== 'closed') {
      if (performance.now() >= until) throw new Error('Single-session container did not finish destruction')
      await new Promise<void>(resolve => setTimeout(resolve, 25))
    }
  }
  const native = async (script: { name: string; args: unknown }[], successful = true) => {
    const before = results.length
    const request = { sessionId: agent.id, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'files:' + JSON.stringify(script) }] }
    check((await rpc(cookie, 'session/prompt', { request })).ok, 'Authenticated prompt enters the native inbox')
    await agent.whenIdle()
    await closed()
    const settled = results.slice(before)
    check(settled.length === script.length && settled.every(event => Boolean(event.data.message.isError) !== successful), 'Native tool results are durable and match their outcome')
    return settled
  }
  check(!(await rpc(cookie, 'session/prompt', { request: { sessionId: agent.id, requestId: randomUUID(), mode: 'queue',
    content: [{ type: 'file', receiptId: 'missing-receipt' }] } })).ok, 'Invalid receipt is rejected before environment creation')
  check((await ctx.sandboxRunner.status(a.workspace.id)).state === 'closed', 'Rejected prompt leaves no Docker container')
  for (const operation of ['open', 'close']) check((await rpc(cookie, `workspaceSandbox/${operation}`, { request: { workspaceId: a.workspace.id } })).error?.code === 'sandbox/manual-operation-forbidden', 'Single-session manual lifecycle is refused by the backend')
  const output = await native([
    { name: 'write', args: { file_path: '/workspace/result.txt', content: 'old value\n' } },
    { name: 'edit', args: { file_path: '/workspace/result.txt', old_string: 'old', new_string: 'new' } },
    { name: 'read', args: { file_path: '/workspace/result.txt' } },
    { name: 'bash', args: { command: "awk 'NR>1 {sum += $1} END {print sum}' input.csv > total.txt; cat result.txt; cat total.txt", description: 'Summarize persisted workspace files' } },
  ])
  check(JSON.stringify(output).includes('new value') && JSON.stringify(output).includes('32'), 'Native read/write/edit and real Bash share the persistent bind directory')
  const download = await fetch(base + '/api/workspace/downloadFileBinary?' + new URLSearchParams({ workspaceId: a.workspace.id, path: 'result.txt' }).toString(), { headers: { cookie }, signal })
  check(download.ok && await download.text() === 'new value\n', 'File remains downloadable after container destruction')
  check((await rpc(otherCookie, 'workspaceSandbox/open', { request: { workspaceId: b.workspace.id } })).ok, 'Multi-session Docker retains manual opening')
  check((await ctx.sandboxRunner.status(b.workspace.id)).state === 'running', 'Multi-session Docker survives a completed single-session task')
  const other = await fetch(base + '/api/workspace/downloadFileBinary?' + new URLSearchParams({ workspaceId: b.workspace.id, path: 'result.txt' }).toString(), { headers: { cookie: otherCookie }, signal })
  check(!other.ok, 'Another workspace cannot download the first workspace output')
  await native([{ name: 'bash', args: { command: 'cat result.txt; cat total.txt', description: 'Read files in another task generation' } }])
  check(generations.length === 2 && generations[0] !== generations[1], 'Continuation uses a fresh Docker generation and original files')
  const beforeQueued = results.length
  const submit = (command: string) => rpc(cookie, 'session/prompt', { request: {
    sessionId: agent.id, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'files:' + JSON.stringify([
      { name: 'bash', args: { command, description: 'Process queued workspace input' } },
    ]) }],
  } })
  check((await submit('echo ready > queued.ready; sleep 1; printf A >> queue-order.txt')).ok, 'First queued task enters the real inbox')
  const queuedUntil = performance.now() + 10_000
  while (await readFile(join(a.workspace.path, 'queued.ready'), 'utf8').catch(() => undefined) === undefined) {
    if (performance.now() >= queuedUntil) throw new Error('First queued command did not start')
    await new Promise<void>(resolve => setTimeout(resolve, 25))
  }
  const queuedContainer = await ctx.sandboxRunner.status(a.workspace.id)
  check((await submit('printf B >> queue-order.txt')).ok, 'New input is accepted while the first command runs')
  await agent.whenIdle()
  await closed()
  check(await readFile(join(a.workspace.path, 'queue-order.txt'), 'utf8') === 'AB'
    && results.slice(beforeQueued).length === 2 && queuedContainer.state === 'running' && generations.length === 3,
  'Queued messages execute in order and retain one Docker generation through final cleanup')
  const timed = await native([{ name: 'bash', args: { command: 'sleep 86400 & child=$!; printf "%s %s\n" "$$" "$child" > timeout.pids; wait "$child"', description: 'Exercise real command timeout', timeoutMs: 500 } }], false)
  check(JSON.stringify(timed).includes('Process cleanup is confirmed'), 'Timeout settles real process cleanup before environment destruction')
  await ctx.workspaceRegistry.setArchived(b.workspace.id, true)
  check(ctx.workspaceRegistry.get(b.workspace.id)?.archived === true
    && (await ctx.sandboxRunner.status(b.workspace.id)).state === 'closed',
  'Archival releases the real multi-session Docker container under exclusive Workspace admission')
  await ctx.workspaceRegistry.setArchived(b.workspace.id, false)
  check((await ctx.sandboxRunner.status(b.workspace.id)).state === 'closed',
    'Workspace restoration does not allocate a Docker container')
  const request = { sessionId: agent.id, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'files:' + JSON.stringify([
    { name: 'bash', args: { command: 'echo ready > cancellation.ready; sleep 86400', description: 'Exercise provider unload during execution', timeoutMs: 60_000 } },
  ]) }] }
  check((await rpc(cookie, 'session/prompt', { request })).ok, 'Unload test enters a real command')
  const until = performance.now() + 10_000
  while (await readFile(join(a.workspace.path, 'cancellation.ready'), 'utf8').catch(() => undefined) === undefined) {
    if (performance.now() >= until) throw new Error('Unload command did not start')
    await new Promise<void>(resolve => setTimeout(resolve, 25))
  }
  const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === 'mode-backend')
  if (entry?.fiber === undefined) throw new Error('Mode backend Loader entry is unavailable')
  check(true, 'Command is running before mode Loader disposal')
  await entry.fiber.dispose()
  check(true, 'Mode Loader disposal completed')
  await agent.whenIdle()
  await closed()
  let unavailable = false
  try { await ctx.workspaceRegistry.modes.acquireUse(a.workspace.id, { signal, admit: () => {} }) }
  catch (error) { unavailable = error instanceof WorkspaceModeError && error.code === 'workspace/mode-runtime-unavailable' }
  check(unavailable, 'Loader disposal drains the active command and removes mode runtime registration')
  check(ctx.get('workspaceFileAccess') === undefined, 'Loader disposal removes the binary mode provider')
  await ctx.sandboxRunner.close(b.workspace.id)
  check(await readFile(join(a.workspace.path, 'result.txt'), 'utf8') === 'new value\n', 'Cancelled task preserves completed workspace files')
  return { checks, generations, output: output.map(event => event.data.message.content), realDocker: true, realLoader: true,
    substituted: ['model stream'] }
}
