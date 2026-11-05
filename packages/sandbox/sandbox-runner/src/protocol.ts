/** Bounded Docker multiplexing and the per-execution supervisor JSON-line protocol. */

import { brandString } from '@deepseek-ai/dsh-brand'
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import { z } from 'zod'
import type { DockerExecOutput } from './docker.ts'
import type { SandboxExecutionId } from './index.ts'

/** Cancellation requests accepted by the supervisor. */
export type SupervisorCancelReason = 'cancelled' | 'timeout' | 'shutdown'

/** Validate and brand execution identity at HTTP and supervisor wire boundaries. */
export const executionIdSchema = z.string().min(1).max(128)
  .refine(value => value.isWellFormed() && !value.includes('\0'))
  .transform(value => brandString<SandboxExecutionId>(value))

const common = { v: z.literal(1), executionId: executionIdSchema }
const bashStatus = z.union([
  z.strictObject({ exitCode: z.int().min(0).max(255), signal: z.null() }),
  z.strictObject({ exitCode: z.null(), signal: z.int().min(1).max(64) }),
])
const finished = z.strictObject({
  ...common,
  type: z.literal('finished'),
  reason: z.enum(['exited', 'timeout', 'cancelled', 'shutdown', 'control_eof']),
  bash: bashStatus.nullable(),
  cleanup: z.literal('confirmed'),
  outputTruncated: z.strictObject({ stdout: z.boolean(), stderr: z.boolean() }),
})
const message = z.discriminatedUnion('type', [
  z.strictObject({ ...common, type: z.literal('ready') }),
  z.strictObject({ ...common, type: z.literal('output'), stream: z.enum(['stdout', 'stderr']), data: z.string().max(10_924) }),
  finished,
])

/** Command status and cleanup confirmation reported by the supervisor, independently of its own exit. */
export type SupervisorFinished = z.output<typeof finished>

/** Validated supervisor completion and the retained user output. */
export interface SupervisorResult {
  readonly finished: SupervisorFinished
  readonly stdout: DockerExecOutput
  readonly stderr: DockerExecOutput
}

/** The stream cannot establish a supervisor result or cleanup confirmation. */
export class SupervisorProtocolError extends Error {}

/** Encode exactly one run, checking the complete byte size before Exec Start.
 * @param executionId - The current execution identity.
 * @param argv - Normalized command arguments from the Runner.
 * @param remainingMs - Remaining command budget in whole milliseconds.
 * @returns One bounded JSON line for supervisor stdin.
 */
export function encodeRun(executionId: SandboxExecutionId, argv: readonly string[], remainingMs: number): Buffer {
  executionIdSchema.parse(executionId)
  if (argv.length === 0 || !argv[0] || argv.some(value => !value.isWellFormed() || value.includes('\0'))
    || !Number.isInteger(remainingMs) || remainingMs < 1 || remainingMs > 60_000) {
    throw new SupervisorProtocolError('Invalid supervisor run arguments or remaining budget')
  }
  const body = Buffer.from(JSON.stringify({ v: 1, type: 'run', executionId, argv, remainingMs }))
  if (body.length > 128 * 1024) throw new SupervisorProtocolError('Supervisor run exceeds 128 KiB')
  return Buffer.concat([body, Buffer.from('\n')])
}

/** Encode one cancellation request.
 * @param executionId - The execution bound to the dedicated control connection.
 * @param reason - The first cancellation requested by the caller.
 * @returns One JSON line for supervisor stdin.
 */
export function encodeCancel(executionId: SandboxExecutionId, reason: SupervisorCancelReason): Buffer {
  return Buffer.from(`${JSON.stringify({ v: 1, type: 'cancel', executionId, reason })}\n`)
}

/** Parse Docker frames and supervisor messages without retaining Engine read buffers. */
export class SupervisorProtocol {
  private readonly header = Buffer.alloc(8)
  private headerBytes = 0
  private remaining = 0
  private stream = 0
  private readonly line = Buffer.alloc(16 * 1024)
  private lineBytes = 0
  private readonly utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  private phase: 'awaiting_ready' | 'ready' | 'running' | 'not_started_cleanup' | 'finished' = 'awaiting_ready'
  private completion: SupervisorFinished | undefined
  private readonly output = {
    stdout: new TextRetainer({ kind: 'tail', maxBytes: 64 * 1024 }),
    stderr: new TextRetainer({ kind: 'tail', maxBytes: 64 * 1024 }),
  }
  private readonly diagnostic = new TextRetainer({ kind: 'tail', maxBytes: 64 * 1024 })

  /**
   * @param executionId - Identity expected on every supervisor message.
   * @param ready - Starts the caller's generation recheck before run may be sent.
   * @param completed - Bounds stream closure and Docker Inspect after finished.
   */
  constructor(
    private readonly executionId: SandboxExecutionId,
    private readonly ready: () => void,
    private readonly completed: (finished: SupervisorFinished) => void,
  ) {}

