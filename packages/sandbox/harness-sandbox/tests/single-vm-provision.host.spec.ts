/** Cloud-init and guest shell command construction with a pinned SSH transport fixture. */
import { createHash } from 'node:crypto'
import { getEventListeners } from 'node:events'
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { Config, vultrEndpoint } from '../src/vultr-config.ts'
import { delay, VultrSshProvisioning } from '../src/vultr-provision.ts'
import type { VultrInstance } from '../src/vultr-api.ts'
import { cloudRecord } from '../src/vultr-storage.ts'

const child = vi.hoisted(() => ({
  exec: vi.fn<(program: string, args: readonly string[], options: { signal: AbortSignal }) => Promise<{ stdout: string }>>(),
}))
vi.mock('node:child_process', async (original) => {
  const { promisify } = await import('node:util')
  return { ...await original<typeof import('node:child_process')>(),
    execFile: Object.assign(vi.fn(), { [promisify.custom]: child.exec }) }
})
afterEach(() => { child.exec.mockReset() })

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'antfarm-single-vm-'))
  onTestFinished(async () => { await rm(home, { recursive: true, force: true }) })
  const record = { workspaceId: brandString<WorkspaceId>('registered-a'), label: 'unique-new-label', remoteRoot: '/workspace' }
  const allocation = join(home, record.workspaceId)
  await mkdir(allocation)
  await writeFile(join(allocation, 'host-key'), 'fixture private host key')
  await writeFile(join(allocation, 'host-key.pub'), 'ssh-ed25519 fixed-host-public-key fixture')
  const settings = Config({ stateRoot: home, apiKeyFile: join(home, 'api-key'), sshKeyFile: join(home, 'client-key'),
    helperArchive: join(home, 'helper.tar.gz'), helperArchiveHash: 'a'.repeat(64), helperHash: 'b'.repeat(64),
    deploymentId: 'test', region: 'nrt', plan: 'vc2-1c-1gb', osId: 2284, pollIntervalMs: 1 })
  const ssh = new VultrSshProvisioning(settings)
  const provisioning = ssh.forVfs({ checkMount: 'fixture check-mount\n', launchHelper: 'fixture launch\n' })
  const instance: VultrInstance = { id: brandString<VultrInstance['id']>('e76abdcf-aeac-40c8-9e6e-bc2653402f93'),
    label: record.label, tags: [], main_ip: '192.0.2.44', status: 'active', power_status: 'running', server_status: 'ok' }
  const directory = { volumePath: '/workspaces/ws-suffix', uid: 11001, gid: 11001 }
  return { ssh, provisioning, record, allocation, settings, instance, directory }
}

function written(script: string, path: string): string {
  const line = script.split('\n').find(value => value.endsWith(" > '" + path + "'"))
  const data = /^printf %s '([^']+)' \| base64 -d > /u.exec(line ?? '')?.[1]
  if (data === undefined) throw new Error('Missing shell output for ' + path)
  return Buffer.from(data, 'base64').toString('utf8')
}

test('bootstrap assigns the stable identity and separates admin commands from the forced helper login', async () => {
  const f = await setup()
  child.exec.mockResolvedValue({ stdout: 'ssh-ed25519 client-public-key\n' })
  const script = await f.provisioning.bootstrap(f.record, f.directory, AbortSignal.timeout(1000))
  expect(script).toContain('groupadd -g 11001 workspace-exec')
  expect(script).toContain('useradd -M -d /home/workspace-exec -u 11001 -g workspace-exec -s /bin/sh workspace-exec')
  expect(script).toContain('install -d -o workspace-exec -g workspace-exec -m 0700 /home/workspace-exec/.cache')
  const adminKey = written(script, '/etc/ssh/antfarm-keys/root')
  expect(adminKey).toBe('restrict ssh-ed25519 client-public-key\n')
  const taskKey = written(script, '/etc/ssh/antfarm-keys/workspace-exec')
  expect(taskKey).toContain('restrict,port-forwarding,command="/usr/bin/sudo -n /opt/antfarm-vfs/start-helper"')
  expect(written(script, '/etc/sudoers.d/antfarm-vfs')).toBe('workspace-exec ALL=(root) NOPASSWD: /opt/antfarm-vfs/start-helper ""\n')
  const sshd = written(script, '/etc/ssh/sshd_config.d/00-antfarm.conf')
  expect(sshd).toContain('AllowTcpForwarding no\nAllowStreamLocalForwarding no\n')
  expect(sshd).toMatch(/\nMatch User workspace-exec\n  AllowTcpForwarding local\n  AllowStreamLocalForwarding local\n$/u)
  expect(written(script, '/var/lib/antfarm-workspace-ready')).toBe('unique-new-label\n')
})

