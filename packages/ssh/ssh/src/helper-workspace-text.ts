/** Linux descriptor-relative acquisition for workspace-confined UTF-8 reads. */
import { constants } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import { posix } from 'node:path'
import { FsError, FsTargetKey, type FileSystem, type FsTarget } from '@deepseek-ai/dsh-fs'

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

function readError(error: unknown, target: FsTarget, signal?: AbortSignal): FsError {
  if (error instanceof FsError) return error
  if (signal?.aborted) return new FsError('read aborted', 'FS_ABORTED', { cause: error })
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  const message = `cannot read "${target.displayPath}"`
  if (code === 'ELOOP' || code === 'ENOTDIR') return new FsError(`${message}: workspace path changed or contains a symlink`, 'FS_SANDBOX_DENIED', { cause: error })
  if (code === 'ENOENT') return new FsError(`${message}: not found`, 'FS_NOT_FOUND', { cause: error })
  if (code === 'EACCES' || code === 'EPERM') return new FsError(`${message}: permission denied`, 'FS_PERMISSION_DENIED', { cause: error })
  return new FsError(`${message}: I/O failure`, 'FS_IO_ERROR', { cause: error })
}

/**
 * Stream a regular file acquired below the handshake's canonical workspace without following symlinks.
 * Directory and file descriptors remain pinned across path replacement; acquisition starts on first pull.
 * @param provider - Local text decoding and binary rejection implementation.
 * @param workspace - Canonical root from the authenticated hello request.
 * @param target - Remote canonical file identity and its original display path.
 * @param signal - Cancellation of acquisition and streaming.
 * @returns UTF-8 chunks; every acquired handle closes on completion, failure, or early return.
 */
export async function* streamWorkspaceText(
  provider: FileSystem, workspace: string, target: FsTarget, signal?: AbortSignal,
): AsyncIterable<string> {
  let directory: FileHandle | undefined
  let file: FileHandle | undefined
  try {
    signal?.throwIfAborted()
    if (process.platform !== 'linux') throw new FsError('Workspace text reads require Linux procfs', 'FS_IO_ERROR')
    try { await fs.access('/proc/self/fd') } catch (error) {
      throw new FsError('Workspace text reads require accessible Linux procfs', 'FS_IO_ERROR', { cause: error })
    }
    const path = String(target.targetKey)
    const relative = posix.relative(workspace, path)
    if (path !== posix.normalize(path) || relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative)) {
      throw new FsError(`cannot read "${target.displayPath}": outside workspace`, 'FS_SANDBOX_DENIED')
    }
    if (relative === '') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    const components = [...workspace.split('/').filter(Boolean), ...relative.split('/')].slice(0, -1)
    const name = posix.basename(path)
    directory = await fs.open('/', directoryFlags)
    for (const component of components) {
      signal?.throwIfAborted()
      const parent = directory
      directory = await fs.open(`/proc/self/fd/${parent.fd}/${component}`, directoryFlags)
      await parent.close()
    }
    signal?.throwIfAborted()
    file = await fs.open(`/proc/self/fd/${directory.fd}/${name}`, fileFlags)
    if (!(await file.stat()).isFile()) {
      throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    await directory.close()
    directory = undefined
    signal?.throwIfAborted()
    // procfs reopens the pinned inode, rather than looking up the original workspace path again.
    yield* await provider.streamText({ targetKey: FsTargetKey(`/proc/self/fd/${file.fd}`), displayPath: target.displayPath }, signal)
  } catch (error) {
    throw readError(error, target, signal)
  } finally {
    try { await Promise.all([directory?.close(), file?.close()]) } catch (error) {
      throw new FsError('Workspace text read handle cleanup failed', 'FS_IO_ERROR', { cause: error })
    }
  }
}
