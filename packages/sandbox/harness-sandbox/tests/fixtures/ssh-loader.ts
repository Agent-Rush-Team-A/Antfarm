/** Real Loader acceptance: the external model is scripted; account, tool and SSH operations are real. */
import { randomUUID } from 'node:crypto'
import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inspect } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '../../src/index.ts'
import type {} from './ssh-accounts.ts'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { executionRequest } from '../../src/execution.ts'

export const name = 'workspace-ssh-loader-acceptance'
export const inject = ['workspaceSshFixture', 'sandboxRunnerClient', 'workspaceSandbox', 'sandboxConversation', 'tools', 'agentLoop', 'sessionController', 'llm', 'webServer']

class Model extends LlmAdapter {
  private readonly seen = new Set<string>()
  readonly requests: GenerateOptions[] = []
  override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model }) }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const prompt = options.messages.filter(message => message.role === 'user' && message.source?.kind === 'user').at(-1)
    const key = JSON.stringify(prompt)
    if (this.seen.has(key)) {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    this.seen.add(key)
    const id = ToolCallId(randomUUID())
    const args = JSON.stringify({ command: "printf 'from-bash\\n' > shared.txt; printf 'output\\n'; printf 'diagnostic\\n' >&2; exit 7", description: 'Write and inspect remote workspace' })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name: 'bash', argumentsDelta: args }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'bash', arguments: args } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

export function apply(ctx: Context): void {
  const lifetime = new AbortController()
  const report = process.env.DSH_WORKSPACE_SSH_TEST_REPORT
  if (report === undefined) throw new Error('SSH acceptance needs an owned report file')
  const keeper = setInterval(() => {}, 1000)
  const task = ctx.loader.await().then(() => run(ctx, lifetime.signal)).then(
    result => writeFile(report, JSON.stringify({ ok: true, ...result })),
    error => writeFile(report, JSON.stringify({ ok: false, error: error instanceof Error ? error.stack : String(error) })),
  )
  ctx.effect(() => async () => { lifetime.abort(); clearInterval(keeper); await task })
}

