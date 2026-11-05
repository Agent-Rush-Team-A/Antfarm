/**
 * Docker Engine operations for the independent workspace sandbox runner.
 */

import { request, type IncomingMessage } from 'node:http'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { deploymentLabel, type resolveCreateRequest, type ResolvedConfig } from './config.ts'

/** Full, 64-character Docker container ID. */
export type DockerContainerId = Branded<'DockerContainerId'>

const fullId = z.string().regex(/^[a-f0-9]{64}$/u)
const containerId = fullId.transform(value => brandString<DockerContainerId>(value))
const idResponse = z.object({ Id: containerId })
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

  /** Inspect one exact container.
   * @param id - Full Docker container ID.
   * @returns The observed container, or null when Docker explicitly returns 404.
   */
  async inspect(id: DockerContainerId): Promise<SandboxContainer | null> {
    const container = await this.inspectPath(containerPath(id))
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

  private async inspectPath(path: string): Promise<SandboxContainer | null> {
    const result = await this.send('GET', `${path}/json`, [200, 404])
    return result.status === 404 ? null : decode(inspection, result.body, 'inspect container')
  }

  private async send(method: string, path: string, expected: readonly number[], body?: string) {
    const deadline = AbortSignal.timeout(this.config.requestTimeoutMs)
    const signal = this.cancellation === undefined ? deadline : AbortSignal.any([deadline, this.cancellation])
    signal.throwIfAborted()
    const operation = `${method} ${path}`
    const result = await new Promise<Awaited<ReturnType<typeof readResponse>>>((resolve, reject) => {
      const req = request({
        socketPath: this.config.dockerSocket,
        agent: false,
        path: `/v1.51${path}`,
        method,
        ...(body === undefined ? {} : {
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }),
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
