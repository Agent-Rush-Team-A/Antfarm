import { randomUUID } from 'node:crypto'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as Bash from '../../src/bash.ts'
import type { RunnerExecutionRequest } from '../../src/execution.ts'
import { conversationFixture } from './conversation.ts'
import { running } from './management.ts'

export class BashModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly seen = new Set<string>()
  args: unknown = { command: 'pwd', description: 'Inspect directory' }
  toolName = 'bash'
  override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model }) }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const key = JSON.stringify(options.messages.filter(message => message.role === 'user' && message.source?.kind === 'user').at(-1))
    if (!this.seen.has(key)) {
      this.seen.add(key)
      const id = ToolCallId(randomUUID())
      const args = JSON.stringify(this.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: this.toolName, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: this.toolName, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'finished' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'finished' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

export async function bashFixture(execTimeoutMs = 1000, queryTimeoutMs?: number) {
  const model = new BashModel()
  const f = await conversationFixture(model, execTimeoutMs, queryTimeoutMs)
  const fiber = f.ctx.plugin(Bash)
  await fiber
  const results: Array<{ exec: ToolExecution; result: ToolExecutionResult }> = []
  const logged: SessionEvent<'tool/result'>[] = []
  f.ctx.on('tools/result', (exec, result) => { results.push({ exec, result }) }, { global: true })
  f.ctx.on('session/event', (_session, event) => { if (event.type === 'tool/result') logged.push(event) }, { global: true })
  f.control.respond = (response, method, call) => {
    if (call.path?.endsWith('/exec')) {
      const request = call.body as RunnerExecutionRequest
      response.end(JSON.stringify({ executionId: request.executionId, exitCode: 0,
        stdout: { text: '/workspace\n', truncated: false }, stderr: { text: '', truncated: false } }))
    } else response.end(JSON.stringify(method === 'DELETE' ? { state: 'closed' } : running))
  }
  async function run(args = model.args) {
    model.args = args
    await f.prompt(randomUUID())
    f.release()
    await f.agent.whenIdle()
    return results.at(-1)!.result
  }
  return { ...f, model, fiber, results, logged, run }
}
