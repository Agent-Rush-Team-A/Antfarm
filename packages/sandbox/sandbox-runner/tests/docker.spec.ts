import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join, parse, sep } from 'node:path'
import { Socket } from 'node:net'
import { getDefaultHighWaterMark, setDefaultHighWaterMark } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { expect, test, vi, type TestContext } from 'vitest'
import SandboxRunner, { type DockerContainerId, type SandboxExecutionId } from '../src/index.ts'
import { resolveCreateRequest } from '../src/config.ts'
import { DockerEngine, type DockerExecRequest } from '../src/docker.ts'
import { enableExecUpgrade, finishedFrame, frame, outputFrames, protocolFrame, supervisor, upgrade } from './fixtures/engine.ts'

const workspaceId = brandString<WorkspaceId>('workspace/A')
const containerId = brandString<DockerContainerId>('a'.repeat(64))
const execId = 'b'.repeat(64)
const executionId = brandString<SandboxExecutionId>('execution-A')
const execPath = `/v1.51/exec/${execId}`
const execCreated = { status: 201, body: { Id: execId } }
const execExited = { ID: execId, ContainerID: containerId, Running: false, ExitCode: 0 }
const argv = ['/bin/bash', '-c', 'echo out; echo err >&2; exit 7']
const image = 'docker.io/library/debian@sha256:1e1a22175fbf1b32157ddaf0219e1db4e5401fab2b94ed285add64d18587cd2d'
const observed = {
  Id: containerId,
  Name: '/owned-container',
  State: { Running: true, Paused: false },
  Config: { Labels: { 'org.agentrush.sandbox.deployment': 'test-runner' } },
  Mounts: [{ Type: 'bind', Source: '/data/A', Destination: '/workspace', RW: true }],
}

type Reply = { status: number; body?: unknown } | ((response: ServerResponse) => void)

