/** Local HTTP transport for the workspace sandbox lifecycle. */

import { once } from 'node:events'
import { chmod, realpath, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { z } from 'zod'
import { InvalidWorkspaceDirectoryError } from './config.ts'
import { DockerRequestError } from './docker.ts'
import { SandboxLifecycleError } from './errors.ts'
import type SandboxRunner from './index.ts'

type SandboxOperations = Pick<SandboxRunner, 'open' | 'status' | 'close'>

const route = /^\/v1\/workspaces\/([^/]*)\/sandbox$/u
const workspaceIdPattern = /^[a-zA-Z0-9_-]{1,128}$/u
const putBody = z.strictObject({ workspaceDir: z.string().min(1) })

class InvalidRequestError extends Error {}

async function readDirectory(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  // The request stream has no text encoding, so Node yields byte buffers.
  for await (const chunk of request.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > 8192) throw new InvalidRequestError()
    chunks.push(chunk)
  }
  try {
    const json: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return putBody.parse(json).workspaceDir
  } catch (cause) {
    throw new InvalidRequestError('Expected a JSON workspaceDir', { cause })
  }
}

function reply(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' })
  response.end(JSON.stringify(body))
}

async function dispatch(
  runner: SandboxOperations, request: IncomingMessage, response: ServerResponse, report: (error: unknown) => void,
): Promise<void> {
  const rawId = route.exec(String(request.url))?.[1]
  if (rawId === undefined) {
    reply(response, 404, { error: 'not_found' })
    return
  }
  if (!workspaceIdPattern.test(rawId)) {
    reply(response, 400, { error: 'invalid_request' })
    return
  }
  const workspaceId = brandString<WorkspaceId>(rawId)
  try {
    switch (request.method) {
      case 'PUT': reply(response, 200, await runner.open(workspaceId, await readDirectory(request))); return
      case 'GET': reply(response, 200, await runner.status(workspaceId)); return
      case 'DELETE': reply(response, 200, await runner.close(workspaceId)); return
      default:
        response.setHeader('Allow', 'PUT, GET, DELETE')
        reply(response, 405, { error: 'method_not_allowed' })
    }
  } catch (error) {
    if (response.destroyed) return
    if (error instanceof InvalidRequestError) {
      reply(response, 400, { error: 'invalid_request' })
    } else if (error instanceof InvalidWorkspaceDirectoryError) {
      reply(response, 400, { error: 'invalid_workspace_directory' })
    } else if (error instanceof SandboxLifecycleError) {
      const unavailable = error.code === 'sandbox_outcome_unknown' || error.code === 'sandbox_not_ready'
      reply(response, unavailable ? 503 : 409, { error: error.code })
    } else if (error instanceof DockerRequestError) {
      reply(response, 503, { error: 'docker_unavailable' })
    } else {
      report(error)
      reply(response, 500, { error: 'internal_error' })
    }
  }
}

/** Bind the API in a trusted directory. An occupied socket is left intact.
 * @param socketPath - Canonical Linux socket path.
 * @param runner - Owner of the sandbox lifecycle.
 * @param report - Diagnostic sink for unexpected server failures.
 * @returns A disposer that stops accepting requests and releases the socket.
 */
export async function listenRunnerSocket(
  socketPath: string, runner: SandboxOperations, report: (error: unknown) => void,
): Promise<() => Promise<void>> {
  if (process.platform !== 'linux' || resolve(socketPath) !== socketPath || Buffer.byteLength(socketPath) > 107) {
    throw new Error('Runner API requires an absolute Linux Unix socket path of at most 107 bytes')
  }
  const parent = dirname(socketPath)
  const directory = await stat(parent)
  if (!directory.isDirectory() || await realpath(parent) !== parent || directory.uid !== process.getuid?.()
    || (directory.mode & 0o027) !== 0) {
    throw new Error('Runner socket directory must be owned by the Runner and allow neither group writes nor other access')
  }
  const server = createServer({ headersTimeout: 5_000, requestTimeout: 5_000, connectionsCheckingInterval: 1_000 },
    (request, response) => { void dispatch(runner, request, response, report).catch(report) })
  const stop = () => new Promise<void>((resolveStop, reject) => {
    server.close((error) => { if (error) reject(error); else resolveStop() })
    server.closeAllConnections()
  })
  await once(server.listen(socketPath), 'listening')
  server.on('error', report)
  try {
    await chmod(socketPath, 0o660)
  } catch (cause) {
    await stop()
    throw cause
  }
  return stop
}
