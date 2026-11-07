/** Authorized workspace-root uploads over a bounded streaming HTTP route. */
import { type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { WorkspaceFileAccess } from '@deepseek-ai/dsh-fs/workspace-access'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import type {} from '@deepseek-ai/dsh-api-workspace-controller'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { Remote, RemoteError, TypertRemoteService, type PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { storeWorkspaceUpload, UploadFailure, validateUploadName } from './storage.ts'
import type { WorkspaceUploadLimits, WorkspaceUploadResult, WorkspaceUploadScope } from './types.ts'

export type * from './types.ts'

/** Per-file streamed intake limit. */
export interface Config {
  /** Inclusive maximum size of one uploaded file; uploads are never truncated. */
  readonly maxBytes?: number
  /** Explicit file provider; provided refuses startup when no remote provider is loaded. */
  readonly storage?: 'local' | 'provided'
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Authorized workspace upload limits and streaming route owner. */
    workspaceUpload: WorkspaceUpload
  }
}

/** Host upload provider; resources belong to the operation and survive its cancellation cleanup. */
export class WorkspaceUpload extends TypertRemoteService {
  static inject = ['connection', 'remoteAccess', 'typert', 'workspaceRegistry', 'workspaceController']
  static Config = z.object({
    storage: z.union([z.const('local'), z.const('provided')]).default('local'),
    maxBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(32 * 1024 * 1024),
  })

  private readonly maxBytes: number
  private readonly storage: WorkspaceFileAccess | undefined
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<Response>>()

  /**
   * @param ctx - Host with authenticated Connection and authoritative workspaces.
   * @param config - validated per-file byte limit.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'workspaceUpload')
    if (process.platform !== 'linux') throw new Error('workspace upload requires Linux descriptor paths')
    const settings = WorkspaceUpload.Config(config)
    this.maxBytes = settings.maxBytes
    this.storage = settings.storage === 'provided' ? ctx.get('workspaceFileAccess') : undefined
    if (settings.storage === 'provided' && this.storage === undefined) throw new Error('Provided workspace file access did not load')
    ctx.effect(() => ctx.connection.fetch.register({
      path: '/api/workspace/uploadFileBinary',
      methods: ['POST'],
      requestBody: 'streaming',
      authorize: (request, peer) => this.authorized(request, peer),
      fetch: (request, peer) => {
        if (this.lifetime.signal.aborted) return Promise.resolve(new Response(null, { status: 503 }))
        const operation = this.receive(request, peer)
        this.operations.add(operation)
        const settled = (): void => { this.operations.delete(operation) }
        void operation.then(settled, settled)
        return operation
      },
    }), 'workspace upload: streaming route')
    ctx.effect(() => async () => {
      this.lifetime.abort()
      await Promise.allSettled([...this.operations])
    }, 'workspace upload: cancel and settle intake')
  }

  /**
   * Read the deployment byte limit for an authorized workspace.
   * @param request - workspace identity from the caller.
   * @param signal - caller cancellation, including browser provider withdrawal.
   * @returns inclusive per-file byte limit without exposing a host path.
   */
  @Remote
  limits(request: WorkspaceUploadScope, signal: AbortSignal): WorkspaceUploadLimits {
    signal.throwIfAborted()
    if (this.ctx.workspaceRegistry.get(request.workspaceId) === undefined) {
      throw new RemoteError('workspace/not-found', 'Workspace not found', { workspaceId: request.workspaceId })
    }
    return { maxBytes: this.maxBytes }
  }

  private workspaceId(request: Request): WorkspaceId | undefined {
    const query = new URL(request.url).searchParams
    const value = query.get('workspaceId')
    return value === null || value === '' || query.getAll('workspaceId').length !== 1
      ? undefined : brandString<WorkspaceId>(value)
  }

  private authorized(request: Request, peer: PeerScope): boolean {
    const workspaceId = this.workspaceId(request)
    return !this.lifetime.signal.aborted && !peer.signal.aborted && workspaceId !== undefined
      && this.ctx.remoteAccess.decide({
        principal: peer.principal,
        action: 'workspaceUpload/upload',
        resources: [{ kind: 'workspace', id: workspaceId }],
      }).kind === 'allow'
  }

  private async receive(request: Request, peer: PeerScope): Promise<Response> {
    const signal = AbortSignal.any([request.signal, peer.signal, this.lifetime.signal])
    let result: WorkspaceUploadResult
    let status = 200
    try {
      const workspaceId = this.workspaceId(request)
      if (workspaceId === undefined || !this.authorized(request, peer)) throw new UploadFailure('denied')
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/octet-stream') {
        throw new UploadFailure('invalid-request')
      }
      const query = new URL(request.url).searchParams
      const name = query.get('name')
      if (name === null || query.getAll('name').length !== 1) throw new UploadFailure('invalid-name')
      validateUploadName(name)
      const declared = request.headers.get('content-length')
      if (declared !== null && (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared)))) {
        throw new UploadFailure('invalid-request')
      }
      if (declared !== null && Number(declared) > this.maxBytes) throw new UploadFailure('too-large')
      const workspace = this.ctx.workspaceRegistry.get(workspaceId)
      if (workspace === undefined) throw new UploadFailure('unavailable')
      const admit = (): void => {
        signal.throwIfAborted()
        if (!this.authorized(request, peer) || this.ctx.workspaceRegistry.get(workspaceId) !== workspace) throw new UploadFailure('denied')
      }
      const chunks = bodyChunks(request.body, signal)
      const value = this.storage === undefined
        ? await storeWorkspaceUpload(workspace.path, name, chunks, this.maxBytes, signal, admit)
        : await this.storage.upload({ workspaceId, project: workspace.path, signal, admit }, name, chunks, this.maxBytes)
      result = { ok: true, value }
    } catch (cause) {
      const error = cause instanceof UploadFailure ? cause : new UploadFailure(
        signal.aborted ? 'cancelled' : 'io', false, { cause },
      )
      result = { ok: false, error: { reason: error.reason, stored: error.stored } }
      status = error.reason === 'too-large' ? 413 : error.reason === 'denied' ? 403
        : error.reason === 'exists' ? 409 : error.reason === 'unavailable' ? 404
          : error.reason === 'io' || error.reason === 'cleanup' || error.reason === 'unknown' ? 500 : 400
      if (error.reason === 'io' || error.reason === 'cleanup') {
        this.ctx.logger.warn('workspace upload failed (' + error.reason + ', stored=' + String(error.stored) + ')', error)
      }
    }
    return Response.json(result, { status, headers: { 'cache-control': 'no-store' } })
  }
}

async function* bodyChunks(body: ReadableStream<Uint8Array> | null, signal: AbortSignal): AsyncIterable<Uint8Array> {
  if (body === null) return
  const reader = body.getReader()
  let cancellation: Promise<void> | undefined
  const abort = (): void => { cancellation = reader.cancel(signal.reason) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const item = await reader.read()
      if (item.done) return
      yield item.value
    }
  } finally {
    signal.removeEventListener('abort', abort)
    try {
      await cancellation
    } finally {
      reader.releaseLock()
    }
  }
}

export default WorkspaceUpload
