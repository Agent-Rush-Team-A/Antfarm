import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join, parse, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { expect, test, vi, type TestContext } from 'vitest'
import SandboxRunner, { type DockerContainerId } from '../src/index.ts'
import { resolveCreateRequest } from '../src/config.ts'
import { DockerEngine } from '../src/docker.ts'

const workspaceId = brandString<WorkspaceId>('workspace/A')
const containerId = brandString<DockerContainerId>('a'.repeat(64))
const execId = 'b'.repeat(64)
const execPath = `/v1.51/exec/${execId}`
const execCreated = { status: 201, body: { Id: execId } }
const execExited = { ID: execId, ContainerID: containerId, Running: false, ExitCode: 7 }
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
  const close = () => new Promise<void>((resolve, reject) => {
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
  }
  const docker = new DockerEngine(SandboxRunner.Config(config))
  const create = async (source: string, settings = config) => docker.create(await resolveCreateRequest(settings, workspaceId, source))
  return { close, seen, docker, create, directory, root, temp, config }
}

function frame(stream: number, text: string) {
  const body = Buffer.from(text)
  const header = Buffer.alloc(8)
  header[0] = stream
  header.writeUInt32BE(body.length, 4)
  return Buffer.concat([header, body])
}

function upgrade(response: ServerResponse, head = Buffer.alloc(0), protocol = 'tcp') {
  const socket = response.socket
  if (!socket) throw new Error('No socket for Exec Start response')
  const headers = Buffer.from(`HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: ${protocol}\r\n`
    + 'Content-Type: application/vnd.docker.multiplexed-stream\r\n\r\n')
  socket.write(Buffer.concat([headers, head]))
  return socket
}

