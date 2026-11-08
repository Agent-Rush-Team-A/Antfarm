/** Authorized workspace listings and descriptor-pinned binary downloads. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { WorkspaceFileAccess, WorkspaceFileDownload } from '@deepseek-ai/dsh-fs/workspace-access'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import type {} from '@deepseek-ai/dsh-api-workspace-controller'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { Remote, RemoteError, TypertRemoteService, type PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { ArtifactFailure, artifactComponents, artifactFailure, listArtifacts, openArtifact, streamArtifact } from './storage.ts'
import type { WorkspaceArtifactListing, WorkspaceArtifactScope } from './types.ts'

export type * from './types.ts'

/** Limits for bounded listing metadata and complete browser downloads. */
export interface Config {
  /** Explicit file provider; provided refuses startup when no remote provider is loaded. */
  readonly storage?: 'local' | 'provided'
  /** Maximum directory entries inspected per request, including omitted entries. */
  readonly maxEntries?: number
  /** Inclusive byte cap for one download; larger files are refused. */
  readonly maxDownloadBytes?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Read-only files retained in registered workspaces, independent of sandbox lifetime. */
    workspaceArtifacts: WorkspaceArtifacts
  }
}

/** Optional Linux file provider; teardown cancels and awaits open requests and bodies. */
export class WorkspaceArtifacts extends TypertRemoteService {
  static inject = ['connection', 'remoteAccess', 'typert', 'workspaceRegistry', 'workspaceController']
  static Config = z.object({
    storage: z.union([z.const('local'), z.const('provided')]).default('local'),
    maxEntries: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(2000),
    maxDownloadBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(32 * 1024 * 1024),
  })

  private readonly config: Required<Config>
  private readonly storage: WorkspaceFileAccess | undefined
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()

  /**
   * @param ctx - authoritative workspaces and authenticated Connection.
   * @param config - deployment limits.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'workspaceArtifacts')
    if (process.platform !== 'linux') throw new Error('workspace artifacts require Linux descriptor paths')
    this.config = WorkspaceArtifacts.Config(config)
    this.storage = this.config.storage === 'provided' ? ctx.get('workspaceFileAccess') : undefined
    if (this.config.storage === 'provided' && this.storage === undefined) throw new Error('Provided workspace file access did not load')
    ctx.effect(() => ctx.connection.fetch.register({
      path: '/api/workspace/downloadFileBinary', methods: ['GET'], requestBody: 'buffered',
      authorize: (request, peer) => this.authorized(this.workspaceId(request), peer, 'download'),
      fetch: (request, peer) => this.track(this.download(request, peer)),
    }), 'workspace artifacts: authenticated download route')
    ctx.effect(() => async () => {
      this.lifetime.abort()
      while (this.operations.size > 0) await Promise.allSettled([...this.operations])
    }, 'workspace artifacts: cancel requests and close files')
  }

  /**
   * List one authorized directory without revealing Host paths or starting a sandbox.
   * @param request - registered workspace identity.
   * @param path - slash-separated relative directory; empty names the root.
   * @param signal - caller lifetime, combined with provider withdrawal.
   * @returns bounded file metadata and the configured download cap.
   */
  @Remote
  async list(request: WorkspaceArtifactScope, path: string, signal: AbortSignal): Promise<WorkspaceArtifactListing> {
    const peer = this.ctx.invocation?.peer
    const lifetime = AbortSignal.any([signal, this.lifetime.signal, ...peer === undefined ? [] : [peer.signal]])
    return this.track((async () => {
      try {
        lifetime.throwIfAborted()
        if (peer !== undefined && !this.authorized(request.workspaceId, peer, 'list')) throw new ArtifactFailure('denied')
        artifactComponents(path)
        const workspace = this.ctx.workspaceRegistry.get(request.workspaceId)
        if (workspace === undefined) throw new ArtifactFailure('not-found')
        const admit = (): void => {
          lifetime.throwIfAborted()
          if (peer !== undefined && !this.authorized(request.workspaceId, peer, 'list')) throw new ArtifactFailure('denied')
          if (this.ctx.workspaceRegistry.get(request.workspaceId) !== workspace) throw new ArtifactFailure('not-found')
        }
        const listing = this.storage === undefined
          ? await listArtifacts(workspace.path, path, this.config.maxEntries, lifetime)
          : await this.storage.list({ workspaceId: request.workspaceId, project: workspace.path, signal: lifetime,
            admit }, path, this.config.maxEntries)
        lifetime.throwIfAborted()
        if (peer !== undefined && !this.authorized(request.workspaceId, peer, 'list')) throw new ArtifactFailure('denied')
        if (this.ctx.workspaceRegistry.get(request.workspaceId) !== workspace) throw new ArtifactFailure('not-found')
        return { path, ...listing, maxDownloadBytes: this.config.maxDownloadBytes }
      } catch (cause) {
        const failure = artifactFailure(cause, lifetime)
        if (failure.reason === 'io') this.ctx.logger.warn('workspace artifact listing failed', failure)
        throw new RemoteError('workspace-artifact/failed', 'Workspace files are unavailable',
          { reason: failure.reason }, { cause: failure })
      }
    })())
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    const settled = (): void => { this.operations.delete(operation) }
    void operation.then(settled, settled)
    return operation
  }

