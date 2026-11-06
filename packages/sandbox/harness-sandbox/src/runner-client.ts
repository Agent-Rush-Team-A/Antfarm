/** Local HTTP client for Runner lifecycle and execution; never connects to Docker. */

import { request, type ClientRequest, type IncomingMessage } from 'node:http'
import { isAbsolute } from 'node:path'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { z } from 'zod'
import type { ResolvedConfig } from './config.ts'
import { cancellationResult, executionFailure, executionFailureCode, executionIdentity, executionRequest, executionResult } from './execution.ts'
import type { RunnerCancellationResult, RunnerExecutionFailure, RunnerExecutionFailureCode, RunnerExecutionIdentity, RunnerExecutionRequest, RunnerExecutionResult } from './execution.ts'

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
   * @param options - Original provider cause, retained for diagnostics rather than user display.
   */
  constructor(readonly code: string, readonly statusCode: number, readonly outcomeUnknown: boolean, options?: ErrorOptions) {
    super(`Runner returned HTTP ${String(statusCode)} (${code})`, options)
    this.name = 'RunnerResponseError'
  }
}

/** A validated execution failure, retaining the original identity, reason and cleanup evidence. */
export class RunnerExecutionError extends RunnerResponseError {
  /**
   * @param code - Original Runner execution failure code.
   * @param statusCode - Validated HTTP status for this failure.
   * @param execution - Confirmed response fields; absent Bash status remains unknown.
   * @param options - Original provider cause, when the failure originated before a validated response.
   */
  constructor(code: RunnerExecutionFailureCode, statusCode: number, readonly execution: RunnerExecutionFailure, options?: ErrorOptions) {
    super(code, statusCode, code === 'execution_outcome_unknown' || code === 'execution_container_recycled', options)
    this.name = 'RunnerExecutionError'
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
    if (size > limit) throw new Error('Runner response exceeds the configured byte limit')
    chunks.push(chunk)
  }
  if (!response.complete) throw new Error('Incomplete Runner response')
  const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  return body
}

interface RunnerHttpRequest<T> {
  readonly method: 'PUT' | 'GET' | 'DELETE' | 'POST'
  readonly suffix: string
  readonly body: string | undefined
  readonly timeoutMs: number
  readonly maxResponseBytes: number
  readonly signal?: AbortSignal
  readonly parse: (value: unknown, statusCode: number) => T
}

/** One deployment's transport, with no retries, state cache, or container ownership. */
export class RunnerClient {
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()

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

  /**
   * Submit or retrieve exactly the caller's saved request; never retry or choose a new generation.
   * @param workspaceId - Trusted workspace identity.
   * @param input - Complete original request, including resolved workdir and command timeout.
   * @param signal - Optional local wait cancellation; omission uses only service lifetime and deadline.
   * @returns The validated result; disconnect or cancellation does not stop the remote command.
   */
  async execute(workspaceId: WorkspaceId, input: RunnerExecutionRequest, signal?: AbortSignal): Promise<RunnerExecutionResult> {
    const saved = executionRequest.parse(input)
    const body = JSON.stringify(saved)
    if (Buffer.byteLength(body) > 64 * 1024) throw new TypeError('Runner exec request exceeds 64 KiB')
    return this.exchange(workspaceId, {
      method: 'POST', suffix: '/exec', body, ...signal === undefined ? {} : { signal },
      timeoutMs: this.config.execTimeoutMs, maxResponseBytes: this.config.maxExecResponseBytes,
      parse: (value, statusCode) => {
        if (statusCode >= 400 && statusCode <= 599) {
          const { error: code } = z.object({ error: z.string().min(1) }).parse(value)
          if (executionFailureCode.safeParse(code).success) {
            const { error, ...execution } = executionFailure.parse(value)
            if (execution.executionId !== saved.executionId || execution.containerId !== saved.expectedContainerId) {
              throw new Error('Runner execution failure identity mismatch')
            }
            const expectedStatus = error === 'execution_timeout' ? 504 : error === 'execution_cancelled' ? 409 : 503
            if (statusCode !== expectedStatus) throw new Error('Unexpected Runner execution failure status')
            throw new RunnerExecutionError(error, statusCode, execution)
          }
          throw new RunnerResponseError(failure.parse(value).error, statusCode, statusCode >= 500)
        }
        if (statusCode !== 200) throw new Error('Unexpected Runner exec success status')
        const result = executionResult.parse(value)
        if (result.executionId !== saved.executionId) throw new Error('Runner execution result identity mismatch')
        return result
      },
    })
  }