test('creates, starts, and inspects an exec with coalesced and split stdout and stderr frames', async (t) => {
  const split = frame(1, '汉字')
  const head = Buffer.concat([frame(1, 'out '), frame(2, 'err'), frame(2, ''), split.subarray(0, 3)])
  const { docker, seen } = await fixture(t, [execCreated, (response) => {
    const socket = upgrade(response, head)
    setTimeout(() => {
      socket.write(split.subarray(3, 9))
      setTimeout(() => socket.end(split.subarray(9)), 10)
    }, 10)
  }, { status: 200, body: execExited }])
  const deadline = AbortSignal.timeout(2_000)
  const id = await docker.createExec(containerId, argv, deadline)
  expect(id).toBe(execId)
  await expect(docker.startExec(id, containerId, deadline)).resolves.toEqual({
    exitCode: 7,
    stdout: { text: 'out 汉字', truncated: false },
    stderr: { text: 'err', truncated: false },
  })
  expect(seen).toEqual([
    { method: 'POST', url: `/v1.51/containers/${containerId}/exec`, body: {
      Cmd: argv, WorkingDir: '/workspace', AttachStdin: false, AttachStdout: true, AttachStderr: true,
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
    upgrade(response, Buffer.concat([frame(1, 'x'), frame(2, 'e'.repeat(96 * 1024 - 1)), frame(2, 'e')])).end()
  }, { status: 200, body: execExited }])
  const deadline = AbortSignal.timeout(2_000)
  const id = await docker.createExec(containerId, argv, deadline)
  await expect(docker.startExec(id, containerId, deadline)).resolves.toEqual({
    exitCode: 7,
    stdout: { text: 'x', truncated: false }, stderr: { text: 'e'.repeat(64 * 1024), truncated: true },
  })
  const storage: number[] = []
  for (const [chunk] of spy.mock.calls) {
    if (typeof chunk !== 'string' && chunk.byteLength === 1) storage.push(chunk.buffer.byteLength)
  }
  expect(storage.length).toBeGreaterThan(0)
  for (const bytes of storage) expect(bytes).toBe(1)
})

test.for([{ stream: 1, long: 'stdout', short: 'stderr' }, { stream: 2, long: 'stderr', short: 'stdout' }] as const)(
  'retains the UTF-8 tail of $long and drains the rest of the stream', async ({ stream, long, short }, t) => {
    const { docker } = await fixture(t, [execCreated, (response) => {
      upgrade(response).end(Buffer.concat([frame(stream, '汉'.repeat(21_846)), frame(3 - stream, 'short')]))
    }, { status: 200, body: { ...execExited, ExitCode: 0 } }])
    const deadline = AbortSignal.timeout(2_000)
    const id = await docker.createExec(containerId, argv, deadline)
    await expect(docker.startExec(id, containerId, deadline)).resolves.toEqual({
      exitCode: 0,
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
  const deadline = AbortSignal.timeout(2_000)
  const id = await docker.createExec(containerId, argv, deadline)
  await expect(docker.startExec(id, containerId, deadline)).rejects.toMatchObject({ kind: 'invalid_response' })
  expect(seen.map(row => row.method)).toEqual(['POST', 'POST'])
})

test.for([
  ['no exit code', { ExitCode: null }],
  ['fractional exit code', { ExitCode: 0.5 }],
  ['a still-running exec', { Running: true }],
  ['another exec ID', { ID: 'c'.repeat(64) }],
  ['the Create field name', { ID: undefined, Id: execId }],
  ['another container ID', { ContainerID: 'c'.repeat(64) }],
] as const)('rejects an Inspect result with %s', async ([, fields], t) => {
  const { docker } = await fixture(t, [execCreated, (response) => { upgrade(response).end() },
    { status: 200, body: { ...execExited, ...fields } }])
  const deadline = AbortSignal.timeout(2_000)
  const id = await docker.createExec(containerId, argv, deadline)
  await expect(docker.startExec(id, containerId, deadline)).rejects.toMatchObject({
    operation: `GET /exec/${id}/json`, kind: 'invalid_response',
  })
})

test.for([
  ['HTTP error', { status: 409 }, { kind: 'engine', details: { status: 409 } }],
  ['unexpected upgrade protocol', (response: ServerResponse) => { upgrade(response, undefined, 'other').end() },
    { kind: 'invalid_response' }],
  ['early disconnect', (response: ServerResponse) => { response.destroy() }, { kind: 'transport' }],
] as const)('rejects a Start %s before inspecting', async ([, reply, error], t) => {
  const { docker, seen } = await fixture(t, [execCreated, reply])
  const deadline = AbortSignal.timeout(2_000)
  const id = await docker.createExec(containerId, argv, deadline)
  await expect(docker.startExec(id, containerId, deadline)).rejects.toMatchObject(error)
  expect(seen.map(row => row.method)).toEqual(['POST', 'POST'])
})

test.for(['execution deadline', 'Runner cancellation'] as const)('%s closes the upgraded socket', async (stop, t) => {
  const upgraded = Promise.withResolvers<undefined>()
  const closed = Promise.withResolvers<undefined>()
  const { docker, seen, config } = await fixture(t, [execCreated, (response) => {
    upgrade(response).once('close', () => { closed.resolve(undefined) })
    upgraded.resolve(undefined)
  }])
  const id = await docker.createExec(containerId, argv, AbortSignal.timeout(2_000))
  const cancellation = stop === 'Runner cancellation' ? new AbortController() : undefined
  const shortJsonTimeout = new DockerEngine(SandboxRunner.Config({ ...config, requestTimeoutMs: 20 }), cancellation?.signal)
  const deadline = AbortSignal.timeout(cancellation ? 2_000 : 500)
  const result = expect(shortJsonTimeout.startExec(id, containerId, deadline)).rejects.toMatchObject({ kind: 'transport' })
  await upgraded.promise
  cancellation?.abort()
  await result
  expect(deadline.aborted).toBe(stop === 'execution deadline')
  await closed.promise
  expect(seen.map(row => row.method)).toEqual(['POST', 'POST'])
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
  for (const invalid of [{ image: 'debian:latest' }, { uid: 0 }, { gid: 0 }, { deploymentId: 'other/deployment' }]) {
    expect(() => SandboxRunner.Config({ ...config, ...invalid })).toThrow()
  }
})
