/**
 * Docker Engine operations for the independent workspace sandbox runner.
 */

import { request, type IncomingMessage } from 'node:http'
import { addAbortSignal, type Duplex } from 'node:stream'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import { z } from 'zod'
import { deploymentLabel, type resolveCreateRequest, type ResolvedConfig } from './config.ts'

/** Full, 64-character Docker container ID. */
export type DockerContainerId = Branded<'DockerContainerId'>

/** Full Docker ID of a single execution. */
export type DockerExecId = Branded<'DockerExecId'>

/** Retained tail and truncation flag for one Docker output stream. */
export interface DockerExecOutput {
  readonly text: string
  readonly truncated: boolean
}

/** Confirmed foreground exit and bounded output from Docker. */
export interface DockerExecResult {
  readonly exitCode: number
  readonly stdout: DockerExecOutput
  readonly stderr: DockerExecOutput
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
    readonly details: { status?: number | undefined; cause?: unknown },
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

async function readExecOutput(socket: Duplex, head: Buffer, signal: AbortSignal, operation: string) {
  const stdout = new TextRetainer({ kind: 'tail', maxBytes: 64 * 1024 })
  const stderr = new TextRetainer({ kind: 'tail', maxBytes: 64 * 1024 })
  const header = Buffer.alloc(8)
  let headerBytes = 0
  let remaining = 0
  let output = stdout

  try {
    // Upgrade detaches the HTTP parser and gives us bytes it already read from the socket.
    if (head.length > 0) socket.unshift(head)
    for await (const chunk of addAbortSignal(signal, socket) as AsyncIterable<Buffer>) {
      let offset = 0
      while (offset < chunk.length) {
        if (remaining === 0) {
          const copied = chunk.copy(header, headerBytes, offset, offset + header.length - headerBytes)
          offset += copied
          headerBytes += copied
          if (headerBytes < header.length) break
          const stream = header[0]
          if ((stream !== 1 && stream !== 2) || header.readUIntBE(1, 3) !== 0) {
            throw new DockerRequestError(operation, 'invalid_response', {})
          }
          output = stream === 1 ? stdout : stderr
          remaining = header.readUInt32BE(4)
          headerBytes = 0
        }
        const size = Math.min(remaining, chunk.length - offset)
        if (size > 0) output.push(Uint8Array.from(chunk.subarray(offset, offset + size)))
        remaining -= size
        offset += size
      }
    }
    if (headerBytes !== 0 || remaining !== 0) throw new DockerRequestError(operation, 'invalid_response', {})
    const out = stdout.finish()
    const err = stderr.finish()
    return { stdout: { text: out.text, truncated: out.truncated }, stderr: { text: err.text, truncated: err.truncated } }
  } finally {
    socket.destroy()
  }
}

/** Send workspace sandbox operations to a local Engine using API v1.51. */
export class DockerEngine {
  /**
   * @param config - Trusted deployment settings.
   * @param cancellation - Optional cancellation in addition to each request's deadline.
   */
  constructor(private readonly config: ResolvedConfig, private readonly cancellation?: AbortSignal) {}

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

  /** Register a foreground process that inherits the container identity. No process starts here.
   * @param id - Full ID of the container selected by the Runner.
   * @param argv - Executable and arguments to pass to Docker as separate strings.
   * @param deadline - Signal for the execution's remaining wait budget.
   * @returns The full exec ID reported by Docker.
   */
  async createExec(id: DockerContainerId, argv: readonly string[], deadline: AbortSignal): Promise<DockerExecId> {
    const path = `${containerPath(id)}/exec`
    const body = JSON.stringify({
      Cmd: argv, WorkingDir: '/workspace', AttachStdin: false, AttachStdout: true, AttachStderr: true,
      Tty: false, Privileged: false,
    })
    const result = await this.send('POST', path, [201], body, deadline)
    return decode(execIdResponse, result.body, `POST ${path}`).Id
  }

  /** Start one exec, drain its separate output streams, and confirm its exit with Inspect.
   * A failed Start or Inspect can leave the outcome unknown. Cancellation closes the connection only.
   * @param id - Full ID of the exec returned by Create.
   * @param container - Full ID of the container used to create the exec.
   * @param deadline - Signal for the execution's remaining wait budget.
   * @returns The confirmed exit code and the last 64 KiB of each stream with truncation flags.
   */
  async startExec(id: DockerExecId, container: DockerContainerId, deadline: AbortSignal): Promise<DockerExecResult> {
    const path = `/exec/${fullId.parse(id)}`
    const operation = `POST ${path}/start`
    const body = JSON.stringify({ Detach: false, Tty: false })
    const signal = this.cancellation === undefined ? deadline : AbortSignal.any([deadline, this.cancellation])
    const output = await new Promise<Awaited<ReturnType<typeof readExecOutput>>>((resolve, reject) => {
      signal.throwIfAborted()
      const req = request({
        socketPath: this.config.dockerSocket,
        agent: false,
        path: `${apiVersion}${path}/start`,
        method: 'POST',
        headers: { ...jsonHeaders(body), Connection: 'Upgrade', Upgrade: 'tcp' },
        signal,
      })
      req.once('upgrade', (response, socket, head) => {
        if (response.statusCode !== 101 || response.headers.upgrade?.toLowerCase() !== 'tcp') {
          socket.destroy()
          reject(new DockerRequestError(operation, 'invalid_response', {}))
          return
        }
        void readExecOutput(socket, head, signal, operation).then(resolve, reject)
      })
      req.once('response', (response) => {
        response.destroy()
        reject(new DockerRequestError(operation, 'engine', { status: response.statusCode }))
      })
      req.once('error', reject)
      req.end(body)
    }).catch((cause: unknown) => {
      if (cause instanceof DockerRequestError) throw cause
      throw new DockerRequestError(operation, 'transport', { cause })
    })

    const inspectPath = `${path}/json`
    const result = await this.send('GET', inspectPath, [200], undefined, deadline)
    const inspected = decode(execInspection, result.body, `GET ${inspectPath}`)
    if (inspected.ID !== id || inspected.ContainerID !== container || inspected.Running || inspected.ExitCode === null) {
      throw new DockerRequestError(`GET ${inspectPath}`, 'invalid_response', {})
    }
    return { exitCode: inspected.ExitCode, ...output }
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
