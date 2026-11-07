/** Resource cleanup and independent process checks for the real spreadsheet acceptance. */
import { readFile } from 'node:fs/promises'
import { execa } from 'execa'
import { z } from 'zod'

type ResourceKind = 'instances' | 'snapshots'

/** Cloud operations scoped to the acceptance run's deployment. */
export interface CloudCleanup {
  inventory: (kind: ResourceKind) => Promise<readonly { id: string }[]>
  remove: (kind: ResourceKind, id: string) => Promise<void>
  verifyEmpty: (kind: ResourceKind) => Promise<void>
}

/**
 * Continue after each inventory or deletion failure, then verify both inventories independently.
 * @param operations - deployment-filtered cloud operations.
 * @returns failures that prevent the acceptance run from succeeding.
 */
export async function cleanupCloudResources(operations: CloudCleanup): Promise<unknown[]> {
  const failures: unknown[] = []
  for (const kind of ['instances', 'snapshots'] as const) {
    let items: readonly { id: string }[]
    try { items = await operations.inventory(kind) }
    catch (error) {
      failures.push(new Error(`Cloud cleanup list ${kind}: ${String(error)}`, { cause: error }))
      continue
    }
    for (const item of items) {
      try { await operations.remove(kind, item.id) }
      catch (error) { failures.push(new Error(`Cloud cleanup delete ${kind}/${item.id}: ${String(error)}`, { cause: error })) }
    }
  }
  for (const kind of ['instances', 'snapshots'] as const) {
    try { await operations.verifyEmpty(kind) }
    catch (error) { failures.push(new Error(`Cloud cleanup verify ${kind}: ${String(error)}`, { cause: error })) }
  }
  return failures
}

/** Both recorded processes outlive the two-hour test unless the execution provider terminates them. */
export const TIMEOUT_PROBE_COMMAND = 'sleep 86400 & child=$!; printf "%s %s\\n" "$$" "$child" > timeout.pids; wait "$child"'

/**
 * Require the logged timeout turn to execute only the long-lived probe with the requested deadline.
 * @param logs - independently decoded Session files.
 */
export function verifyTimeoutInvocation(logs: string[]): void {
  let found = 0
  const callSchema = z.object({ turn: z.number(), name: z.string(), arguments: z.string() })
  for (const log of logs) {
    const events = log.split('\n').filter(line => line.trim() !== '')
      .map(line => z.object({ type: z.string(), data: z.unknown().optional() }).parse(JSON.parse(line)))
    const calls = events.filter(event => event.type === 'tool/call').map(event => callSchema.parse(event.data))
    for (const call of calls) {
      if (call.name !== 'bash') continue
      const args = z.object({ command: z.string(), timeoutMs: z.number().optional() }).parse(JSON.parse(call.arguments))
      if (!args.command.includes('timeout.pids')) continue
      found++
      if (![TIMEOUT_PROBE_COMMAND, 'cd /workspace && ' + TIMEOUT_PROBE_COMMAND].includes(args.command)
        || args.timeoutMs !== 1000 || calls.filter(other => other.turn === call.turn).length !== 1) {
        throw new Error('The timeout turn must execute only the 24-hour probe with timeoutMs=1000')
      }
    }
  }
  if (found !== 1) throw new Error(`Expected one logged timeout probe, received ${found}`)
}

/**
 * Run the Linux process-state probe independently of the model and bound its transport lifetime.
 * @param command - Python locally or OpenSSH for the real Workspace VM.
 * @param args - argv invoking Python with stdin source, the PID-file path and cleanup deadline in seconds.
 * @returns the independently observed terminated processes and elapsed verification time.
 */
export async function verifyTimeoutProcesses(command: string, args: string[]) {
  const source = await readFile(new URL('./fixtures/workspace-spreadsheet/timeout-process-check.py', import.meta.url), 'utf8')
  const result = await execa(command, args, { input: source, timeout: 10_000, killSignal: 'SIGKILL', reject: false })
  if (result.failed) {
    throw new Error(`Independent timeout process check failed (exit ${String(result.exitCode)}, timedOut ${String(result.timedOut)}): ${result.stderr}`)
  }
  return z.object({ verified: z.literal(true), pids: z.array(z.number().int().positive()).length(2), elapsedMs: z.number() })
    .parse(JSON.parse(result.stdout))
}
