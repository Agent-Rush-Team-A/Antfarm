import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, parse, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { expect, test, type TestContext } from 'vitest'
import SandboxRunner, { type DockerContainerId } from '../src/index.ts'
import { resolveCreateRequest } from '../src/config.ts'
import { DockerEngine } from '../src/docker.ts'

const workspaceId = brandString<WorkspaceId>('workspace/A')
const containerId = brandString<DockerContainerId>('a'.repeat(64))
const image = 'docker.io/library/debian@sha256:1e1a22175fbf1b32157ddaf0219e1db4e5401fab2b94ed285add64d18587cd2d'
const observed = {
  Id: containerId,
  Name: '/owned-container',
  State: { Running: true, Paused: false },
  Config: { Labels: { 'org.agentrush.sandbox.deployment': 'test-runner' } },
  Mounts: [{ Type: 'bind', Source: '/data/A', Destination: '/workspace', RW: true }],
}

async function fixture(t: TestContext, replies: Array<{ status: number; body?: unknown }> = []) {
  const temp = await mkdtemp(join(await realpath(tmpdir()), 'dsh-sbx-'))
  t.onTestFinished(() => rm(temp, { recursive: true, force: true }))
  const root = join(temp, 'root')
  const directory = join(root, 'A')
  await mkdir(directory, { recursive: true })
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\dsh-sbx-${randomUUID()}` : join(temp, 'engine.sock')
  const seen: Array<{ method: string | undefined; url: string | undefined; body: unknown }> = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { body += chunk })
    req.on('end', () => {
      const value: unknown = body ? JSON.parse(body) : undefined
      seen.push({ method: req.method, url: req.url, body: value })
      const reply = replies.shift() ?? { status: 500 }
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
