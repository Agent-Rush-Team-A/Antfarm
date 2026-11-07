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
assert.equal(parent, '/tmp/antfarm-issue8-m5', 'Use the dedicated daemon-visible M5 bind')
const nonce = randomUUID().slice(0, 8)
const deployment = `issue8-m5-${nonce}`
const root = join(parent, nonce)
const data = join(root, 'workspaces'), apiDir = join(root, 'api')
const runnerSocket = join(apiDir, 'runner.sock'), harnessSocket = join(apiDir, 'harness.sock')
const image = 'agentrush-sandbox@sha256:6410324ee0ef8f3f1609a0056234e52b6fc0345ab4a2c754051f0931faafcb98'
const uid = 10001, gid = 10001
// Lifecycle waits must cover the Runner's 10-second Docker request budget.
const mutationTimeoutMs = 15_000
const idleTimeoutMs = 5000, sweepIntervalMs = 100
const evidenceDir = process.env.M5_EVIDENCE_DIR ?? '/evidence'
const evidence = { deployment, root, image, node: process.version, mutationTimeoutMs, idleTimeoutMs, sweepIntervalMs, checks: [], requests: [], workspaces: [], artifacts: {}, cleanup: {} }
const children = []
const faults = []
const allFaults = []
const proxyPending = new Set()
let stage = 'setup'
function step(value) { stage = value; console.log('[M5] ' + value) }
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
    const entry = { method: incoming.method, path: incoming.url, body: text ? JSON.parse(text) : undefined, at: performance.now(), stage }
    evidence.requests.push(entry)
    const index = faults.findIndex(fault => fault.match(entry))
    const gate = index < 0 ? undefined : faults.splice(index, 1)[0]
    if (gate?.phase === 'before') { gate.seen.resolve(entry); await gate.release.promise }
    const reply = await json(runnerSocket, entry.method, entry.path, entry.body)
    entry.response = reply
    if (gate?.phase === 'after') { gate.seen.resolve(entry); await gate.release.promise }
    entry.deliveredAt = performance.now()
    entry.forwarded = !gate?.drop && !outgoing.destroyed
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
try {
  await mkdir(root, { mode: 0o755 })
  await own(data)
  await mkdir(apiDir, { mode: 0o750 }); await chown(apiDir, 0, gid)
  for (const file of ['apps/cli/lib/bin.js', 'packages/sandbox/sandbox-runner/lib/index.js', 'packages/sandbox/harness-sandbox/lib/index.js', 'packages/sandbox/harness-sandbox/lib/bash.js', 'packages/sandbox/harness-sandbox/lib/idle.js', 'apps/cli/tests/profiles/harness-sandbox/fixtures/docker-idle-acceptance.mjs', 'apps/cli/tests/profiles/harness-sandbox/fixtures/docker-idle-model.mjs', 'apps/cli/tests/profiles/harness-sandbox/fixtures/docker-model.mjs']) {
    evidence.artifacts[file] = createHash('sha256').update(await readFile(join(repo, file))).digest('hex')
  }
  evidence.docker = (await engine('GET', '/version')).body
  const runnerHome = join(root, 'runner-home'), home = join(root, 'harness-home')
  const profile = join(runnerHome, 'profiles/sandbox-runner')
  await mkdir(join(profile, 'node_modules/@deepseek-ai'), { recursive: true })
  await symlink(join(repo, 'packages/sandbox/sandbox-runner'), join(profile, 'node_modules/@deepseek-ai/dsh-sandbox-runner'))
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'issue8-runner-acceptance', private: true, dependencies: { '@deepseek-ai/dsh-sandbox-runner': '*' }, dsh: { profile: { bundles: [] } } }))
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
  await writeFile(patch, JSON.stringify([{ insert: [{ id: 'docker-model', name: new URL('./docker-idle-model.mjs', import.meta.url).href }] },
    { id: 'sandbox-idle', config: { idleTimeoutMs, sweepIntervalMs } },
    { id: 'agent-default-model', config: { provider: 'docker-acceptance', model: 'fixture' } }, { id: 'session-title', disabled: true },
    { id: 'workspace-sandbox', config: { socketPath: harnessSocket, workspaceRoot: data, mutationTimeoutMs, queryTimeoutMs: 5000, execTimeoutMs: 30_000, cancelTimeoutMs: 10_000 } }]))
  const denial = start('docker-denial', ['--input-type=module', '-e', "import{connect}from'node:net';connect('/var/run/docker.sock').on('connect',()=>process.exit(9)).on('error',e=>{console.log(e.code);process.exit(e.code==='EACCES'?0:8)})"], {}, { uid, gid })
  assert.deepEqual(await denial.exited, [0, null]); assert.match(denial.log, /EACCES/); evidence.harnessDockerAccess = { uid, gid, denied: denial.log.trim() }; children.splice(children.indexOf(denial), 1)
  const web = start('harness', [join(repo, 'apps/cli/lib/bin.js'), '--profile', 'web', '--patch', join(repo, 'apps/cli/config/antfarm-web.patch.yml'), '--patch', join(repo, 'apps/cli/config/examples/harness-sandbox.patch.yml'), '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    DSH_HOME: home, DSH_AGENTS_HOME: join(home, '.agents'), DSH_MULTIUSER_WORKSPACE_ROOT: data, DSH_SANDBOX_RUNNER_SOCKET: harnessSocket,
    DEEPSEEK_API_KEY: 'keyless-issue8-acceptance',
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
  async function state(user, extra = {}) {
    const reply = await post('/__test/idle-docker', { op: 'state', workspaceId: user.workspace.workspaceId, ...extra })
    assert.equal(reply.status, 200, JSON.stringify(reply.body))
    return reply.body
  }
  async function gated(gate) {
    const timer = setTimeout(() => gate.seen.reject(new Error(`No intercepted request during ${stage}`)), 30_000)
    try { return await gate.seen.promise } finally { clearTimeout(timer) }
  }
  const deletes = user => evidence.requests.filter(entry => entry.method === 'DELETE' && entry.path.includes(user.workspace.workspaceId))
  const lifecycle = user => entry => entry.path === `/v1/workspaces/${user.workspace.workspaceId}/sandbox`
  async function ready(user, file) {
    return until(async () => { try { await stat(join(user.workspace.path, file)); return true } catch (error) { if (error.code !== 'ENOENT') throw error; return false } }, file)
  }
  async function age(user, since, duration) {
    return until(async () => { const value = await state(user); return value.now - since >= duration ? value : false }, `real idle/work age ${duration}ms`, duration + 15_000)
  }
  async function absent(id) { return until(async () => (await engine('GET', `/containers/${id}/json`)).status === 404, `container ${id} removed`, 25_000) }
  async function idleClosed(user, id) {
    await absent(id)
    const value = await until(async () => { const value = await state(user); return value.activity.sandbox.state === 'closed' ? value : false }, 'Harness confirmed idle closure')
    assert.equal((await manage(user, 'status')).value.state, 'closed')
    return value
  }
  const argumentsFor = command => ({ command, description: 'Inspect actual persistent workspace', timeoutMs: 30_000 })
  const held = async label => until(async () => (await post('/__test/docker', { op: 'held', label })).body.held, `model ${label} held`)
  const bobSession = await session(bob)
  step('real files and two-slot capacity')
  const first = await run(alice, a, 'idle-first', argumentsFor('pwd; printf issue8-persistent > retained.txt; cat retained.txt'))
  assert.equal(first.message.isError, false)
  assert.match(text(first), /\/workspace\nissue8-persistent/)
  const original = (await container(alice.workspace)).Id
  const originalDetails = (await engine('GET', `/containers/${original}/json`)).body
  assert.equal(originalDetails.Config.User, '10001:10001')
  assert.equal(originalDetails.HostConfig.NetworkMode, 'none')
  assert.equal(originalDetails.HostConfig.ReadonlyRootfs, true)
  assert.deepEqual(originalDetails.Mounts.map(mount => [mount.Source, mount.Destination]), [[alice.workspace.path, '/workspace']])
  await prompt(alice, b, 'capacity-held', argumentsFor('cat retained.txt'), { hold: true })
  await held('capacity-held')
  await prompt(bob, bobSession, 'bob-held', argumentsFor('printf BOB_COMPLETED'), { hold: true })
  await held('bob-held')
  const full = await manage(carol, 'open')
  assert.equal(full.ok, false)
  assert.equal(full.error.details.reason, 'sandbox_capacity')
  assert.equal((await containers()).length, 2)
  await post('/__test/docker', { op: 'release', label: 'capacity-held' })
  assert.match(text(await result(alice, b, 'capacity-held')), /issue8-persistent/)
  const initialIdle = await state(alice)
  assert.equal(initialIdle.activity.busy, false)
  assert.ok(initialIdle.activity.idleSince !== null)
  await age(alice, initialIdle.activity.idleSince, idleTimeoutMs - 500)
  assert.equal((await container(alice.workspace)).Id, original)
  await idleClosed(alice, original)
  assert.equal(deletes(alice).length, 1)
  assert.equal(await readFile(join(alice.workspace.path, 'retained.txt'), 'utf8'), 'issue8-persistent')
  const releasedSlot = await manage(carol, 'open')
  assert.equal(releasedSlot.ok, true, JSON.stringify(releasedSlot))
  assert.equal((await containers()).length, 2)
  assert.equal((await manage(carol, 'close')).ok, true)
  evidence.initialIdle = { original, observed: initialIdle, capacityFailure: full, releasedSlot }
  evidence.checks.push('Real idle DELETE removed the original container once; Docker returned 404, the marker survived, and a formerly capacity-rejected workspace acquired the freed slot')

  step('same-Session continuation after real idle reclamation')
  const continued = await run(alice, a, 'idle-continued', argumentsFor('cat retained.txt; printf CONTINUED'))
  assert.equal(continued.message.isError, false)
  assert.match(text(continued), /issue8-persistent.*CONTINUED/s)
  const current = (await container(alice.workspace)).Id
  assert.notEqual(current, original)
  assert.equal((await inspect(alice, a)).events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length, 2)
  evidence.generations = [original, current]
  evidence.checks.push('A new authenticated message in the same Session opened a new real container and read the original persistent file; Session history retained both turns')

  step('shared-workspace requests remain busy across the real timeout')
  await prompt(alice, a, 'busy-a', argumentsFor('touch busy-a.ready; while [ ! -e busy-a.release ]; do sleep .02; done; printf A_DONE'))
  await ready(alice, 'busy-a.ready')
  await prompt(alice, b, 'busy-b', argumentsFor('touch busy-b.ready; while [ ! -e busy-b.release ]; do sleep .02; done; printf B_DONE'))
  await ready(alice, 'busy-b.ready')
  const busy = await state(alice)
  assert.equal(busy.activity.requests, 2)
  assert.equal(busy.activity.executions, 2)
  const beforeBusy = deletes(alice).length
  const agedBusy = await age(alice, busy.now, idleTimeoutMs + 300)
  assert.equal(agedBusy.activity.busy, true)
  assert.equal(agedBusy.activity.idleSince, null)
  assert.equal(deletes(alice).length, beforeBusy)
  assert.equal((await container(alice.workspace)).Id, current)
  await writeFile(join(alice.workspace.path, 'busy-a.release'), '')
  assert.match(text(await result(alice, a, 'busy-a')), /A_DONE/)
  assert.equal((await state(alice)).activity.requests, 1)
  assert.equal((await state(alice)).activity.idleSince, null)
  await writeFile(join(alice.workspace.path, 'busy-b.release'), '')
  assert.match(text(await result(alice, b, 'busy-b')), /B_DONE/)
  const allSettled = await state(alice)
  assert.equal(allSettled.activity.busy, false)
  assert.ok(allSettled.activity.idleSince > busy.now)
  evidence.busy = { initial: busy, aged: agedBusy, settled: allSettled }
  evidence.checks.push('Two real Sessions executed concurrently beyond the test timeout without reclamation; settling one left the other busy, and the last settlement established a new idle start')

  step('cancel acknowledgement is not execution settlement')
  const cancelledResult = intercept(entry => entry.path.endsWith('/exec') && entry.body.command.includes('cancel-idle.ready'), 'after')
  await prompt(alice, a, 'cancel-idle', argumentsFor('touch cancel-idle.ready; while true; do sleep .02; done'))
  await ready(alice, 'cancel-idle.ready')
  assert.equal((await rpc(alice, 'session/cancel', { sessionId: a })).ok, true)
  const cleaned = await gated(cancelledResult)
  assert.equal(cleaned.response.body.cleanup, 'processes_cleaned')
  await until(() => evidence.requests.some(entry => entry.path.endsWith('/exec/cancel') && entry.response?.status === 202), 'real Runner cancel acknowledgement')
  const cleanupPending = await state(alice)
  assert.equal(cleanupPending.activity.executions, 1)
  await age(alice, cleanupPending.now, idleTimeoutMs + 300)
  assert.equal((await state(alice)).activity.idleSince, null)
  assert.equal(deletes(alice).length, beforeBusy)
  assert.equal((await container(alice.workspace)).Id, current)
  cancelledResult.release.resolve()
  assert.equal((await result(alice, a, 'cancel-idle')).message.isError, true)
  const afterCleanup = await state(alice)
  assert.equal(afterCleanup.activity.busy, false)
  assert.ok(afterCleanup.activity.idleSince > cleanupPending.now)
  evidence.cleanupWait = { pending: cleanupPending, settled: afterCleanup, runnerResult: cleaned.response }
  evidence.checks.push('After real cancel and confirmed remote process cleanup, a held original exec result still kept Harness execution activity busy across the timeout; releasing it established a fresh full idle interval')

  step('new input admitted during an expired real Runner GET')
  const oldGet = intercept(entry => entry.method === 'GET' && lifecycle(alice)(entry), 'after')
  const observed = await gated(oldGet)
  assert.equal(observed.response.body.containerId, current)
  const race = await run(alice, b, 'input-first', argumentsFor('cat retained.txt; printf INPUT_SURVIVED'))
  assert.equal(race.message.isError, false)
  assert.match(text(race), /INPUT_SURVIVED/)
  const newIdle = await state(alice)
  const staleGet = intercept(entry => entry.method === 'GET' && lifecycle(alice)(entry), 'after')
  oldGet.release.resolve()
  await age(alice, newIdle.activity.idleSince, idleTimeoutMs - 500)
  assert.equal(observed.forwarded, true)
  assert.equal(deletes(alice).length, beforeBusy)
  assert.equal((await container(alice.workspace)).Id, current)
  assert.equal((await state(alice)).activity.idleSince, newIdle.activity.idleSince)
  evidence.checks.push('A short authenticated Bash request completed while an expired GET was paused; releasing that GET did not delete its real container or shorten the new idle interval')

  step('manual close and reopen while an old idle response is pending')
  const stale = await gated(staleGet)
  assert.equal(stale.response.body.containerId, current)
  assert.equal((await manage(alice, 'close')).ok, true)
  await absent(current)
  const fresh = await run(alice, a, 'manual-reopened', argumentsFor('cat retained.txt; printf FRESH_GENERATION'))
  assert.equal(fresh.message.isError, false)
  const replacement = (await container(alice.workspace)).Id
  assert.notEqual(replacement, current)
  const replacementIdle = await state(alice)
  const beforeStale = deletes(alice).length
  const closeFirst = intercept(entry => entry.method === 'DELETE' && lifecycle(alice)(entry))
  staleGet.release.resolve()
  await age(alice, replacementIdle.activity.idleSince, idleTimeoutMs - 500)
  assert.equal(stale.forwarded, true)
  assert.equal((await container(alice.workspace)).Id, replacement)
  assert.equal((await state(alice)).activity.idleSince, replacementIdle.activity.idleSince)
  assert.equal(deletes(alice).length, beforeStale)
  evidence.generations.push(replacement)
  evidence.checks.push('Manual close deleted the old generation and normal input reopened another; a delayed old running response could not change its new idle history or send a stale DELETE')

  step('idle close admitted before a new request')
  await gated(closeFirst)
  assert.equal((await state(alice)).activity.closing, true)
  const rejected = await prompt(alice, b, 'close-first-rejected', argumentsFor('touch must-not-run'))
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'gateway/cancelled')
  closeFirst.release.resolve()
  await idleClosed(alice, replacement)
  assert.equal(await readFile(join(alice.workspace.path, 'must-not-run')).catch(error => error.code), 'ENOENT')
  const reopenedAgain = await run(alice, a, 'after-close-first', argumentsFor('cat retained.txt; printf OPENED_AGAIN'))
  assert.equal(reopenedAgain.message.isError, false)
  const last = (await container(alice.workspace)).Id
  assert.notEqual(last, replacement)
  evidence.generations.push(last)
  evidence.closeFirst = rejected
  evidence.checks.push('Once idle close synchronously admitted its barrier, a new authenticated message was rejected with the existing gateway/cancelled error and never executed; a genuinely new message reopened after confirmed deletion')

  step('failed observation recovers with a fresh full interval')
  const lostGet = intercept(entry => entry.method === 'GET' && lifecycle(alice)(entry), 'after', true)
  const recoveryGet = intercept(entry => entry.method === 'GET' && lifecycle(alice)(entry))
  await gated(lostGet)
  const beforeFailure = deletes(alice).length
  lostGet.release.resolve()
  await gated(recoveryGet)
  const unconfirmed = await state(alice)
  assert.equal(unconfirmed.activity.idleSince, null)
  assert.equal(unconfirmed.activity.sandbox.state, 'unconfirmed')
  assert.equal(deletes(alice).length, beforeFailure)
  const lostDelete = intercept(entry => entry.method === 'DELETE' && lifecycle(alice)(entry), 'after', true)
  recoveryGet.release.resolve()
  const recovered = await until(async () => { const value = await state(alice); return value.activity.idleSince !== null ? value : false }, 'fresh observation after lost GET')
  await age(alice, recovered.activity.idleSince, idleTimeoutMs - 500)
  assert.equal((await container(alice.workspace)).Id, last)
  assert.equal(deletes(alice).length, beforeFailure)
  evidence.observationRecovery = { unconfirmed, recovered }
  evidence.checks.push('A lost actual GET response invalidated qualification; a later real running observation established a fresh full interval without deleting in its recovery round')

  step('lost real DELETE reply retains failure and closing without automatic retry')
  const removed = await gated(lostDelete)
  assert.equal(removed.response.body.state, 'closed')
  await absent(last)
  lostDelete.release.resolve()
  const uncertain = await state(alice)
  assert.equal(uncertain.activity.closing, true)
  assert.equal((await manage(alice, 'status')).value.state, 'closing')
  const failedDeleteCount = deletes(alice).length
  await age(alice, uncertain.now, idleTimeoutMs + 300)
  assert.equal(deletes(alice).length, failedDeleteCount)
  step('explicit cleanup retains unknown modification failure')
  const uncertainRetry = await manage(alice, 'close')
  assert.equal(uncertainRetry.ok, false)
  assert.equal(uncertainRetry.error.details.outcomeUnknown, true)
  assert.equal((await manage(alice, 'status')).value.state, 'closing')
  const blocked = await prompt(alice, b, 'unknown-close-blocked', argumentsFor('touch unknown-must-not-run'))
  assert.equal(blocked.ok, false)
  const preserved = await state(alice)
  assert.equal(preserved.registered, true)
  assert.equal(preserved.owner, alice.userId)
  assert.equal(await readFile(join(alice.workspace.path, 'retained.txt'), 'utf8'), 'issue8-persistent')
  const history = await inspect(alice, a)
  assert.ok(history.events.some(event => event.type === 'user/message'))
  evidence.uncertainClose = { actualDeletion: removed.response, local: uncertain, automaticDeletes: failedDeleteCount,
    explicitRetry: uncertainRetry, blocked, preserved }
  evidence.checks.push('A real DELETE succeeded but its reply was lost: Docker independently confirmed removal while Harness retained closing, rejected reopening, did not repeat DELETE, and preserved files, Sessions and ownership')
  await post('/__test/docker', { op: 'release', label: 'bob-held' })
  assert.match(text(await result(bob, bobSession, 'bob-held')), /BOB_COMPLETED/)
  evidence.finalMarker = await readFile(join(alice.workspace.path, 'retained.txt'), 'utf8')
  evidence.result = 'passed'
} catch (error) {
  evidence.result = 'failed'; evidence.stage = stage; evidence.error = error.stack
  process.exitCode = 1
} finally {
  for (const fault of allFaults) fault.release.resolve()
  evidence.cleanup.forcedChildren = []
  for (const entry of [...children].reverse()) {
    if (entry.child.exitCode !== null || entry.child.signalCode !== null) { await entry.exited; continue }
    entry.child.kill('SIGTERM')
    try { await once(entry.child, 'close', { signal: AbortSignal.timeout(10_000) }) }
    catch { evidence.cleanup.forcedChildren.push(entry.name); entry.child.kill('SIGKILL'); await entry.exited }
  }
  await Promise.allSettled([...proxyPending])
  for (const row of await containers()) await engine('DELETE', `/containers/${row.Id}?force=true`)
  if (proxy.listening) await new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections() })
  evidence.cleanup.remainingContainers = (await containers()).length
  evidence.logs = children.map(entry => ({ name: entry.name, log: entry.log, code: entry.child.exitCode, signal: entry.child.signalCode }))
  if (evidence.logs.some(entry => entry.code !== 0 || entry.signal !== null)
    || evidence.cleanup.forcedChildren.length > 0 || evidence.cleanup.remainingContainers !== 0) {
    evidence.result = 'failed'; evidence.cleanup.failed = true; process.exitCode = 1
  }
  await writeFile(join(evidenceDir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
  if (root.startsWith(`${parent}/`) && root.split('/').length === parent.split('/').length + 1) {
    await rm(root, { recursive: true, force: true })
    evidence.cleanup.rootRemoved = true
  } else { evidence.result = 'failed'; evidence.cleanup.error = 'Invalid owned cleanup root'; process.exitCode = 1 }
  await writeFile(join(evidenceDir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify({ result: evidence.result, stage: evidence.stage, error: evidence.error, checks: evidence.checks, cleanup: evidence.cleanup }, null, 2))
}
