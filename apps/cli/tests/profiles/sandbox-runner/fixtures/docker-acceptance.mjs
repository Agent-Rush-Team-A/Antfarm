/** Real-Docker acceptance through the built sandbox-runner profile; owns only disposable M5 resources. */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { appendFile, chmod, chown, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, symlink, unlink, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const repo = process.env.M5_REPO
const root = process.env.M5_DATA_ROOT
const deployment = process.env.M5_DEPLOYMENT
assert.ok(repo && root && deployment && process.env.M5_WORKSPACE_ROOT, 'M5 requires explicit disposable control/workspace paths')
assert.match(deployment, /^issue9-m5-\d+$/u, 'Use a unique M5 deployment ID')
const image = 'agentrush-sandbox@sha256:6410324ee0ef8f3f1609a0056234e52b6fc0345ab4a2c754051f0931faafcb98'
const data = process.env.M5_WORKSPACE_ROOT
const home = join(root, 'dsh')
const profile = join(home, 'profiles', 'sandbox-runner')
const apiDir = await mkdtemp('/tmp/dsh-m5-api-')
const socket = join(apiDir, 'runner.sock')
const ids = new Set()
let runner
let current
let sequence = 0
let stage = 'setup'
async function log(value) {
  const line = JSON.stringify(value)
  console.log(line)
  await appendFile(join(root, 'evidence.jsonl'), `${line}\n`)
}
function http(socketPath, method, path, body, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body)
    const req = request({ socketPath, method, path, agent: false, signal: AbortSignal.timeout(timeout),
      ...(encoded === undefined ? {} : { headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) } }),
    }, res => {
      let raw = ''
      res.setEncoding('utf8').on('data', chunk => { raw += chunk })
      res.on('error', reject)
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }) }
        catch (cause) { reject(new Error(`${method} ${path}: invalid response`, { cause })) }
      })
    })
    req.on('error', reject)
    req.end(encoded)
  })
}
const api = (method, workspace = 'A', suffix = '', body) => http(socket, method, `/v1/workspaces/${workspace}/sandbox${suffix}`, body)
const engine = (path, method = 'GET') => http('/var/run/docker.sock', method, `/v1.51${path}`)
const inspect = id => engine(`/containers/${id}/json`)
const observed = operation => operation.then(value => ({ value }), error => ({ error }))
async function value(result) { const outcome = await result; if (outcome.error) throw outcome.error; return outcome.value }
async function until(predicate, label) {
  const deadline = performance.now() + 8000
  while (performance.now() < deadline) {
    if (await predicate()) return
    await delay(10)
  }
  throw new Error(`No readiness evidence: ${label}`)
}
async function text(path) {
  try { return await readFile(path, 'utf8') }
  catch (error) { if (error.code !== 'ENOENT') throw error; return '' }
}
async function start() {
  if (runner) assert.ok(runner.finished, 'Previous Runner must exit before restart')
  const stale = await lstat(socket).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
  if (stale) { assert.ok(stale.isSocket()); await unlink(socket) }
  const child = spawn(process.execPath, [join(repo, 'apps/cli/lib/bin.js'), '--profile', 'sandbox-runner'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {
      PATH: '/usr/local/bin:/usr/bin:/bin', HOME: join(root, 'home'), NODE_PATH: process.env.NODE_PATH,
      DSH_HOME: home, DSH_RUNNER_DOCKER_SOCKET: '/var/run/docker.sock', DSH_RUNNER_SOCKET: socket,
      DSH_RUNNER_DEPLOYMENT: deployment, DSH_RUNNER_WORKSPACE_ROOT: data, DSH_RUNNER_IMAGE: image,
      DSH_RUNNER_CONTAINER_UID: '10001', DSH_RUNNER_CONTAINER_GID: '10001',
    },
  })
  const state = { child, diagnostics: '', finished: null }
  child.stdout.setEncoding('utf8').on('data', chunk => { state.diagnostics += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { state.diagnostics += chunk })
  child.once('close', (code, signal) => { state.finished = { code, signal } })
  runner = state
  const deadline = performance.now() + 90000
  while (performance.now() < deadline && !state.finished) {
    try { const ready = await api('GET'); if (ready.status === 200) return }
    catch (error) { if (!['ENOENT', 'ECONNREFUSED', 'ECONNRESET'].includes(error.code)) throw error }
    await delay(50)
  }
  throw new Error(`Runner startup failed: ${JSON.stringify(state.finished)}\n${state.diagnostics}`)
}
async function stop(signal = 'SIGTERM') {
  if (!runner) return null
  if (!runner.finished) {
    const closed = once(runner.child, 'close', { signal: AbortSignal.timeout(15000) })
    runner.child.kill(signal)
    await closed
  }
  return runner.finished
}
async function open(workspace = 'A') {
  const reply = await api('PUT', workspace, '', { workspaceDir: join(data, workspace) })
  assert.equal(reply.status, 200, JSON.stringify(reply))
  ids.add(reply.body.containerId)
  if (workspace === 'A') current = reply.body.containerId
  return reply.body.containerId
}
function input(name, command, extra = {}) {
  return { executionId: `${name}-${++sequence}`, expectedContainerId: current, command, timeoutMs: 10000, ...extra }
}
const execute = spec => api('POST', 'A', '/exec', spec)
const cancel = spec => api('POST', 'A', '/exec/cancel', { executionId: spec.executionId, expectedContainerId: spec.expectedContainerId })
async function run(name, command, extra = {}) {
  const response = await execute(input(name, command, extra))
  assert.equal(response.status, 200, JSON.stringify(response))
  return response.body
}
async function proc(pids) {
  const response = await run('proc-observer', `python3 -I -B /workspace/.m5-observe.py ${pids.join(' ')}`)
  assert.equal(response.exitCode, 0)
  return JSON.parse(response.stdout.text)
}
async function gone(pids) { const rows = await proc(pids); assert.ok(rows.every(row => !row.exists), JSON.stringify(rows)); return rows }
async function directory(name) {
  const path = join(data, 'A', name)
  await mkdir(path)
  await chown(path, 10001, 10001)
  return path
}
async function onlySleep(id) {
  const reply = await engine(`/containers/${id}/top`)
  assert.equal(reply.status, 200)
  assert.equal(reply.body.Processes.length, 1, JSON.stringify(reply.body))
  assert.match(reply.body.Processes[0].at(-1), /sleep infinity/u)
  return reply.body
}
const tree = hold => `import os, signal, time\nfrom pathlib import Path\nPath('main.pid').write_text(str(os.getpid()))\nif os.fork():\n    while not Path('leaf.pid').exists(): time.sleep(0.005)\n    if not ${hold ? 'True' : 'False'}: os._exit(0)\nelse:\n    os.setsid()\n    Path('middle.pid').write_text(str(os.getpid()))\n    if os.fork(): os._exit(0)\n    signal.signal(signal.SIGTERM, signal.SIG_IGN)\n    Path('leaf.pid').write_text(str(os.getpid()))\nwhile True: time.sleep(1)\n`

try {
  await chmod(apiDir, 0o750)
  await mkdir(join(profile, 'node_modules/@deepseek-ai'), { recursive: true })
  for (const file of ['package.json', 'cordis.patch.yml']) await copyFile(join(repo, 'team-docs/sandbox-runner-profile', file), join(profile, file))
  const packageTarget = join(repo, 'packages/sandbox/sandbox-runner')
  const packageLink = join(profile, 'node_modules/@deepseek-ai/dsh-sandbox-runner')
  try { await symlink(packageTarget, packageLink) }
  catch (error) { if (error.code !== 'EEXIST') throw error; assert.equal(await readlink(packageLink), packageTarget) }
  for (const name of ['A', 'B', 'C']) { await mkdir(join(data, name), { recursive: true }); await chown(join(data, name), 10001, 10001) }
  await copyFile(join(repo, '.local/issue-9-process-cleanup/m5-runtime/clone-child'), join(data, 'A/.m5-clone-child'))
  await chmod(join(data, 'A/.m5-clone-child'), 0o555)
  await writeFile(join(data, 'A/.m5-observe.py'), `import json, pathlib, sys\nrows=[]\nfor value in sys.argv[1:]:\n p=int(value)\n try:\n  fields=pathlib.Path(f'/proc/{p}/stat').read_text().rsplit(') ',1)[1].split()\n  rows.append(dict(pid=p,exists=True,state=fields[0],ppid=int(fields[1]),session=int(fields[3]),exitSignal=int(fields[35])))\n except FileNotFoundError: rows.append(dict(pid=p,exists=False))\nprint(json.dumps(rows))\n`)
  await log({ case: 'environment', node: process.version, deployment, image, engine: (await engine('/version')).body,
    runnerBundleSha256: createHash('sha256').update(await readFile(join(repo, 'packages/sandbox/sandbox-runner/lib/index.js'))).digest('hex') })
  stage = 'formal startup'
  await start()
  await open()
  const originalId = current
  const container = (await inspect(current)).body
  assert.equal(container.Config.User, '10001:10001')
  assert.equal(container.HostConfig.ReadonlyRootfs, true)
  assert.equal(container.HostConfig.NetworkMode, 'none')
  assert.deepEqual(container.HostConfig.CapDrop, ['ALL'])
  assert.ok(container.HostConfig.SecurityOpt.some(value => value.startsWith('no-new-privileges')))
  assert.equal(container.HostConfig.Memory, 536870912)
  assert.equal(container.HostConfig.MemorySwap, 536870912)
  assert.equal(container.HostConfig.NanoCpus, 1000000000)
  assert.equal(container.HostConfig.PidsLimit, 64)
  assert.equal(container.Mounts.filter(mount => mount.Type === 'bind').length, 1)
  assert.equal(container.Mounts.find(mount => mount.Type === 'bind').Source, join(data, 'A'))
  await log({ case: 'restricted-container', containerId: current, config: { user: container.Config.User, ...container.HostConfig } })
  assert.equal((await run('nonzero', 'printf hello; printf warning >&2; exit 7')).exitCode, 7)
  assert.equal((await run('uid', 'id -u')).stdout.text.trim(), '10001')
  const supervisorHash = await run('immutable-supervisor', 'sha256sum /opt/agentrush/sandbox-runner/supervisor.py')
  assert.ok(supervisorHash.stdout.text.startsWith('fd07457c9524dacbf45f8fc9a92eb6e6d83c0c302f141fdca51e233da16a5fff'))

  for (const reason of ['timeout', 'cancelled']) {
    stage = reason
    const path = await directory(reason)
    await writeFile(join(path, 'tree.py'), tree(true))
    const a = input(`${reason}-A`, 'printf x >> starts; exec python3 -I -B tree.py', { workdir: reason, timeoutMs: reason === 'timeout' ? 2000 : 10000 })
    const primary = observed(execute(a))
    const joined = observed(execute(a))
    const b = observed(execute(input(`${reason}-B`, 'while [[ ! -e release-B ]]; do printf x >> progress; sleep 0.02; done; exit 7', { workdir: reason })))
    await until(async () => (await text(join(path, 'leaf.pid'))) && (await text(join(path, 'progress'))), reason)
    const pids = await Promise.all(['main', 'middle', 'leaf'].map(async name => Number(await text(join(path, `${name}.pid`)))))
    const before = await proc(pids)
    assert.ok(before.find(row => row.pid === pids[2]).exists)
    const cancellation = []
    if (reason === 'cancelled') {
      cancellation.push(await cancel(a), await cancel(a))
      assert.equal(cancellation[0].status, 202)
      assert.ok([200, 202].includes(cancellation[1].status))
    }
    const result = await value(primary)
    assert.equal(result.status, reason === 'timeout' ? 504 : 409, JSON.stringify(result))
    assert.equal(result.body.reason, reason)
    assert.equal(result.body.cleanup, 'processes_cleaned')
    assert.equal(result.body.bash.signal, 15)
    assert.deepEqual(await value(joined), result)
    assert.deepEqual(await execute(a), result)
    assert.equal(await text(join(path, 'starts')), 'x')
    const absent = await gone(pids)
    const progressBefore = (await text(join(path, 'progress'))).length
    await until(async () => (await text(join(path, 'progress'))).length > progressBefore, 'B progress after A cleanup')
    const progressAfter = (await text(join(path, 'progress'))).length
    const top = (await engine(`/containers/${current}/top`)).body
    await writeFile(join(path, 'release-B'), '')
    assert.equal((await value(b)).body.exitCode, 7)
    assert.deepEqual((await api('GET')).body, { state: 'running', containerId: originalId })
    assert.equal((await run(`${reason}-C`, 'printf available')).exitCode, 0)
    await log({ case: reason, containerId: current, A: result, cancellation, before, absent, progressBefore, progressAfter, Bexit: 7, top })
  }

  for (const kind of ['background', 'double-fork', 'clone']) {
    stage = kind
    const path = await directory(kind)
    let command
    let names
    let expected
    if (kind === 'background') {
      command = "sleep 60 & printf '%s' $! > child.pid; while [[ ! -e release ]]; do sleep 0.01; done; exit 3"
      names = ['child']; expected = 3
    } else if (kind === 'double-fork') {
      await writeFile(join(path, 'tree.py'), tree(false))
      command = 'python3 -I -B tree.py; while [[ ! -e release ]]; do sleep 0.01; done; exit 9'
      names = ['main', 'middle', 'leaf']; expected = 9
    } else {
      command = 'exec /workspace/.m5-clone-child clone.pid parent.pid release'
      names = ['clone', 'parent']; expected = 3
    }
    const result = observed(execute(input(kind, command, { workdir: kind })))
    await until(async () => (await text(join(path, `${names.at(-1)}.pid`))) && (await text(join(path, `${names[0]}.pid`))), kind)
    const pids = await Promise.all(names.map(async name => Number(await text(join(path, `${name}.pid`)))))
    const before = await proc(pids)
    if (kind === 'clone') { assert.equal(before[0].exitSignal, 0); assert.equal(before[0].ppid, pids[1]) }
    else assert.ok(before.at(-1).exists)
    await writeFile(join(path, 'release'), '')
    const response = await value(result)
    assert.equal(response.status, 200, JSON.stringify(response))
    assert.equal(response.body.exitCode, expected)
    const absent = await gone(pids)
    await log({ case: kind, containerId: current, exitCode: expected, before, absent, top: await onlySleep(current) })
  }

  stage = 'lifecycle and output regression'
  await open('B')
  assert.equal((await api('PUT', 'C', '', { workspaceDir: join(data, 'C') })).body.error, 'sandbox_capacity')
  assert.equal((await api('DELETE', 'B')).status, 200)
  await open('C'); await api('DELETE', 'C')
  const huge = await run('output', `python3 -I -B -c 'import os; os.write(1,b"x"*100000); os.write(2,b"y"*100000)'; exit 3`)
  assert.equal(huge.exitCode, 3)
  assert.deepEqual(huge.stdout, { text: 'x'.repeat(65536), truncated: true })
  assert.deepEqual(huge.stderr, { text: 'y'.repeat(65536), truncated: true })
  await directory('--nested')
  assert.equal((await run('workdir', 'pwd -P', { workdir: './--nested//' })).stdout.text, '/workspace/--nested\n')
  assert.equal((await execute(input('invalid-workdir', 'true', { workdir: '../B' }))).status, 400)
  await symlink('/tmp', join(data, 'A', 'outside'))
  assert.equal((await run('symlink', 'printf must-not-run', { workdir: 'outside' })).exitCode, 125)
  await log({ case: 'regression', capacity: 'two slots', outputBytes: [65536, 65536], bothTruncated: true, workdir: 'checked' })

  stage = 'supervisor failure'
  const b = observed(execute(input('recycled-B', 'while true; do printf x >> recovery.progress; sleep 0.02; done')))
  await until(async () => await text(join(data, 'A', 'recovery.progress')), 'recovery B')
  const failure = await execute(input('kill-supervisor', 'printf persisted > preserved; kill -KILL "$PPID"; sleep 60'))
  assert.equal(failure.status, 503)
  assert.equal(failure.body.error, 'execution_outcome_unknown')
  assert.equal(failure.body.cleanup, 'container_removed')
  const affected = await value(b)
  assert.equal(affected.body.error, 'execution_container_recycled')
  assert.equal(affected.body.cleanup, 'container_removed')
  assert.equal((await inspect(current)).status, 404)
  assert.equal((await api('GET')).body.state, 'closed')
  const previous = current
  await open()
  assert.notEqual(current, previous)
  assert.equal((await cancel({ executionId: 'late', expectedContainerId: previous })).body.error, 'execution_generation_mismatch')
  assert.equal((await run('preserved', 'cat preserved')).stdout.text, 'persisted')
  await log({ case: 'supervisor-failed', removed: previous, reopened: current, A: failure, B: affected, filesPreserved: true })

  for (const signal of ['SIGTERM', 'SIGKILL']) {
    stage = `Runner ${signal}`
    const name = signal.toLowerCase()
    const active = observed(execute(input(name, `sleep 60 & printf '%s' $! > ${name}.pid; wait`)))
    await until(async () => await text(join(data, 'A', `${name}.pid`)), name)
    const pid = Number(await text(join(data, 'A', `${name}.pid`)))
    const id = current
    const exit = await stop(signal)
    await value(active).catch(error => { assert.ok(['ECONNRESET', 'EPIPE', 'ENOENT'].includes(error.code), String(error)) })
    if (signal === 'SIGTERM') { assert.equal(exit.code, 0); await onlySleep(id) }
    await start()
    assert.equal((await inspect(id)).status, 404)
    await open()
    assert.notEqual(current, id)
    assert.equal((await run('post-restart', 'cat preserved')).stdout.text, 'persisted')
    assert.equal((await cancel({ executionId: 'late', expectedContainerId: id })).status, 409)
    await log({ case: name, exit, oldContainerRemoved: id, oldChildPid: pid, current, filesPreserved: true })
  }
  stage = 'explicit close'
  const active = observed(execute(input('closing', "sleep 60 & printf '%s' $! > close.pid; wait")))
  await until(async () => await text(join(data, 'A/close.pid')), 'close')
  const closedId = current
  assert.equal((await api('DELETE')).status, 200)
  const interrupted = await value(active)
  assert.equal(interrupted.body.error, 'execution_container_recycled')
  assert.equal(interrupted.body.cleanup, 'container_removed')
  assert.equal((await inspect(closedId)).status, 404)
  await log({ case: 'close', removed: closedId, interrupted })
  await log({ case: 'passed', scenarios: ['timeout', 'cancelled', 'background', 'double-fork', 'clone', 'regression', 'supervisor-failed', 'sigterm', 'sigkill', 'close'] })
} catch (error) {
  await log({ case: 'failed', stage, error: String(error.stack ?? error), diagnostics: runner?.diagnostics })
  process.exitCode = 1
} finally {
  if (runner && !runner.finished) {
    for (const workspace of ['A', 'B', 'C']) await api('DELETE', workspace).catch(error => log({ case: 'cleanup-api-failed', workspace, error: String(error) }))
    await stop().catch(error => { runner.child.kill('SIGKILL'); console.error(error); process.exitCode = 1 })
  }
  const filters = encodeURIComponent(JSON.stringify({ label: [`org.agentrush.sandbox.deployment=${deployment}`] }))
  const remaining = (await engine(`/containers/json?all=true&filters=${filters}`)).body
  for (const row of remaining) {
    const container = (await inspect(row.Id)).body
    assert.equal(container.Config.Labels['org.agentrush.sandbox.deployment'], deployment)
    assert.ok(container.Mounts.some(mount => mount.Source.startsWith(`${data}/`)))
    await engine(`/containers/${row.Id}?force=true`, 'DELETE')
    assert.equal((await inspect(row.Id)).status, 404)
  }
  for (const id of ids) assert.equal((await inspect(id)).status, 404)
  await log({ case: 'cleanup', containersConfirmedAbsent: [...ids], fallbackRemovals: remaining.map(row => row.Id), runnerExit: runner?.finished })
}
