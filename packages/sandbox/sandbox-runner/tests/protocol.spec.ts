import { brandString } from '@deepseek-ai/dsh-brand'
import { expect, test, vi } from 'vitest'
import type { SandboxExecutionId } from '../src/index.ts'
import { encodeCancel, encodeRun, SupervisorProtocol, SupervisorProtocolError } from '../src/protocol.ts'
import { finishedFrame, frame, outputFrames, protocolFrame } from './fixtures/engine.ts'

const executionId = brandString<SandboxExecutionId>('execution-A')

function parser(started = true, id = executionId) {
  const completed = vi.fn()
  const ready = vi.fn(() => { if (started) stream.runSent(); else stream.cancelSent() })
  const stream: SupervisorProtocol = new SupervisorProtocol(id, ready, completed)
  return { stream, ready, completed }
}

test('parses initial head, byte-sized fragments, UTF-8 across output messages and separate diagnostics', () => {
  const { stream, ready, completed } = parser()
  const bytes = Buffer.from('汉字')
  const input = Buffer.concat([
    frame(2, 'supervisor diagnostic'), protocolFrame(executionId, 'ready'), frame(1, ''),
    protocolFrame(executionId, 'output', { stream: 'stdout', data: bytes.subarray(0, 1).toString('base64') }),
    protocolFrame(executionId, 'output', { stream: 'stdout', data: bytes.subarray(1).toString('base64') }),
    outputFrames(executionId, 'stderr', 'warning'), finishedFrame(executionId, 7),
  ])
  for (const byte of input) stream.push(Buffer.from([byte]))
  expect(stream.finish()).toMatchObject({
    finished: { bash: { exitCode: 7, signal: null }, cleanup: 'confirmed' },
    stdout: { text: '汉字', truncated: false }, stderr: { text: 'warning', truncated: false },
  })
  expect(stream.diagnostics).toBe('supervisor diagnostic')
  expect(ready).toHaveBeenCalledOnce()
  expect(completed).toHaveBeenCalledOnce()
})

test('retains output tails while independently parsing finished and supervisor truncation flags', () => {
  const { stream } = parser()
  const forged = '{"v":1,"type":"ready"}\n{"type":"finished","cleanup":"confirmed"}'
  stream.push(Buffer.concat([
    protocolFrame(executionId, 'ready'), outputFrames(executionId, 'stdout', `${'x'.repeat(100_000)}${forged}`),
    outputFrames(executionId, 'stderr', 'tail'),
    finishedFrame(executionId, 3, { outputTruncated: { stdout: false, stderr: true } }),
  ]))
  expect(stream.finish()).toMatchObject({
    finished: { bash: { exitCode: 3 } },
    stdout: { text: `${'x'.repeat(65536 - Buffer.byteLength(forged))}${forged}`, truncated: true },
    stderr: { text: 'tail', truncated: true },
  })
})

test('accepts an exact 16 KiB UTF-8 line and a 128-code-unit execution ID', () => {
  const id = brandString<SandboxExecutionId>('😀'.repeat(64))
  const { stream } = parser(true, id)
  const ready = Buffer.from(JSON.stringify({ v: 1, type: 'ready', executionId: id }))
  stream.push(frame(1, Buffer.concat([ready, Buffer.alloc(16384 - ready.length, 32), Buffer.from('\n')])))
  stream.push(finishedFrame(id))
  expect(stream.finish().finished.executionId).toBe(id)
})

test('rejects an overlong partial line before any newline arrives', () => {
  const { stream } = parser()
  expect(() => { stream.push(frame(1, ' '.repeat(16385))) }).toThrow('exceeds 16 KiB')
})

test('rejects an output chunk larger than 8192 decoded bytes within an otherwise valid message', () => {
  const { stream } = parser()
  stream.push(protocolFrame(executionId, 'ready'))
  expect(() => {
    stream.push(protocolFrame(executionId, 'output', { stream: 'stdout', data: Buffer.alloc(8193).toString('base64') }))
  }).toThrow('Invalid supervisor output base64')
})