test('waits for the current marker and probes exact mounts under the assigned task before returning SSH coordinates', async () => {
  const f = await setup()
  child.exec.mockRejectedValueOnce(new Error('Guest marker is stale')).mockResolvedValue({ stdout: '' })
  const beforeMount = vi.fn(async () => { expect(child.exec).toHaveBeenCalledTimes(4) })
  const connection = await f.provisioning.connect(f.record, f.instance, f.directory, 113849250, AbortSignal.timeout(1000), beforeMount)
  expect(beforeMount).toHaveBeenCalledOnce()
  const calls = child.exec.mock.calls
  expect(calls.map(([program]) => program)).toEqual(['ssh', 'ssh', 'scp', 'ssh', 'ssh'])
  expect(calls[0]?.[1].at(-1)).toBe('test "$(cat /var/lib/antfarm-workspace-ready)" = \'unique-new-label\'')
  const install = calls[3]?.[1].at(-1) ?? ''
  expect(install).toContain('/dsh-ssh-helper')
  expect(install).toContain('sha256sum -c')
  const mount = calls[4]?.[1].at(-1) ?? ''
  expect(mount).toContain("mount -t virtiofs -o nosuid,nodev '113849250' '/srv/antfarm/vfs'")
  expect(mount).toContain("'/bin/bash' '/opt/antfarm-vfs/check-mount' '/srv/antfarm/vfs' '113849250' '/'")
  expect(mount).toContain("mount --bind '/srv/antfarm/vfs/workspaces/ws-suffix' '/workspace'")
  expect(written(mount, '/opt/antfarm-vfs/probe')).toContain("'113849250[/workspaces/ws-suffix]' '/workspaces/ws-suffix' '/workspace' 'read-write'")
  expect(mount).toContain("'/opt/antfarm-vfs/launch' '11001' '/workspace' '/opt/antfarm-vfs/probe'")
  expect(written(mount, '/opt/antfarm-vfs/start-helper')).toContain("'/opt/antfarm-vfs/launch' '11001' '/workspace' ")
  expect(written(mount, '/opt/antfarm-vfs/start-helper')).toContain("test ! -e '/opt/antfarm-vfs/retired'")
  expect(connection).toMatchObject({ host: 'antfarm-workspace', workspace: '/workspace', helperHash: f.settings.helperHash })
  expect(await readFile(join(f.allocation, 'known-hosts'), 'utf8')).toBe('192.0.2.44 ssh-ed25519 fixed-host-public-key\n')
  const config = await readFile(join(f.allocation, 'ssh-config'), 'utf8')
  expect(config).toContain('StrictHostKeyChecking yes')
  expect(config).toContain('GlobalKnownHostsFile /dev/null')
  expect(config).toContain('HostKeyAlgorithms ssh-ed25519')
  expect(config).toContain('Host antfarm-workspace\n  User workspace-exec')
  expect(config).toContain('Host antfarm-admin\n  User root')
})

test('a stale marker at the deadline never permits helper installation or mounting', async () => {
  const f = await setup()
  const deadline = new AbortController()
  child.exec.mockImplementation(() => {
    deadline.abort(new Error('Old readiness marker'))
    return Promise.reject(new Error('Old readiness marker'))
  })
  const beforeMount = vi.fn(async () => {})
  await expect(f.provisioning.connect(f.record, f.instance, f.directory, 113849250, deadline.signal, beforeMount)).rejects.toThrow('Old readiness marker')
  expect(beforeMount).not.toHaveBeenCalled()
  expect(child.exec.mock.calls.map(([program]) => program)).toEqual(['ssh'])
})

test('an already cancelled SSH setup never probes the guest', async () => {
  const f = await setup()
  const reason = new Error('Allocation cancelled before SSH')
  await expect(f.provisioning.retire(f.record, f.instance, AbortSignal.abort(reason))).rejects.toBe(reason)
  expect(child.exec).not.toHaveBeenCalled()
})

test.runIf(process.platform === 'linux')('preserves a host key path error instead of generating a replacement', async () => {
  const f = await setup()
  await rm(join(f.allocation, 'host-key'))
  await symlink('host-key', join(f.allocation, 'host-key'))
  await expect(f.provisioning.bootstrap(f.record, f.directory, new AbortController().signal)).rejects.toMatchObject({ code: 'ELOOP' })
  expect(child.exec).not.toHaveBeenCalled()
})

