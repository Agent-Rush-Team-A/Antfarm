/**
 * Docker Engine operations for the independent workspace sandbox runner.
 */

import { request, type IncomingMessage } from 'node:http'
import { addAbortSignal, type Duplex } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { deploymentLabel, type resolveCreateRequest, type ResolvedConfig } from './config.ts'
import type { SandboxExecutionId } from './index.ts'
import { encodeCancel, encodeRun, executionIdSchema, SupervisorProtocol, SupervisorProtocolError } from './protocol.ts'
import type { SupervisorCancelReason, SupervisorFinished, SupervisorResult } from './protocol.ts'

/** Full, 64-character Docker container ID. */
export type DockerContainerId = Branded<'DockerContainerId'>

/** Full Docker ID of a single execution. */
export type DockerExecId = Branded<'DockerExecId'>

/** Retained tail and truncation flag for one Docker output stream. */
export interface DockerExecOutput {
  readonly text: string
  readonly truncated: boolean
}

/** Cleanup-confirmed command exit and bounded user output. */
export interface DockerExecResult {
  readonly exitCode: number
  readonly stdout: DockerExecOutput
  readonly stderr: DockerExecOutput
}

/** One command's identity, original deadline and admission check. */
export interface DockerExecRequest {
  readonly executionId: SandboxExecutionId
  readonly argv: readonly string[]
  /** Absolute monotonic command deadline, in performance.now() milliseconds. */
  readonly expiresAt: number
  /** Recheck the execution immediately before dispatching the single Exec Start. */
  readonly beforeStart: () => void
  /** Recheck the captured execution and container after ready, before run.
   * @param signal - Transport deadline; aborts any unfinished check when the operation settles.
   * @returns When the original generation is still executable.
   */
  readonly beforeRun: (signal: AbortSignal) => Promise<void>
  /** Observe run admission when supplied; omitting it does not change protocol handling. */
  readonly onRun?: () => void
  /** Observe validated finished before EOF/Inspect when supplied; omitting it leaves protocol handling unchanged.
   * @param finished - A reported result that still requires EOF and Inspect confirmation.
   */
  readonly onFinished?: (finished: SupervisorFinished) => void
}

/** A dedicated control connection and its cleanup-confirmed result. */
export interface DockerExecSession {
  readonly result: Promise<SupervisorResult>
  /** Request cancellation once without closing the result stream.
   * @param reason - First requested cancellation reason; subsequent requests do not replace it.
   */
  cancel(reason: SupervisorCancelReason): void
  /** Close a connection whose entire container generation is being removed. */
  interrupt(): void
}

const apiVersion = '/v1.51'
const fullId = z.string().regex(/^[a-f0-9]{64}$/u)

/** Validate the full container ID at HTTP and Engine boundaries. */
export const dockerContainerIdSchema = fullId.transform(value => brandString<DockerContainerId>(value))

const idResponse = z.object({ Id: dockerContainerIdSchema })
const execId = fullId.transform(value => brandString<DockerExecId>(value))
const execIdResponse = z.object({ Id: execId })
const execInspection = z.object({ ID: execId, ContainerID: dockerContainerIdSchema, Running: z.boolean(), ExitCode: z.int().nullable() })
const inspection = idResponse.extend({
  Name: z.string(),
  State: z.object({ Running: z.boolean(), Paused: z.boolean() }),
  Config: z.object({ Labels: z.record(z.string(), z.string()).nullable() }),
  Mounts: z.array(z.object({ Type: z.string(), Source: z.string(), Destination: z.string(), RW: z.boolean() })),
})

/** Container identity, observed running state, ownership labels and mounts. */
export type SandboxContainer = z.output<typeof inspection>

/** A request failure whose effects must not be inferred from a missing reply. */
export class DockerRequestError extends Error {
  /**
   * @param operation - HTTP method and Docker endpoint.
   * @param kind - Failed exchange, rejected HTTP status, or invalid success reply.
   * @param details - Observed HTTP status or underlying error.
   */
  constructor(
    readonly operation: string,
    readonly kind: 'transport' | 'engine' | 'invalid_response',
    readonly details: { status?: number | undefined; cause?: unknown; diagnostics?: string },
  ) {
    super(`Docker ${operation}: ${details.status === undefined ? kind : `HTTP ${details.status}`}`, { cause: details.cause })
    this.name = 'DockerRequestError'
  }
}

