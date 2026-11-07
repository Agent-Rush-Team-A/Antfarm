/** Linux descriptor-anchored, exclusive publication of streamed workspace files. */
import { constants } from 'node:fs'
import { open, mkdtemp, link, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { WorkspaceFileWriteFailure as WorkspaceUploadFailureReason, WorkspaceFileUpload as WorkspaceUploadValue } from '@deepseek-ai/dsh-fs/workspace-access'

/** Expected upload refusal with its publication fact and original cause. */
export class UploadFailure extends Error {
  /**
   * @param reason - stable receiving operation failure.
   * @param stored - whether exclusive publication already succeeded.
   * @param options - retained internal cause, never sent to the browser.
   */
  constructor(
    readonly reason: WorkspaceUploadFailureReason,
    readonly stored = false,
    options?: ErrorOptions,
  ) {
    super('workspace upload: ' + reason, options)
  }
}

/**
 * Validate one untrusted filesystem leaf without changing its spelling.
 * @param name - browser-supplied filename.
 * @throws UploadFailure for directory components, control bytes, or oversized names.
 */
export function validateUploadName(name: string): void {
  if (name.trim() === '' || name === '.' || name === '..'
    || /[\/\\\u0000-\u001f\u007f]/u.test(name) || /^[a-z]:/iu.test(name)
    || Buffer.byteLength(name, 'utf8') > 255) {
    throw new UploadFailure('invalid-name')
  }
}

/**
 * Stage bytes outside the container mount, then hard-link one exclusive leaf.
 * The registry supplies a trusted root with a trusted parent on the same
 * filesystem. The final lookup uses its open directory descriptor and never
 * follows a destination symlink. Existing entries are preserved.
 * @param root - registered workspace directory.
 * @param name - untrusted leaf name.
 * @param chunks - bounded-memory byte stream.
 * @param maxBytes - inclusive deployment byte limit.
 * @param signal - cancellation through completion of staging.
 * @param admitPublication - rechecks current authority immediately before publication.
 * @param pinned - Optional transferred directory descriptor and trusted staging parent for a remote helper.
 * @returns the committed name and byte count after temporary resources settle.
 * @throws UploadFailure; its stored flag distinguishes committed cleanup failures.
 */
export async function storeWorkspaceUpload(
  root: string,
  name: string,
  chunks: AsyncIterable<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
  admitPublication: () => void,
  pinned?: { directory: FileHandle; stagingRoot: string },
): Promise<WorkspaceUploadValue> {
  let directory: FileHandle | undefined = pinned?.directory
  let staged: FileHandle | undefined
  let temporary: string | undefined
  let stored = false
  let bytes = 0
  let failure: { readonly cause: unknown } | undefined
  try {
    validateUploadName(name)
    signal.throwIfAborted()
    const path = resolve(root)
    directory = pinned?.directory ?? await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const info = await directory.stat()
    temporary = await mkdtemp(join(pinned?.stagingRoot ?? dirname(path), '.dsh-upload-'))
    const source = join(temporary, 'file')
    staged = await open(source, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    // The container and Harness share the workspace group, not the file owner.
    await staged.chown(-1, info.gid)
    for await (const chunk of chunks) {
      signal.throwIfAborted()
      bytes += chunk.byteLength
      if (bytes > maxBytes) throw new UploadFailure('too-large')
      await staged.writeFile(chunk)
    }
    await staged.chmod(0o660)
    await staged.sync()
    signal.throwIfAborted()
    admitPublication()
    await link(source, '/proc/self/fd/' + String(directory.fd) + '/' + name)
    stored = true
    await directory.sync()
  } catch (cause) {
    failure = { cause }
  }
  const cleanup: unknown[] = []
  if (staged !== undefined) {
    try { await staged.close() } catch (cause) { cleanup.push(cause) }
  }
  if (temporary !== undefined) {
    try { await rm(temporary, { recursive: true, force: true }) } catch (cause) { cleanup.push(cause) }
  }
  if (directory !== undefined) {
    try { await directory.close() } catch (cause) { cleanup.push(cause) }
  }
  if (cleanup.length > 0) {
    throw new UploadFailure('cleanup', stored, {
      cause: new AggregateError([...cleanup, ...(failure === undefined ? [] : [failure.cause])]),
    })
  }
  if (failure !== undefined) {
    const cause = failure.cause
    if (cause instanceof UploadFailure) throw cause
    if (signal.aborted) throw new UploadFailure('cancelled', stored, { cause })
    const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined
    const reason = code === 'EEXIST' ? 'exists'
      : code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP' ? 'unavailable' : 'io'
    throw new UploadFailure(reason, stored, { cause })
  }
  return { name, bytes }
}
