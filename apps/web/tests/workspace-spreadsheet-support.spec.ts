/** Failure-path coverage for acceptance cleanup and its independent timeout oracle. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { expect, test } from 'vitest'
import { cleanupCloudResources, TIMEOUT_PROBE_COMMAND, verifyTimeoutInvocation, verifyTimeoutProcesses } from './workspace-spreadsheet-support.ts'

function invocation(command = TIMEOUT_PROBE_COMMAND, timeoutMs = 1000): string {
  return JSON.stringify({ type: 'tool/call', data: { turn: 2, name: 'bash', arguments: JSON.stringify({ command, timeoutMs }) } })
}

test('timeout evidence requires the long-lived command and forbids model cleanup in the same turn', () => {
  expect(() => { verifyTimeoutInvocation([invocation()]) }).not.toThrow()
  expect(() => { verifyTimeoutInvocation([invocation('cd /workspace && ' + TIMEOUT_PROBE_COMMAND)]) }).not.toThrow()
  expect(() => { verifyTimeoutInvocation([invocation(TIMEOUT_PROBE_COMMAND.replace('86400', '20'))]) }).toThrow('24-hour probe')
  expect(() => { verifyTimeoutInvocation([invocation(TIMEOUT_PROBE_COMMAND, 2000)]) }).toThrow('timeoutMs=1000')
  expect(() => { verifyTimeoutInvocation([invocation() + '\n' + invocation('kill 1234')]) }).toThrow('only')
  expect(() => { verifyTimeoutInvocation([]) }).toThrow('Expected one logged timeout probe')
})

test.each(['request timeout', 'HTTP 429', 'HTTP 503'])('cleanup continues after a DELETE fails: %s', async (message) => {
  const events: string[] = []
  const failures = await cleanupCloudResources({
    inventory: async (kind) => {
      events.push(`list ${kind}`)
      return [{ id: kind + '-1' }, { id: kind + '-2' }]
    },
    remove: async (_kind, id) => {
      events.push(`delete ${id}`)
      if (id === 'instances-1') throw new Error(message)
    },
    verifyEmpty: async (kind) => {
      events.push(`verify ${kind}`)
      if (kind === 'instances') throw new Error('instances-1 remains')
    },
  })
  expect(events).toEqual([
    'list instances', 'delete instances-1', 'delete instances-2',
    'list snapshots', 'delete snapshots-1', 'delete snapshots-2', 'verify instances', 'verify snapshots',
  ])
  expect(failures.map(String).join('\n')).toContain(message)
  expect(failures.map(String).join('\n')).toContain('instances-1 remains')
})

test('an unavailable instance inventory does not prevent snapshot cleanup or either final verification', async () => {
  const events: string[] = []
  const failures = await cleanupCloudResources({
    inventory: async (kind) => {
      events.push(`list ${kind}`)
      if (kind === 'instances') throw new Error('list unavailable')
      return [{ id: 'snapshot-1' }]
    },
    remove: async (_kind, id) => { events.push(`delete ${id}`) },
    verifyEmpty: async (kind) => { events.push(`verify ${kind}`) },
  })
  expect(events).toEqual(['list instances', 'list snapshots', 'delete snapshot-1', 'verify instances', 'verify snapshots'])
  expect(failures.map(String).join('\n')).toContain('list unavailable')
})

test('successful cleanup returns no failures after verifying both inventories', async () => {
  const verified: string[] = []
  expect(await cleanupCloudResources({
    inventory: async () => [],
    remove: async () => { throw new Error('No deletion expected') },
    verifyEmpty: async (kind) => { verified.push(kind) },
  })).toEqual([])
  expect(verified).toEqual(['instances', 'snapshots'])
})

test('multiple failed deletions and failed final inventories all remain visible', async () => {
  const events: string[] = []
  const failures = await cleanupCloudResources({
    inventory: async kind => [{ id: kind + '-1' }, { id: kind + '-2' }],
    remove: async (_kind, id) => {
      events.push(`delete ${id}`)
      throw new Error(`delete failed ${id}`)
    },
    verifyEmpty: async (kind) => {
      events.push(`verify ${kind}`)
      throw new Error(`verify failed ${kind}`)
    },
  })
  expect(events).toEqual(['delete instances-1', 'delete instances-2', 'delete snapshots-1', 'delete snapshots-2',
    'verify instances', 'verify snapshots'])
  expect(failures).toHaveLength(6)
})

test.skipIf(process.platform !== 'linux')('independent probe rejects leaked processes, including an orphan child, and accepts termination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spreadsheet-timeout-oracle-'))
  const child = spawn('bash', ['-c', TIMEOUT_PROBE_COMMAND], { cwd: root, detached: true, stdio: 'ignore' })
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', () => { resolve() })
  })
  try {
    const path = join(root, 'timeout.pids')
    await expect.poll(async () => (await readFile(path, 'utf8')).trim()).toMatch(/^\d+ \d+$/u)
    const pids = (await readFile(path, 'utf8')).trim().split(' ').map(Number)
    await expect(verifyTimeoutProcesses('python3', ['-', path, '0.1'])).rejects.toThrow('still alive')
    child.kill('SIGKILL')
    await exited
    // The observer must still reject when the shell is gone but its sleep child survives.
    process.kill(pids[1]!, 0)
    await expect(verifyTimeoutProcesses('python3', ['-', path, '0.1'])).rejects.toThrow(String(pids[1]))
    process.kill(pids[1]!, 'SIGKILL')
    expect(await verifyTimeoutProcesses('python3', ['-', path, '5'])).toMatchObject({ verified: true, pids })
    await writeFile(path, 'not a PID\n')
    await expect(verifyTimeoutProcesses('python3', ['-', path, '0.1'])).rejects.toThrow('Expected the shell and child PIDs')
  } finally {
    if (child.pid !== undefined) {
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
      }
    }
    await exited
    await rm(root, { recursive: true, force: true })
  }
})