  private workspaceId(request: Request): WorkspaceId | undefined {
    const query = new URL(request.url).searchParams
    const id = query.get('workspaceId')
    return id === null || id === '' || query.getAll('workspaceId').length !== 1 ? undefined : brandString<WorkspaceId>(id)
  }

  private authorized(workspaceId: WorkspaceId | undefined, peer: PeerScope, action: 'list' | 'download'): boolean {
    return !this.lifetime.signal.aborted && !peer.signal.aborted && workspaceId !== undefined
      && this.ctx.remoteAccess.decide({ principal: peer.principal, action: `workspaceArtifacts/${action}`,
        resources: [{ kind: 'workspace', id: workspaceId }],
      }).kind === 'allow'
  }

  /**
   * Open an authorized stream shared by HTTP downloads and file previews.
   * @param workspaceId - registered workspace identity.
   * @param path - relative file path without traversal or symlinks.
   * @param signal - consumer cancellation.
   * @param peer - authenticated caller captured by Connection or Gateway.
   * @param maxBytes - consumer cap, further limited by the deployment download cap.
   * @returns the initial file extent and a body retaining its descriptor through settlement.
   * @throws ArtifactFailure for denied, invalid, missing, non-regular or oversized files.
   */
  async openDownload(
    workspaceId: WorkspaceId, path: string, signal: AbortSignal, peer: PeerScope, maxBytes: number,
  ): Promise<WorkspaceFileDownload> {
    signal = AbortSignal.any([signal, peer.signal, this.lifetime.signal])
    const limit = Math.min(maxBytes, this.config.maxDownloadBytes)
    return this.track((async () => {
      signal.throwIfAborted()
      if (!this.authorized(workspaceId, peer, 'download')) throw new ArtifactFailure('denied')
      artifactComponents(path)
      const workspace = this.ctx.workspaceRegistry.get(workspaceId)
      if (workspace === undefined) throw new ArtifactFailure('not-found')
      const admit = (): void => {
        signal.throwIfAborted()
        if (!this.authorized(workspaceId, peer, 'download')
          || this.ctx.workspaceRegistry.get(workspaceId) !== workspace) throw new ArtifactFailure('denied')
      }
      const stream = await (async () => {
        if (this.storage !== undefined) return this.storage.download(
          { workspaceId, project: workspace.path, signal, admit }, path, limit,
        )
        const file = await openArtifact(workspace.path, path, false, signal)
        let bytes: number
        try {
          bytes = (await file.stat()).size
          admit()
          if (bytes > limit) throw new ArtifactFailure('too-large')
        } catch (cause) { await file.close(); throw cause }
        return { bytes, ...streamArtifact(file, bytes, signal, admit) }
      })()
      void this.track(stream.settled).catch((cause: unknown) => { this.ctx.logger.warn('workspace download descriptor cleanup failed', cause) })
      return stream
    })())
  }

  private async download(request: Request, peer: PeerScope): Promise<Response> {
    const signal = AbortSignal.any([request.signal, peer.signal, this.lifetime.signal])
    try {
      signal.throwIfAborted()
      const workspaceId = this.workspaceId(request)
      if (!this.authorized(workspaceId, peer, 'download') || workspaceId === undefined) throw new ArtifactFailure('denied')
      const query = new URL(request.url).searchParams
      const path = query.get('path')
      if (path === null || query.getAll('path').length !== 1) throw new ArtifactFailure('invalid-path')
      const stream = await this.openDownload(workspaceId, path, signal, peer, this.config.maxDownloadBytes)
      const { bytes } = stream
      const name = encodeURIComponent(path.slice(path.lastIndexOf('/') + 1))
        .replace(/[!'()*]/gu, character => '%' + character.charCodeAt(0).toString(16))
      return new Response(stream.body, { headers: {
        'content-type': 'application/octet-stream', 'content-length': String(bytes),
        'content-disposition': "attachment; filename=\"download\"; filename*=UTF-8''" + name,
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      } })
    } catch (cause) {
      const failure = artifactFailure(cause, signal)
      if (failure.reason === 'io') this.ctx.logger.warn('workspace download failed', failure)
      const status = failure.reason === 'denied' ? 403 : failure.reason === 'not-found' ? 404
        : failure.reason === 'too-large' ? 413 : failure.reason === 'io' ? 500 : 400
      return Response.json({ ok: false, error: { reason: failure.reason } }, { status, headers: { 'cache-control': 'no-store' } })
    }
  }
}

export default WorkspaceArtifacts
