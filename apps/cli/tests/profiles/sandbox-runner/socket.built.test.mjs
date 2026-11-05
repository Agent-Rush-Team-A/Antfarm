/** Linux built CLI smoke with a local fake Docker Engine. */

import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, chown, copyFile, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../../../../', import.meta.url))

function query(socketPath, method, workspace, body, { suffix = '', signal = AbortSignal.timeout(3_000) } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({
      socketPath, method, path: `/v1/workspaces/${workspace}/sandbox${suffix}`, agent: false, signal,
    }, (res) => {
      res.setEncoding('utf8')
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => { resolve([res.statusCode, JSON.parse(data)]) })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(body)
  })
}

const upgradeHeaders = 'HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n'

function frame(stream, text) {
  const body = Buffer.from(text)
  const header = Buffer.alloc(8)
  header[0] = stream
  header.writeUInt32BE(body.length, 4)
  return Buffer.concat([header, body])
}

const linuxProfileTest = {
  skip: process.platform !== 'linux',
  timeout: 150_000,
}

async function profileFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runner-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  await chmod(root, 0o755)
  const distinctUsers = process.getuid() === 0
  const uid = distinctUsers ? 21001 : process.getuid()
  const gid = distinctUsers ? 21002 : process.getgid()
  const dshHome = join(root, 'dsh')
  const profile = join(dshHome, 'profiles', 'sandbox-runner')
  const modules = join(profile, 'node_modules', '@deepseek-ai')
  const apiDir = join(root, 'api')
  const engineDir = join(root, 'engine')
  const dataRoot = join(root, 'workspaces')
  const apiSocket = join(apiDir, 'runner.sock')
  const engineSocket = join(engineDir, 'docker.sock')
  await mkdir(modules, { recursive: true })
  await mkdir(apiDir, { mode: 0o750 })
  await mkdir(engineDir, { mode: 0o700 })
  for (const dir of [dshHome, join(dshHome, 'profiles'), profile, apiDir, engineDir]) await chown(dir, uid, gid)
  await chmod(apiDir, 0o2750)
  for (const name of ['package.json', 'cordis.patch.yml']) {
    await copyFile(join(repo, 'team-docs', 'sandbox-runner-profile', name), join(profile, name))
  }
  await symlink(join(repo, 'packages', 'sandbox', 'sandbox-runner'), join(modules, 'dsh-sandbox-runner'))
  for (const name of ['A', 'B', 'C']) await mkdir(join(dataRoot, name), { recursive: true })

  function startRunner() {
    const runner = spawn(process.execPath, [join(repo, 'apps', 'cli', 'lib', 'bin.js'), '--profile', 'sandbox-runner'], {
      cwd: repo,
      uid,
      gid,
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        DSH_RUNNER_DOCKER_SOCKET: engineSocket,
        DSH_RUNNER_SOCKET: apiSocket,
        DSH_RUNNER_DEPLOYMENT: 'm3-smoke',
        DSH_RUNNER_WORKSPACE_ROOT: dataRoot,
        DSH_RUNNER_IMAGE: `debian@sha256:${'a'.repeat(64)}`,
        DSH_RUNNER_CONTAINER_UID: '10001',
        DSH_RUNNER_CONTAINER_GID: '10001',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 140_000,
      killSignal: 'SIGKILL',
    })
    let stderr = ''
    runner.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    return { runner, exited: once(runner, 'close'), diagnostics: () => stderr }
  }

  async function listenEngine(engine) {
    await once(engine.listen(engineSocket), 'listening')
    t.after(() => new Promise((resolve) => {
      engine.close(resolve)
      engine.closeAllConnections()
    }))
    await chown(engineSocket, uid, gid)
    await chmod(engineSocket, 0o600)
  }

  return { root, profile, distinctUsers, uid, gid, apiSocket, engineSocket, dataRoot, startRunner, listenEngine }
}

test('built dsh exits nonzero when the Runner cannot reach Docker at startup', linuxProfileTest, async (t) => {
  const f = await profileFixture(t)
  const { exited, diagnostics } = f.startRunner()
  assert.deepEqual(await exited, [1, null], diagnostics())
  assert.match(diagnostics(), /startup failed: 1 required plugin did not activate/u)
  assert.match(diagnostics(), /sandbox-runner \(required\)/u)
  assert.match(diagnostics(), /Docker GET \/containers\/json/u)
  assert.match(diagnostics(), /connect ENOENT/u)
  await assert.rejects(lstat(f.apiSocket), { code: 'ENOENT' })
})

