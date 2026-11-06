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
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'

export const name = 'workspace-ssh-loader-acceptance'
export const inject = ['workspaceSshFixture', 'sandboxRunnerClient', 'workspaceSandbox', 'sandboxConversation', 'tools', 'agentLoop', 'sessionController', 'llm', 'webServer']

class Model extends LlmAdapter {
  private readonly progress = new Map<string, number>()
  readonly requests: GenerateOptions[] = []
  override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model }) }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const prompt = options.messages.filter(message => message.role === 'user' && message.source?.kind === 'user').at(-1)
    const key = JSON.stringify(prompt)
    const text = prompt?.content.find(block => block.type === 'text')
    const script: Array<{ name: string; args: unknown }> = text?.type === 'text' && text.text.startsWith('files:')
      ? z.array(z.object({ name: z.string(), args: z.unknown() })).parse(JSON.parse(text.text.slice('files:'.length)))
      : [{ name: 'bash', args: { command: "printf 'from-bash\\n' > shared.txt; printf 'output\\n'; printf 'diagnostic\\n' >&2; exit 7", description: 'Write and inspect remote workspace' } }]
    const index = this.progress.get(key) ?? 0
    const call = script[index]
    if (call === undefined) {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    this.progress.set(key, index + 1)
    const id = ToolCallId(randomUUID())
    const args = JSON.stringify(call.args)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name: call.name, argumentsDelta: args }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: call.name, arguments: args } }
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
    (error: unknown) => writeFile(report, JSON.stringify({ ok: false, error: error instanceof Error ? error.stack : String(error) })),
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
  const outcomes = new Map<ToolCallId, ToolExecutionResult>()
  ctx.on('session/event', (_session, event) => { if (event.type === 'tool/result') events.push(event) }, { global: true })
  ctx.on('tools/result', (exec, result) => { outcomes.set(exec.callId, result) }, { global: true })
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
  const exerciseFiles = async (script: Array<{ name: string; args: unknown }>, target = agent, cookie = aliceCookie) => {
    const before = events.length
    const request = { sessionId: target.id, requestId: randomUUID(), content: [{ type: 'text', text: `files:${JSON.stringify(script)}` }], mode: 'queue' }
    check((await rpc(cookie, 'session/prompt', { request })).ok, 'Native file-tool prompt is admitted for its owning user')
    await target.whenIdle()
    const results = events.slice(before)
    check(results.length === script.length, 'Every native file call has a durable result')
    return results.map(event => event.data.message)
  }
  const suffix = randomUUID()
  const nativeFile = `native-${suffix}.txt`
  const largeFile = `large-${suffix}.txt`
  const link = `escape-${suffix}`
  const outside = `outside-${suffix}`
  const preparedFiles = exec(`head -c 9437184 /dev/zero | tr '\\0' 'a' > ${largeFile}; printf '\\ntail\\n' >> ${largeFile}; printf sentinel > ../${outside}; ln -s ../${outside} ${link}`)
  check((await backend.execute(a.workspace.id, preparedFiles)).exitCode === 0, 'Remote Bash prepares a large text file and an outside symlink')
  const nativeResults = await exerciseFiles([
    { name: 'read', args: { file_path: 'shared.txt', offset: 1, limit: 1 } },
    { name: 'write', args: { file_path: nativeFile, content: 'left target right\n' } },
    { name: 'edit', args: { file_path: nativeFile, old_string: 'target', new_string: 'changed' } },
    { name: 'bash', args: { command: `cat ${nativeFile}`, description: 'Read native file changes' } },
    { name: 'read', args: { file_path: largeFile, offset: 2, limit: 1 } },
    { name: 'bash', args: { command: `printf external > ${nativeFile}`, description: 'Replace the observed file' } },
    { name: 'edit', args: { file_path: nativeFile, old_string: 'external', new_string: 'bad' } },
    { name: 'read', args: { file_path: nativeFile } },
    { name: 'edit', args: { file_path: nativeFile, old_string: 'missing', new_string: 'bad' } },
    { name: 'read', args: { file_path: '../' + outside } },
    { name: 'write', args: { file_path: link, content: 'bad' } },
    { name: 'edit', args: { file_path: link, old_string: 'sentinel', new_string: 'bad' } },
  ])
  check(nativeResults[0]?.content.some(block => block.type === 'text' && block.text.includes('1: from-files')) === true, 'Native read sees the same remote file as Bash')
  check(JSON.stringify(nativeResults[1]?.content) === JSON.stringify([{ type: 'text', text: `<path>${files.root}/${nativeFile}</path>\n<type>file</type>\n<content>\nCreated file\n</content>` }]), 'Native write confirmation retains its exact format')
  check(JSON.stringify(nativeResults[2]?.content) === JSON.stringify([{ type: 'text', text: `The file ${files.root}/${nativeFile} has been updated successfully.` }]), 'Native edit confirmation retains its exact format')
  check(nativeResults[3]?.isError !== true && JSON.stringify(nativeResults[3]?.content).includes('left changed right'), 'Bash reads native write/edit output')
  check(nativeResults[4]?.content.some(block => block.type === 'text' && block.text.includes('2: tail')) === true, 'Native read streams a file larger than the whole-file RPC budget')
  const stale = nativeResults[6] === undefined ? undefined : outcomes.get(nativeResults[6].toolCallId)
  check(stale?.isError === true && stale.error.info?.code === 'FS_STALE_VERSION', 'Native edit refuses a stale observed version')
  check(nativeResults[8]?.isError === true, 'Native edit refuses a missing literal match')
  check(nativeResults.slice(9).every((message) => {
    const result = outcomes.get(message.toolCallId)
    return result?.isError === true && result.error.info?.code === 'SANDBOX_INVALID_PATH'
  }), 'All three native tools refuse outside paths and symlinks')
  check((await backend.execute(a.workspace.id, exec(`cat ${nativeFile}; cat ../${outside}`))).stdout.text === 'externalsentinel', 'Failed edits and outside mutations preserve their original bytes')
  const second = await ctx.agentLoop.create(SessionId(randomUUID()), { provider: 'ssh-fixture', model: 'fixture' }, { cwd: a.workspace.path })
  await a.workspace.attachSession(second.id)
  check((await exerciseFiles([{ name: 'read', args: { file_path: nativeFile } }], second))[0]?.isError !== true, 'Another session in the same Workspace reads native file changes')
  const bob = await ctx.agentLoop.create(SessionId(randomUUID()), { provider: 'ssh-fixture', model: 'fixture' }, { cwd: b.workspace.path })
  await b.workspace.attachSession(bob.id)
  const isolated = await exerciseFiles([{ name: 'read', args: { file_path: nativeFile } }, { name: 'write', args: { file_path: nativeFile, content: 'bob only' } }], bob, bobCookie)
  check(isolated[0]?.isError === true && isolated[1]?.isError !== true, 'Another Workspace reads and writes only its own directory')
  check((await backend.execute(a.workspace.id, exec(`cat ${nativeFile}`))).stdout.text === 'external', 'Another Workspace cannot replace the first Workspace file')
  check(await access(join(a.workspace.path, nativeFile)).then(() => false, () => true), 'Native file tools never create a Harness project copy')
  check((await backend.execute(a.workspace.id, exec(`rm -f ${largeFile} ${link} ../${outside}`))).exitCode === 0, 'Owned large-file and symlink fixtures are removed')
  const timed = backend.execute(a.workspace.id, exec('echo $$ > timed.pid; sleep 30', 400)).then(() => false, (error: unknown) =>
    z.object({ code: z.literal('execution_timeout'), execution: z.object({ cleanup: z.literal('processes_cleaned') }) }).safeParse(error).success)
  check(await timed, 'Timeout confirms managed remote-process cleanup')
  check((await backend.execute(a.workspace.id, exec('if test -f timed.pid && kill -0 "$(cat timed.pid)" 2>/dev/null; then exit 1; fi'))).exitCode === 0, 'Timed-out remote Bash no longer runs')
  const closingRequest = exec('echo $$ > closing.pid; sleep 30')
  const pending = backend.execute(a.workspace.id, closingRequest).then(() => false, (error: unknown) =>
    z.object({ execution: z.object({ reason: z.literal('shutdown'), cleanup: z.literal('processes_cleaned') }) }).safeParse(error).success)
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
  check((await exerciseFiles([{ name: 'read', args: { file_path: nativeFile } }]))[0]?.isError !== true, 'Native file tools reopen on the new generation and retain remote data')
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
  return { checks, output: events[0]!.data.message.content,
    unload: { host: ctx.workspaceSshFixture.bindings[b.workspace.id]!.host, pid: unloadPid } }
}
