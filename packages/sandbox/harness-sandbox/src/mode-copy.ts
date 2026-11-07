/** Bounded, Linux descriptor-anchored directory checkpoints with durable file and directory writes. */
import { constants } from 'node:fs'
import { mkdir, open, opendir } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { artifactComponents, openArtifact } from '@deepseek-ai/dsh-fs-local/workspace-artifacts'

/** Aggregate limits apply to every entry and complete file extent in one copy. */
export interface WorkspaceModeCopyLimits {
  readonly maxFiles: number
  readonly maxBytes: number
}

/** Copy refusal preserves the original source and prevents publishing an incomplete destination. */
export class WorkspaceModeCopyError extends Error {
  /** @param reason - Complete-copy condition that was not satisfied. */
  constructor(readonly reason: 'entry-limit' | 'byte-limit' | 'unsupported-entry' | 'changed-extent') {
    super('Workspace file preservation did not complete: ' + reason)
    this.name = 'WorkspaceModeCopyError'
  }
}

/**
 * Copy every regular file and directory; symlinks/special files refuse rather than disappearing.
 * @param source - Verified complete source directory.
 * @param destination - New private staging directory, absent on entry.
 * @param limits - Aggregate entry and byte budgets.
 * @param signal - Transition owner's cancellation.
 * @param ownership - Omitted for private checkpoints; publication retains destination uid/gid and root permissions.
 * @returns A fully synchronized copy; partial staging remains owned by the caller on rejection.
 */
export async function copyWorkspaceDirectory(source: string, destination: string, limits: WorkspaceModeCopyLimits,
  signal: AbortSignal, ownership?: { readonly uid: number; readonly gid: number; readonly rootMode?: number }): Promise<void> {
  let entries = 0
  let total = 0
  const scan = async (directory: FileHandle, output: string): Promise<void> => {
    const info = await directory.stat()
    await mkdir(output, { mode: 0o700 })
    const listing = await opendir('/proc/self/fd/' + String(directory.fd))
    for await (const entry of listing) {
      signal.throwIfAborted()
      artifactComponents(entry.name)
      if (++entries > limits.maxFiles) throw new WorkspaceModeCopyError('entry-limit')
      if (!entry.isDirectory() && !entry.isFile()) throw new WorkspaceModeCopyError('unsupported-entry')
      const path = '/proc/self/fd/' + String(directory.fd) + '/' + entry.name
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW
        | (entry.isDirectory() ? constants.O_DIRECTORY : constants.O_NONBLOCK))
      try {
        const stat = await file.stat()
        if (entry.isDirectory()) {
          if (!stat.isDirectory()) throw new WorkspaceModeCopyError('unsupported-entry')
          await scan(file, join(output, entry.name))
        } else {
          if (!stat.isFile()) throw new WorkspaceModeCopyError('unsupported-entry')
          if (stat.size > limits.maxBytes - total) throw new WorkspaceModeCopyError('byte-limit')
          const writer = await open(join(output, entry.name),
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
          try {
            const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, stat.size)))
            let position = 0
            while (position < stat.size) {
              signal.throwIfAborted()
              const read = await file.read(buffer, 0, Math.min(buffer.length, stat.size - position), position)
              if (read.bytesRead === 0) throw new WorkspaceModeCopyError('changed-extent')
              let written = 0
              while (written < read.bytesRead) {
                const result = await writer.write(buffer, written, read.bytesRead - written)
                if (result.bytesWritten === 0) throw new Error('Workspace checkpoint write made no progress')
                written += result.bytesWritten
              }
              position += read.bytesRead
            }
            if ((await file.stat()).size !== stat.size) throw new WorkspaceModeCopyError('changed-extent')
            if (ownership !== undefined) await writer.chown(ownership.uid, ownership.gid)
            await writer.chmod(stat.mode & 0o777)
            await writer.sync()
          } finally { await writer.close() }
          total += stat.size
        }
      } finally { await file.close() }
    }
    const target = await open(output, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      if (ownership !== undefined) await target.chown(ownership.uid, ownership.gid)
      await target.chmod(output === destination ? ownership?.rootMode ?? (info.mode & 0o3777) : info.mode & 0o3777)
      await target.sync()
    } finally { await target.close() }
  }
  const directory = await openArtifact(source, '', true, signal)
  try { await scan(directory, destination); signal.throwIfAborted() }
  finally { await directory.close() }
}
