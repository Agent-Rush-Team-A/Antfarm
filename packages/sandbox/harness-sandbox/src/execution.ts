/** Runner execution wire validation; callers retain the complete request for any result retrieval. */

import { posix } from 'node:path'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import type { SandboxContainerId } from './runner-client.ts'

/** One caller-generated command identity, retained unchanged within its container generation. */
export type RunnerExecutionId = Branded<'RunnerExecutionId'>

const argumentText = (value: string) => value.isWellFormed() && !value.includes('\0')
const executionId = z.string().min(1).max(128).refine(argumentText).transform(value => brandString<RunnerExecutionId>(value))
const containerId = z.string().regex(/^[a-f0-9]{64}$/u).transform(value => brandString<SandboxContainerId>(value))

/** Validate the original execution and full container identity before dispatch. */
export const executionIdentity = z.strictObject({ executionId, expectedContainerId: containerId })

/** Validate a fully resolved request without generating identities or changing its command or directory. */
export const executionRequest = executionIdentity.extend({
  command: z.string().refine(value => argumentText(value) && value.trim().length > 0),
  workdir: z.string().min(1).refine(value => argumentText(value) && !posix.isAbsolute(value) && !value.split('/').includes('..')),
  timeoutMs: z.int().min(1).max(60_000),
})

/** Original identity required for cancellation; no command is submitted. */
export type RunnerExecutionIdentity = z.output<typeof executionIdentity>

/** Complete request retained by the caller; workdir and command timeout must be resolved before calling. */
export type RunnerExecutionRequest = z.output<typeof executionRequest>

const output = z.strictObject({ text: z.string(), truncated: z.boolean() })

/** Validate a confirmed command result, including nonzero exits and independent output tails. */
export const executionResult = z.strictObject({ executionId, exitCode: z.int().min(0).max(255), stdout: output, stderr: output })

/** Confirmed command exit; contains no inferred signal, container id or spill file. */
export type RunnerExecutionResult = z.output<typeof executionResult>

/** Validate cancellation acceptance independently of the original execution's final result. */
export const cancellationResult = z.strictObject({ executionId, containerId, cancellation: z.enum(['requested', 'settled']) })

/** Cancellation acknowledgement, never a guarantee that command cleanup completed or cancellation won. */
export type RunnerCancellationResult = z.output<typeof cancellationResult>

/** Failure codes whose responses must retain execution identity and cleanup evidence. */
export const executionFailureCode = z.enum(['execution_timeout', 'execution_cancelled', 'execution_outcome_unknown', 'execution_container_recycled'])

const bash = z.union([
  z.strictObject({ exitCode: z.int().min(0).max(255), signal: z.null() }),
  z.strictObject({ exitCode: z.null(), signal: z.int().min(1).max(64) }),
]).nullable()
const failure = z.strictObject({
  executionId, containerId,
  reason: z.enum(['exited', 'timeout', 'cancelled', 'shutdown', 'control_eof']).nullable(),
  bash: bash.optional(),
})
const cleaned = z.enum(['not_started', 'processes_cleaned'])
const removed = z.enum(['container_removed', 'unconfirmed'])

/** Validate error-specific cleanup guarantees without synthesizing unknown Bash status. */
export const executionFailure = z.discriminatedUnion('error', [
  failure.extend({ error: z.literal('execution_timeout'), reason: z.literal('timeout'), cleanup: cleaned }),
  failure.extend({ error: z.literal('execution_cancelled'), reason: z.enum(['cancelled', 'shutdown']), cleanup: cleaned }),
  failure.extend({ error: z.literal('execution_outcome_unknown'), cleanup: removed }),
  failure.extend({ error: z.literal('execution_container_recycled'), cleanup: removed }),
])

/** Structured failure fields preserved from the original execution; omitted Bash status remains unknown. */
export type RunnerExecutionFailure = Omit<z.output<typeof executionFailure>, 'error'>

/** Stable execution termination or lost-result identifier. */
export type RunnerExecutionFailureCode = z.output<typeof executionFailureCode>