async function fixture(t: TestContext, replies: Reply[] = []) {
  const temp = await mkdtemp(join(await realpath(tmpdir()), 'dsh-sbx-'))
  t.onTestFinished(() => rm(temp, { recursive: true, force: true }))
  const root = join(temp, 'root')
  const directory = join(root, 'A')
  await mkdir(directory, { recursive: true })
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\dsh-sbx-${randomUUID()}` : join(temp, 'engine.sock')
  const seen: Array<{ method: string | undefined; url: string | undefined; body: unknown; upgrade?: string }> = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { body += chunk })
    req.on('end', () => {
      const value: unknown = body ? JSON.parse(body) : undefined
      seen.push({ method: req.method, url: req.url, body: value, ...(req.headers.upgrade ? { upgrade: req.headers.upgrade } : {}) })
      const reply = replies.shift() ?? { status: 500 }
      if (typeof reply === 'function') {
        reply(res)
        return
      }
      res.writeHead(reply.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply.body))
    })
  })
  const closeUpgrades = enableExecUpgrade(server)
  const close = () => new Promise<void>((resolve, reject) => {
    closeUpgrades()
    server.close((error) => { if (error) reject(error); else resolve() })
  })
  server.listen(socket)
  await once(server, 'listening')
  t.onTestFinished(async () => { if (server.listening) await close() })
  const config = {
    dockerSocket: socket,
    deploymentId: 'test-runner',
    workspaceRoot: root,
    image,
    uid: 10001,
    gid: 10002,
    cleanupTimeoutMs: 100,
    termGraceMs: 20,
  }
  const docker = new DockerEngine(SandboxRunner.Config(config))
  const create = async (source: string, settings = config) => docker.create(await resolveCreateRequest(settings, workspaceId, source))
  return { close, seen, docker, create, directory, root, temp, config }
}

async function start(docker: DockerEngine, fields: Partial<DockerExecRequest> = {}) {
  const id = await docker.createExec(containerId, executionId, AbortSignal.timeout(2_000))
  return docker.startExec(id, containerId, {
    executionId, argv, expiresAt: performance.now() + 2_000, beforeStart: () => {}, beforeRun: async () => {}, ...fields,
  })
}

test('starts the supervisor, rechecks after ready, and keeps Bash status separate from Inspect', async (t) => {
  const inputs: unknown[] = []
  const checked = vi.fn(async () => {})
  const { docker, seen } = await fixture(t, [execCreated, (response) => {
    const peer = supervisor(response, executionId, false)
    peer.socket.on('data', (chunk: Buffer) => {
      inputs.push(JSON.parse(chunk.toString()))
      expect(checked).toHaveBeenCalledOnce()
      const output = Buffer.concat([outputFrames(executionId, 'stdout', 'out 汉字'), outputFrames(executionId, 'stderr', 'err'), finishedFrame(executionId)])
      peer.socket.write(output.subarray(0, 3))
      peer.socket.write(output.subarray(3, 9))
      peer.socket.end(output.subarray(9))
    })
  }, { status: 200, body: execExited }])
  const session = await start(docker, { beforeRun: checked })
  await expect(session.result).resolves.toMatchObject({
    finished: { reason: 'exited', bash: { exitCode: 7, signal: null }, cleanup: 'confirmed' },
    stdout: { text: 'out 汉字', truncated: false },
    stderr: { text: 'err', truncated: false },
  })
  expect(inputs).toHaveLength(1)
  expect(inputs[0]).toMatchObject({ v: 1, type: 'run', executionId, argv })
  expect(seen).toEqual([
    { method: 'POST', url: `/v1.51/containers/${containerId}/exec`, body: {
      Cmd: ['/usr/local/bin/python3', '-I', '-B', '/opt/agentrush/sandbox-runner/supervisor.py',
        `--execution-id=${executionId}`, '--run-wait-ms', '10000', '--cleanup-timeout-ms', '100', '--term-grace-ms', '20'],
      WorkingDir: '/workspace', AttachStdin: true, AttachStdout: true, AttachStderr: true,
      Tty: false, Privileged: false,
    } },
    { method: 'POST', url: `${execPath}/start`, upgrade: 'tcp', body: { Detach: false, Tty: false } },
    { method: 'GET', url: `${execPath}/json`, body: undefined },
  ])
})

test('a retained byte does not keep the other stream\'s read buffer alive', async (t) => {
  const spy = vi.spyOn(TextRetainer.prototype, 'push')
  t.onTestFinished(() => { spy.mockRestore() })
  const { docker } = await fixture(t, [execCreated, (response) => {
    supervisor(response, executionId, false).complete(7, 'x', 'e'.repeat(96 * 1024))
  }, { status: 200, body: execExited }])
  const session = await start(docker)
  await expect(session.result).resolves.toMatchObject({
    finished: { bash: { exitCode: 7 } },
    stdout: { text: 'x', truncated: false }, stderr: { text: 'e'.repeat(64 * 1024), truncated: true },
  })
  const storage: number[] = []
  for (const [chunk] of spy.mock.calls) {
    if (typeof chunk !== 'string' && chunk.byteLength === 1) storage.push(chunk.buffer.byteLength)
  }
  expect(storage.length).toBeGreaterThan(0)
  for (const bytes of storage) expect(bytes).toBe(1)
})

test.for([{ long: 'stdout', short: 'stderr' }, { long: 'stderr', short: 'stdout' }] as const)(
  'retains the UTF-8 tail of $long and drains through finished', async ({ long, short }, t) => {
    const { docker } = await fixture(t, [execCreated, (response) => {
      supervisor(response, executionId, false).complete(0, long === 'stdout' ? '汉'.repeat(21_846) : 'short',
        long === 'stderr' ? '汉'.repeat(21_846) : 'short')
    }, { status: 200, body: execExited }])
    const session = await start(docker)
    await expect(session.result).resolves.toMatchObject({
      finished: { bash: { exitCode: 0 } },
      [long]: { text: '汉'.repeat(21_845), truncated: true },
      [short]: { text: 'short', truncated: false },
    })
  },
)

test.for([
  ['incomplete header', frame(1, 'out').subarray(0, 5)],
  ['incomplete body', frame(2, 'err').subarray(0, 10)],
  ['system error', frame(3, 'engine failed')],
  ['unknown stream', frame(4, 'invalid')],
  ['invalid header padding', Buffer.from([1, 0, 1, 0, 0, 0, 0, 0])],
] as const)('rejects an exec stream with %s before inspecting', async ([, bytes], t) => {
  const { docker, seen } = await fixture(t, [execCreated, (response) => { upgrade(response, bytes).end() }])
  const session = await start(docker)
  await expect(session.result).rejects.toMatchObject({ kind: 'invalid_response' })
  expect(seen.map(row => row.method)).toEqual(['POST', 'POST'])
})

test.for([
  ['no exit code', { ExitCode: null }],
  ['fractional exit code', { ExitCode: 0.5 }],
  ['a failed supervisor', { ExitCode: 7 }],
  ['another exec ID', { ID: 'c'.repeat(64) }],
  ['the Create field name', { ID: undefined, Id: execId }],
  ['another container ID', { ContainerID: 'c'.repeat(64) }],
] as const)('rejects an Inspect result with %s', async ([, fields], t) => {
  const { docker } = await fixture(t, [execCreated, (response) => { supervisor(response, executionId) },
    { status: 200, body: { ...execExited, ...fields } }])
  const session = await start(docker)
  await expect(session.result).rejects.toMatchObject({
    operation: `GET /exec/${execId}/json`, kind: 'invalid_response',
  })
})

test.for([
  ['HTTP error', { status: 409 }, { kind: 'engine', details: { status: 409 } }],
  ['unexpected upgrade protocol', (response: ServerResponse) => { upgrade(response, undefined, 'other').end() },
    { kind: 'invalid_response' }],
  ['early disconnect', (response: ServerResponse) => { response.destroy() }, { kind: 'transport' }],
] as const)('rejects a Start %s before inspecting', async ([, reply, error], t) => {
  const { docker, seen } = await fixture(t, [execCreated, reply])
  const session = await start(docker)
  await expect(session.result).rejects.toMatchObject(error)
  expect(seen.map(row => row.method)).toEqual(['POST', 'POST'])
})

test.for(['ready deadline', 'Runner cancellation'] as const)('%s closes an unconfirmed upgraded socket', async (stop, t) => {
  const upgraded = Promise.withResolvers<undefined>()
  const closed = Promise.withResolvers<undefined>()
  const { docker, seen, config } = await fixture(t, [execCreated, (response) => {
    upgrade(response).once('close', () => { closed.resolve(undefined) })
    upgraded.resolve(undefined)
  }])
  const id = await docker.createExec(containerId, executionId, AbortSignal.timeout(2_000))
  const cancellation = stop === 'Runner cancellation' ? new AbortController() : undefined
  const shortJsonTimeout = new DockerEngine(SandboxRunner.Config({ ...config, requestTimeoutMs: 20 }), cancellation?.signal)
  const session = shortJsonTimeout.startExec(id, containerId, {
    executionId, argv, expiresAt: performance.now() + 500, beforeStart: () => {}, beforeRun: async () => {},
  })
  const result = expect(session.result).rejects.toMatchObject({ kind: 'transport' })
  await upgraded.promise
  cancellation?.abort()
  await result
  await closed.promise
  expect(seen.map(row => row.method)).toEqual(['POST', 'POST'])
})

test('queues one cancel behind a backpressured run and continues reading its cleanup result', async (t) => {
  const previous = getDefaultHighWaterMark(false)
  setDefaultHighWaterMark(false, 1)
  t.onTestFinished(() => { setDefaultHighWaterMark(false, previous) })
  const writes = vi.spyOn(Socket.prototype, 'write')
  t.onTestFinished(() => { writes.mockRestore() })
  const arrived = Promise.withResolvers<ReturnType<typeof supervisor>>()
  const { docker, seen } = await fixture(t, [execCreated, (response) => {
    arrived.resolve(supervisor(response, executionId, false))
  }, { status: 200, body: execExited }])
  const session = await start(docker)
  await (await arrived.promise).started
  session.cancel('cancelled')
  session.cancel('shutdown')
  const result = await session.result
  expect(result.finished).toMatchObject({ reason: 'cancelled', bash: { exitCode: null, signal: 15 } })
  const controls = writes.mock.calls.flatMap(([chunk], index) => {
    if (!Buffer.isBuffer(chunk) || chunk[0] !== 123) return []
    const control = JSON.parse(chunk.toString()) as { type?: string; reason?: string }
    return control.type === 'run' || control.type === 'cancel'
      ? [{ ...control, writable: writes.mock.results[index]?.value as boolean }] : []
  })
  expect(controls).toMatchObject([{ type: 'run', writable: false }, { type: 'cancel', reason: 'cancelled', writable: false }])
  expect(seen.filter(row => row.url?.endsWith('/start'))).toHaveLength(1)
})

test('a cancellation before ready sends no run and needs no admission recheck', async (t) => {
  const arrived = Promise.withResolvers<() => void>()
  const inputs: Array<{ type: string; reason: string }> = []
  const checked = vi.fn(async () => {})
  const { docker } = await fixture(t, [execCreated, (response) => {
    const socket = upgrade(response)
    socket.once('data', (chunk: Buffer) => {
      const input = JSON.parse(chunk.toString()) as { type: string; reason: string }
      inputs.push(input)
      socket.end(finishedFrame(executionId, 0, { reason: input.reason, bash: null }))
    })
    arrived.resolve(() => { socket.write(protocolFrame(executionId, 'ready')) })
  }, { status: 200, body: execExited }])
  const session = await start(docker, { beforeRun: checked })
  const ready = await arrived.promise
  session.cancel('cancelled')
  ready()
  await expect(session.result).resolves.toMatchObject({ finished: { reason: 'cancelled', bash: null } })
  expect(checked).not.toHaveBeenCalled()
  expect(inputs).toMatchObject([{ type: 'cancel', reason: 'cancelled' }])
})

test('cancellation during the admission recheck prevents its late result from sending run', async (t) => {
  const checking = Promise.withResolvers<undefined>()
  const allow = Promise.withResolvers<undefined>()
  const cancelled = Promise.withResolvers<undefined>()
  const controls: Array<{ type: string }> = []
  const { docker } = await fixture(t, [execCreated, (response) => {
    const peer = supervisor(response, executionId, false)
    peer.socket.on('data', (chunk: Buffer) => {
      const input = JSON.parse(chunk.toString()) as { type: string }
      controls.push(input)
      if (input.type === 'cancel') cancelled.resolve(undefined)
    })
  }, { status: 200, body: execExited }])
  const session = await start(docker, { beforeRun: async () => { checking.resolve(undefined); await allow.promise } })
  await checking.promise
  session.cancel('cancelled')
  await cancelled.promise
  allow.resolve(undefined)
  await expect(session.result).resolves.toMatchObject({ finished: { reason: 'cancelled', bash: null } })
  expect(controls).toMatchObject([{ type: 'cancel' }])
})

test('an expired budget after ready sends timeout instead of a late run', async (t) => {
  const { config } = await fixture(t, [execCreated, (response) => { supervisor(response, executionId, false) },
    { status: 200, body: execExited }])
  const docker = new DockerEngine(SandboxRunner.Config({ ...config, cleanupTimeoutMs: 2_000 }))
  const session = await start(docker, {
    expiresAt: performance.now() + 200,
    beforeRun: async (signal) => { await delay(250, undefined, { signal }) },
  })
  await expect(session.result).resolves.toMatchObject({ finished: { reason: 'timeout', bash: null } })
})

test('a failed admission recheck never sends run or retries Start', async (t) => {
  const inputs: Buffer[] = []
  const { docker, seen } = await fixture(t, [execCreated, (response) => {
    const socket = upgrade(response, protocolFrame(executionId, 'ready'))
    socket.on('data', (chunk: Buffer) => { inputs.push(chunk) })
  }])
  const session = await start(docker, { beforeRun: async () => { throw new Error('Original generation changed') } })
  await expect(session.result).rejects.toMatchObject({ kind: 'transport', details: { cause: { message: 'Original generation changed' } } })
  expect(inputs).toEqual([])
  expect(seen.map(row => row.method)).toEqual(['POST', 'POST'])
})

test('finished remains pending until Inspect confirms the supervisor stopped with exit zero', async (t) => {
  const { docker, seen } = await fixture(t, [execCreated, (response) => { supervisor(response, executionId) },
    { status: 200, body: { ...execExited, Running: true, ExitCode: null } }, { status: 200, body: execExited }])
  const session = await start(docker)
  await expect(session.result).resolves.toMatchObject({ finished: { bash: { exitCode: 7 } } })
  expect(seen.filter(row => row.url === `${execPath}/json`)).toHaveLength(2)
  expect(seen.filter(row => row.url === `${execPath}/start`)).toHaveLength(1)
})

test('a supervisor that stays running after finished cannot establish a completed result', async (t) => {
  const waiting = { status: 200, body: { ...execExited, Running: true, ExitCode: null } }
  const { docker } = await fixture(t, [execCreated, (response) => { supervisor(response, executionId) },
    ...Array.from({ length: 30 }, () => waiting)])
  const session = await start(docker)
  await expect(session.result).rejects.toMatchObject({ kind: 'transport' })
})

test('missing ready/finished preserves bounded supervisor diagnostics as an error', async (t) => {
  const { docker, seen } = await fixture(t, [execCreated, (response) => {
    upgrade(response, frame(2, 'capability failed')).end()
  }])
  const session = await start(docker)
  await expect(session.result).rejects.toMatchObject({ kind: 'invalid_response', details: { diagnostics: 'capability failed' } })
  expect(seen).toHaveLength(2)
})

test('an oversized normalized command fails before Start, without a fallback execution', async (t) => {
  const { docker, seen } = await fixture(t, [execCreated])
  const session = await start(docker, { argv: ['/bin/bash', '-c', 'x'.repeat(128 * 1024)] })
  await expect(session.result).rejects.toMatchObject({ kind: 'invalid_response' })
  expect(seen).toHaveLength(1)
})

test('sends only versioned, deployment-scoped sandbox operations over the local socket', async (t) => {
  const { docker, create: createContainer, seen, directory } = await fixture(t, [
    { status: 201, body: { Id: containerId } },
    { status: 204 },
    { status: 200, body: observed },
    { status: 200, body: [{ Id: containerId }] },
    { status: 204 },
    { status: 404, body: { message: 'No such container' } },
    { status: 201, body: { Id: containerId } },
  ])
  const id = await createContainer(directory)
  expect(id).toBe(containerId)
  await docker.start(id)
  expect(await docker.inspect(id)).toEqual(observed)
  expect(await docker.list()).toEqual([id])
  await docker.remove(id)
  expect(await docker.inspect(id)).toBeNull()
  await createContainer(directory)

  const [create, start, inspect, list, remove, missing, reopen] = seen
  expect(seen).toHaveLength(7)
  expect(create?.method).toBe('POST')
  expect(create?.url).toMatch(/^\/v1\.51\/containers\/create\?name=agentrush-sandbox-test-runner-[a-f0-9]{64}$/u)
  expect(reopen?.url).toBe(create?.url)
  const creationMarker: unknown = expect.stringMatching(/^[a-f0-9-]{36}$/u)
  expect(create?.body).toEqual({
    Image: image,
    User: '10001:10002',
    WorkingDir: '/workspace',
    Entrypoint: ['/usr/bin/sleep'],
    Cmd: ['infinity'],
    Healthcheck: { Test: ['NONE'] },
    Labels: {
      'org.agentrush.sandbox.project': 'agentrush',
      'org.agentrush.sandbox.deployment': 'test-runner',
      'org.agentrush.sandbox.workspace': workspaceId,
      'org.agentrush.sandbox.creation': creationMarker,
    },
    HostConfig: {
      ReadonlyRootfs: true,
      NetworkMode: 'none',
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      RestartPolicy: { Name: 'no' },
      NanoCpus: 1_000_000_000,
      Memory: 536_870_912,
      MemorySwap: 536_870_912,
      PidsLimit: 64,
      Tmpfs: { '/tmp': 'size=32m,mode=1777' },
      Mounts: [{
        Type: 'bind',
        Source: directory,
        Target: '/workspace',
        ReadOnly: false,
        BindOptions: { NonRecursive: true, Propagation: 'rprivate', CreateMountpoint: false },
      }],
    },
  })
  const base = `/v1.51/containers/${id}`
  expect(start).toMatchObject({ method: 'POST', url: `${base}/start` })
  expect(inspect).toMatchObject({ method: 'GET', url: `${base}/json` })
  expect(remove).toMatchObject({ method: 'DELETE', url: `${base}?force=true` })
  expect(missing).toEqual(inspect)
  const listUrl = new URL(list?.url ?? '', 'http://engine')
  expect(list?.method).toBe('GET')
  expect(listUrl.pathname).toBe('/v1.51/containers/json')
  expect(Object.fromEntries(listUrl.searchParams)).toEqual({
    all: 'true',
    filters: '{"label":["org.agentrush.sandbox.deployment=test-runner"]}',
  })
})

test('distinguishes missing containers, daemon errors, malformed success and an unreachable socket', async (t) => {
  const { docker, close, seen } = await fixture(t, [
    { status: 404 },
    { status: 404 },
    { status: 503 },
    { status: 200, body: { ...observed, Id: 'b'.repeat(64) } },
    { status: 200, body: { ...observed, State: {} } },
    { status: 200, body: observed },
  ])
  await expect(docker.inspect(containerId)).resolves.toBeNull()
  await expect(docker.remove(containerId)).resolves.toBeUndefined()
  await expect(docker.inspect(containerId)).rejects.toMatchObject({ kind: 'engine', details: { status: 503 } })
  await expect(docker.inspect(containerId)).rejects.toMatchObject({ kind: 'invalid_response' })
  await expect(docker.inspect(containerId)).rejects.toMatchObject({ kind: 'invalid_response' })
  await expect(docker.find('different-name')).rejects.toMatchObject({ kind: 'invalid_response' })
  await expect(docker.remove(brandString<DockerContainerId>('a'.repeat(12)))).rejects.toThrow()
  expect(seen).toHaveLength(6)
  await close()
  await expect(docker.inspect(containerId)).rejects.toMatchObject({ kind: 'transport' })
})

test('rejects an invalid bind source before any Docker request', async (t) => {
  const { create, seen, directory, root, temp, config } = await fixture(t)
  const outside = join(temp, 'outside')
  const childLink = join(root, 'linked-child')
  const rootLink = join(temp, 'linked-root')
  const nested = join(directory, 'nested')
  const file = join(root, 'file')
  await mkdir(outside)
  await mkdir(nested)
  await writeFile(file, 'not a directory')
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(outside, childLink, linkType)
  await symlink(root, rootLink, linkType)

  const invalidSources = [root, outside, nested, file, 'relative', join(root, 'missing'), childLink, `${childLink}${sep}`]
  for (const invalid of invalidSources) {
    await expect(create(invalid)).rejects.toMatchObject({ name: 'InvalidWorkspaceDirectoryError' })
  }
  const makeRunner = (workspaceRoot: string) => new SandboxRunner(new Context(), SandboxRunner.Config({ ...config, workspaceRoot }))
  const missingRoot = join(temp, 'missing-root')
  await expect(create(join(missingRoot, 'A'), { ...config, workspaceRoot: missingRoot })).rejects.toMatchObject({
    name: 'InvalidWorkspaceDirectoryError', cause: { code: 'ENOENT' },
  })
  await expect(create(join(rootLink, 'A'), { ...config, workspaceRoot: rootLink })).rejects.toMatchObject({
    name: 'InvalidWorkspaceDirectoryError',
  })
  for (const invalid of [parse(root).root, `${root}${sep}`]) {
    expect(() => makeRunner(invalid)).toThrow('workspace root')
  }
  expect(() => new SandboxRunner(new Context(), SandboxRunner.Config({ ...config, dockerSocket: 'relative.sock' })))
    .toThrow('Docker socket path must be absolute')
  expect(seen).toEqual([])
})

test('the Loader schema rejects a mutable image, root identities and invalid deployment names', () => {
  const config = {
    dockerSocket: '/run/docker.sock', deploymentId: 'test-runner', workspaceRoot: '/srv/workspaces',
    image, uid: 10001, gid: 10001,
  }
  expect(SandboxRunner.Config(config).requestTimeoutMs).toBeGreaterThan(0)
  expect(SandboxRunner.Config(config)).toMatchObject({ cleanupTimeoutMs: 2000, termGraceMs: 250 })
  for (const invalid of [{ image: 'debian:latest' }, { uid: 0 }, { gid: 0 }, { deploymentId: 'other/deployment' },
    { cleanupTimeoutMs: 0 }, { cleanupTimeoutMs: 60001 }, { termGraceMs: -1 }, { termGraceMs: 60000 }]) {
    expect(() => SandboxRunner.Config({ ...config, ...invalid })).toThrow()
  }
  expect(() => new DockerEngine(SandboxRunner.Config({ ...config, cleanupTimeoutMs: 100, termGraceMs: 100 }))).toThrow('smaller')
  expect(() => new DockerEngine(SandboxRunner.Config({ ...config, cleanupTimeoutMs: 1, termGraceMs: 0 }))).not.toThrow()
})
