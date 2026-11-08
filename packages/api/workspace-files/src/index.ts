/**
 * Workspace file service: read-only file previews, workspace directory
 * listings, and the filesystem-observation change feed, exposed as
 * `workspaceFiles`.
 *
 * File reads follow the composed filesystem's read access, including paths
 * outside the workspace for owner calls. User calls remain inside their
 * registered workspace. The selected Session header supplies the base for
 * owner-relative paths, with the sandbox policy root as its no-cwd fallback.
 * Directory listings and directory watches remain workspace-scoped.
 * File-kind checks and configured read caps apply to
 * every preview; this service exposes no mutations.
 *
 * An owner page is cut from `streamText`, which decodes and rejects non-UTF-8 as it
 * goes, so the file is read only up to the first character past the page and
 * never held whole in memory; the NUL scan runs on the page itself.
 * User previews read a capped complete file through the authorized artifact
 * service before selecting a page; their versions hash the returned bytes.
 *
 * This is NOT modelled on `session.openWorkspacePath`. That endpoint hands a
 * path to the local opener and leaves the effect on the machine; this one sends
 * file content across the wire, which is a different level of exposure.
 */

import { posix, win32 } from 'node:path'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import type {} from '@deepseek-ai/dsh-api-workspace-artifacts'
import { artifactFailure } from '@deepseek-ai/dsh-fs-local/workspace-artifacts'
import type { FsDirEntry, FsInfo, FsPathInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Remote, RemoteError, remoteErrorOf, TypertRemoteService, type TypertLookup } from '@deepseek-ai/dsh-typert-protocol'
import { WorkspaceChangeFeed } from './changes.ts'
import type {
  WorkspaceByteRange,
  WorkspaceByteReadOptions,
  WorkspaceDirectoryEntry,
  WorkspaceDirectoryListing,
  WorkspaceFileBytes,
  WorkspaceFileRange,
  WorkspaceFileStat,
  WorkspaceFileText,
  WorkspaceFileWatchFrame,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `workspaceFiles` Remote namespace. */
    workspaceFiles: WorkspaceFiles
  }
}

/** Header-derived file resolution context for one Session identity. */
export interface WorkspaceFileScope {
  /** Session identity received on the wire. */
  readonly sessionId: SessionId
  /** Session workspace root, or the deployment fallback when its header has no cwd. */
  readonly workspaceRoot: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    /** Resolve a Session id to its workspace root without loading its event body or activating an Agent. */
    workspaceFileScope: TypertLookup<WorkspaceFileScope, SessionId>
  }
}

/** Deployment caps on one page or one listing. */
export interface Config {
  /**
   * Inclusive byte cap on one page's text and on one byte window.
   *
   * A page above this fails; it is not shortened, because a silently cut page
   * reads as the whole page. A byte window asking for more is refused the same
   * way. Owner pages have no complete-file cap; user previews also apply maxFileBytes.
   */
  readonly maxBytes: number
  /** Inclusive byte cap on complete-file reads and all user file previews; larger files are refused. */
  readonly maxFileBytes: number
  /** Default and largest page size in lines; a request asking for more is refused. */
  readonly maxLines: number
  /** Cap on returned directory entries; the rest is dropped and reported cut. */
  readonly maxEntries: number
}

/** One page cut from a decoded text stream. */
interface Page {
  readonly text: string
  /** Lines in `text`; `0` for a page past the last line. */
  readonly lines: number
  readonly eof: boolean
}

/** The byte text never carries: its presence marks a page as binary. */
const NUL = String.fromCharCode(0)

/** Refuse anything the wire schema admits as a number but a window cannot use: only safe integers index a file. */
function integerAtLeast(value: number, min: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RemoteError('gateway/bad-request', `${name} must be a safe integer of at least ${min}`, {})
  }
  return value
}

/**
 * Cut lines `offset` through `offset + limit - 1` from decoded chunks, stopping
 * at the first character past the page so the rest of the file is never read.
 * Lines before the page are counted, not kept, and the page is refused the
 * moment its bytes exceed `maxBytes`, so one giant line cannot grow memory past
 * the cap either.
 */