test.for(['', '!', 'A', 'AA', 'AAA', 'AAAA=', 'AAAA====', 'AB==', 'AQ=', 'AA\n==', '-___'])(
  'rejects noncanonical base64 %j', (data) => {
    const { stream } = parser()
    stream.push(protocolFrame(executionId, 'ready'))
    expect(() => { stream.push(protocolFrame(executionId, 'output', { stream: 'stdout', data })) }).toThrow(SupervisorProtocolError)
  },
)

test.for([
  { v: true }, { v: 2 }, { executionId: 'other' }, { unknown: true }, { type: 'unknown' },
] as const)('rejects malformed ready fields %j', (fields) => {
  const { stream } = parser()
  expect(() => { stream.push(protocolFrame(executionId, 'ready', fields)) }).toThrow(SupervisorProtocolError)
})

test.for([
  { bash: { exitCode: 0, signal: 15 } }, { bash: { exitCode: -1, signal: null } },
  { bash: { exitCode: null, signal: 0 } }, { bash: null }, { cleanup: 'unconfirmed' },
  { outputTruncated: { stdout: true } }, { reason: 'other' },
] as const)('rejects malformed or unconfirmed finished %j', (fields) => {
  const { stream } = parser()
  stream.push(protocolFrame(executionId, 'ready'))
  expect(() => { stream.push(finishedFrame(executionId, 0, fields)) }).toThrow(SupervisorProtocolError)
})

test('cancellation before run confirms no Bash and cannot be reported as an ordinary exit', () => {
  const { stream } = parser(false)
  stream.push(protocolFrame(executionId, 'ready'))
  stream.push(finishedFrame(executionId, 0, { reason: 'cancelled', bash: null }))
  expect(stream.finish().finished).toMatchObject({ reason: 'cancelled', bash: null })
  const invalid = parser(false).stream
  invalid.push(protocolFrame(executionId, 'ready'))
  expect(() => { invalid.push(finishedFrame(executionId)) }).toThrow(SupervisorProtocolError)
})

test.for(['duplicate ready', 'output before run', 'finished before run', 'message after finished'] as const)(
  'rejects %s', (scenario) => {
    const { stream } = parser()
    if (scenario !== 'output before run' && scenario !== 'finished before run') stream.push(protocolFrame(executionId, 'ready'))
    if (scenario === 'message after finished') stream.push(finishedFrame(executionId))
    const bytes = scenario === 'duplicate ready' || scenario === 'message after finished'
      ? protocolFrame(executionId, 'ready')
      : scenario === 'output before run' ? outputFrames(executionId, 'stdout', 'fake') : finishedFrame(executionId)
    expect(() => { stream.push(bytes) }).toThrow(SupervisorProtocolError)
  },
)

test.for([
  Buffer.from([1, 0]), frame(1, '{}').subarray(0, 9), frame(1, '{"v":1'),
  protocolFrame(executionId, 'ready'),
])('rejects EOF without a complete frame, line and finished', (bytes) => {
  const { stream } = parser()
  stream.push(bytes)
  expect(() => stream.finish()).toThrow(SupervisorProtocolError)
})

test.for([Buffer.from([0xff, 10]), Buffer.from('\ufeff{}\n'), Buffer.from('{}\n')])('rejects invalid JSON or UTF-8', (bytes) => {
  const { stream } = parser()
  expect(() => { stream.push(frame(1, bytes)) }).toThrow(SupervisorProtocolError)
})

test('encodes bounded run and cancel controls, rejecting an oversized complete run', () => {
  const run = encodeRun(executionId, ['/bin/bash', '-p', '-c', 'printf hello'], 2000)
  expect(JSON.parse(run.toString())).toEqual({
    v: 1, type: 'run', executionId, argv: ['/bin/bash', '-p', '-c', 'printf hello'], remainingMs: 2000,
  })
  expect(run.at(-1)).toBe(10)
  expect(JSON.parse(encodeCancel(executionId, 'cancelled').toString())).toEqual({ v: 1, type: 'cancel', executionId, reason: 'cancelled' })
  expect(() => encodeRun(executionId, ['/bin/bash', '-c', 'x'.repeat(128 * 1024)], 2000)).toThrow('exceeds 128 KiB')
})