test.each([new Error('Setup revoked'), 'setup revoked'])('aborting a poll releases its listener (%s)', async (reason) => {
  const controller = new AbortController()
  const waiting = delay(60_000, controller.signal)
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)
  controller.abort(reason)
  if (reason instanceof Error) await expect(waiting).rejects.toBe(reason)
  else await expect(waiting).rejects.toMatchObject({ message: 'Vultr polling cancelled', cause: reason })
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
})

test('mounting waits for the allocation record to persist', async () => {
  const f = await setup()
  child.exec.mockResolvedValue({ stdout: '' })
  await expect(f.provisioning.connect(f.record, f.instance, f.directory, 113849250, AbortSignal.timeout(1000), async () => {
    throw new Error('Allocation record failed to persist')
  })).rejects.toThrow('Allocation record failed to persist')
  expect(child.exec.mock.calls.map(([program]) => program)).toEqual(['ssh', 'scp', 'ssh'])
})

test('refuses invalid directory coordinates and preserves a failed task probe', async () => {
  const f = await setup()
  child.exec.mockResolvedValue({ stdout: '' })
  await expect(f.provisioning.connect(f.record, f.instance, { ...f.directory, volumePath: '/workspaces/../escape' },
    113849250, AbortSignal.timeout(1000), async () => {})).rejects.toThrow('Invalid native VFS workspace path')
  expect(child.exec).not.toHaveBeenCalled()
  child.exec.mockReset()
  child.exec.mockResolvedValueOnce({ stdout: '' }).mockResolvedValueOnce({ stdout: '' }).mockResolvedValueOnce({ stdout: '' })
    .mockRejectedValueOnce(new Error('Task permission probe failed'))
  await expect(f.provisioning.connect(f.record, f.instance, f.directory, 113849250, AbortSignal.timeout(1000), async () => {}))
    .rejects.toThrow('Task permission probe failed')
})

test.each([
  { volumePath: '/workspaces/a;touch' }, { volumePath: '/workspaces/..' },
  { uid: 1.5, gid: 1.5 }, { uid: 0, gid: 0 }, { uid: 0xffff_ffff, gid: 0xffff_ffff }, { gid: 11002 },
])('refuses invalid task coordinates %o before constructing a guest', async (overrides) => {
  const f = await setup()
  const reason = 'volumePath' in overrides ? 'Invalid native VFS workspace path' : 'assigned matching UID and GID'
  await expect(f.provisioning.bootstrap(f.record, { ...f.directory, ...overrides }, new AbortController().signal)).rejects.toThrow(reason)
  expect(child.exec).not.toHaveBeenCalled()
})

test.each([0, 1.5, Number.MAX_SAFE_INTEGER + 1])('refuses invalid mount tag %s before SSH', async (tag) => {
  const f = await setup()
  const beforeMount = vi.fn(async () => {})
  await expect(f.provisioning.connect(f.record, f.instance, f.directory, tag, new AbortController().signal, beforeMount))
    .rejects.toThrow('Invalid native VFS Mount Tag')
  expect(child.exec).not.toHaveBeenCalled()
  expect(beforeMount).not.toHaveBeenCalled()
})

test('rejects retirement without the original instance IPv4', async () => {
  const f = await setup()
  await expect(f.provisioning.retire(f.record, { ...f.instance, main_ip: '2001:db8::44' }, new AbortController().signal))
    .rejects.toThrow('no usable IPv4 address')
  expect(child.exec).not.toHaveBeenCalled()
})

test.runIf(process.platform === 'linux')('validates credential ownership, helper digests and the deployment root before SSH', async () => {
  const { settings } = await setup()
  await writeFile(settings.apiKeyFile, 'fixture', { mode: 0o600 })
  await writeFile(settings.sshKeyFile, 'fixture', { mode: 0o600 })
  await writeFile(settings.helperArchive, 'fixture archive')
  settings.helperArchiveHash = createHash('sha256').update('fixture archive').digest('hex')
  const validate = (overrides: Partial<typeof settings> = {}) => new VultrSshProvisioning({ ...settings, ...overrides }).validate()
  await expect(validate()).resolves.toBeUndefined()
  await expect(validate({ sshKeyFile: 'relative' })).rejects.toThrow('absolute paths')
  await expect(validate({ apiKeyFile: settings.stateRoot })).rejects.toThrow('not regular')
  await chmod(settings.apiKeyFile, 0o644)
  await expect(validate()).rejects.toThrow('private files owned by the Harness user')
  await chmod(settings.apiKeyFile, 0o600)
  await expect(validate({ helperArchiveHash: 'invalid' })).rejects.toThrow('SHA-256')
  await expect(validate({ helperHash: 'invalid' })).rejects.toThrow('SHA-256')
  await expect(validate({ helperArchiveHash: 'a'.repeat(64) })).rejects.toThrow('digest mismatch')
  for (const remoteRoot of ['relative', '/', '/work\nspace']) {
    await expect(validate({ remoteRoot })).rejects.toThrow('absolute POSIX path')
  }
  expect(child.exec).not.toHaveBeenCalled()
})