async function cutPage(
  chunks: AsyncIterable<string>,
  offset: number,
  limit: number,
  maxBytes: number,
  path: string,
): Promise<Page> {
  const last = offset + limit - 1
  const lines: string[] = []
  let current = ''
  let bytes = 0
  let lineNumber = 1
  const admit = (size: number): void => {
    bytes += size
    if (bytes > maxBytes) {
      throw new RemoteError(
        'workspace-file/too-large',
        `lines ${offset}-${last} of "${path}" exceed the ${maxBytes} byte cap`,
        { path, limit: maxBytes },
      )
    }
  }
  const complete = (): void => {
    if (lines.length > 0) admit(1)
    lines.push(current)
    current = ''
  }
  for await (const chunk of chunks) {
    let position = 0
    while (position < chunk.length) {
      if (lineNumber > last) return { text: lines.join('\n'), lines: lines.length, eof: false }
      const newline = chunk.indexOf('\n', position)
      const segment = newline === -1 ? chunk.slice(position) : chunk.slice(position, newline)
      if (lineNumber >= offset) {
        admit(Buffer.byteLength(segment, 'utf8'))
        current += segment
      }
      if (newline === -1) break
      if (lineNumber >= offset) complete()
      lineNumber += 1
      position = newline + 1
    }
  }
  // Only an in-page line can be pending here: earlier lines were never kept,
  // and a character past the page returned above.
  if (current.length > 0) complete()
  return { text: lines.join('\n'), lines: lines.length, eof: true }
}

/**
 * Workspace path of `target` relative to `root`, derived from the two canonical
 * `file:` URIs so the answer is `/`-joined on every platform. Empty for the root.
 */
function workspacePathOf(rootUrl: string, targetUrl: string): string {
  const root = new URL(rootUrl).pathname.replace(/\/+$/, '')
  const target = new URL(targetUrl).pathname
  if (target === root) return ''
  return target.slice(root.length + 1).split('/').map(decodeURIComponent).join('/')
}

/** Strip the resolved child target: the wire carries names and metadata only. */
function directoryEntry(child: FsDirEntry): WorkspaceDirectoryEntry {
  return {
    name: child.name,
    type: child.type,
    ...child.size === undefined ? {} : { size: child.size },
  }
}

/** Host Remote file reads and workspace directory observations over the composed filesystem. */
export class WorkspaceFiles extends TypertRemoteService {
  static inject = ['fs', 'sandboxPolicy', 'sessions', 'typert']