async function readResponse(response: IncomingMessage) {
  response.setEncoding('utf8')
  let body = ''
  for await (const chunk of response) body += String(chunk)
  return { status: response.statusCode, body }
}

function decode<T>(schema: z.ZodType<T>, body: string, operation: string): T {
  try {
    const value: unknown = JSON.parse(body)
    return schema.parse(value)
  } catch (cause) {
    throw new DockerRequestError(operation, 'invalid_response', { cause })
  }
}

function containerPath(id: DockerContainerId): string {
  return `/containers/${fullId.parse(id)}`
}

function jsonHeaders(body: string) {
  return { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
}

/** Send workspace sandbox operations to a local Engine using API v1.51. */
export class DockerEngine {
  /**
   * @param config - Trusted deployment settings.
   * @param cancellation - Optional cancellation in addition to each request's deadline.
   */
  constructor(private readonly config: ResolvedConfig, private readonly cancellation?: AbortSignal) {
    if (config.termGraceMs >= config.cleanupTimeoutMs) throw new Error('termGraceMs must be smaller than cleanupTimeoutMs')
  }

  /** Create without starting the sandbox. The Engine must already have the pinned image.
   * @param spec - Create request with a validated bind source.
   * @returns The full ID reported by Docker.
   */
  async create(spec: Awaited<ReturnType<typeof resolveCreateRequest>>): Promise<DockerContainerId> {
    const result = await this.send('POST', `/containers/create?name=${spec.name}`, [201], JSON.stringify(spec.body))
    return decode(idResponse, result.body, 'create container').Id
  }

  /** Start one exact container. An already started container also succeeds.
   * @param id - Full Docker container ID.
   */
  async start(id: DockerContainerId): Promise<void> {
    await this.send('POST', `${containerPath(id)}/start`, [204, 304])
  }

  /** Register the immutable image supervisor. No user command or supervisor starts here.
   * @param id - Full ID of the container selected by the Runner.
   * @param executionId - Execution identity bound to this supervisor's control channel.
   * @param deadline - Signal for the execution's remaining wait budget.
   * @returns The full exec ID reported by Docker.
   */
  async createExec(id: DockerContainerId, executionId: SandboxExecutionId, deadline: AbortSignal): Promise<DockerExecId> {
    const path = `${containerPath(id)}/exec`
    executionIdSchema.parse(executionId)
    const body = JSON.stringify({
      Cmd: [
        '/usr/local/bin/python3', '-I', '-B', '/opt/agentrush/sandbox-runner/supervisor.py',
        `--execution-id=${executionId}`, '--run-wait-ms', String(this.config.requestTimeoutMs),
        '--cleanup-timeout-ms', String(this.config.cleanupTimeoutMs), '--term-grace-ms', String(this.config.termGraceMs),
      ],
      WorkingDir: '/workspace', AttachStdin: true, AttachStdout: true, AttachStderr: true,
      Tty: false, Privileged: false,
    })
    const result = await this.send('POST', path, [201], body, deadline)
    return decode(execIdResponse, result.body, `POST ${path}`).Id
  }

  /** Start one supervisor, recheck admission after ready, and send at most one run and one cancel.
   * Completion requires finished, stream EOF and Inspect confirming supervisor exit zero.
   * Cancellation keeps reading until cleanup confirmation or the independent cleanup deadline.
   * @param id - Full ID of the exec returned by Create.
   * @param container - Full ID of the container used to create the exec.
   * @param spec - Original command deadline, normalized argv and captured generation check.
   * @returns Per-execution cancellation and a result that preserves the original Bash status.
   */
  startExec(id: DockerExecId, container: DockerContainerId, spec: DockerExecRequest): DockerExecSession {
    const path = `/exec/${fullId.parse(id)}`
    const operation = `POST ${path}/start`
    const body = JSON.stringify({ Detach: false, Tty: false })
    const lifetime = new AbortController()
    const { signal } = lifetime
    let settled = false
    let failure: unknown
    let socket: Duplex | undefined
    let pendingCheck: Promise<void> | undefined
    let cancellation: { reason: SupervisorCancelReason; sent: boolean } | undefined
    let ready = false
    let until = spec.expiresAt + this.config.cleanupTimeoutMs
    let timer: ReturnType<typeof setTimeout> | undefined
    let readyTimer: ReturnType<typeof setTimeout> | undefined
    const fail = (cause: unknown) => {
      if (settled || signal.aborted) return
      failure = cause
      lifetime.abort(cause)
    }
    const bound = (deadline: number) => {
      until = Math.min(until, deadline)
      clearTimeout(timer)
      timer = setTimeout(() => { fail(new Error('Supervisor cleanup or confirmation deadline elapsed')) }, Math.max(0, Math.ceil(until - performance.now())))
      timer.unref()
    }
    const protocol = new SupervisorProtocol(spec.executionId, () => {
      ready = true
      clearTimeout(readyTimer)
      if (cancellation) sendCancel()
      else pendingCheck = prepare().catch(fail)
    }, (finished) => {
      bound(performance.now() + this.config.cleanupTimeoutMs)
      spec.onFinished?.(finished)
    })
    const sendCancel = () => {
      if (!socket || !ready || !cancellation || cancellation.sent || protocol.isFinished) return
      protocol.cancelSent()
      cancellation.sent = true
      socket.write(encodeCancel(spec.executionId, cancellation.reason))
    }
    const cancel = (reason: SupervisorCancelReason) => {
      if (settled || signal.aborted || cancellation || protocol.isFinished) return
      cancellation = { reason, sent: false }
      bound(performance.now() + this.config.cleanupTimeoutMs)
      try { sendCancel() } catch (cause) { fail(cause) }
    }
    const prepare = async () => {
      await spec.beforeRun(signal)
      if (settled || signal.aborted || !protocol.canRun) return
      const remaining = Math.floor(spec.expiresAt - performance.now())
      if (remaining < 1) { cancel('timeout'); return }
      const run = encodeRun(spec.executionId, spec.argv, remaining)
      protocol.runSent()
      spec.onRun?.()
      // The queue contains at most one bounded run and one cancel; drain must not block control or reads.
      socket?.write(run)
    }
    const stop = () => { fail(this.cancellation?.reason) }
    this.cancellation?.addEventListener('abort', stop, { once: true })
    const result = (async (): Promise<SupervisorResult> => {
      try {
        encodeRun(spec.executionId, spec.argv, 60_000)
        const remaining = spec.expiresAt - performance.now()
        if (remaining <= 0) throw new Error('Command deadline elapsed before supervisor Start')
        if (this.cancellation?.aborted) stop()
        signal.throwIfAborted()
        bound(until)
        readyTimer = setTimeout(() => { fail(new Error('Timed out waiting for supervisor ready')) }, Math.ceil(Math.min(remaining, this.config.requestTimeoutMs)))
        readyTimer.unref()
        await new Promise<void>((resolve, reject) => {
          spec.beforeStart()
          const req = request({
            socketPath: this.config.dockerSocket, agent: false, path: `${apiVersion}${path}/start`, method: 'POST',
            headers: { ...jsonHeaders(body), Connection: 'Upgrade', Upgrade: 'tcp' }, signal,
          })
          req.once('upgrade', (response, connection, head) => {
            socket = connection
            if (response.statusCode !== 101 || response.headers.upgrade?.toLowerCase() !== 'tcp') {
              connection.destroy()
              reject(new DockerRequestError(operation, 'invalid_response', {}))
              return
            }
            void (async () => {
              // Attach the iterator's error handling before parsing a head that may trigger control writes.
              if (head.length > 0) connection.unshift(head)
              for await (const chunk of addAbortSignal(signal, connection) as AsyncIterable<Buffer>) protocol.push(chunk)
              resolve()
            })().catch(reject)
          })
          req.once('response', (response) => {
            response.destroy()
            reject(new DockerRequestError(operation, 'engine', { status: response.statusCode }))
          })
          req.once('error', reject)
          req.end(body)
        })
        const completion = protocol.finish()
        const inspectPath = `${path}/json`
        while (true) {
          const reply = await this.send('GET', inspectPath, [200], undefined, signal)
          const inspected = decode(execInspection, reply.body, `GET ${inspectPath}`)
          if (inspected.ID !== id || inspected.ContainerID !== container || (!inspected.Running && inspected.ExitCode !== 0)) {
            throw new DockerRequestError(`GET ${inspectPath}`, 'invalid_response', {})
          }
          if (!inspected.Running) return completion
          await delay(10, undefined, { signal })
        }
      } catch (cause) {
        const error = failure ?? cause
        if (error instanceof DockerRequestError) throw error
        throw new DockerRequestError(operation, error instanceof SupervisorProtocolError ? 'invalid_response' : 'transport', {
          cause: error, ...(protocol.diagnostics ? { diagnostics: protocol.diagnostics } : {}),
        })
      } finally {
        settled = true
        clearTimeout(timer)
        clearTimeout(readyTimer)
        this.cancellation?.removeEventListener('abort', stop)
        lifetime.abort()
        socket?.destroy()
        await pendingCheck
      }
    })()
    return { result, cancel, interrupt: () => { fail(new Error('Container generation is being removed')) } }
  }

  /** Inspect one exact container.
   * @param id - Full Docker container ID.
   * @param deadline - Optional execution deadline that also bounds the inspection.
   * @returns The observed container, or null when Docker explicitly returns 404.
   */
  async inspect(id: DockerContainerId, deadline?: AbortSignal): Promise<SandboxContainer | null> {
    const container = await this.inspectPath(containerPath(id), deadline)
    if (container && container.Id !== id) throw new DockerRequestError('inspect container', 'invalid_response', {})
    return container
  }

  /** Resolve an exact Runner-generated name to a full ID and ownership data.
   * @param name - Stable container name derived from the deployment and workspace.
   * @returns The observed container, or null for HTTP 404.
   */
  async find(name: string): Promise<SandboxContainer | null> {
    const container = await this.inspectPath(`/containers/${encodeURIComponent(name)}`)
    if (container && container.Name !== `/${name}`) throw new DockerRequestError('inspect container by name', 'invalid_response', {})
    return container
  }

  /** Force-remove one exact container. Inspect afterward to confirm absence.
   * @param id - Full Docker container ID.
   */
  async remove(id: DockerContainerId): Promise<void> {
    await this.send('DELETE', `${containerPath(id)}?force=true`, [204, 404])
  }

  /** List deployment candidates, including stopped and never-started containers.
   * @returns Full IDs selected by the deployment label; inspect before acting on them.
   */
  async list(): Promise<DockerContainerId[]> {
    const query = new URLSearchParams({
      all: 'true',
      filters: JSON.stringify({ label: [`${deploymentLabel}=${this.config.deploymentId}`] }),
    })
    const result = await this.send('GET', `/containers/json?${query}`, [200])
    return decode(z.array(idResponse), result.body, 'list containers').map(container => container.Id)
  }

  private async inspectPath(path: string, deadline?: AbortSignal): Promise<SandboxContainer | null> {
    const result = await this.send('GET', `${path}/json`, [200, 404], undefined, deadline)
    return result.status === 404 ? null : decode(inspection, result.body, 'inspect container')
  }

  private async send(method: string, path: string, expected: readonly number[], body?: string, executionDeadline?: AbortSignal) {
    const signals = [AbortSignal.timeout(this.config.requestTimeoutMs)]
    if (this.cancellation !== undefined) signals.push(this.cancellation)
    if (executionDeadline !== undefined) signals.push(executionDeadline)
    const signal = AbortSignal.any(signals)
    signal.throwIfAborted()
    const operation = `${method} ${path}`
    const result = await new Promise<Awaited<ReturnType<typeof readResponse>>>((resolve, reject) => {
      const req = request({
        socketPath: this.config.dockerSocket,
        agent: false,
        path: `${apiVersion}${path}`,
        method,
        ...(body === undefined ? {} : { headers: jsonHeaders(body) }),
        signal,
      }, (response) => { void readResponse(response).then(resolve, reject) })
      req.once('error', reject)
      req.end(body)
    }).catch((cause: unknown) => {
      throw new DockerRequestError(operation, 'transport', { cause })
    })
    if (!expected.some(status => status === result.status)) {
      throw new DockerRequestError(operation, 'engine', { status: result.status })
    }
    return result
  }
}
