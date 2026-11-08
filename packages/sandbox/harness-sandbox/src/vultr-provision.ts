/** Pinned OpenSSH bootstrap and installation of a verified standalone helper archive. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { join, posix, isAbsolute } from 'node:path'
import { isIP } from 'node:net'
import type { Config as SshConfig } from '@deepseek-ai/dsh-ssh'
import type { ResolvedConfig } from './vultr-config.ts'
import type { CloudRecord } from './vultr-storage.ts'
import type { VultrInstance } from './vultr-api.ts'
import type { SingleVmWorkspaceDirectory } from './single-vm-workspaces.ts'

const executeFile = promisify(execFile)
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
const write = (path: string, content: string): string => 'printf %s ' + quote(Buffer.from(content).toString('base64')) + ' | base64 -d > ' + quote(path)
const vfsRoot = '/srv/antfarm/vfs'
const guestWorkspace = '/workspace'
const guestVfsSetup = '/opt/antfarm-vfs'
const guestLaunch = guestVfsSetup + '/start-helper'
const guestFence = guestVfsSetup + '/retired'
const guestHelperLock = guestVfsSetup + '/helper.lock'
const admin = 'antfarm-admin'
const host = 'antfarm-workspace'
type BootTarget = Pick<CloudRecord, 'workspaceId' | 'label' | 'remoteRoot'>
type TaskDirectory = Pick<SingleVmWorkspaceDirectory, 'volumePath' | 'uid' | 'gid'>

/** Deployment-owned sources of the guest mount checks and privilege-dropping launcher. */
export interface VultrVfsScripts {
  readonly checkMount: string
  readonly launchHelper: string
}

/** Prepare pinned SSH, an exact shared-volume mount and a restricted helper. */
export interface VultrVfsProvisioning {
  /**
   * Generate guest startup for the assigned task identity and allocation label.
   * @param record - Original allocation and fixed workspace root.
   * @param directory - Registered VFS path and task identity.
   * @param signal - Allocation deadline.
   * @returns Cloud-init script for the single-session guest.
   */
  bootstrap(record: BootTarget, directory: TaskDirectory, signal: AbortSignal): Promise<string>
  /**
   * Mount and probe the original VFS directory before returning the helper connection.
   * @param record - Original allocation.
   * @param instance - API-verified instance.
   * @param directory - Registered VFS path and task identity.
   * @param mountTag - Tag observed for the original attachment.
   * @param signal - Preparation deadline.
   * @param beforeMount - Persist possible guest mounts after SSH readiness and helper installation, before issuing the mount command.
   * @returns Pinned SSH coordinates for the installed restricted helper.
   */
  connect(record: BootTarget, instance: VultrInstance, directory: TaskDirectory, mountTag: number, signal: AbortSignal,
    beforeMount: () => Promise<void>): Promise<SshConfig>
  /**
   * Verify retained mounts, task identity and installed helper before reconnecting after a provider restart.
   * @param record - Original allocation and pinned bootstrap marker.
   * @param instance - API-verified retained instance.
   * @param directory - Registered volume directory and stable task identity.
   * @param mountTag - Tag of the confirmed original attachment.
   * @param signal - Recovery deadline.
   * @returns Pinned helper coordinates; mismatched or retired guests reject without changing their mounts.
   */
  reconnect(record: BootTarget, instance: VultrInstance, directory: TaskDirectory,
    mountTag: number, signal: AbortSignal): Promise<SshConfig>
  /**
   * Fence helper startup, confirm task processes exited, and synchronize and unmount the original guest.
   * @param record - Original allocation, including its bootstrap marker.
   * @param instance - API-verified original VM.
   * @param signal - Cleanup deadline.
   */
  retire(record: BootTarget, instance: VultrInstance, signal: AbortSignal): Promise<void>
}

