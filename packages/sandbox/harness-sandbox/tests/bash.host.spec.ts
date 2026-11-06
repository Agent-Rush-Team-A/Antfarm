import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { runnerWorkdir } from '../src/bash.ts'
import type { RunnerExecutionRequest } from '../src/execution.ts'
import { bashFixture } from './fixtures/bash.ts'
import { running } from './fixtures/management.ts'

const args = { command: 'printf original; exit 7', description: 'Inspect command result' }

test.each([
  [undefined, '.'], ['.', '.'], ['/workspace', '.'], ['src', 'src'], ['./src', 'src'],
  ['/workspace/src', 'src'], ['/workspace//src/', 'src/'], ['src/./child', 'src/child'],
])('normalizes %s as %s', (path, expected) => { expect(runnerWorkdir(path)).toBe(expected) })

test.each(['', ' ', '/etc', '/workspace-other', '/workspace/../etc', '../x', 'src/../x', 'C:/work', 'C:work', '\\server\\share', 'x\0y', '\ud800'])('rejects directory %j', (path) => {
  expect(() => runnerWorkdir(path)).toThrow()
})

test('real model/tool pipeline logs nonzero output and returns it in the next model request', async () => {
  const f = await bashFixture()
  f.control.respond = (response, method, call) => {
    if (call.path?.endsWith('/exec')) {
      const request = call.body as RunnerExecutionRequest
      expect(request).toMatchObject({ command: args.command, workdir: 'src', timeoutMs: 30_000, expectedContainerId: running.containerId })
      response.end(JSON.stringify({ executionId: request.executionId, exitCode: 7,
        stdout: { text: '你好\n', truncated: true }, stderr: { text: 'specific error\n', truncated: false } }))
    } else response.end(JSON.stringify(method === 'DELETE' ? { state: 'closed' } : running))
  }
  const result = await f.run({ ...args, workdir: '/workspace/src' })
  expect(result).toMatchObject({ isError: false, value: { cwd: '/workspace/src', exitCode: 7 } })
  expect(result.content).toEqual([{ type: 'text', text: '你好\n\n[output truncated; full output: (unavailable)]\n[stderr]\nspecific error\n[exit code: 7]' }])
  expect(JSON.stringify(result)).not.toContain(running.containerId)
  expect(JSON.stringify(result)).not.toContain('signal')
  expect(f.logged).toHaveLength(1)
  expect(f.logged[0]?.data.message.content).toEqual(result.content)
  expect(f.model.requests[1]?.messages.some(message => message.role === 'tool' && JSON.stringify(message.content) === JSON.stringify(result.content))).toBe(true)
  expect(f.calls.map(call => call.method)).toEqual(['PUT', 'POST'])
})

test.each([
  { run_in_background: true }, { promoteOnTimeout: true }, { sandbox_permissions: 'require_escalated' },
  { workspaceId: 'forged' }, { expectedContainerId: running.containerId }, { timeoutMs: 0 }, { timeoutMs: 60_001 },
  { timeoutMs: 1.5 }, { workdir: '/etc' }, { command: ' ' },
])('invalid arguments never reach Runner: %j', async (extra) => {
  const f = await bashFixture()
  const result = await f.run({ ...args, ...extra })
  expect(result.isError).toBe(true)
  expect(f.calls.map(call => call.method)).toEqual(['PUT'])
})

test('direct execution without original step admission stops before exec', async () => {
  const f = await bashFixture()
  const direct = await f.ctx.tools.execute({ agent: f.agent, signal: new AbortController().signal,
    calls: [{ type: 'tool-call', id: ToolCallId(randomUUID()), name: 'bash', arguments: JSON.stringify(args) }] })
  expect(direct.results[0]?.result.isError).toBe(true)
  expect(f.calls).toEqual([])
})

