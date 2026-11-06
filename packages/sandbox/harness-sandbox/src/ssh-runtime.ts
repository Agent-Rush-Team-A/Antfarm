/** Private service realm for one workspace generation; no provider changes the Harness filesystem. */
import { Context } from '@deepseek-ai/cordis'
import { SshConnection } from '@deepseek-ai/dsh-ssh'
import type { Config as SshConfig } from '@deepseek-ai/dsh-ssh'
import { SshFileSystem } from '@deepseek-ai/dsh-fs-ssh'
import { SshSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-ssh'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'

/** Providers captured from the same private execution world. */
export interface WorkspaceSshServices {
  readonly ssh: Pick<SshConnection, 'request' | 'signal'>
  readonly fs: FileSystem
  readonly subprocess: Pick<SubprocessRuntime, 'spawn'>
  readonly root: string
  /** Drain processes and helper before releasing the connection. */
  close(): Promise<void>
}

/**
 * Prepare one independently owned realm; partial startup rolls back every acquired provider.
 * @param config - Fixed instance and helper coordinates.
 * @returns Verified execution root and its matched providers.
 */
export async function createWorkspaceSshServices(config: SshConfig): Promise<WorkspaceSshServices> {
  const ctx = new Context()
  const fibers: ReturnType<Context['plugin']>[] = []
  let connection: SshConnection | undefined
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= (async () => {
      const errors: unknown[] = []
      if (connection !== undefined) {
        try { await connection.closeConfirmed() } catch (error) { errors.push(error) }
      }
      for (const fiber of [...fibers].reverse()) {
        try { await fiber.dispose() } catch (error) { errors.push(error) }
      }
      if (errors.length > 0) throw new AggregateError(errors, 'Workspace SSH cleanup could not be confirmed')
    })()
    return closing
  }
  async function mount(fiber: ReturnType<Context['plugin']>): Promise<void> {
    fibers.push(fiber)
    await fiber
  }
  try {
    await mount(ctx.plugin(SessionProjectionRegistry))
    await mount(ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', modelContext: false, workspaceRoot: config.workspace }))
    await mount(ctx.plugin(SshConnection, config))
    connection = ctx.ssh
    await mount(ctx.plugin(SshFileSystem, { confineTextReads: true }))
    await mount(ctx.plugin(SshSubprocessRuntime))
    const hello = await ctx.ssh.ready
    const root = await ctx.fs.resolve(hello.workspace)
    const info = await ctx.fs.stat(root)
    if (info?.type !== 'directory') throw new Error('Remote workspace root is not a directory')
    return { ssh: ctx.ssh, fs: ctx.fs, subprocess: ctx.subprocess, root: ctx.fs.processPath(root), close }
  } catch (error) {
    try { await close() } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Workspace SSH startup and cleanup failed')
    }
    throw error
  }
}