  /**
   * Request cancellation of an existing execution using an independent bounded connection.
   * @param workspaceId - Trusted workspace identity.
   * @param input - Original execution and full container identity; no command is sent.
   * @returns Acceptance or prior settlement; neither confirms cleanup or changes the original result.
   */
  async cancel(workspaceId: WorkspaceId, input: RunnerExecutionIdentity): Promise<RunnerCancellationResult> {
    const saved = executionIdentity.parse(input)
    return this.exchange(workspaceId, {
      method: 'POST', suffix: '/exec/cancel', body: JSON.stringify(saved),
      timeoutMs: this.config.cancelTimeoutMs, maxResponseBytes: this.config.maxResponseBytes,
      parse: (value, statusCode) => {
        if (statusCode >= 400 && statusCode <= 599) throw new RunnerResponseError(failure.parse(value).error, statusCode, statusCode >= 500)
        const result = cancellationResult.parse(value)
        if (statusCode !== (result.cancellation === 'requested' ? 202 : 200)) throw new Error('Unexpected Runner cancellation status')
        if (result.executionId !== saved.executionId || result.containerId !== saved.expectedContainerId) {
          throw new Error('Runner cancellation identity mismatch')
        }
        return result
      },
    })
  }

  /**
   * Abort local waits and reject future calls without cancelling commands or closing sandboxes.
   * @returns Completion after admitted requests release their connections and deadline timers.
   */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled(this.pending)
  }

  private send<T>(method: 'PUT' | 'GET' | 'DELETE', workspaceId: WorkspaceId, input: object | undefined, schema: z.ZodType<T>): Promise<T> {
    return this.exchange(workspaceId, {
      method, suffix: '', body: input === undefined ? undefined : JSON.stringify(input),
      timeoutMs: method === 'GET' ? this.config.queryTimeoutMs : this.config.mutationTimeoutMs,
      maxResponseBytes: this.config.maxResponseBytes,
      parse: (value, statusCode) => {
        if (statusCode >= 400 && statusCode <= 599) throw new RunnerResponseError(failure.parse(value).error, statusCode, method !== 'GET' && statusCode >= 500)
        if (statusCode !== 200) throw new Error('Unexpected Runner success status')
        return schema.parse(value)
      },
    })
  }

  private exchange<T>(workspaceId: WorkspaceId, operation: RunnerHttpRequest<T>): Promise<T> {
    const pending = this.request(workspaceId, operation)
    this.pending.add(pending)
    return pending.finally(() => { this.pending.delete(pending) })
  }

  private async request<T>(workspaceId: WorkspaceId, operation: RunnerHttpRequest<T>): Promise<T> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(workspaceId)) throw new TypeError('Invalid Runner workspace ID')
    const { method, body } = operation
    const deadline = new AbortController()
    const signal = AbortSignal.any([this.lifetime.signal, deadline.signal, ...operation.signal ? [operation.signal] : []])
    const timer = setTimeout(() => { deadline.abort(new Error('Runner request deadline exceeded')) }, operation.timeoutMs)
    timer.unref()
    let req: ClientRequest | undefined
    const connection = { established: false }
    const onConnect = () => { connection.established = true }
    try {
      signal.throwIfAborted()
      return await new Promise<T>((resolve, reject) => {
        req = request({
          socketPath: this.config.socketPath, method, path: `/v1/workspaces/${workspaceId}/sandbox${operation.suffix}`, agent: false, signal,
          ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }),
        }, (response) => {
          void readResponse(response, operation.maxResponseBytes)
            .then(value => operation.parse(value, response.statusCode ?? 0)).then(resolve, reject)
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
