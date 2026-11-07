/** Linux directory-descriptor traversal without following browser-selected symlinks. */
import { constants } from 'node:fs'
import { open, opendir } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { WorkspaceFileEntry as WorkspaceArtifactEntry, WorkspaceFileReadFailure as WorkspaceArtifactFailureReason } from '@deepseek-ai/dsh-fs/workspace-access'

/** Expected filesystem refusal with its original internal cause. */
export class ArtifactFailure extends Error {
  /**
   * @param reason - stable refusal category.
   * @param options - internal cause, never returned to the browser.
   */
  constructor(readonly reason: WorkspaceArtifactFailureReason, options?: ErrorOptions) {
    super('workspace artifact: ' + reason, options)
  }
}

/**
 * Reject absolute paths, traversal, control bytes and unsupported leaf names.
 * @param path - untrusted slash-separated relative path; empty names the root.
 * @returns the original components without normalization or decoding.
 * @throws ArtifactFailure for an invalid path.
 */
export function artifactComponents(path: string): readonly string[] {
  if (path === '') return []
  const parts = path.split('/')
  if (Buffer.byteLength(path, 'utf8') > 4095 || /^[a-z]:/iu.test(path)
    || /[\\\u0000-\u001f\u007f]/u.test(path)
    || parts.some(part => part === '' || part === '.' || part === '..' || Buffer.byteLength(part, 'utf8') > 255)) {
    throw new ArtifactFailure('invalid-path')
  }
  return parts
}

/**
 * Convert filesystem failures without exposing a filename or Host path.
 * @param cause - original operation error.
 * @param signal - operation cancellation state.
 * @returns the stable failure retaining its internal cause.
 */
