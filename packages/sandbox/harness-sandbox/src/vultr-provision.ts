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

const executeFile = promisify(execFile)
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"

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
    const write = (path: string, content: string): string => 'printf %s ' + quote(Buffer.from(content).toString('base64')) + ' | base64 -d > ' + quote(path)
    const script = [
      '#!/bin/sh', 'set -eu',
      'install -d -m 0700 /root/.ssh',
      write('/root/.ssh/authorized_keys', publicClient.trim() + '\n'), 'chmod 0600 /root/.ssh/authorized_keys',
      write('/etc/ssh/ssh_host_ed25519_key', privateHost), 'chmod 0600 /etc/ssh/ssh_host_ed25519_key',
      write('/etc/ssh/ssh_host_ed25519_key.pub', publicHost),
      'id workspace-exec >/dev/null 2>&1 || useradd -u 10001 -m -s /bin/bash workspace-exec',
      'install -d -m 0700 -o workspace-exec -g workspace-exec /home/workspace-exec/.ssh',
      write('/home/workspace-exec/.ssh/authorized_keys', publicClient.trim() + '\n'),
      'chown workspace-exec:workspace-exec /home/workspace-exec/.ssh/authorized_keys', 'chmod 0600 /home/workspace-exec/.ssh/authorized_keys',
      'install -d -m 0700 -o workspace-exec -g workspace-exec ' + quote(record.remoteRoot),
      write('/etc/ssh/sshd_config.d/00-antfarm.conf', 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\nHostKey /etc/ssh/ssh_host_ed25519_key\n'),
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
    if (isIP(instance.main_ip) !== 4) throw new Error('Vultr instance has no usable IPv4 address')
    const root = join(this.settings.stateRoot, record.workspaceId)
    const known = join(root, 'known-hosts')
    const publicHost = (await readFile(join(root, 'host-key.pub'), 'utf8')).trim().split(/\s+/u).slice(0, 2).join(' ')
    await writeFile(known, instance.main_ip + ' ' + publicHost + '\n', { mode: 0o600 })
    const configFile = join(root, 'ssh-config')
    const host = 'antfarm-workspace'
    const admin = 'antfarm-admin'
    const escaped = (value: string): string => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"'
    await writeFile(configFile, [
      'Host ' + host + ' ' + admin, '  HostName ' + instance.main_ip,
      '  IdentityFile ' + escaped(this.settings.sshKeyFile), '  UserKnownHostsFile ' + escaped(known),
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
    const remoteArchive = '/tmp/antfarm-helper-' + this.settings.helperArchiveHash + '.tar.gz'
    await executeFile('scp', ['-F', configFile, this.settings.helperArchive, admin + ':' + remoteArchive], { signal, maxBuffer: 64 * 1024 })
    const install = '/opt/antfarm-helper/' + this.settings.helperHash
    const command = [
      'set -eu', 'printf \"%s\\n\" ' + quote(this.settings.helperArchiveHash + '  ' + remoteArchive) + ' | sha256sum -c - >/dev/null',
      'install -d -m 0755 ' + quote(install), 'tar -xzf ' + quote(remoteArchive) + ' -C ' + quote(install) + ' --strip-components=1',
      'printf \"%s\\n\" ' + quote(this.settings.helperHash + '  ' + install + '/dsh-ssh-helper') + ' | sha256sum -c - >/dev/null',
      'chown -R root:root ' + quote(install), 'chmod -R go-w ' + quote(install), 'rm -f ' + quote(remoteArchive),
    ].join('\n')
    await executeFile('ssh', ['-F', configFile, admin, command], { signal, maxBuffer: 64 * 1024 })
    return { host, configFile, launch: { kind: 'executable' }, helper: install + '/dsh-ssh-helper', helperHash: this.settings.helperHash,
      workspace: record.remoteRoot, requestTimeoutMs: this.settings.requestTimeoutMs }
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
