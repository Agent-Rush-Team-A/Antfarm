/** Host-local maintenance control for a planned Workspace mode shutdown. */
import { once } from 'node:events'
import { lstat, realpath } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'

/**
 * Signal readiness and accept drain requests through a private Linux runtime directory.
 * @param socketPath - Absolute socket path in an owner-only directory.
 * @param quiesce - Stop new admissions and await existing leases.
 * @returns A disposer for the socket and any outstanding responses.
 */
export async function listenModeDrain(socketPath: string, quiesce: () => Promise<void>): Promise<() => Promise<void>> {
  if (process.platform !== 'linux' || resolve(socketPath) !== socketPath || Buffer.byteLength(socketPath) > 107) {
    throw new Error('Workspace mode drain requires an absolute Linux Unix socket path')
  }
  const parent = dirname(socketPath)
  const info = await lstat(parent)
  if (!info.isDirectory() || await realpath(parent) !== parent || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error('Workspace mode drain requires an owner-only socket directory')
  }
  let draining = false
  const server = createServer((request, response) => {
    response.setHeader('Connection', 'close')
    if (request.method === 'GET' && request.url === '/ready') {
      response.writeHead(draining ? 503 : 204).end()
      return
    }
    if (request.method !== 'POST' || request.url !== '/drain') {
      response.writeHead(404).end()
      return
    }
    draining = true
    void quiesce().then(
      () => { response.writeHead(204).end() },
      () => { response.writeHead(503).end() },
    )
  })
  server.listen(socketPath)
  await once(server, 'listening')
  return () => new Promise<void>((done, fail) => {
    server.close((error) => { if (error === undefined) done(); else fail(error) })
    server.closeAllConnections()
  })
}
