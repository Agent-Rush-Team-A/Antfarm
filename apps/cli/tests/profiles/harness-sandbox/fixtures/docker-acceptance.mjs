/** Owns disposable real-Docker checks driven exclusively through built dsh profiles and native login. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer, request } from 'node:http'
import { chmod, chown, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { descriptorOf } from '@deepseek-ai/dsh-storage-domain'
import { hashPassword, multiuserDomainSpec } from '@deepseek-ai/dsh-api-multiuser'

assert.equal(process.platform, 'linux')
assert.equal(process.getuid(), 0)
const repo = fileURLToPath(new URL('../../../../../../', import.meta.url))
const parent = process.env.M5_DATA_ROOT
assert.equal(parent, '/tmp/antfarm-issue7-m5', 'Use the dedicated daemon-visible M5 bind')
const nonce = randomUUID().slice(0, 8)
const deployment = `issue7-m5-${nonce}`
const root = join(parent, nonce)
const data = join(root, 'workspaces'), apiDir = join(root, 'api')
const runnerSocket = join(apiDir, 'runner.sock'), harnessSocket = join(apiDir, 'harness.sock')
const image = 'agentrush-sandbox@sha256:6410324ee0ef8f3f1609a0056234e52b6fc0345ab4a2c754051f0931faafcb98'
const uid = 10001, gid = 10001
const evidenceDir = process.env.M5_EVIDENCE_DIR ?? '/evidence'
const evidence = { deployment, root, image, node: process.version, checks: [], requests: [], workspaces: [], artifacts: {}, cleanup: {} }
const children = []
const faults = []
const allFaults = []
const proxyPending = new Set()
let stage = 'setup'
const deadline = AbortSignal.timeout(600_000)
await mkdir(evidenceDir, { recursive: true })
function http(socketPath, method, path, body, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, agent: false, signal: AbortSignal.timeout(timeout),
      headers: { 'content-type': 'application/json' } }, res => {
      const chunks = []
      res.on('data', chunk => { chunks.push(chunk) })
      res.on('error', reject)
      res.on('end', () => { resolve({ status: res.statusCode, raw: Buffer.concat(chunks) }) })
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}
async function json(socket, method, path, body) {
  const reply = await http(socket, method, path, body)
  return { status: reply.status, body: reply.raw.length ? JSON.parse(reply.raw) : undefined }
}
const engine = (method, path, body) => json('/var/run/docker.sock', method, `/v1.51${path}`, body)
async function containers() {
  return (await engine('GET', `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: [`org.agentrush.sandbox.deployment=${deployment}`] }))}`)).body
}
async function container(workspace) { return (await containers()).find(row => row.Labels['org.agentrush.sandbox.workspace'] === workspace.workspaceId) }
async function until(check, label, budget = 15_000) {
  const end = performance.now() + budget
  do {
    deadline.throwIfAborted()
    const value = await check()
    if (value) return value
    const exited = children.find(entry => entry.child.exitCode !== null)
    if (exited) throw new Error(`Child exited: ${exited.log}`)
    await delay(20)
  } while (performance.now() < end)
  throw new Error(`Missing observable condition: ${label}`)
}
function intercept(match, phase = 'before', drop = false) {
  const gate = { match, phase, drop, seen: Promise.withResolvers(), release: Promise.withResolvers() }
  faults.push(gate)
  allFaults.push(gate)
  return gate
}
const proxy = createServer((incoming, outgoing) => {
  const operation = (async () => {
    let text = ''
    for await (const chunk of incoming) text += chunk
    const entry = { method: incoming.method, path: incoming.url, body: text ? JSON.parse(text) : undefined }
    evidence.requests.push(entry)
    const index = faults.findIndex(fault => fault.match(entry))
    const gate = index < 0 ? undefined : faults.splice(index, 1)[0]
    if (gate?.phase === 'before') { gate.seen.resolve(entry); await gate.release.promise }
    const reply = await json(runnerSocket, entry.method, entry.path, entry.body)
    entry.response = reply
    if (gate?.phase === 'after') { gate.seen.resolve(entry); await gate.release.promise }
    if (gate?.drop) outgoing.destroy()
    else if (!outgoing.destroyed) outgoing.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body))
  })().catch(error => { outgoing.destroy(error) })
  proxyPending.add(operation)
  void operation.finally(() => { proxyPending.delete(operation) })
})
function start(name, args, env, identity = {}) {
  const child = spawn(process.execPath, args, { cwd: repo, env: { PATH: process.env.PATH, HOME: root,
    DSH_TELEMETRY_DISABLED: '1', NODE_NO_WARNINGS: '1', ...env }, ...identity, stdio: ['ignore', 'pipe', 'pipe'] })
  const entry = { name, child, log: '' }
  child.stdout.setEncoding('utf8').on('data', chunk => { entry.log += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { entry.log += chunk })
  entry.exited = once(child, 'close')
  children.push(entry)
  return entry
}
async function own(path, mode = 0o700) { await mkdir(path, { recursive: true }); await chown(path, uid, gid); await chmod(path, mode) }
async function probe(id, code) {
  const created = await engine('POST', `/containers/${id}/exec`, { AttachStdout: true, AttachStderr: true, User: `${uid}:${gid}`, Cmd: ['python3', '-I', '-B', '-c', code] })
  assert.equal(created.status, 201)
  const reply = await http('/var/run/docker.sock', 'POST', `/v1.51/exec/${created.body.Id}/start`, { Detach: false, Tty: false })
  assert.equal(reply.status, 200)
  let offset = 0, text = ''
  while (offset < reply.raw.length) { const size = reply.raw.readUInt32BE(offset + 4); text += reply.raw.subarray(offset + 8, offset + 8 + size).toString(); offset += 8 + size }
  assert.equal((await engine('GET', `/exec/${created.body.Id}/json`)).body.ExitCode, 0, text)
  return JSON.parse(text)
}
try {
  await mkdir(root, { mode: 0o755 })
  await own(data)
  await mkdir(apiDir, { mode: 0o750 }); await chown(apiDir, 0, gid)
  for (const file of ['apps/cli/lib/bin.js', 'packages/sandbox/sandbox-runner/lib/index.js', 'packages/sandbox/harness-sandbox/lib/index.js', 'packages/sandbox/harness-sandbox/lib/bash.js']) {
    evidence.artifacts[file] = createHash('sha256').update(await readFile(join(repo, file))).digest('hex')
  }
  evidence.docker = (await engine('GET', '/version')).body
  const runnerHome = join(root, 'runner-home'), home = join(root, 'harness-home')
  const profile = join(runnerHome, 'profiles/sandbox-runner')
  await mkdir(join(profile, 'node_modules/@deepseek-ai'), { recursive: true })
  await symlink(join(repo, 'packages/sandbox/sandbox-runner'), join(profile, 'node_modules/@deepseek-ai/dsh-sandbox-runner'))
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'issue7-runner-acceptance', private: true, dependencies: { '@deepseek-ai/dsh-sandbox-runner': '*' }, dsh: { profile: { bundles: [] } } }))
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'sandbox-runner', name: '@deepseek-ai/dsh-sandbox-runner', config: {
    dockerSocket: '/var/run/docker.sock', runnerSocket, workspaceRoot: data, deploymentId: deployment, image, uid, gid,
  } }] }]))
  start('runner', [join(repo, 'apps/cli/lib/bin.js'), '--profile', 'sandbox-runner'], { DSH_HOME: runnerHome })
  await until(async () => { try { return (await json(runnerSocket, 'GET', '/v1/workspaces/readiness/sandbox')).status === 200 } catch { return false } }, 'Runner readiness', 60_000)
  await once(proxy.listen(harnessSocket), 'listening'); await chown(harnessSocket, 0, gid); await chmod(harnessSocket, 0o660)
  await own(home)
  const password = randomUUID()
  const backend = new JsonStorageBackend(join(home, 'storages'))
  try {
    const table = await backend.kv.open(descriptorOf(multiuserDomainSpec)); await table.loadAll()
    for (const username of ['alice', 'bob', 'carol']) {
      const id = `user-${randomUUID()}`
      await table.putRecord('users', id, { id, username, usernameNormalized: username, password: await hashPassword(password), createdAt: new Date().toISOString() })
    }
  } finally { await backend.close() }
  const chownHome = spawn('/bin/chown', ['-R', `${uid}:${gid}`, home]); assert.deepEqual(await once(chownHome, 'close'), [0, null])
  const patch = join(root, 'model.patch.yml')
  await writeFile(patch, JSON.stringify([{ insert: [{ id: 'docker-model', name: new URL('./docker-model.mjs', import.meta.url).href }] },
    { id: 'agent-default-model', config: { provider: 'docker-acceptance', model: 'fixture' } }, { id: 'session-title', disabled: true },
    { id: 'workspace-sandbox', config: { socketPath: harnessSocket, workspaceRoot: data, mutationTimeoutMs: 3000, queryTimeoutMs: 5000, execTimeoutMs: 30_000, cancelTimeoutMs: 10_000 } }]))
  const denial = start('docker-denial', ['--input-type=module', '-e', "import{connect}from'node:net';connect('/var/run/docker.sock').on('connect',()=>process.exit(9)).on('error',e=>{console.log(e.code);process.exit(e.code==='EACCES'?0:8)})"], {}, { uid, gid })
  assert.deepEqual(await denial.exited, [0, null]); assert.match(denial.log, /EACCES/); children.splice(children.indexOf(denial), 1)
  const web = start('harness', [join(repo, 'apps/cli/lib/bin.js'), '--profile', 'web', '--patch', join(repo, 'apps/cli/config/examples/harness-sandbox.patch.yml'), '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    DSH_HOME: home, DSH_AGENTS_HOME: join(home, '.agents'), DSH_MULTIUSER_WORKSPACE_ROOT: data, DSH_SANDBOX_RUNNER_SOCKET: harnessSocket,
    DEEPSEEK_API_KEY: 'keyless-issue7-acceptance',
  }, { uid, gid })
  const base = await until(() => /dsh web: (http:\/\/[^\s]+)/u.exec(web.log)?.[1], 'Web readiness', 60_000)
  async function post(path, body, cookie = '') {
    const response = await fetch(new URL(path, base), { method: 'POST', signal: deadline,
      headers: { origin: new URL(base).origin, 'content-type': 'application/json', cookie }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json(), cookie: response.headers.getSetCookie()[0]?.split(';')[0] }
  }
  async function rpc(user, method, request) {
    const response = await post(`/api/${method}`, { type: 'client-request', rpcId: randomUUID(), method, payload: { args: { request } } }, user.cookie)
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.result
  }
  async function account(username) {
    const login = await post('/auth/login', { username, password }); assert.equal(login.status, 200)
    const user = { cookie: login.cookie, userId: login.body.user.userId }
    const created = await rpc(user, 'workspace/create', { title: username }); assert.equal(created.ok, true, JSON.stringify(created))
    user.workspace = created.value.workspace
    evidence.workspaces.push({ username, userId: user.userId, ...user.workspace })
    return user
  }
  const alice = await account('alice'), bob = await account('bob'), carol = await account('carol')
  const manage = (user, operation) => rpc(user, `workspaceSandbox/${operation}`, { workspaceId: user.workspace.workspaceId })
  async function session(user) {
    const response = await rpc(user, 'session/create', { workspaceId: user.workspace.workspaceId }); assert.equal(response.ok, true)
    return response.value.sessionId
  }
  const a = await session(alice), b = await session(alice)
  const args = (command, extra = {}) => ({ command, description: 'Inspect actual sandbox execution', ...extra })
  const prompt = (user, sessionId, label, parameters, extra = {}) => rpc(user, 'session/prompt', {
    sessionId, requestId: extra.requestId ?? label, mode: 'queue', content: [{ type: 'text', text: JSON.stringify({ label, args: parameters, ...extra.hold ? { hold: true } : {} }) }],
  })
  async function inspect(user, sessionId, wait = false) {
    return (await post('/__test/docker', { op: 'inspect', sessionId, userId: user.userId, workspaceId: user.workspace.workspaceId, wait })).body
  }
  async function result(user, sessionId, label) {
    await until(async () => {
      const value = await inspect(user, sessionId)
      return value.events.some(event => event.type === 'tool/result' && event.data.message.toolCallId === `docker-${label}`) ? value : false
    }, `tool result ${label}`, 40_000)
    const settled = await inspect(user, sessionId, true)
    if (!label.startsWith('limit-fill-')) await writeFile(join(evidenceDir, `${label}.jsonl`), settled.log)
    return settled.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === `docker-${label}`).data
  }
  async function run(user, sessionId, label, parameters) {
    const accepted = await prompt(user, sessionId, label, parameters); assert.equal(accepted.ok, true, JSON.stringify(accepted))
    return result(user, sessionId, label)
  }
  const text = value => value.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  stage = 'authenticated conversation'
  const first = await run(alice, a, 'first', args('pwd; printf inside > retained.txt; mkdir -p src; printf "你好\\n"; printf diagnostic >&2; exit 7'))
  assert.equal(first.message.isError, false); assert.equal(first.meta.exitCode, 7); assert.match(text(first), /\/workspace\n你好/)
  const firstContainer = (await container(alice.workspace)).Id
  const details = (await engine('GET', `/containers/${firstContainer}/json`)).body
  assert.deepEqual(details.Mounts.map(mount => [mount.Source, mount.Destination]), [[alice.workspace.path, '/workspace']])
  assert.equal(details.Config.User, '10001:10001'); assert.equal(details.HostConfig.NetworkMode, 'none'); assert.equal(details.HostConfig.ReadonlyRootfs, true)
  assert.equal(await readFile(join(alice.workspace.path, 'retained.txt'), 'utf8'), 'inside')
  assert.equal(await readFile(join(repo, 'retained.txt'), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null }), null)
  const safe = await probe(firstContainer, "import os,json;print(json.dumps(dict(uid=os.getuid(),docker=os.path.exists('/var/run/docker.sock'),runner=os.path.exists('" + runnerSocket + "'),key='DEEPSEEK_API_KEY' in os.environ)))")
  assert.deepEqual(safe, { uid, docker: false, runner: false, key: false })
  evidence.container = { id: firstContainer, mounts: details.Mounts, user: details.Config.User, limits: details.HostConfig, safe }
  evidence.checks.push('Native authenticated prompt automatically opened the real sandbox; actual output, nonzero exit, bind, non-root isolation and host non-effect verified')
  const deniedAt = evidence.requests.length
  assert.equal((await prompt(bob, a, 'unauthorized', args('touch unauthorized'))).error.code, 'remote-access/denied')
  assert.equal(evidence.requests.length, deniedAt)
  await run(bob, await session(bob), 'bob', args('printf bob > bob.txt'))
  const capacity = await prompt(carol, await session(carol), 'capacity', args('true'))
  assert.equal(capacity.ok, false); assert.equal(capacity.error.details.reason, 'sandbox_capacity')
  await manage(bob, 'close')
  evidence.checks.push('Other user denied before Runner; separate user files/container and actual two-slot capacity verified')
  stage = 'concurrent sessions'
  await prompt(alice, a, 'parallel-a', args('printf A > a.ready; while [ ! -e release ]; do sleep .02; done; printf PARALLEL_A; exit 3'))
  await until(() => stat(join(alice.workspace.path, 'a.ready')).catch(() => false), 'A running')
  await prompt(alice, b, 'parallel-b', args('printf B > b.ready; while [ ! -e release ]; do sleep .02; done; printf PARALLEL_B; exit 5'))
  await until(() => stat(join(alice.workspace.path, 'b.ready')).catch(() => false), 'B running concurrently')
  assert.equal((await container(alice.workspace)).Id, firstContainer)
  await writeFile(join(alice.workspace.path, 'release'), '')
  const [ra, rb] = await Promise.all([result(alice, a, 'parallel-a'), result(alice, b, 'parallel-b')])
  assert.equal(ra.meta.exitCode, 3); assert.equal(rb.meta.exitCode, 5); assert.match(text(ra), /PARALLEL_A/); assert.match(text(rb), /PARALLEL_B/)
  evidence.checks.push('Same-workspace sessions overlapped in one real container with separate output and exit codes')
  stage = 'same-id retrieval'
  const lost = intercept(entry => entry.path.endsWith('/exec') && entry.body.command.includes('once.txt'), 'after', true)
  const onceResult = run(alice, a, 'retrieval', args('printf x >> once.txt; cat once.txt'))
  const original = await lost.seen.promise; lost.release.resolve()
  assert.match(text(await onceResult), /^x$/)
  const repeated = evidence.requests.filter(entry => entry.path.endsWith('/exec') && entry.body.executionId === original.body.executionId)
  assert.equal(repeated.length, 2); assert.deepEqual(repeated[0].body, repeated[1].body)
  assert.equal(await readFile(join(alice.workspace.path, 'once.txt'), 'utf8'), 'x')
  const beforeDuplicate = evidence.requests.length
  assert.equal((await prompt(alice, a, 'retrieval', args('printf WRONG >> once.txt'))).ok, true)
  assert.equal(evidence.requests.length, beforeDuplicate)
  evidence.checks.push('Lost exec response retrieved once with identical identity/fields; real file side effect occurred once; duplicate message did not open or execute')
  stage = 'cancel and timeout process trees'
  const tree = name => `python3 - <<'PY'\nimport os,signal,time\nfrom pathlib import Path\np=Path('${name}');p.mkdir(exist_ok=True)\np.joinpath('main.pid').write_text(str(os.getpid()))\nif os.fork()==0:\n os.setsid();p.joinpath('middle.pid').write_text(str(os.getpid()))\n if os.fork(): os._exit(0)\n signal.signal(signal.SIGTERM,signal.SIG_IGN)\n p.joinpath('leaf.pid').write_text(str(os.getpid()))\n while True: time.sleep(1)\nwhile not p.joinpath('leaf.pid').exists(): time.sleep(.005)\np.joinpath('ready').write_text('ready')\nwhile True: time.sleep(1)\nPY`
  async function ready(name) { await until(() => stat(join(alice.workspace.path, name)).catch(() => false), name) }
  async function gone(id, name) {
    const pids = await Promise.all(['main', 'middle', 'leaf'].map(async part => Number(await readFile(join(alice.workspace.path, name, `${part}.pid`), 'utf8'))))
    const rows = await probe(id, `import json,os;print(json.dumps([dict(pid=p,exists=os.path.exists('/proc/'+str(p))) for p in ${JSON.stringify(pids)}]))`)
    assert.ok(rows.every(row => !row.exists), JSON.stringify(rows)); return rows
  }
  await prompt(alice, b, 'survivor', args('touch survivor.ready; while [ ! -e survivor.release ]; do sleep .02; done; printf SURVIVED'))
  await ready('survivor.ready')
  await prompt(alice, a, 'cancel-tree', args(tree('cancel-tree')))
  await ready('cancel-tree/ready')
  assert.equal((await rpc(alice, 'session/cancel', { sessionId: a })).ok, true)
  assert.equal((await result(alice, a, 'cancel-tree')).message.isError, true)
  evidence.cancelProcesses = await gone(firstContainer, 'cancel-tree')
  assert.equal((await container(alice.workspace)).Id, firstContainer)
  assert.equal((await inspect(alice, b)).activity.busy, true)
  await writeFile(join(alice.workspace.path, 'survivor.release'), '')
  assert.match(text(await result(alice, b, 'survivor')), /SURVIVED/)
  await prompt(alice, a, 'timeout-tree', args(tree('timeout-tree'), { timeoutMs: 1500 }))
  await ready('timeout-tree/ready')
  const timed = await result(alice, a, 'timeout-tree')
  assert.equal(timed.message.isError, true); assert.match(text(timed), /timed out/)
  evidence.timeoutProcesses = await gone(firstContainer, 'timeout-tree')
  assert.equal((await container(alice.workspace)).Id, firstContainer)
  evidence.checks.push('Cancellation and timeout removed double-forked TERM-resistant descendants; independent /proc confirmed absence; another session survived and container identity stayed unchanged')
  stage = 'cancel before exec registration'
  const earlyExec = intercept(entry => entry.path.endsWith('/exec') && entry.body.command.includes('early.ready'))
  const earlyCancel = intercept(entry => entry.path.endsWith('/exec/cancel'), 'after')
  await prompt(alice, a, 'early-cancel', args('touch early.ready; while true; do sleep 1; done'))
  await earlyExec.seen.promise
  const cancelRequest = rpc(alice, 'session/cancel', { sessionId: a })
  const missing = await earlyCancel.seen.promise
  assert.equal(missing.response.status, 404)
  earlyExec.release.resolve()
  await ready('early.ready')
  earlyCancel.release.resolve()
  await cancelRequest
  assert.equal((await result(alice, a, 'early-cancel')).message.isError, true)
  assert.equal((await container(alice.workspace)).Id, firstContainer)
  evidence.checks.push('Actual Runner cancel 404 preceded exec registration; after observed command start the bounded second cancel cleaned it without replaying exec')
  stage = 'late model and queued input'
  await prompt(alice, a, 'late-model', args('touch must-not-exist'), { hold: true })
  await until(async () => (await post('/__test/docker', { op: 'held', label: 'late-model' })).body.held, 'Held model request')
  await prompt(alice, a, 'queued-old', args('touch queued-must-not-exist'))
  assert.equal((await manage(alice, 'close')).ok, true)
  assert.equal((await engine('GET', `/containers/${firstContainer}/json`)).status, 404)
  await post('/__test/docker', { op: 'release', label: 'late-model' })
  await inspect(alice, a, true)
  assert.equal(await readFile(join(alice.workspace.path, 'must-not-exist')).catch(error => error.code), 'ENOENT')
  assert.equal(await readFile(join(alice.workspace.path, 'queued-must-not-exist')).catch(error => error.code), 'ENOENT')
  const closedAt = evidence.requests.length
  await prompt(alice, a, 'queued-old', args('touch queued-must-not-exist'))
  assert.equal(evidence.requests.length, closedAt)
  const reopened = await run(alice, a, 'reopen', args('cat ../retained.txt; pwd', { workdir: '/workspace/src' }))
  assert.equal(reopened.meta.exitCode, 0)
  assert.match(text(reopened), /\/workspace\/src/)
  const reopenedId = (await container(alice.workspace)).Id
  assert.notEqual(reopenedId, firstContainer)
  assert.equal(await readFile(join(alice.workspace.path, 'retained.txt'), 'utf8'), 'inside')
  evidence.checks.push('Close revoked queued input and late model; old IDs did not reopen; new message reopened a new container with retained files and POSIX directory mapping')
  stage = 'old cancellation after reopen'
  await prompt(alice, a, 'old-cancel', args('touch old-cancel.ready; while true; do sleep 1; done'))
  await ready('old-cancel.ready')
  const lateCancel = intercept(entry => entry.path.endsWith('/exec/cancel'))
  const lateCancellation = rpc(alice, 'session/cancel', { sessionId: a })
  const oldIdentity = (await lateCancel.seen.promise).body
  assert.equal((await manage(alice, 'close')).ok, true)
  await prompt(alice, b, 'new-generation', args('touch new-generation.ready; while [ ! -e new-generation.release ]; do sleep .02; done; printf NEW_GENERATION'))
  await ready('new-generation.ready')
  const freshId = (await container(alice.workspace)).Id
  assert.notEqual(freshId, oldIdentity.expectedContainerId)
  lateCancel.release.resolve()
  await lateCancellation
  assert.equal((await result(alice, a, 'old-cancel')).message.isError, true)
  assert.equal((await container(alice.workspace)).Id, freshId)
  await writeFile(join(alice.workspace.path, 'new-generation.release'), '')
  assert.match(text(await result(alice, b, 'new-generation')), /NEW_GENERATION/)
  evidence.checks.push('Delayed old-generation cancel was rejected after a new generation started and did not interrupt its command')
  stage = 'unknown supervisor result recycles the generation'
  await prompt(alice, b, 'recycled-peer', args('touch recycled-peer.ready; while true; do sleep 1; done'))
  await ready('recycled-peer.ready')
  await prompt(alice, a, 'lost-supervisor', args('exec python3 -c "import os,time;open(\'lost-supervisor.pid\',\'w\').write(str(os.getpid()));time.sleep(20)"'))
  await ready('lost-supervisor.pid')
  const parentPid = await probe(freshId, "import os,json;pid=int(open('/workspace/lost-supervisor.pid').read());print(json.dumps(int(open('/proc/'+str(pid)+'/stat').read().rsplit(') ',1)[1].split()[1])))")
  await probe(freshId, `import os,signal,json;os.kill(${parentPid},signal.SIGKILL);print(json.dumps(True))`)
  const [unknown, recycled] = await Promise.all([result(alice, a, 'lost-supervisor'), result(alice, b, 'recycled-peer')])
  assert.equal(unknown.message.isError, true); assert.equal(recycled.message.isError, true)
  assert.equal((await engine('GET', `/containers/${freshId}/json`)).status, 404)
  const failures = evidence.requests.filter(entry => entry.path.endsWith('/exec') && entry.body.expectedContainerId === freshId).map(entry => entry.response?.body)
  assert.ok(failures.some(body => body?.error === 'execution_outcome_unknown' && body.cleanup === 'container_removed'))
  assert.ok(failures.some(body => body?.error === 'execution_container_recycled' && body.cleanup === 'container_removed'))
  evidence.checks.push('Independent supervisor SIGKILL caused real unknown-result retirement; original and concurrent execution reported distinct errors and Docker confirmed the old container absent')
  stage = 'large output and invalid workdir'
  const large = await run(alice, a, 'large', args("python3 -c \"import sys;sys.stdout.write('中\\x00'*40000);sys.stderr.write('e'*70000)\""))
  assert.equal(large.message.isError, false); assert.match(text(large), /output truncated/)
  assert.ok(Buffer.byteLength(text(large)) > 100_000)
  assert.doesNotMatch(text(large), /Full formatted result stored at:|Use read with offset\/limit/)
  const beforeInvalid = evidence.requests.filter(entry => entry.path.endsWith('/exec')).length
  assert.equal((await run(alice, a, 'invalid-directory', args('pwd', { workdir: '/etc' }))).message.isError, true)
  assert.equal(evidence.requests.filter(entry => entry.path.endsWith('/exec')).length, beforeInvalid)
  evidence.checks.push('Chinese/control-character large stdout and stderr retained bounded real tails; outside workdir failed before Runner exec')
  stage = 'execution record limit'
  const fullId = (await container(alice.workspace)).Id
  const count = new Set(evidence.requests.filter(entry => entry.path.endsWith('/exec') && entry.body.expectedContainerId === fullId).map(entry => entry.body.executionId)).size
  for (let index = count; index < 128; index++) assert.equal((await run(alice, a, `limit-fill-${index}`, args('true'))).meta.exitCode, 0)
  const limitAt = evidence.requests.length
  const fullResult = await run(alice, a, 'execution-limit', args('touch limit-must-not-run'))
  assert.equal(fullResult.message.isError, true); assert.match(text(fullResult), /command record limit/)
  assert.equal(evidence.requests.length, limitAt + 2)
  assert.equal(evidence.requests.at(-1).response.body.error, 'execution_limit')
  assert.equal((await container(alice.workspace)).Id, fullId)
  evidence.checks.push('Actual per-generation record 129 was refused as execution_limit; message preparation reused the existing container without retry, new ID or automatic recycle')
  stage = 'known delayed PUT drained before successful close'
  assert.equal((await manage(alice, 'close')).ok, true)
  const knownPut = intercept(entry => entry.method === 'PUT' && entry.path.includes(alice.workspace.workspaceId))
  const knownPrompt = prompt(alice, a, 'known-delayed-put', args('touch known-must-not-run'))
  await knownPut.seen.promise
  const knownClose = manage(alice, 'close')
  await until(async () => (await manage(alice, 'status')).value.state === 'closing', 'Synchronous closing barrier')
  assert.equal((await prompt(alice, a, 'during-close', args('true'))).ok, false)
  knownPut.release.resolve()
  assert.equal((await knownPrompt).ok, false)
  assert.equal((await knownClose).ok, true)
  assert.equal(await container(alice.workspace), undefined)
  evidence.checks.push('Known delayed PUT settled before DELETE; successful close confirmed no container, revoked admission and rejected new input during closure')
  stage = 'late PUT after uncertain admission'
  const delayedPut = intercept(entry => entry.method === 'PUT' && entry.path.includes(alice.workspace.workspaceId))
  const rejectedPrompt = prompt(alice, a, 'unknown-put', args('touch never-admitted'))
  await delayedPut.seen.promise
  const uncertainClose = await manage(alice, 'close')
  assert.equal(uncertainClose.ok, false)
  assert.equal((await rejectedPrompt).ok, false)
  assert.equal((await manage(alice, 'status')).value.state, 'closing')
  assert.equal(await container(alice.workspace), undefined)
  delayedPut.release.resolve()
  await until(() => container(alice.workspace), 'Delayed real PUT completed')
  const beforeBlocked = evidence.requests.length
  assert.equal((await prompt(alice, a, 'unknown-put', args('touch never-admitted'))).ok, false)
  assert.equal((await prompt(alice, a, 'blocked-new', args('true'))).ok, false)
  assert.equal(evidence.requests.length, beforeBlocked)
  assert.equal((await post('/__test/docker', { op: 'reload' })).body.loaded, true)
  assert.equal((await manage(alice, 'status')).value.state, 'closing')
  assert.equal((await manage(alice, 'open')).ok, false)
  const finalClose = await manage(alice, 'close')
  assert.equal(finalClose.ok, false)
  assert.equal(await container(alice.workspace), undefined)
  evidence.unknownPut = { close: uncertainClose, cleanupClose: finalClose }
  evidence.checks.push('PUT delayed beyond transport termination created late after DELETE, but Harness never reported successful closure: it kept closing across new input, old IDs, retry-close and plugin reload; no old message executed')
  stage = 'lost PUT response after real creation'
  const lostPut = intercept(entry => entry.method === 'PUT' && entry.path.includes(carol.workspace.workspaceId), 'after', true)
  const lostAdmission = prompt(carol, await session(carol), 'lost-put-response', args('touch lost-must-not-run'))
  await lostPut.seen.promise
  assert.ok(await container(carol.workspace))
  lostPut.release.resolve()
  assert.equal((await lostAdmission).ok, false)
  assert.equal((await manage(carol, 'status')).value.state, 'closing')
  assert.equal((await manage(carol, 'close')).ok, false)
  assert.equal(await container(carol.workspace), undefined)
  evidence.checks.push('Dropping a real successful PUT response rejected admission and retained unconfirmed closure after actual cleanup, without executing the message')
  evidence.result = 'passed'
} catch (error) {
  evidence.result = 'failed'; evidence.stage = stage; evidence.error = error.stack
  process.exitCode = 1
} finally {
  for (const fault of allFaults) fault.release.resolve()
  for (const entry of [...children].reverse()) {
    if (entry.child.exitCode !== null) continue
    entry.child.kill('SIGTERM')
    try { await once(entry.child, 'close', { signal: AbortSignal.timeout(10_000) }) }
    catch { entry.child.kill('SIGKILL'); await entry.exited }
  }
  for (const row of await containers()) await engine('DELETE', `/containers/${row.Id}?force=true`)
  await new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections() })
  evidence.cleanup.remainingContainers = (await containers()).length
  evidence.logs = children.map(entry => ({ name: entry.name, log: entry.log, code: entry.child.exitCode }))
  await writeFile(join(evidenceDir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
  if (root.startsWith(`${parent}/`) && root.split('/').length === parent.split('/').length + 1) await rm(root, { recursive: true, force: true })
  evidence.cleanup.rootRemoved = true
  await writeFile(join(evidenceDir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify({ result: evidence.result, stage: evidence.stage, error: evidence.error, checks: evidence.checks, cleanup: evidence.cleanup }, null, 2))
}