  static Config: z<Config> = z.object({
    maxBytes: z.number().step(1).min(1).default(2 * 1024 * 1024),
    maxFileBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER - 1).default(32 * 1024 * 1024),
    maxLines: z.number().step(1).min(1).default(5000),
    maxEntries: z.number().step(1).min(1).default(2000),
  })

  private readonly feed: WorkspaceChangeFeed

  /**
   * @param ctx - Host context carrying the filesystem and the sandbox policy.
   * @param config - deployment caps on one page or one listing.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'workspaceFiles')
    this.feed = new WorkspaceChangeFeed(ctx)
    ctx.inject(['sessions', 'typert'], (scope) => {
      scope.typert.lookups.register('workspaceFileScope', {
        parameter: 'workspaceFileScope',
        wire: 'workspaceFileScopeId',
        resource: 'session',
        hostTypeSymbol: '@deepseek-ai/dsh-api-workspace-files#WorkspaceFileScope',
        wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
        resolve: async (sessionId) => {
          const live = scope.sessions.get(sessionId)?.header
          const stored = live === undefined
            ? await scope.get('sessionPersistence')?.stat(sessionId)
            : undefined
          const header = live ?? stored?.header
          if (header === undefined) return undefined
          return {
            sessionId,
            workspaceRoot: header.cwd ?? scope.sandboxPolicy.workspaceRoot,
          }
        },
      })
    })
  }

  /**
   * Read one page of lines from a UTF-8 file readable by the filesystem backend.
   * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
   * @param path - absolute or workspace-relative path; user calls remain inside their registered workspace.
   * @param range - the line window; omitted fields take the page defaults.
   * @param signal - caller cancellation.
   * @returns the page, the file's version at the stat before it, and whether it reaches the last line.
   */
  @Remote
  async read(
    workspaceFileScope: WorkspaceFileScope,
    path: string,
    range: WorkspaceFileRange,
    signal: AbortSignal,
  ): Promise<WorkspaceFileText> {
    const { offset, limit } = this.resolvePage(range)
    const user = await this.userFile(workspaceFileScope, path, signal)
    if (user !== undefined) {
      let text: string
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(user.data) }
      catch (cause) { throw new RemoteError('workspace-file/not-text', 'File is not UTF-8 text.', { path }, { cause }) }
      const page = await cutPage((async function* () { yield await Promise.resolve(text) })(), offset, limit, this.config.maxBytes, path)
      if (page.text.includes(NUL)) throw new RemoteError('workspace-file/not-text', 'File contains NUL bytes.', { path })
      return { ...user.stat, ...page, offset }
    }
    const { target, info } = await this.locateFile(workspaceFileScope, path, signal)
    const page = await this.cutPage(target, offset, limit, signal, path)
    if (page.text.includes(NUL)) {
      throw new RemoteError('workspace-file/not-text', `"${path}" contains NUL bytes`, { path })
    }
    return { ...this.statOf(target, info), offset, text: page.text, lines: page.lines, eof: page.eof }
  }

  /**
   * Read a complete regular file or one byte range without text decoding.
   * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
   * @param path - target path, absolute or workspace-relative; relative to the base file's directory when provided.
   * @param options - optional base file and range; without a range the complete-file cap applies.
   * @param signal - caller cancellation.
   * @returns native bytes with the file's version and size at the preceding stat, byte offset, and EOF marker.
   */
  @Remote
  async readBytes(
    workspaceFileScope: WorkspaceFileScope,
    path: string,
    options: WorkspaceByteReadOptions,
    signal: AbortSignal,
  ): Promise<WorkspaceFileBytes> {
    const window = options.range === undefined ? undefined : this.resolveWindow(options.range, path)
    const resolved = options.baseFile === undefined ? path : await this.relativePath(workspaceFileScope, options.baseFile, path, signal)
    const user = await this.userFile(workspaceFileScope, resolved, signal)
    if (user !== undefined) {
      if (window === undefined) return { ...user.stat, offset: 0, data: user.data, eof: true }
      const { offset, length } = window
      return { ...user.stat, offset, data: user.data.slice(offset, offset + length), eof: offset + length >= user.data.length }
    }
    const { target, info } = await this.locateFile(workspaceFileScope, resolved, signal)
    if (window !== undefined) {
      const { offset, length } = window
      const data = await this.ctx.fs.readByteRange(target, window, signal)
      const eof = info.size === undefined ? data.length < length : offset + data.length >= info.size
      return { ...this.statOf(target, info), offset, data, eof }
    }
    const limit = this.config.maxFileBytes
    const data = await this.ctx.fs.readBytes(target, signal, limit).catch((cause: unknown) => {
      if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'FS_TOO_LARGE') {
        throw new RemoteError('workspace-file/too-large', `"${path}" exceeds the ${limit} byte full-file cap`, { path, limit }, { cause })
      }
      throw cause
    })
    return { ...this.statOf(target, info), offset: 0, data, eof: true }
  }

  /**
   * Report one regular file's identity, version, and size without its content.
   * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
   * @param path - absolute path or path relative to the workspace root; files outside it are allowed.
   * @param signal - caller cancellation.
   * @returns the file's absolute path, current version, and byte size.
   */
  @Remote
  async stat(workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkspaceFileStat> {
    const user = await this.userFile(workspaceFileScope, path, signal)
    if (user !== undefined) return user.stat
    const { target, info } = await this.locateFile(workspaceFileScope, path, signal)
    return this.statOf(target, info)
  }

  /**
   * List the direct children of one directory inside the Session's workspace.
   * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
   * @param path - workspace path, absolute or relative to the workspace root.
   * @param signal - caller cancellation.
   * @returns the directory's children in the backend's stable name order, bounded by the entry cap.
   */
  @Remote
  async list(workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkspaceDirectoryListing> {
    const selected = this.fileScope(workspaceFileScope, path)
    if (selected.confined) return this.userListing(workspaceFileScope, path, signal)
    const { root, workspaceRoot, path: requested, entry } = await this.inspect(workspaceFileScope, path, signal)
    // A final link — a Windows junction or a symlink — is listed through the
    // directory it resolves to, matching the child type `listDir` reports for
    // that entry; `read` keeps its own no-follow gate on the final component.
    if (entry.type !== 'directory' && entry.type !== 'symlink') {
      throw new RemoteError(
        'workspace-file/not-directory',
        `"${path}" is a ${entry.type}`,
        { path, kind: entry.type },
      )
    }
    const target = await this.confine(root, workspaceRoot, requested, signal)
    if (entry.type === 'symlink') {
      const info = await this.ctx.fs.stat(target, signal)
      if (info?.type !== 'directory') {
        throw new RemoteError('workspace-file/not-directory', `"${path}" does not resolve to a directory`, { path, kind: 'symlink' })
      }
    }
    const children = await this.ctx.fs.listDir(target, signal)
    return {
      path: workspacePathOf(this.ctx.fs.fileUrl(root), this.ctx.fs.fileUrl(target)),
      entries: children.slice(0, this.config.maxEntries).map(directoryEntry),
      truncated: children.length > this.config.maxEntries,
    }
  }

  /**
   * Watch one file or a directory's direct entries in the Session's filesystem.
   * Owner file watches use backend read authority; user watches and directories remain workspace-scoped.
   * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
   * @param path - target path; the Host determines its type and confines user targets and directories.
   * @param signal - generation cancellation.
   * @returns `ready` once the target watch is active, then current metadata for queued and live invalidations.
   * @throws RemoteError when watching is unavailable or a directory is outside the workspace.
   */
  @Remote({ mode: 'stream' })
  changes(workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal): AsyncIterable<WorkspaceFileWatchFrame> {
    const scope = this.fileScope(workspaceFileScope, path)
    return this.feed.follow(scope.workspaceRoot, scope.path, signal, scope.confined,
      scope.confined ? () => this.userMetadata(workspaceFileScope, path, signal) : undefined)
  }

  private fileScope(scope: WorkspaceFileScope, path: string): { workspaceRoot: string; path: string; confined: boolean } {
    const invocation = this.ctx.invocation
    if (invocation?.peer.principal.kind !== 'user') return { workspaceRoot: scope.workspaceRoot, path, confined: false }
    const workspace = this.ctx.get('workspaceRegistry')?.findSession(scope.sessionId)
    if (workspace === undefined) {
      throw new RemoteError('remote-access/denied', 'Workspace files are unavailable.', {
        action: `workspaceFiles/${invocation.request.method}`, reason: 'not-found',
      })
    }
    const paths = workspace.path.startsWith('/') ? posix : win32
    const requested = path === '/workspace' || path.startsWith('/workspace/')
      ? paths.join(workspace.path, path.slice('/workspace'.length)) : path
    const absolute = paths.resolve(workspace.path, requested)
    const relative = paths.relative(workspace.path, absolute)
    if (relative === '..' || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) {
      throw new RemoteError('workspace-file/outside-workspace', 'Path is outside the workspace.', { path })
    }
    return { workspaceRoot: workspace.path, path: absolute, confined: true }
  }

  private async userFile(scope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<{
    data: Uint8Array<ArrayBuffer>
    stat: WorkspaceFileStat
  } | undefined> {
    const invocation = this.ctx.invocation
    if (invocation?.peer.principal.kind !== 'user') return undefined
    const selected = this.fileScope(scope, path)
    const paths = selected.workspaceRoot.startsWith('/') ? posix : win32
    const relative = paths.relative(selected.workspaceRoot, paths.resolve(selected.workspaceRoot, selected.path))
    const workspace = this.ctx.get('workspaceRegistry')?.findSession(scope.sessionId)
    const artifacts = this.ctx.get('workspaceArtifacts')
    if (workspace === undefined || artifacts === undefined) {
      throw new RemoteError('remote-access/denied', 'Workspace files are unavailable.', {
        action: `workspaceFiles/${invocation.request.method}`, reason: 'not-found',
      })
    }
    try {
      const stream = await artifacts.openDownload(workspace.id, relative.replaceAll('\\', '/'), signal, invocation.peer, this.config.maxFileBytes)
      let data: Uint8Array<ArrayBuffer>
      try { data = new Uint8Array(await new Response(stream.body).arrayBuffer()) }
      finally { await stream.settled }
      return { data, stat: { absolutePath: paths.resolve(selected.workspaceRoot, relative),
        version: createHash('sha256').update(data).digest('hex'), bytes: data.byteLength } }
    } catch (cause) {
      const failure = artifactFailure(cause, signal)
      if (failure.reason === 'too-large') throw new RemoteError('workspace-file/too-large', 'File is too large.', { path, limit: this.config.maxFileBytes }, { cause })
      if (failure.reason === 'invalid-path') throw new RemoteError('workspace-file/outside-workspace', 'File path is outside the workspace.', { path }, { cause })
      if (failure.reason === 'not-found' || failure.reason === 'not-regular') throw new RemoteError('workspace-file/not-found', 'File is unavailable.', { path }, { cause })
      if (failure.reason === 'denied') throw new RemoteError('remote-access/denied', 'Workspace files are unavailable.', {
        action: `workspaceFiles/${invocation.request.method}`, reason: 'not-found',
      }, { cause })
      if (failure.reason === 'cancelled') throw new RemoteError('gateway/cancelled', 'Workspace file read was cancelled.', {}, { cause })
      throw new RemoteError('gateway/internal', 'Workspace files are unavailable.', {}, { cause })
    }
  }

  private async userListing(scope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkspaceDirectoryListing> {
    const selected = this.fileScope(scope, path)
    const paths = selected.workspaceRoot.startsWith('/') ? posix : win32
    const relative = paths.relative(selected.workspaceRoot, paths.resolve(selected.workspaceRoot, selected.path))
    const workspace = this.ctx.get('workspaceRegistry')?.findSession(scope.sessionId)
    const artifacts = this.ctx.get('workspaceArtifacts')
    if (workspace === undefined || artifacts === undefined) {
      throw new RemoteError('remote-access/denied', 'Workspace files are unavailable.', { action: 'workspaceFiles/list', reason: 'not-found' })
    }
    const listing = await artifacts.list({ workspaceId: workspace.id }, relative.replaceAll('\\', '/'), signal)
    return { path: relative.replaceAll('\\', '/'), entries: listing.entries.slice(0, this.config.maxEntries).map(entry => ({
      name: entry.name, type: entry.kind, ...entry.bytes === undefined ? {} : { size: entry.bytes },
    })), truncated: listing.truncated || listing.entries.length > this.config.maxEntries }
  }

  private async userMetadata(scope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<{
    type: 'file' | 'directory'
    version: string
  } | undefined> {
    try {
      const file = await this.userFile(scope, path, signal)
      if (file !== undefined) return { type: 'file', version: file.stat.version }
    } catch (cause) {
      if (remoteErrorOf(cause)?.code !== 'workspace-file/not-found') throw cause
    }
    try {
      const listing = await this.userListing(scope, path, signal)
      return { type: 'directory', version: createHash('sha256').update(JSON.stringify(listing)).digest('hex') }
    } catch (cause) {
      const failure = remoteErrorOf(cause)
      if (failure?.code !== 'workspace-artifact/failed' || failure.details.reason !== 'not-found') throw cause
      return undefined
    }
  }

  private async relativePath(scope: WorkspaceFileScope, baseFile: string, path: string, signal: AbortSignal): Promise<string> {
    const relative = path.replace(/\\/g, '/')
    if (relative.length === 0 || relative.startsWith('/') || /^[a-z][a-z\d+.-]*:/iu.test(relative) || relative.includes(NUL)) {
      throw new RemoteError('gateway/bad-request', 'path must be relative when baseFile is provided', {})
    }
    const user = await this.userFile(scope, baseFile, signal)
    const absolute = user !== undefined ? user.stat.absolutePath
      : this.ctx.fs.processPath((await this.locateFile(scope, baseFile, signal)).target)
    const paths = absolute.startsWith('/') ? posix : win32
    return paths.resolve(paths.dirname(absolute), relative)
  }

  /** Apply the page defaults and caps here, so the request never carries them implicitly. */
  private resolvePage(range: WorkspaceFileRange): { offset: number; limit: number } {
    const offset = range.offset === undefined ? 1 : integerAtLeast(range.offset, 1, 'offset')
    const limit = range.limit === undefined ? this.config.maxLines : integerAtLeast(range.limit, 1, 'limit')
    if (limit > this.config.maxLines) {
      throw new RemoteError('gateway/bad-request', `limit must be at most ${this.config.maxLines}`, {})
    }
    return { offset, limit }
  }

  /** Apply the byte-window defaults and cap; a window above the cap is refused, not shortened. */
  private resolveWindow(range: WorkspaceByteRange, path: string): { offset: number; length: number } {
    const offset = range.offset === undefined ? 0 : integerAtLeast(range.offset, 0, 'offset')
    const length = range.length === undefined ? this.config.maxBytes : integerAtLeast(range.length, 1, 'length')
    if (offset + length > Number.MAX_SAFE_INTEGER) {
      throw new RemoteError('gateway/bad-request', 'offset plus length must stay a safe integer', {})
    }
    if (length > this.config.maxBytes) {
      throw new RemoteError(
        'workspace-file/too-large',
        `${length} bytes of "${path}" exceed the ${this.config.maxBytes} byte cap`,
        { path, limit: this.config.maxBytes },
      )
    }
    return { offset, length }
  }
  /** Inspect the final entry without following its symlink, after any user containment check. */
  private async inspect(
    workspaceFileScope: WorkspaceFileScope,
    path: string,
    signal: AbortSignal,
  ): Promise<{ root: FsTarget; workspaceRoot: string; path: string; confined: boolean; entry: FsPathInfo }> {
    if (path.length === 0) throw new RemoteError('gateway/bad-request', 'path is required', {})
    const { workspaceRoot, path: requested, confined } = this.fileScope(workspaceFileScope, path)
    const root = await this.ctx.fs.resolve(workspaceRoot, { signal })
    if (confined) await this.confine(root, workspaceRoot, requested, signal)
    const entry = await this.ctx.fs.lstat(requested, { cwd: workspaceRoot }, signal)
    if (entry === undefined) {
      throw new RemoteError('workspace-file/not-found', `no entry at "${path}"`, { path })
    }
    return { root, workspaceRoot, path: requested, confined, entry }
  }

  /** Resolve an inspected path and refuse it unless the workspace contains it. */
  private async confine(root: FsTarget, workspaceRoot: string, path: string, signal: AbortSignal): Promise<FsTarget> {
    const target = await this.ctx.fs.resolve(path, { cwd: workspaceRoot, signal })
    if (!this.ctx.fs.contains(root, target)) {
      throw new RemoteError('workspace-file/outside-workspace', `"${path}" is outside the workspace`, { path })
    }
    return target
  }

  /**
   * All gates for a regular file, ending in the one stat that names its version
   * and size. The stat re-checks what `lstat` saw: the file may have gone or
   * changed kind in between.
   */
  private async locateFile(
    workspaceFileScope: WorkspaceFileScope,
    path: string,
    signal: AbortSignal,
  ): Promise<{ target: FsTarget; info: FsInfo }> {
    const { root, workspaceRoot, path: requested, confined, entry } = await this.inspect(workspaceFileScope, path, signal)
    if (entry.type !== 'file') {
      throw new RemoteError('workspace-file/not-regular-file', `"${path}" is a ${entry.type}`, { path, kind: entry.type })
    }
    const target = confined ? await this.confine(root, workspaceRoot, requested, signal)
      : await this.ctx.fs.resolve(requested, { cwd: workspaceRoot, signal })
    const info = await this.ctx.fs.stat(target, signal)
    if (info === undefined) {
      throw new RemoteError('workspace-file/not-found', `no entry at "${path}"`, { path })
    }
    if (info.type !== 'file') {
      throw new RemoteError('workspace-file/not-regular-file', `"${path}" is a ${info.type}`, { path, kind: info.type })
    }
    return { target, info }
  }

  private statOf(target: FsTarget, info: FsInfo): WorkspaceFileStat {
    return {
      absolutePath: this.ctx.fs.processPath(target),
      version: info.version,
      ...info.size === undefined ? {} : { bytes: info.size },
    }
  }

  /** Stream the file as text and cut the page, classifying the backend's non-text refusal. */
  private async cutPage(target: FsTarget, offset: number, limit: number, signal: AbortSignal, path: string): Promise<Page> {
    try {
      return await cutPage(await this.ctx.fs.streamText(target, signal), offset, limit, this.config.maxBytes, path)
    } catch (error: unknown) {
      if (isNotTextRefusal(error)) {
        throw new RemoteError('workspace-file/not-text', `"${path}" is not UTF-8 text`, { path }, { cause: error })
      }
      throw error
    }
  }
}

/**
 * The backend's non-text refusal, recognized by its code alone: the error class
 * belongs to whichever `dsh-fs` instance the provider loaded, so no class
 * identity is shared across the package boundary.
 */
function isNotTextRefusal(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'FS_NOT_TEXT'
}

export default WorkspaceFiles
