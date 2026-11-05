/** Linux built CLI smoke with a local fake Docker Engine. */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, chown, copyFile, lstat, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../../../../', import.meta.url))

function query(socketPath, method, workspace, body) {
  return new Promise((resolve, reject) => {
    const req = request({
      socketPath, method, path: `/v1/workspaces/${workspace}/sandbox`, agent: false,
      signal: AbortSignal.timeout(3_000),
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
  let serial = 0
  let unavailable = false
  let preserve = false
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
      const [, , , key, action] = url.pathname.split('/')
      const row = rows.get(key) ?? [...rows.values()].find(container => container.Name === `/${key}`)
      if (!row) return send(404)
      if (req.method === 'GET' && action === 'json') return send(200, row)
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
    assert.equal((await open('B'))[0], 200)
    assert.deepEqual(await open('C'), [409, { error: 'sandbox_capacity' }])
    assert.equal(serial, 2)
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