/** Current production preparation operations, independently owned by the cloud controller. */
export interface VultrProvisioning {
  /**
   * @param record - Durable original identity.
   * @param signal - Allocation deadline.
   * @returns Cloud-init text with no management credential.
   */
  bootstrap(record: CloudRecord, signal: AbortSignal): Promise<string>
  /**
   * @param record - Original workspace generation.
   * @param instance - API-verified VM.
   * @param signal - Preparation lifetime.
   * @returns Matched installed helper coordinates.
   */
  connect(record: CloudRecord, instance: VultrInstance, signal: AbortSignal): Promise<SshConfig>
  /**
   * @param record - Quiescent workspace.
   * @param signal - Save deadline. Flush the guest disk before cloud halt.
   */
  flush(record: CloudRecord, signal: AbortSignal): Promise<void>
}

/** Installs only SSH keys, the standalone helper, and one non-root execution account. */
export class VultrSshProvisioning implements VultrProvisioning {
  /** @param settings - Fixed deployment coordinates. */
  constructor(private readonly settings: ResolvedConfig) {}

  /** Validate local secrets and the exact archive before creating paid resources. */
  async validate(): Promise<void> {
    for (const path of [this.settings.sshKeyFile, this.settings.apiKeyFile, this.settings.helperArchive]) {
      if (!isAbsolute(path) || /[\r\n\0]/u.test(path)) throw new Error('Vultr deployment files must use absolute paths')
      const info = await stat(path)
      if (!info.isFile()) throw new Error('Vultr deployment file is not regular')
      if (path !== this.settings.helperArchive && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) throw new Error('Vultr credentials must be private files owned by the Harness user')
    }
    if (!/^[a-f0-9]{64}$/u.test(this.settings.helperArchiveHash) || !/^[a-f0-9]{64}$/u.test(this.settings.helperHash)) throw new Error('Vultr helper hashes must be SHA-256')
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(this.settings.helperArchive) as AsyncIterable<Buffer>) digest.update(chunk)
    if (digest.digest('hex') !== this.settings.helperArchiveHash) throw new Error('Vultr helper archive digest mismatch')
    if (!posix.isAbsolute(this.settings.remoteRoot) || posix.resolve(this.settings.remoteRoot) === '/' || /[\r\n\0]/u.test(this.settings.remoteRoot)) throw new Error('Vultr workspace root must be an absolute POSIX path')
  }

  async bootstrap(record: CloudRecord, signal: AbortSignal): Promise<string> {
    return this.bootstrapGuest(record, signal)
  }

  /**
   * Reuse pinned bootstrap and archive installation with VFS-specific guest preparation.
   * @param scripts - Trusted scripts loaded before allocation.
   * @returns Provisioning operations for the native shared-volume provider.
   */
  forVfs(scripts: VultrVfsScripts): VultrVfsProvisioning {
    return {
      bootstrap: async (record, directory, signal) => this.bootstrapGuest(record, signal, this.taskId(directory)),
      connect: async (record, instance, directory, mountTag, signal, beforeMount) => {
        const command = this.mountWorkspace(directory, mountTag, scripts)
        return this.connectGuest(record, instance, signal, async (configFile) => {
          signal.throwIfAborted()
          await beforeMount()
          await executeFile('ssh', ['-F', configFile, admin, command], { signal, maxBuffer: 64 * 1024 })
        })
      },
      reconnect: async (record, instance, directory, mountTag, signal) => {
        const command = this.verifyWorkspace(directory, mountTag, scripts)
        const configFile = await this.pinnedGuest(record, instance, signal)
        await executeFile('ssh', ['-F', configFile, admin, command], { signal, maxBuffer: 64 * 1024 })
        return this.helperConnection(record, configFile)
      },
      retire: async (record, instance, signal) => {
        const configFile = await this.pinnedGuest(record, instance, signal)
        await executeFile('ssh', ['-F', configFile, admin, this.retireVfs()], { signal, maxBuffer: 64 * 1024 })
      },
    }
  }

  private async bootstrapGuest(record: BootTarget, signal: AbortSignal, task?: string): Promise<string> {
    const root = join(this.settings.stateRoot, record.workspaceId)
    await mkdir(root, { recursive: true, mode: 0o700 })
    const hostKey = join(root, 'host-key')
    try { await stat(hostKey) }
    catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error
      await executeFile('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', hostKey], { signal, maxBuffer: 64 * 1024 })
    }
    const privateHost = await readFile(hostKey, 'utf8')
    const publicHost = await readFile(hostKey + '.pub', 'utf8')
    const { stdout: publicClient } = await executeFile('ssh-keygen', ['-y', '-f', this.settings.sshKeyFile], { signal, maxBuffer: 64 * 1024 })
    const publicKey = publicClient.trim() + '\n'
    const sshd = 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\nHostKey /etc/ssh/ssh_host_ed25519_key\n'
    const script = [
      '#!/bin/sh', 'set -eu',
      write('/etc/ssh/ssh_host_ed25519_key', privateHost), 'chmod 0600 /etc/ssh/ssh_host_ed25519_key',
      write('/etc/ssh/ssh_host_ed25519_key.pub', publicHost),
      ...task === undefined ? [
        'install -d -m 0700 /root/.ssh',
        write('/root/.ssh/authorized_keys', publicKey), 'chmod 0600 /root/.ssh/authorized_keys',
        'id workspace-exec >/dev/null 2>&1 || useradd -u 10001 -m -s /bin/bash workspace-exec',
        'install -d -m 0700 -o workspace-exec -g workspace-exec /home/workspace-exec/.ssh',
        write('/home/workspace-exec/.ssh/authorized_keys', publicKey),
        'chown workspace-exec:workspace-exec /home/workspace-exec/.ssh/authorized_keys',
        'chmod 0600 /home/workspace-exec/.ssh/authorized_keys',
        'install -d -m 0700 -o workspace-exec -g workspace-exec ' + quote(record.remoteRoot),
        write('/etc/ssh/sshd_config.d/00-antfarm.conf', sshd),
      ] : this.vfsAccount(task, publicKey, sshd),
      '/usr/sbin/sshd -t', 'systemctl restart ssh',
      write('/var/lib/antfarm-workspace-ready', record.label + '\n'), '',
    ].join('\n')
    if (Buffer.byteLength(script) > 48 * 1024) throw new Error('Workspace cloud-init exceeds its allocation budget')
    return script
  }

  async flush(record: CloudRecord, signal: AbortSignal): Promise<void> {
    const configFile = join(this.settings.stateRoot, record.workspaceId, 'ssh-config')
    await executeFile('ssh', ['-F', configFile, 'antfarm-admin', '/bin/sync'], { signal, maxBuffer: 64 * 1024 })
  }

  async connect(record: CloudRecord, instance: VultrInstance, signal: AbortSignal): Promise<SshConfig> {
    return this.connectGuest(record, instance, signal)
  }

  private async pinnedGuest(record: BootTarget, instance: VultrInstance, signal: AbortSignal): Promise<string> {
    if (isIP(instance.main_ip) !== 4) throw new Error('Vultr instance has no usable IPv4 address')
    const root = join(this.settings.stateRoot, record.workspaceId)
    const known = join(root, 'known-hosts')
    const publicHost = (await readFile(join(root, 'host-key.pub'), 'utf8')).trim().split(/\s+/u).slice(0, 2).join(' ')
    await writeFile(known, instance.main_ip + ' ' + publicHost + '\n', { mode: 0o600 })
    const configFile = join(root, 'ssh-config')
    const escaped = (value: string): string => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"'
    await writeFile(configFile, [
      'Host ' + host + ' ' + admin, '  HostName ' + instance.main_ip,
      '  IdentityFile ' + escaped(this.settings.sshKeyFile), '  UserKnownHostsFile ' + escaped(known),
      '  GlobalKnownHostsFile /dev/null', '  UpdateHostKeys no', '  HostKeyAlgorithms ssh-ed25519',
      '  StrictHostKeyChecking yes', '  IdentitiesOnly yes', '  BatchMode yes', '  ForwardAgent no', '  ConnectTimeout 5',
      'Host ' + host, '  User workspace-exec', 'Host ' + admin, '  User root', '',
    ].join('\n'), { mode: 0o600 })
    // Only the preinstalled cloud host key is trusted; readiness never accepts an arbitrary host key.
    while (true) {
      signal.throwIfAborted()
      try {
        await executeFile('ssh', ['-F', configFile, admin, 'test "$(cat /var/lib/antfarm-workspace-ready)" = ' + quote(record.label)], { signal, maxBuffer: 64 * 1024 })
        break
      } catch (error) { if (signal.aborted) throw error; await delay(this.settings.pollIntervalMs, signal) }
    }
    return configFile
  }

  private async connectGuest(record: BootTarget, instance: VultrInstance, signal: AbortSignal,
    prepare?: (configFile: string) => Promise<void>): Promise<SshConfig> {
    const configFile = await this.pinnedGuest(record, instance, signal)
    const remoteArchive = '/tmp/antfarm-helper-' + this.settings.helperArchiveHash + '.tar.gz'
    await executeFile('scp', ['-F', configFile, this.settings.helperArchive, admin + ':' + remoteArchive], { signal, maxBuffer: 64 * 1024 })
    const install = this.helperDirectory
    const command = [
      'set -eu', 'printf \"%s\\n\" ' + quote(this.settings.helperArchiveHash + '  ' + remoteArchive) + ' | sha256sum -c - >/dev/null',
      'install -d -m 0755 ' + quote(install), 'tar -xzf ' + quote(remoteArchive) + ' -C ' + quote(install) + ' --strip-components=1',
      'printf \"%s\\n\" ' + quote(this.settings.helperHash + '  ' + install + '/dsh-ssh-helper') + ' | sha256sum -c - >/dev/null',
      'chown -R root:root ' + quote(install), 'chmod -R go-w ' + quote(install), 'rm -f ' + quote(remoteArchive),
    ].join('\n')
    await executeFile('ssh', ['-F', configFile, admin, command], { signal, maxBuffer: 64 * 1024 })
    await prepare?.(configFile)
    return this.helperConnection(record, configFile)
  }

  private helperConnection(record: BootTarget, configFile: string): SshConfig {
    return { host, configFile, launch: { kind: 'executable' }, helper: this.helperDirectory + '/dsh-ssh-helper', helperHash: this.settings.helperHash,
      workspace: record.remoteRoot, requestTimeoutMs: this.settings.requestTimeoutMs }
  }

  private taskId(directory: TaskDirectory): string {
    const path = directory.volumePath
    if (!/^\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u.test(path) || posix.normalize(path) !== path) {
      throw new Error('Invalid native VFS workspace path')
    }
    if (!Number.isInteger(directory.uid) || directory.uid <= 0 || directory.uid >= 0xffff_ffff || directory.uid !== directory.gid) {
      throw new Error('VFS task must have the assigned matching UID and GID')
    }
    return String(directory.uid)
  }

  private vfsAccount(task: string, publicKey: string, sshd: string): string[] {
    const keys = '/etc/ssh/antfarm-keys'
    const sudoers = '/etc/sudoers.d/antfarm-vfs'
    return [
      'groupadd -g ' + task + ' workspace-exec',
      'useradd -M -d /home/workspace-exec -u ' + task + ' -g workspace-exec -s /bin/sh workspace-exec',
      'install -d -o root -g root -m 0755 /home/workspace-exec ' + keys + ' ' + guestVfsSetup,
      'install -d -o workspace-exec -g workspace-exec -m 0700 /home/workspace-exec/.cache',
      write(keys + '/root', 'restrict ' + publicKey),
      write(keys + '/workspace-exec', 'restrict,port-forwarding,command="/usr/bin/sudo -n ' + guestLaunch + '" ' + publicKey),
      'chmod 0644 ' + keys + '/root ' + keys + '/workspace-exec',
      write(sudoers, 'workspace-exec ALL=(root) NOPASSWD: ' + guestLaunch + ' ""\n'),
      'chmod 0440 ' + sudoers, '/usr/sbin/visudo -cf ' + sudoers,
      write('/etc/ssh/sshd_config.d/00-antfarm.conf', sshd
        + 'AuthorizedKeysFile ' + keys + '/%u\nAllowTcpForwarding no\nAllowStreamLocalForwarding no\nPermitUserEnvironment no\n'
        // OpenSSH also consults the local TCP forwarding policy when opening a Unix socket.
        + 'Match User workspace-exec\n  AllowTcpForwarding local\n  AllowStreamLocalForwarding local\n'),
    ]
  }

  private get helperDirectory(): string { return '/opt/antfarm-helper/' + this.settings.helperHash }

  private mountWorkspace(directory: TaskDirectory, mountTag: number, scripts: VultrVfsScripts): string {
    const task = this.taskId(directory)
    const path = directory.volumePath
    if (!Number.isSafeInteger(mountTag) || mountTag <= 0) throw new Error('Invalid native VFS Mount Tag')
    const tag = String(mountTag)
    const source = vfsRoot + path
    const check = guestVfsSetup + '/check-mount'
    const launch = guestVfsSetup + '/launch'
    const probe = guestVfsSetup + '/probe'
    const command = (program: string, ...args: string[]): string => [program, ...args].map(quote).join(' ')
    return [
      'set -eu',
      'exec 9>>' + quote(guestHelperLock), '/usr/bin/flock -x 9', 'test ! -e ' + quote(guestFence),
      'install -d -m 0755 ' + command(vfsRoot, guestWorkspace),
      'test "$(realpath -e -- ' + quote(vfsRoot) + ')" = ' + quote(vfsRoot),
      'test "$(realpath -e -- ' + quote(guestWorkspace) + ')" = ' + quote(guestWorkspace),
      'if mountpoint -q ' + quote(vfsRoot) + ' || mountpoint -q ' + quote(guestWorkspace) + '; then exit 1; fi',
      write(check, scripts.checkMount), write(launch, scripts.launchHelper),
      'mount -t virtiofs -o nosuid,nodev ' + command(tag, vfsRoot),
      command('/bin/bash', check, vfsRoot, tag, '/', source, 'traverse'),
      'mount --bind ' + command(source, guestWorkspace),
      write(probe, '#!/bin/sh\nexec ' + command('/bin/bash', check, guestWorkspace, tag + '[' + path + ']', path, guestWorkspace, 'read-write') + '\n'),
      write(guestLaunch, this.vfsHelperStartup(task)),
      'chmod 0755 ' + command(check, launch, probe, guestLaunch),
      command(launch, task, guestWorkspace, probe),
      'rm -- ' + quote(probe),
    ].join('\n')
  }

  private vfsHelperStartup(task: string): string {
    return [
      '#!/bin/sh', 'set -eu', 'exec 9>>' + quote(guestHelperLock), '/usr/bin/flock -sn 9',
      'test ! -e ' + quote(guestFence),
      'exec ' + [guestVfsSetup + '/launch', task, guestWorkspace, this.helperDirectory + '/dsh-ssh-helper'].map(quote).join(' '), '',
    ].join('\n')
  }

  private verifyWorkspace(directory: TaskDirectory, mountTag: number, scripts: VultrVfsScripts): string {
    const task = this.taskId(directory)
    if (!Number.isSafeInteger(mountTag) || mountTag <= 0) throw new Error('Invalid native VFS Mount Tag')
    const tag = String(mountTag)
    const check = guestVfsSetup + '/check-mount'
    const launch = guestVfsSetup + '/launch'
    const probe = guestVfsSetup + '/reconnect-probe'
    const command = (program: string, ...args: string[]): string => [program, ...args].map(quote).join(' ')
    const digest = (path: string, content: string): string => 'printf "%s\\n" '
      + quote(createHash('sha256').update(content).digest('hex') + '  ' + path) + ' | sha256sum -c - >/dev/null'
    return [
      'set -eu', 'exec 9>>' + quote(guestHelperLock), '/usr/bin/flock -xn 9', 'test ! -e ' + quote(guestFence),
      'test "$(id -u workspace-exec)" = ' + quote(task), 'test "$(id -g workspace-exec)" = ' + quote(task),
      ...[check, launch, guestLaunch].map(path => 'test ! -L ' + quote(path)
        + '; test "$(stat -c %u:%g:%a -- ' + quote(path) + ')" = 0:0:755'),
      digest(check, scripts.checkMount), digest(launch, scripts.launchHelper), digest(guestLaunch, this.vfsHelperStartup(task)),
      'printf "%s\\n" ' + quote(this.settings.helperHash + '  ' + this.helperDirectory + '/dsh-ssh-helper') + ' | sha256sum -c - >/dev/null',
      command('/bin/bash', check, vfsRoot, tag, '/', vfsRoot + directory.volumePath, 'traverse'),
      write(probe, '#!/bin/sh\nexec ' + command('/bin/bash', check, guestWorkspace,
        tag + '[' + directory.volumePath + ']', directory.volumePath, guestWorkspace, 'read-write') + '\n'),
      'chmod 0755 ' + quote(probe), command(launch, task, guestWorkspace, probe), 'rm -- ' + quote(probe),
    ].join('\n')
  }

  private retireVfs(): string {
    const settle = [
      'set -eu',
      'uid=$(id -u workspace-exec)',
      'test "$uid" -gt 0',
      'exec 9>>' + quote(guestHelperLock),
      'while true; do',
      '  if /usr/bin/flock -xn 9; then',
      '    if /usr/bin/pgrep -u "$uid" >/dev/null; then :',
      '    else test "$?" -eq 1; break; fi',
      '  else test "$?" -eq 1; fi',
      '  /usr/bin/pkill -KILL -u "$uid" || test "$?" -eq 1',
      '  sleep 1',
      'done',
      'rm -f -- ' + quote(guestLaunch),
      'vfs_mounts() { awk ' + quote('$5 == "' + guestWorkspace + '" || $5 == "' + vfsRoot + '" { print $5 }') + ' /proc/self/mountinfo; }',
      'mounts=$(vfs_mounts)',
      'if printf "%s\\n" "$mounts" | grep -Fxq ' + quote(guestWorkspace) + '; then',
      '  /bin/sync -f ' + quote(guestWorkspace),
      '  umount -- ' + quote(guestWorkspace),
      'fi',
      'if printf "%s\\n" "$mounts" | grep -Fxq ' + quote(vfsRoot) + '; then',
      '  /bin/sync -f ' + quote(vfsRoot),
      '  umount -- ' + quote(vfsRoot),
      'fi',
      'mounts=$(vfs_mounts)',
      'test -z "$mounts"',
    ].join('\n')
    return [
      'set -eu',
      'touch -- ' + quote(guestFence),
      '/usr/bin/timeout --kill-after=5s ' + String(Math.ceil(this.settings.operationTimeoutMs / 1000)) + 's /bin/sh -c ' + quote(settle),
    ].join('\n')
  }
}

/**
 * Wait one polling interval while respecting the original operation deadline.
 * @param ms - Poll interval.
 * @param signal - Operation deadline.
 * @returns A cancelled or elapsed interval without leaked listeners.
 */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason instanceof Error ? signal.reason : new Error('Vultr polling cancelled', { cause: signal.reason })) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}
