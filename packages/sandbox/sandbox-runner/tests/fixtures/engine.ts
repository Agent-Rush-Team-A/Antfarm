import { IncomingMessage, ServerResponse, type Server } from 'node:http'
import { StringDecoder } from 'node:string_decoder'

export function enableExecUpgrade(server: Server): () => void {
  const connections = new Set<import('node:stream').Duplex>()
  server.on('connection', (socket) => {
    connections.add(socket)
    socket.once('close', () => connections.delete(socket))
  })
  server.on('upgrade', (request, socket, head) => {
    socket.on('error', (error: NodeJS.ErrnoException) => {
      // The client may abandon an upgraded Exec Start while the fixture is writing.
      if (error.code !== 'ECONNRESET') throw error
    })
    socket.once('end', () => { socket.end() })
    socket.pause()
    let body = head
    const length = Number(request.headers['content-length'] ?? 0)
    const consume = (chunk?: Buffer) => {
      if (chunk) body = Buffer.concat([body, chunk])
      if (body.length < length) return
      socket.pause()
      socket.removeListener('data', consume)
      // Node ends the original IncomingMessage at Upgrade; its POST body belongs to head.
      const upgraded = new IncomingMessage(request.socket)
      Object.assign(upgraded, {
        method: request.method, url: request.url, headers: request.headers, complete: true,
        httpVersion: request.httpVersion, httpVersionMajor: request.httpVersionMajor, httpVersionMinor: request.httpVersionMinor,
      })
      const response = new ServerResponse(upgraded)
      response.assignSocket(request.socket)
      server.emit('request', upgraded, response)
      upgraded.push(body.subarray(0, length))
      upgraded.push(null)
      if (body.length > length) socket.unshift(body.subarray(length))
      socket.resume()
    }
    consume()
    if (body.length < length) socket.on('data', consume).resume()
  })
  return () => { for (const socket of connections) socket.destroy() }
}

export function frame(stream: number, body: string | Buffer): Buffer {
  const bytes = typeof body === 'string' ? Buffer.from(body) : body
  const header = Buffer.alloc(8)
  header[0] = stream
  header.writeUInt32BE(bytes.length, 4)
  return Buffer.concat([header, bytes])
}

export function protocolFrame(executionId: string, type: string, fields: Record<string, unknown> = {}): Buffer {
  return frame(1, `${JSON.stringify({ v: 1, type, executionId, ...fields })}\n`)
}

export function outputFrames(executionId: string, stream: 'stdout' | 'stderr', text: string): Buffer {
  const bytes = Buffer.from(text)
  const frames: Buffer[] = []
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    frames.push(protocolFrame(executionId, 'output', { stream, data: bytes.subarray(offset, offset + 8192).toString('base64') }))
  }
  return Buffer.concat(frames)
}

export function finishedFrame(executionId: string, exitCode = 7, fields: Record<string, unknown> = {}): Buffer {
  return protocolFrame(executionId, 'finished', {
    reason: 'exited', bash: { exitCode, signal: null }, cleanup: 'confirmed',
    outputTruncated: { stdout: false, stderr: false }, ...fields,
  })
}

export function upgrade(response: ServerResponse, head: Buffer = Buffer.alloc(0), protocol = 'tcp') {
  const socket = response.socket
  if (!socket) throw new Error('No socket for Exec Start response')
  socket.write(Buffer.concat([
    Buffer.from(`HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: ${protocol}\r\n\r\n`), head,
  ]))
  return socket
}

export function supervisor(response: ServerResponse, executionId: string, automatic = true, cleanup?: Promise<void>) {
  const socket = upgrade(response, protocolFrame(executionId, 'ready'))
  const started = Promise.withResolvers<undefined>()
  const cancelled = Promise.withResolvers<string>()
  const controls: Array<{ type: string; reason: string }> = []
  let input = ''
  let running = false
  let ended = false
  let completion: { exitCode: number; stdout: string; stderr: string } | undefined
  const flush = () => {
    if (!running || !completion || ended) return
    ended = true
    socket.end(Buffer.concat([
      outputFrames(executionId, 'stdout', completion.stdout), outputFrames(executionId, 'stderr', completion.stderr),
      finishedFrame(executionId, completion.exitCode),
    ]))
  }
  const decoder = new StringDecoder('utf8')
  socket.on('data', (chunk: Buffer) => {
    input += decoder.write(chunk)
    let end: number
    while ((end = input.indexOf('\n')) !== -1) {
      const message = JSON.parse(input.slice(0, end)) as { type: string; reason: string }
      controls.push(message)
      input = input.slice(end + 1)
      if (message.type === 'run') { running = true; started.resolve(undefined); flush() }
      else if (message.type === 'cancel' && !ended) {
        ended = true
        const finished = finishedFrame(executionId, 7, {
          reason: message.reason, bash: running ? { exitCode: null, signal: 15 } : null,
        })
        cancelled.resolve(message.reason)
        if (cleanup) void cleanup.then(() => { socket.end(finished) })
        else socket.end(finished)
      }
    }
  })
  const complete = (exitCode = 7, stdout = '', stderr = '') => {
    completion = { exitCode, stdout, stderr }
    flush()
  }
  if (automatic) complete()
  return { socket, complete, controls, started: started.promise, cancelled: cancelled.promise }
}
