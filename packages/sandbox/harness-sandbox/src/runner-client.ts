/** Local HTTP client for the Runner lifecycle protocol; never connects to Docker. */

import { request, type ClientRequest, type IncomingMessage } from 'node:http'
import { isAbsolute } from 'node:path'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { z } from 'zod'
import type { ResolvedConfig } from './config.ts'

/** Full container identity returned by the Runner, not a browser-supplied execution target. */
export type SandboxContainerId = Branded<'SandboxContainerId'>

const running = z.strictObject({
  state: z.literal('running'),
  containerId: z.string().regex(/^[a-f0-9]{64}$/u).transform(value => brandString<SandboxContainerId>(value)),
})
const closed = z.strictObject({ state: z.literal('closed') })
const status = z.union([running, closed, z.strictObject({ state: z.enum(['starting', 'closing', 'cleanup_required']) })])
const failure = z.strictObject({ error: z.string().min(1) })

/** Confirmed running sandbox, retaining the full container identity for trusted callers. */
export interface RunnerRunningSandbox {
  readonly state: 'running'
  readonly containerId: SandboxContainerId
}
/** Confirmed absence of the workspace container. */
export interface RunnerClosedSandbox {
  readonly state: 'closed'
}
/** This query's observation, never a cached or guessed state. */
export type RunnerSandboxStatus = RunnerRunningSandbox | RunnerClosedSandbox | { readonly state: 'starting' | 'closing' | 'cleanup_required' }

/** A complete Runner failure response. A server failure may follow partial effects. */
export class RunnerResponseError extends Error {
  /**
   * @param code - Runner error identifier, for classification rather than direct user display.
   * @param statusCode - HTTP failure status.
   * @param outcomeUnknown - Whether a modification may have taken effect before this server failure.
   */
  constructor(readonly code: string, readonly statusCode: number, readonly outcomeUnknown: boolean) {
    super(`Runner returned HTTP ${String(statusCode)} (${code})`)
    this.name = 'RunnerResponseError'
  }
}

/** Transport/protocol failure; unknown modifications must be queried rather than replayed. */
export class RunnerRequestError extends Error {
  /**
   * @param code - Unavailable observation, or a modification whose result cannot be confirmed.
   * @param cause - Connection, cancellation, deadline, or response-validation failure.
   */
  constructor(readonly code: 'runner_unavailable' | 'runner_outcome_unknown', cause: unknown) {
    super(code === 'runner_outcome_unknown' ? 'Runner operation outcome is unknown; query its status' : 'Runner is unavailable', { cause })
    this.name = 'RunnerRequestError'
  }
}

async function readResponse(response: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of response as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > limit) throw new Error('Runner response exceeds maxResponseBytes')
    chunks.push(chunk)
  }
  if (!response.complete) throw new Error('Incomplete Runner response')
  const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  return body
}

/** One deployment's transport, with no retries, state cache, or container ownership. */
export class RunnerClient {
  private readonly lifetime = new AbortController()

  /** @param config - Validated deployment settings, captured independently of the caller's object. */
  constructor(private readonly config: ResolvedConfig) {
    if (!isAbsolute(config.socketPath) || config.socketPath.includes('\0')) throw new Error('Runner socketPath must be an absolute local path')
    this.config = { ...config }
  }

  /**
   * Open or reuse a sandbox; an unconfirmed result never causes a retry or compensating close.
   * @param workspaceId - Runner-compatible trusted workspace identity.
   * @param workspaceDir - Existing persistent directory from the trusted workspace record.
   * @returns The confirmed running container.
   */
  open(workspaceId: WorkspaceId, workspaceDir: string): Promise<RunnerRunningSandbox> {
    return this.send('PUT', workspaceId, { workspaceDir }, running)
  }

  /**
   * Observe one workspace without opening or closing it.
   * @param workspaceId - Runner-compatible trusted workspace identity.
   * @returns One of the five validated Runner states.
   */
  status(workspaceId: WorkspaceId): Promise<RunnerSandboxStatus> {
    return this.send('GET', workspaceId, undefined, status)
  }

  /**
   * Close a sandbox only when the Runner confirms absence; never automatically replay this request.
   * @param workspaceId - Runner-compatible trusted workspace identity.
   * @returns Confirmed closure without deleting persistent files or sessions.
   */
  close(workspaceId: WorkspaceId): Promise<RunnerClosedSandbox> {
    return this.send('DELETE', workspaceId, undefined, closed)
  }

  /** Cancel current waits and reject future calls; does not send a Runner close request. */
  dispose(): void { this.lifetime.abort() }

  private async send<T>(method: 'PUT' | 'GET' | 'DELETE', workspaceId: WorkspaceId, input: object | undefined, schema: z.ZodType<T>): Promise<T> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(workspaceId)) throw new TypeError('Invalid Runner workspace ID')
    const body = input === undefined ? undefined : JSON.stringify(input)
    const deadline = new AbortController()
    const signal = AbortSignal.any([this.lifetime.signal, deadline.signal])
    const timer = setTimeout(() => { deadline.abort(new Error('Runner request deadline exceeded')) },
      method === 'GET' ? this.config.queryTimeoutMs : this.config.mutationTimeoutMs)
    timer.unref()
    let req: ClientRequest | undefined
    const connection = { established: false }
    const onConnect = () => { connection.established = true }
    try {
      signal.throwIfAborted()
      return await new Promise<T>((resolve, reject) => {
        req = request({
          socketPath: this.config.socketPath, method, path: `/v1/workspaces/${workspaceId}/sandbox`, agent: false, signal,
          ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }),
        }, (response) => {
          void readResponse(response, this.config.maxResponseBytes).then((value) => {
            const statusCode = response.statusCode ?? 0
            if (statusCode >= 400 && statusCode <= 599) {
              throw new RunnerResponseError(failure.parse(value).error, statusCode, method !== 'GET' && statusCode >= 500)
            }
            if (statusCode !== 200) throw new Error('Unexpected Runner success status')
            return schema.parse(value)
          }).then(resolve, reject)
        })
        req.once('socket', (socket) => {
          if (!socket.connecting) connection.established = true
          else socket.once('connect', onConnect)
        })
        req.once('error', reject)
        req.once('close', () => { req?.removeListener('error', reject) })
        req.end(body)
      })
    } catch (cause) {
      if (cause instanceof RunnerResponseError) throw cause
      throw new RunnerRequestError(method !== 'GET' && connection.established ? 'runner_outcome_unknown' : 'runner_unavailable', cause)
    } finally {
      clearTimeout(timer)
      req?.socket?.removeListener('connect', onConnect)
      req?.destroy()
    }
  }
}