test('a lost exec response is retrieved at most once with exactly the same request', async () => {
  const f = await bashFixture()
  const respond = f.control.respond
  let execs = 0
  f.control.respond = (response, method, call) => {
    if (call.path?.endsWith('/exec') && ++execs === 1) response.destroy()
    else respond(response, method, call)
  }
  expect((await f.run()).isError).toBe(false)
  const sent = f.calls.filter(call => call.path?.endsWith('/exec'))
  expect(sent).toHaveLength(2)
  expect(sent[0]?.body).toEqual(sent[1]?.body)
  expect(f.calls.map(call => call.method)).toEqual(['PUT', 'POST', 'GET', 'POST'])
})

test('pwd output is valid for the next workdir and is sent as a relative Runner directory', async () => {
  const f = await bashFixture()
  const first = await f.run()
  const block = first.content[0]
  expect(block?.type).toBe('text')
  if (block?.type !== 'text') throw new Error('text result required')
  expect((await f.run({ command: 'pwd', description: 'Reuse reported directory', workdir: block.text.trim() })).isError).toBe(false)
  expect(f.calls.filter(call => call.path?.endsWith('/exec')).map(call => (call.body as RunnerExecutionRequest).workdir)).toEqual(['.', '.'])
})

test('retained large output and UI status use real fields without guessing from stdout', async () => {
  const f = await bashFixture()
  const stdout = `${'中\0'.repeat(16_000)}\n[exit code: 7]`
  const stderr = 'e'.repeat(64 * 1024)
  const respond = f.control.respond
  f.control.respond = (response, method, call) => {
    if (call.path?.endsWith('/exec')) response.end(JSON.stringify({ executionId: (call.body as RunnerExecutionRequest).executionId,
      exitCode: 0, stdout: { text: stdout, truncated: true }, stderr: { text: stderr, truncated: false } }))
    else respond(response, method, call)
  }
  const result = await f.run()
  expect(result).toMatchObject({ isError: false, value: { stdout: { text: stdout }, stderr: { text: stderr } }, meta: { exitCode: 0 } })
  const definition = f.ctx.tools.get('bash', f.agent)
  expect(definition?.presentResult?.(args, result)).toMatchObject({ card: 'terminal', exitCode: 0 })
  expect(JSON.stringify(result)).not.toContain('spillPath')
})

test('execution record capacity is an explicit error without retries or recycling', async () => {
  const f = await bashFixture()
  const respond = f.control.respond
  f.control.respond = (response, method, call) => {
    if (call.path?.endsWith('/exec')) response.writeHead(409).end(JSON.stringify({ error: 'execution_limit' }))
    else respond(response, method, call)
  }
  const result = await f.run()
  expect(result).toMatchObject({ isError: true, error: { info: { code: 'SANDBOX_EXECUTION_LIMIT' } } })
  expect(f.calls.map(call => call.method)).toEqual(['PUT', 'POST'])
})

test.each(['processes_cleaned', 'not_started', 'container_removed', 'unconfirmed'])('execution failure preserves cleanup %s', async (cleanup) => {
  const f = await bashFixture()
  const respond = f.control.respond
  f.control.respond = (response, method, call) => {
    if (call.path?.endsWith('/exec')) {
      const request = call.body as RunnerExecutionRequest
      const timeout = cleanup === 'processes_cleaned' || cleanup === 'not_started'
      response.writeHead(timeout ? 504 : 503).end(JSON.stringify({ error: timeout ? 'execution_timeout' : 'execution_outcome_unknown',
        executionId: request.executionId, containerId: request.expectedContainerId,
        reason: timeout ? 'timeout' : null, cleanup, ...(timeout ? { bash: { exitCode: 0, signal: null } } : {}) }))
    } else respond(response, method, call)
  }
  const result = await f.run()
  expect(result.isError).toBe(true)
  if (cleanup === 'processes_cleaned' || cleanup === 'not_started') {
    expect(result).toMatchObject({ error: { info: { code: 'SANDBOX_EXECUTION_TIMEOUT' } } })
    expect(JSON.stringify(result.content)).toContain('timed out')
    expect(JSON.stringify(result.content)).toContain('Bash exited with code 0')
  }
  expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(cleanup === 'unconfirmed' ? 1 : 0)
})