  /** Whether ready has arrived and no command or cancellation has been sent. */
  get canRun(): boolean { return this.phase === 'ready' }

  /** Whether the supervisor has already reported its final cleanup confirmation. */
  get isFinished(): boolean { return this.phase === 'finished' }

  /** Bounded supervisor diagnostics, never mixed with user stderr. */
  get diagnostics(): string { return this.diagnostic.finish().text }

  /** Record the single run before queuing its bytes on the connection. */
  runSent(): void {
    if (!this.canRun) throw new SupervisorProtocolError('Run sent outside supervisor readiness')
    this.phase = 'running'
  }

  /** Record a cancellation; before run, a successful completion must have no Bash status. */
  cancelSent(): void {
    if (this.phase === 'ready') this.phase = 'not_started_cleanup'
    else if (this.phase !== 'running') throw new SupervisorProtocolError('Cancel sent outside supervisor readiness')
  }

  /** Consume arbitrary fragments, including bytes from the HTTP Upgrade head.
   * @param chunk - Docker multiplexed bytes; views into this buffer are not retained.
   */
  push(chunk: Buffer): void {
    let offset = 0
    while (offset < chunk.length) {
      if (this.remaining === 0) {
        const copied = chunk.copy(this.header, this.headerBytes, offset, offset + this.header.length - this.headerBytes)
        offset += copied
        this.headerBytes += copied
        if (this.headerBytes < this.header.length) break
        this.stream = this.header[0] ?? 0
        if ((this.stream !== 1 && this.stream !== 2) || this.header.readUIntBE(1, 3) !== 0) {
          throw new SupervisorProtocolError('Invalid Docker multiplexed stream header')
        }
        this.remaining = this.header.readUInt32BE(4)
        this.headerBytes = 0
      }
      const size = Math.min(this.remaining, chunk.length - offset)
      if (this.stream === 1) this.readLines(chunk.subarray(offset, offset + size))
      else if (size > 0) this.diagnostic.push(Uint8Array.from(chunk.subarray(offset, offset + size)))
      this.remaining -= size
      offset += size
    }
  }

  /** Validate stream EOF and return the command result only after finished.
   * @returns Confirmed cleanup and independent user output tails.
   */
  finish(): SupervisorResult {
    if (this.headerBytes !== 0 || this.remaining !== 0 || this.lineBytes !== 0 || !this.completion) {
      throw new SupervisorProtocolError('Incomplete Docker stream or missing supervisor finished')
    }
    const stdout = this.output.stdout.finish()
    const stderr = this.output.stderr.finish()
    return {
      finished: this.completion,
      stdout: { text: stdout.text, truncated: stdout.truncated || this.completion.outputTruncated.stdout },
      stderr: { text: stderr.text, truncated: stderr.truncated || this.completion.outputTruncated.stderr },
    }
  }

  private readLines(bytes: Buffer): void {
    let offset = 0
    while (offset < bytes.length) {
      const end = bytes.indexOf(10, offset)
      const size = (end === -1 ? bytes.length : end) - offset
      if (this.lineBytes + size > this.line.length) throw new SupervisorProtocolError('Supervisor message exceeds 16 KiB')
      bytes.copy(this.line, this.lineBytes, offset, offset + size)
      this.lineBytes += size
      if (end === -1) return
      try {
        const value: unknown = JSON.parse(this.utf8.decode(this.line.subarray(0, this.lineBytes)))
        this.accept(message.parse(value))
      } catch (cause) {
        if (cause instanceof SupervisorProtocolError) throw cause
        throw new SupervisorProtocolError('Invalid supervisor JSON message', { cause })
      }
      this.lineBytes = 0
      offset = end + 1
    }
  }

  private accept(value: z.output<typeof message>): void {
    if (value.executionId !== this.executionId || this.phase === 'finished') {
      throw new SupervisorProtocolError('Unexpected execution ID or message after finished')
    }
    if (value.type === 'ready') {
      if (this.phase !== 'awaiting_ready') throw new SupervisorProtocolError('Duplicate or out-of-order ready')
      this.phase = 'ready'
      this.ready()
    } else if (value.type === 'output') {
      if (this.phase !== 'running') throw new SupervisorProtocolError('User output before run')
      const decoded = Buffer.from(value.data, 'base64')
      if (decoded.length < 1 || decoded.length > 8192 || decoded.toString('base64') !== value.data) {
        throw new SupervisorProtocolError('Invalid supervisor output base64')
      }
      this.output[value.stream].push(Uint8Array.from(decoded))
    } else {
      const started = this.phase === 'running'
      if ((!started && this.phase !== 'not_started_cleanup') || started !== (value.bash !== null)
        || (value.reason === 'exited' && value.bash === null)) {
        throw new SupervisorProtocolError('Finished does not match command admission or Bash status')
      }
      this.completion = value
      this.phase = 'finished'
      this.completed(value)
    }
  }
}