export function artifactFailure(cause: unknown, signal: AbortSignal): ArtifactFailure {
  if (cause instanceof ArtifactFailure) return cause
  if (signal.aborted) return new ArtifactFailure('cancelled', { cause })
  const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined
  return new ArtifactFailure(code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP' ? 'not-found' : 'io', { cause })
}

function descriptor(handle: FileHandle): string {
  return '/proc/self/fd/' + String(handle.fd)
}

/**
 * Pin every directory component and open the final entry with O_NOFOLLOW.
 * The registry root has a trusted parent; the sandbox can replace its children.
 * @param root - authoritative workspace directory.
 * @param path - untrusted workspace-relative path.
 * @param directory - whether the target must be a directory.
 * @param signal - cancellation through descriptor acquisition.
 * @returns one owned descriptor; the caller must close it.
 * @throws ArtifactFailure; all other acquired descriptors are closed before rejection.
 */
export async function openArtifact(root: string, path: string, directory: boolean, signal: AbortSignal): Promise<FileHandle> {
  const parts = artifactComponents(path)
  if (!directory && parts.length === 0) throw new ArtifactFailure('not-regular')
  const handles: FileHandle[] = []
  try {
    signal.throwIfAborted()
    let target = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    handles.push(target)
    for (const [index, part] of parts.entries()) {
      signal.throwIfAborted()
      const flags = constants.O_RDONLY | constants.O_NOFOLLOW
        | (directory || index < parts.length - 1 ? constants.O_DIRECTORY : constants.O_NONBLOCK)
      target = await open(descriptor(target) + '/' + part, flags)
      handles.push(target)
    }
    signal.throwIfAborted()
    if (!directory && !(await target.stat()).isFile()) throw new ArtifactFailure('not-regular')
    const closed = await Promise.allSettled(handles.slice(0, -1).map(handle => handle.close()))
    const failed = closed.filter(result => result.status === 'rejected')
    if (failed.length > 0) throw new AggregateError(failed.map((result): unknown => result.reason))
    return target
  } catch (cause) {
    const closed = await Promise.allSettled(handles.map(handle => handle.close()))
    const failed = closed.filter(result => result.status === 'rejected')
    throw artifactFailure(failed.length === 0 ? cause
      : new AggregateError([cause, ...failed.map((result): unknown => result.reason)]), signal)
  }
}

/**
 * Scan a pinned directory, omitting symlinks and special or replaced entries.
 * @param root - authoritative workspace directory.
 * @param path - untrusted relative directory.
 * @param maxEntries - maximum inspected entries, including omitted entries.
 * @param signal - cancellation through scan and descriptor cleanup.
 * @returns bounded metadata and whether more entries may exist.
 * @throws ArtifactFailure after closing the directory and file descriptors.
 */
export async function listArtifacts(root: string, path: string, maxEntries: number, signal: AbortSignal): Promise<{
  readonly entries: readonly WorkspaceArtifactEntry[]
  readonly truncated: boolean
}> {
  const directory = await openArtifact(root, path, true, signal)
  try {
    const entries: WorkspaceArtifactEntry[] = []
    let inspected = 0
    let truncated = false
    const scan = await opendir(descriptor(directory))
    for await (const child of scan) {
      signal.throwIfAborted()
      if (inspected++ === maxEntries) { truncated = true; break }
      try { artifactComponents(child.name) } catch (_cause) {
        // The local parser refuses unsupported directory-entry names.
        continue
      }
      if (child.isDirectory()) entries.push({ name: child.name, kind: 'directory' })
      else if (child.isFile()) {
        let file: FileHandle | undefined
        try {
          file = await open(descriptor(directory) + '/' + child.name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
          const info = await file.stat()
          if (info.isFile()) entries.push({ name: child.name, kind: 'file', bytes: info.size })
        } catch (cause) {
          const failure = artifactFailure(cause, signal)
          if (failure.reason !== 'not-found') throw failure
        } finally {
          await file?.close()
        }
      }
    }
    entries.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1)
    return { entries, truncated }
  } catch (cause) {
    throw artifactFailure(cause, signal)
  } finally {
    await directory.close()
  }
}

/**
 * Stream the opened file's initial byte extent, retaining its descriptor until settlement.
 * @param file - owned regular-file descriptor; ownership transfers to the stream.
 * @param bytes - byte extent at preflight stat, bounded by the deployment cap.
 * @param signal - request, Peer and provider cancellation.
 * @param admit - recheck current resource authority before and after each read.
 * @returns the pull-driven body and a promise settling only after descriptor close.
 */
export function streamArtifact(file: FileHandle, bytes: number, signal: AbortSignal, admit: () => void): {
  readonly body: ReadableStream<Uint8Array>
  readonly settled: Promise<void>
} {
  let resolve!: () => void
  let reject!: (cause: unknown) => void
  const settled = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  let closing: Promise<void> | undefined
  let offset = 0
  let controller: ReadableStreamDefaultController<Uint8Array>
  const finish = (): Promise<void> => {
    closing ??= file.close().then(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, (cause: unknown) => {
      signal.removeEventListener('abort', abort)
      reject(cause)
      throw cause
    })
    return closing
  }
  const abort = (): void => {
    controller.error(new ArtifactFailure('cancelled', { cause: signal.reason }))
    void finish().catch((cause: unknown) => { controller.error(cause) })
  }
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    },
    async pull(value) {
      try {
        signal.throwIfAborted()
        admit()
        if (offset === bytes) { await finish(); value.close(); return }
        const buffer = new Uint8Array(Math.min(64 * 1024, bytes - offset))
        const read = await file.read(buffer, 0, buffer.byteLength, offset)
        signal.throwIfAborted()
        admit()
        if (read.bytesRead === 0) throw new ArtifactFailure('io')
        offset += read.bytesRead
        value.enqueue(buffer.subarray(0, read.bytesRead))
      } catch (cause) {
        value.error(artifactFailure(cause, signal))
        await finish()
      }
    },
    cancel: finish,
  }, { highWaterMark: 0 })
  return { body, settled }
}
