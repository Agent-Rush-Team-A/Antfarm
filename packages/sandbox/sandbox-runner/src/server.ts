/** Local HTTP transport for workspace sandbox lifecycle and execution. */

import { once } from 'node:events'
import { chmod, realpath, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, posix, resolve } from 'node:path'
import process from 'node:process'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { z } from 'zod'
import { InvalidWorkspaceDirectoryError } from './config.ts'
import { dockerContainerIdSchema, DockerRequestError } from './docker.ts'
import { SandboxLifecycleError } from './errors.ts'
import type { default as SandboxRunner, SandboxExecutionId, SandboxExecutionRequest } from './index.ts'

type SandboxOperations = Pick<SandboxRunner, 'open' | 'status' | 'close' | 'execute'>

const route = /^\/v1\/workspaces\/([^/]*)\/sandbox(\/exec)?$/u
const workspaceIdPattern = /^[a-zA-Z0-9_-]{1,128}$/u
const putBody = z.strictObject({ workspaceDir: z.string().min(1) })
const argumentText = (value: string) => value.isWellFormed() && !value.includes('\0')
const execBody = z.strictObject({
  executionId: z.string().min(1).max(128).refine(argumentText).transform(value => brandString<SandboxExecutionId>(value)),
  expectedContainerId: dockerContainerIdSchema,
  command: z.string().refine(value => argumentText(value) && value.trim().length > 0),
  workdir: z.string().min(1).refine(value => argumentText(value) && !posix.isAbsolute(value) && !value.split('/').includes('..'))
    .transform(value => posix.normalize(value).replace(/\/$/u, '')).default('.'),
  timeoutMs: z.int().min(1).max(60_000).default(30_000),
})

// Docker starts the wrapper in /workspace. Bash -p skips inherited startup hooks in both shells.
const bashWrapper = `workspace=$(builtin pwd -P) || exit 125
if ! builtin cd -P -- "./$1" 2>/dev/null || [[ $PWD != "$workspace" && $PWD != "$workspace/"* ]]; then
  printf '%s\\n' 'Cannot use the requested working directory inside /workspace' >&2
  exit 125
fi
exec /bin/bash -p -c -- "$2"`

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

class InvalidRequestError extends Error {}

async function readBody<T>(request: IncomingMessage, limit: number, schema: z.ZodType<T>): Promise<T> {
  const chunks: Buffer[] = []
  let size = 0
  // The request stream has no text encoding, so Node yields byte buffers.
  for await (const chunk of request.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > limit) throw new InvalidRequestError()
    chunks.push(chunk)
  }
  try {
    const json: unknown = JSON.parse(utf8.decode(Buffer.concat(chunks)))
    return schema.parse(json)
  } catch (cause) {
    throw new InvalidRequestError('Invalid JSON request body', { cause })
  }
}

async function readExec(request: IncomingMessage): Promise<SandboxExecutionRequest> {
  const { command, workdir, ...identity } = await readBody(request, 64 * 1024, execBody)
  return { ...identity, argv: ['/bin/bash', '-p', '-c', bashWrapper, 'sandbox-exec', workdir, command] }
}

function reply(response: ServerResponse, status: number, body: object): void {
  if (response.destroyed) return
  response.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' })
  response.end(JSON.stringify(body))
}

async function dispatch(
  runner: SandboxOperations, request: IncomingMessage, response: ServerResponse, report: (error: unknown) => void,
): Promise<void> {
  const [, rawId, exec] = route.exec(String(request.url)) ?? []
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
    if (exec) {
      if (request.method === 'POST') {
        reply(response, 200, await runner.execute(workspaceId, await readExec(request)))
        return
      }
      response.setHeader('Allow', 'POST')
    } else {
      switch (request.method) {
        case 'PUT': reply(response, 200, await runner.open(workspaceId, (await readBody(request, 8192, putBody)).workspaceDir)); return
        case 'GET': reply(response, 200, await runner.status(workspaceId)); return
        case 'DELETE': reply(response, 200, await runner.close(workspaceId)); return
        default: response.setHeader('Allow', 'PUT, GET, DELETE')
      }
    }
    reply(response, 405, { error: 'method_not_allowed' })
  } catch (error) {
    if (response.destroyed) return
    if (error instanceof InvalidRequestError) {
      reply(response, 400, { error: 'invalid_request' })
    } else if (error instanceof InvalidWorkspaceDirectoryError) {
      reply(response, 400, { error: 'invalid_workspace_directory' })
    } else if (error instanceof SandboxLifecycleError) {
      const unavailable = error.code === 'sandbox_outcome_unknown' || error.code === 'sandbox_not_ready'
        || error.code === 'execution_outcome_unknown'
      reply(response, error.code === 'execution_timeout' ? 504 : unavailable ? 503 : 409, { error: error.code })
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