async function run(ctx: Context, signal: AbortSignal) {
  const checks: string[] = []
  const check = (ok: boolean, text: string): void => { if (!ok) throw new Error(text); checks.push(text) }
  const [a, b] = ctx.workspaceSshFixture.accounts
  if (a === undefined || b === undefined) throw new Error('Accounts did not load')
  const model = new Model()
  ctx.llm.registerAdapter(['ssh-fixture'], model)
  const base = `http://127.0.0.1:${ctx.webServer.port}`
  const login = async (account: typeof a) => {
    const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ username: account.user.username, password: account.password }), signal })
    check(response.status === 200, 'Native account login')
    return response.headers.getSetCookie()[0]!.split(';', 1)[0]!
  }
  const aliceCookie = await login(a)
  const bobCookie = await login(b)
  const preflight = await ctx.workspaceSandbox.openForUser(a.user.userId, a.workspace.id)
  try {
    const command = executionRequest.parse({ executionId: randomUUID(), expectedContainerId: preflight.containerId, command: 'printf preflight', workdir: '.', timeoutMs: 5000 })
    check((await ctx.sandboxRunnerClient.execute(a.workspace.id, command)).stdout.text === 'preflight', 'Loader-selected SSH backend executes on its prepared endpoint')
  } catch (error) { throw new Error(`SSH preflight failed: ${inspect(error, { depth: 6 })}`) }
  const rpc = async (cookie: string, method: string, args: unknown) => {
    const response = await fetch(`${base}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }), signal })
    return (await response.json() as { result: { ok: boolean; value?: unknown } }).result
  }
  const agent = await ctx.agentLoop.create(SessionId(randomUUID()), { provider: 'ssh-fixture', model: 'fixture' }, { cwd: a.workspace.path })
  await a.workspace.attachSession(agent.id)
  const events: SessionEvent<'tool/result'>[] = []
  ctx.on('session/event', (_session, event) => { if (event.type === 'tool/result') events.push(event) }, { global: true })
  const prompt = { request: { sessionId: agent.id, requestId: randomUUID(), content: [{ type: 'text', text: 'exercise remote Bash' }], mode: 'queue' } }
  check(!(await rpc(bobCookie, 'session/prompt', prompt)).ok, 'Another user cannot prompt this session')
  check((await rpc(aliceCookie, 'session/prompt', prompt)).ok, 'Owned prompt is admitted through the real Gateway')
  await agent.whenIdle()
  if (events.length !== 1 || events[0]?.data.message.isError === true) {
    throw new Error(`Bash result missing or failed; model requests: ${model.requests.length}; results: ${JSON.stringify(events)}`)
  }
  checks.push('Bash result is logged by the real Agent loop')
  check(JSON.stringify(events).includes('output') && JSON.stringify(events).includes('diagnostic') && JSON.stringify(events).includes('exit code: 7'), 'Nonzero exit and separate output are preserved')
  check(model.requests.some(request => request.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('output'))), 'Remote output reaches the next model request')
  const backend = ctx.sandboxRunnerClient
  const opened = await ctx.workspaceSandbox.openForUser(a.user.userId, a.workspace.id)
  check((await ctx.workspaceSandbox.openForUser(a.user.userId, a.workspace.id)).containerId === opened.containerId, 'Repeated Workspace open reuses its generation')
  const files = await backend.files(a.workspace.id, opened.containerId, signal)
  const shared = await files.fs.resolve('shared.txt', { cwd: files.root, signal: files.signal })
  check(await files.fs.readText(shared, files.signal) === 'from-bash\n', 'Remote file capability reads Bash output')
  await files.fs.writeText(shared, 'from-files\n', undefined, files.signal)
  const exec = (command: string, timeoutMs = 5000) => executionRequest.parse({ executionId: randomUUID(), expectedContainerId: opened.containerId, command, workdir: '.', timeoutMs })
  check((await backend.execute(a.workspace.id, exec('cat shared.txt'))).stdout.text === 'from-files\n', 'Bash reads file-capability writes from the same directory')
  check(await access(join(a.workspace.path, 'shared.txt')).then(() => false, () => true), 'Remote writes do not fall back into the registered Harness project')
  const other = await ctx.workspaceSandbox.openForUser(b.user.userId, b.workspace.id)
  const otherFiles = await backend.files(b.workspace.id, other.containerId, signal)
  const missing = await otherFiles.fs.resolve('shared.txt', { cwd: otherFiles.root, signal: otherFiles.signal })
  check(await otherFiles.fs.stat(missing, otherFiles.signal) === undefined, 'Another Workspace sees its own remote directory')
  check(!(await rpc(bobCookie, 'workspaceSandbox/open', { request: { workspaceId: a.workspace.id } })).ok, 'Gateway denies another user opening this Workspace')
  const timed = backend.execute(a.workspace.id, exec('echo $$ > timed.pid; sleep 30', 400)).then(() => false, error => error?.execution?.cleanup === 'processes_cleaned' && error?.code === 'execution_timeout')
  check(await timed, 'Timeout confirms managed remote-process cleanup')
  check((await backend.execute(a.workspace.id, exec('if test -f timed.pid && kill -0 "$(cat timed.pid)" 2>/dev/null; then exit 1; fi'))).exitCode === 0, 'Timed-out remote Bash no longer runs')
  const closingRequest = exec('echo $$ > closing.pid; sleep 30')
  const pending = backend.execute(a.workspace.id, closingRequest).then(() => false, error => error?.execution?.reason === 'shutdown' && error?.execution?.cleanup === 'processes_cleaned')
  for (let attempt = 0; attempt < 50; attempt++) {
    const pid = await files.fs.resolve('closing.pid', { cwd: files.root, signal: files.signal })
    if (await files.fs.stat(pid, files.signal)) break
    await new Promise<void>(resolve => setTimeout(resolve, 20))
  }
  await ctx.workspaceSandbox.closeForUser(a.user.userId, a.workspace.id)
  check(await pending, 'Workspace closure cancels and drains active Bash')
  check(files.signal.aborted, 'Closure revokes original file access')
  const reopened = await ctx.workspaceSandbox.openForUser(a.user.userId, a.workspace.id)
  check(reopened.containerId !== opened.containerId, 'Reopen receives a new execution generation')
  check(await backend.cancel(a.workspace.id, closingRequest).then(() => false, () => true), 'Old cancellation cannot affect the new generation')
  check((await backend.execute(a.workspace.id, { ...exec('cat shared.txt; if kill -0 "$(cat closing.pid)" 2>/dev/null; then exit 1; fi'), expectedContainerId: reopened.containerId })).stdout.text === 'from-files\n', 'Reopen retains remote files and closed Bash stays stopped')
  await ctx.workspaceSandbox.closeForUser(a.user.userId, a.workspace.id)
  const unloadFile = `unload-${randomUUID()}.pid`
  const unloading = executionRequest.parse({ executionId: randomUUID(), expectedContainerId: other.containerId, command: `echo $$ > ${unloadFile}; sleep 30`, workdir: '.', timeoutMs: 30_000 })
  void backend.execute(b.workspace.id, unloading).catch(() => { /* The provider owns cancellation during process shutdown. */ })
  let unloadPid = 0
  for (let attempt = 0; attempt < 100; attempt++) {
    const pid = await otherFiles.fs.resolve(unloadFile, { cwd: otherFiles.root, signal: otherFiles.signal })
    if (await otherFiles.fs.stat(pid, otherFiles.signal)) {
      unloadPid = Number((await otherFiles.fs.readText(pid, otherFiles.signal)).trim())
      break
    }
    await new Promise<void>(resolve => setTimeout(resolve, 20))
  }
  check(Number.isSafeInteger(unloadPid) && unloadPid > 1, 'A managed SSH command is active before application unload')
  return {
    checks, output: events[0]!.data.message.content,
    unload: { host: ctx.workspaceSshFixture.bindings[b.workspace.id]!.host, pid: unloadPid },
  }
}