test('built dsh releases the Runner socket on SIGTERM during startup cleanup', linuxProfileTest, async (t) => {
  const f = await profileFixture(t)
  const listing = Promise.withResolvers()
  await f.listenEngine(createServer((req) => {
    if (new URL(req.url, 'http://docker').pathname === '/v1.51/containers/json') listing.resolve()
  }))

  const { runner, exited, diagnostics } = f.startRunner()
  try {
    const reachedDocker = await Promise.race([listing.promise.then(() => true), exited.then(() => false)])
    assert.ok(reachedDocker, diagnostics())
    assert.deepEqual(await query(f.apiSocket, 'GET', 'A'), [503, { error: 'sandbox_not_ready' }])
    assert.ok(runner.kill('SIGTERM'))
    assert.deepEqual(await exited, [0, null], diagnostics())
    await assert.rejects(lstat(f.apiSocket), { code: 'ENOENT' })
  } finally {
    if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL')
    await exited
  }
})

test('built dsh starts the isolated Runner profile and serves the Linux socket', linuxProfileTest, async (t) => {
  const { root, profile, distinctUsers, uid, gid, apiSocket, engineSocket, dataRoot, startRunner, listenEngine } = await profileFixture(t)
  const rows = new Map()
  const execs = new Map()
  let serial = 0
  let unavailable = false
  let preserve = false
  let execFault
  let holdStart
  let holdInspection
  let starts = 0
  const startupHook = join(root, 'bash-env')
  await writeFile(startupHook, 'printf unexpected-startup; cd /tmp\n')
  const engine = createServer((req, res) => {
    req.setEncoding('utf8')
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const url = new URL(req.url, 'http://docker')
      const send = (status, body) => {
        res.writeHead(status)
        res.end(JSON.stringify(body))
      }
      if (unavailable) return send(503)
      if (url.pathname === '/v1.51/containers/json') return send(200, [...rows.keys()].map(Id => ({ Id })))
      if (req.method === 'POST' && url.pathname === '/v1.51/containers/create') {
        const body = JSON.parse(raw)
        const Id = String(++serial).padStart(64, '0')
        rows.set(Id, {
          Id, Name: `/${url.searchParams.get('name')}`, Config: { Labels: body.Labels },
          State: { Running: false, Paused: false },
          Mounts: body.HostConfig.Mounts.map(mount => ({
            Type: mount.Type, Source: mount.Source, Destination: mount.Target, RW: !mount.ReadOnly,
          })),
        })
        return send(201, { Id })
      }
      const [, , collection, key, action] = url.pathname.split('/')
      if (collection === 'exec') {
        const exec = execs.get(key)
        if (!exec) return send(404)
        if (req.method === 'GET' && action === 'json') {
          return send(200, { ID: key, ContainerID: exec.containerId, Running: false, ExitCode: exec.exitCode })
        }
        assert.equal(req.method, 'POST')
        assert.equal(action, 'start')
        starts++
        if (execFault === 'drop') return res.destroy()
        if (execFault === 'timeout') {
          res.socket.write(upgradeHeaders)
          return
        }
        const run = () => {
          // Map Docker's /workspace to the bind source without changing the wrapper or its arguments.
          const [file, ...args] = exec.argv
          assert.equal(file, '/bin/bash')
          const env = { PATH: '/usr/bin:/bin', BASH_ENV: startupHook }
          execFile(file, args, { cwd: exec.cwd, env, timeout: 2_000 }, (error, stdout, stderr) => {
            exec.exitCode = error === null ? 0 : error.code
            assert.ok(Number.isInteger(exec.exitCode), String(error))
            res.socket.end(Buffer.concat([Buffer.from(upgradeHeaders), frame(1, stdout), frame(2, stderr)]))
          })
        }
        if (holdStart) {
          const { arrived, release } = holdStart
          holdStart = undefined
          arrived.resolve()
          void release.promise.then(run)
        } else run()
        return
      }
      const row = rows.get(key) ?? [...rows.values()].find(container => container.Name === `/${key}`)
      if (!row) return send(404)
      if (req.method === 'GET' && action === 'json') {
        if (holdInspection) {
          const { arrived, release } = holdInspection
          holdInspection = undefined
          arrived.resolve()
          void release.promise.then(() => send(200, row))
        } else send(200, row)
        return
      }
      if (req.method === 'POST' && action === 'exec' && key === row.Id) {
        const body = JSON.parse(raw)
        assert.equal(body.WorkingDir, '/workspace')
        const Id = (execs.size + 1).toString(16).padStart(64, 'e')
        execs.set(Id, { argv: body.Cmd, containerId: key, cwd: row.Mounts[0].Source, exitCode: null })
        return send(201, { Id })
      }
      if (req.method === 'POST' && action === 'start' && key === row.Id) {
        row.State.Running = true
        return send(204)
      }
      if (req.method === 'DELETE' && key === row.Id) {
        if (!preserve) rows.delete(key)
        return send(204)
      }
      send(500)
    })
  })
  await listenEngine(engine)

  const { runner, exited, diagnostics } = startRunner()
  let shutdown
  try {
    let ready = false
    for (let attempt = 0; attempt < 1_200 && runner.exitCode === null && runner.signalCode === null; attempt++) {
      const socket = await lstat(apiSocket).catch(() => undefined)
      if (socket?.isSocket() && (socket.mode & 0o777) === 0o660) {
        const status = await query(apiSocket, 'GET', 'A')
        if (status[0] === 200) {
          assert.deepEqual(status, [200, { state: 'closed' }])
          assert.equal(socket.uid, uid)
          assert.equal(socket.gid, gid)
          ready = true
          break
        }
        assert.deepEqual(status, [503, { error: 'sandbox_not_ready' }])
      }
      await setTimeout(100)
    }
    if (!ready) {
      const socket = await lstat(apiSocket).catch(() => undefined)
      const composed = await lstat(join(profile, 'cordis.yml')).then(() => true, () => false)
      assert.fail(`Runner did not become ready (exit=${runner.exitCode}, profile=${composed}, socket=${socket?.mode.toString(8)}).\n${diagnostics()}`)
    }

    if (distinctUsers) {
      const probe = async (socketPath, group) => {
        const client = spawn(process.execPath, ['--input-type=module', '-e', `
          import { request } from 'node:http';
          const req = request({ socketPath: process.argv[1], path: '/v1/workspaces/A/sandbox' },
            res => { res.resume(); console.log(res.statusCode) });
          req.on('error', error => console.log(error.code));
          req.end();
        `, socketPath], { uid: 21003, gid: group, timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] })
        let result = ''
        let diagnostics = ''
        client.stdout.setEncoding('utf8').on('data', (chunk) => { result += chunk })
        client.stderr.setEncoding('utf8').on('data', (chunk) => { diagnostics += chunk })
        assert.deepEqual(await once(client, 'close'), [0, null], diagnostics)
        return result.trim()
      }
      assert.equal(await probe(apiSocket, gid), '200')
      assert.equal(await probe(engineSocket, gid), 'EACCES')
      assert.equal(await probe(apiSocket, 21004), 'EACCES')
    }

    assert.deepEqual(await query(apiSocket, 'PUT', 'A', '{'), [400, { error: 'invalid_request' }])
    assert.deepEqual(await query(apiSocket, 'GET', 'bad%2Fid'), [400, { error: 'invalid_request' }])
    assert.deepEqual(await query(apiSocket, 'PUT', 'A', JSON.stringify({ workspaceDir: root })),
      [400, { error: 'invalid_workspace_directory' }])
    assert.deepEqual(await query(apiSocket, 'POST', 'A'), [405, { error: 'method_not_allowed' }])
    const open = name => query(apiSocket, 'PUT', name, JSON.stringify({ workspaceDir: join(dataRoot, name) }))
    const a = [200, { state: 'running', containerId: '1'.padStart(64, '0') }]
    assert.deepEqual(await open('A'), a)
    assert.deepEqual(await query(apiSocket, 'GET', 'A'), a)
    assert.deepEqual(await open('A'), a)
    const b = await open('B')
    assert.equal(b[0], 200)
    assert.deepEqual(await open('C'), [409, { error: 'sandbox_capacity' }])
    assert.equal(serial, 2)

    const requestA = { executionId: 'nonzero', expectedContainerId: a[1].containerId, command: 'printf hello; printf warning >&2; exit 7' }
    const execute = (workspace, input, signal) => query(apiSocket, 'POST', workspace, JSON.stringify(input), { suffix: '/exec', signal })
    const inspection = Promise.withResolvers()
    const allowInspection = Promise.withResolvers()
    holdInspection = { arrived: inspection, release: allowInspection }
    const reuse = open('A')
    try {
      await Promise.race([inspection.promise, reuse.then(() => { assert.fail('Reuse inspection was not held') })])
      assert.deepEqual(await query(apiSocket, 'GET', 'A'), a)
      assert.deepEqual(await execute('A', requestA), [200, {
        executionId: 'nonzero', exitCode: 7,
        stdout: { text: 'hello', truncated: false }, stderr: { text: 'warning', truncated: false },
      }])
    } finally {
      allowInspection.resolve()
      await reuse
    }
    assert.deepEqual(await reuse, a)
    assert.equal(serial, 2)
    const aDirectory = join(dataRoot, 'A')
    const nested = join(aDirectory, '--nested')
    await mkdir(nested)
    await symlink(join(dataRoot, 'B'), join(aDirectory, 'out'))
    const pwd = { ...requestA, executionId: 'directory', command: 'pwd -P' }
    const [, inside] = await execute('A', { ...pwd, workdir: './--nested//' })
    assert.equal(inside.exitCode, 0)
    assert.equal(inside.stdout.text, `${nested}\n`)
    assert.deepEqual(await execute('A', { ...pwd, workdir: '--nested' }), [200, inside])
    const rejected = { ...requestA, executionId: 'outside', command: 'printf should-not-run' }
    assert.deepEqual(await execute('A', { ...rejected, workdir: '../B' }), [400, { error: 'invalid_request' }])
    const [outsideStatus, outside] = await execute('A', { ...rejected, workdir: 'out' })
    assert.equal(outsideStatus, 200)
    assert.equal(outside.exitCode, 125)
    assert.equal(outside.stdout.text, '')
    assert.match(outside.stderr.text, /working directory inside \/workspace/u)
    assert.deepEqual(await execute('A', { ...requestA, expectedContainerId: b[1].containerId }),
      [409, { error: 'execution_generation_mismatch' }])

    const arrived = Promise.withResolvers()
    const release = Promise.withResolvers()
    holdStart = { arrived, release }
    const detached = { ...requestA, executionId: 'detached', command: 'printf detached' }
    const client = new AbortController()
    const beforeDetach = starts
    const disconnected = assert.rejects(execute('A', detached, client.signal), { name: 'AbortError' })
    try {
      await Promise.race([arrived.promise, disconnected])
      client.abort()
      await disconnected
      assert.deepEqual(await execute('A', { ...detached, executionId: 'parallel', command: 'printf parallel' }), [200, {
        executionId: 'parallel', exitCode: 0,
        stdout: { text: 'parallel', truncated: false }, stderr: { text: '', truncated: false },
      }])
    } finally {
      release.resolve()
    }
    assert.deepEqual(await execute('A', detached), [200, {
      executionId: 'detached', exitCode: 0,
      stdout: { text: 'detached', truncated: false }, stderr: { text: '', truncated: false },
    }])
    assert.equal(starts - beforeDetach, 2)

    execFault = 'drop'
    assert.deepEqual(await execute('A', { ...requestA, executionId: 'lost' }), [503, { error: 'execution_outcome_unknown' }])
    assert.deepEqual(await query(apiSocket, 'GET', 'A'), [200, { state: 'cleanup_required' }])
    execFault = 'timeout'
    assert.deepEqual(await execute('B', { ...requestA, expectedContainerId: b[1].containerId, executionId: 'timeout', timeoutMs: 500 }),
      [504, { error: 'execution_timeout' }])
    execFault = undefined

    unavailable = true
    assert.deepEqual(await query(apiSocket, 'GET', 'A'), [503, { error: 'docker_unavailable' }])
    unavailable = false
    preserve = true
    assert.deepEqual(await query(apiSocket, 'DELETE', 'A'), [409, { error: 'sandbox_cleanup_required' }])
    preserve = false
    assert.deepEqual(await query(apiSocket, 'DELETE', 'A'), [200, { state: 'closed' }])
    assert.equal(rows.has(a[1].containerId), false)
    assert.deepEqual(await query(apiSocket, 'GET', 'A'), [200, { state: 'closed' }])
    assert.equal((await open('C'))[0], 200)
  } finally {
    runner.kill('SIGTERM')
    shutdown = await exited
  }
  assert.deepEqual(shutdown, [0, null], diagnostics())
  await assert.rejects(lstat(apiSocket), { code: 'ENOENT' })
})