test.each(['https://cloud.invalid/v2/', 'http://127.0.0.1:3000/v2/'])('accepts a trusted cloud endpoint %s', (endpoint) => {
  expect(vultrEndpoint(endpoint)).toBe(endpoint.slice(0, -1))
})

test.each([
  ['http://cloud.invalid/v2', 'HTTPS or test loopback'], ['ftp://localhost/v2', 'HTTPS or test loopback'],
  ['https://fixture@cloud.invalid/v2', 'credentials, query or fragment'],
  ['https://:fixture@cloud.invalid/v2', 'credentials, query or fragment'],
  ['https://cloud.invalid/v2?key=value', 'credentials, query or fragment'],
  ['https://cloud.invalid/v2#fixture', 'credentials, query or fragment'],
])('refuses unsafe cloud endpoint %s', (endpoint, reason) => {
  expect(() => vultrEndpoint(endpoint)).toThrow(reason)
})

test('non-VFS provisioning creates one pinned host key, retains it on retry, and flushes through the admin alias', async () => {
  const f = await setup()
  await rm(join(f.allocation, 'host-key'))
  await rm(join(f.allocation, 'host-key.pub'))
  child.exec.mockImplementation(async (program, args) => {
    if (program === 'ssh-keygen' && args[0] === '-t') {
      const path = join(f.allocation, 'host-key')
      expect(args.at(-1)).toBe(path)
      await writeFile(path, 'new private host key')
      await writeFile(path + '.pub', 'ssh-ed25519 new-host-public-key')
    }
    return { stdout: 'ssh-ed25519 client-public-key\n' }
  })
  const record = cloudRecord.parse({ ...f.record, format: 1, project: f.allocation, deploymentId: 'test',
    generation: 'b'.repeat(64), state: 'starting', phase: 'creating' })
  const signal = new AbortController().signal
  const first = await f.ssh.bootstrap(record, signal)
  expect(written(first, '/etc/ssh/ssh_host_ed25519_key.pub')).toBe('ssh-ed25519 new-host-public-key')
  expect(written(first, '/home/workspace-exec/.ssh/authorized_keys')).toBe('ssh-ed25519 client-public-key\n')
  await expect(f.ssh.bootstrap(record, signal)).resolves.toBe(first)
  expect(child.exec.mock.calls.filter(([, args]) => args[0] === '-t')).toHaveLength(1)
  const connection = await f.ssh.connect(record, f.instance, signal)
  await f.ssh.flush(record, signal)
  expect(child.exec.mock.calls.at(-1)?.slice(0, 2)).toEqual(['ssh', ['-F', connection.configFile, 'antfarm-admin', '/bin/sync']])
})

test('guest retirement fences the helper and drains the task UID before syncing and unmounting', async () => {
  const f = await setup()
  child.exec.mockResolvedValue({ stdout: '' })
  await f.provisioning.retire(f.record, f.instance, AbortSignal.timeout(1000))
  const calls = child.exec.mock.calls
  expect(calls.map(([program, args]) => [program, args[2]])).toEqual([['ssh', 'antfarm-admin'], ['ssh', 'antfarm-admin']])
  expect(calls[0]?.[1].at(-1)).toContain(f.record.label)
  const retire = calls[1]?.[1].at(-1) ?? ''
  const steps = [
    'touch --', '/usr/bin/timeout', 'id -u workspace-exec', '/usr/bin/flock -xn 9', '/usr/bin/pgrep -u "$uid"',
    '/usr/bin/pkill -KILL -u "$uid"', 'rm -f --', '/proc/self/mountinfo',
    '/bin/sync -f', 'umount --', '/bin/sync -f', 'umount --',
  ]
  let cursor = 0
  for (const step of steps) {
    cursor = retire.indexOf(step, cursor)
    expect(cursor).toBeGreaterThanOrEqual(0)
    cursor += step.length
  }
  expect(retire.indexOf('/workspace', retire.indexOf('/bin/sync -f'))).toBeLessThan(retire.lastIndexOf('/srv/antfarm/vfs'))
})
