/** Bounded result retrieval and cancellation of one original Runner execution. */
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { SandboxExecutionPermit } from './conversation.ts'
import type { RunnerExecutionRequest, RunnerExecutionResult } from './execution.ts'
import { RunnerExecutionError, RunnerRequestError, RunnerResponseError } from './runner-client.ts'
import type {} from './transport.ts'
import type {} from './index.ts'

/**
 * Execute once, retrieving at most once under the original identity and draining cancellation.
 * @param ctx - Owned Runner transport and authorized management services.
 * @param permit - Original message permission, including its confirmed container.
 * @param request - Saved complete request; never changed during retrieval.
 * @param signal - Tool, permission and plugin cancellation fused by the caller.
 * @param check - Synchronous recheck of the original turn before uncancelled dispatch.
 * @returns The Runner's real command result, including nonzero exits.
 */
export async function runBashExecution(
  ctx: Context, permit: SandboxExecutionPermit, request: RunnerExecutionRequest,
  signal: AbortSignal, check: () => void,
): Promise<RunnerExecutionResult> {
  const transport = ctx.sandboxRunnerClient
  const manager = ctx.workspaceSandbox
  let submitted = false
  let terminal = false
  let cancelling: Promise<boolean> | undefined
  const diagnostics = (event: string, outcome: unknown) => {
    ctx.logger.warn('sandbox-bash: %s %o', event, {
      workspaceId: permit.workspaceId, executionId: request.executionId, containerId: request.expectedContainerId, outcome,
    })
  }
  const cancel = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await transport.cancel(permit.workspaceId, { executionId: request.executionId, expectedContainerId: request.expectedContainerId })
        return true
      } catch (error) {
        if (attempt === 0 && !terminal && error instanceof RunnerResponseError && error.statusCode === 404) continue
        diagnostics('cancellation not confirmed', error instanceof RunnerResponseError ? { code: error.code } : { code: 'transport_failed' })
        return false
      }
    }
    return false
  }
  const aborted = () => { if (submitted && !terminal) cancelling ??= cancel() }
  signal.addEventListener('abort', aborted, { once: true })
  try {
    check()
    signal.throwIfAborted()
    let pending = transport.execute(permit.workspaceId, request)
    submitted = true
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await pending
        terminal = true
        if (cancelling !== undefined) {
          await cancelling
          diagnostics('cancelled wait settled', result)
        }
        return result
      } catch (error) {
        if (error instanceof TypeError) {
          terminal = true
          throw new HarnessError('Invalid command request. Check the arguments and keep the complete UTF-8 JSON request within 64 KiB.', 'SANDBOX_INVALID_REQUEST', { cause: error })
        }
        if (error instanceof RunnerExecutionError) terminal = true
        const lost = error instanceof RunnerRequestError && error.code === 'runner_outcome_unknown'
        const evidence = lost && attempt === 0 ? await retrievable() : 'none'
        if (evidence === 'record' || evidence === 'running' && !isAborted(signal)) {
          if (!isAborted(signal)) check()
          // Cancellation requires a matching cancel acknowledgement: this must only read an existing record.
          pending = transport.execute(permit.workspaceId, request)
          continue
        }
        if (cancelling !== undefined) await cancelling
        const uncertain = error instanceof RunnerExecutionError
          ? error.execution.cleanup === 'unconfirmed'
          : lost || error instanceof RunnerResponseError && error.outcomeUnknown
        let closure: 'unneeded' | 'confirmed' | 'unconfirmed' | 'superseded' = 'unneeded'
        if (uncertain) {
          try {
            await manager.closeForUser(permit.userId, permit.workspaceId, { containerId: permit.containerId, version: permit.version })
            closure = 'confirmed'
          } catch (failure) {
            closure = remoteErrorOf(failure)?.code === 'gateway/cancelled' ? 'superseded' : 'unconfirmed'
          }
        }
        diagnostics('execution failed', {
          code: error instanceof RunnerResponseError || error instanceof RunnerRequestError ? error.code : 'dispatch_failed',
          ...error instanceof RunnerExecutionError ? { execution: error.execution } : {}, closure,
        })
        throw failure(error, request.timeoutMs, closure)
      }
    }
  } finally {
    signal.removeEventListener('abort', aborted)
    if (cancelling !== undefined) await cancelling
  }

  async function retrievable(): Promise<'record' | 'running' | 'none'> {
    if (isAborted(signal)) return cancelling !== undefined && await cancelling ? 'record' : 'none'
    try {
      check()
      const state = await manager.statusForUser(permit.userId, permit.workspaceId)
      if (isAborted(signal)) return cancelling !== undefined && await cancelling ? 'record' : 'none'
      check()
      return state.state === 'running' && state.containerId === request.expectedContainerId ? 'running' : 'none'
    } catch {
      return 'none'
    }
  }
}

function isAborted(signal: AbortSignal): boolean { return signal.aborted }

function failure(error: unknown, timeoutMs: number, closure: string): HarnessError {
  let code = 'SANDBOX_EXECUTION_REJECTED'
  let text = 'The command could not run in its original execution environment.'
  if (error instanceof RunnerExecutionError) {
    code = `SANDBOX_${error.code.toUpperCase()}`
    if (error.code === 'execution_timeout') text = `Command timed out after ${timeoutMs}ms.`
    else if (error.code === 'execution_cancelled') text = 'Command was cancelled.'
    else text = 'The command result is unknown. Check workspace files before running it again.'
    if (error.execution.cleanup === 'not_started') text += ' The process was not started.'
    else if (error.execution.cleanup === 'processes_cleaned') text += ' Process cleanup is confirmed.'
    else if (error.execution.cleanup === 'container_removed') text += ' Its execution environment was removed.'
    if (error.execution.bash != null) {
      text += error.execution.bash.signal === null
        ? ` Bash exited with code ${error.execution.bash.exitCode}.`
        : ` Bash terminated with signal ${error.execution.bash.signal}.`
    }
  } else if (error instanceof RunnerRequestError) {
    code = `SANDBOX_${error.code.toUpperCase()}`
    text = error.code === 'runner_unavailable'
      ? 'The command service is unavailable.'
      : 'The command result is unknown. Check workspace files before running it again.'
  } else if (error instanceof RunnerResponseError && error.code === 'execution_limit') {
    code = 'SANDBOX_EXECUTION_LIMIT'
    text = 'This workspace has reached its command record limit.'
  }
  if (closure === 'confirmed') text += ' The workspace execution environment was closed; other commands were interrupted.'
  if (closure === 'unconfirmed') text += ' Workspace closure is unconfirmed; further execution is blocked.'
  return new HarnessError(text, code, { cause: error })
}
