/** External model with explicit request gates for native message, queue and Runner execution tests. */
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const inject = ['llm', 'webServer']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Isolated Web profile with a controlled external model. */
export function apply(ctx) {
  const held = new Map()
  const observed = []
  const waiters = new Map()
  class Model extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async * stream(options) {
      const input = options.messages.findLast(message => message.role === 'user' && message.source.kind === 'user')
      const task = JSON.parse(input.content[0].text)
      const id = `idle-${task.label}`
      const result = options.messages.find(message => message.role === 'tool' && message.toolCallId === id)
      const record = { label: task.label, cancelled: options.signal.aborted, tools: options.tools.map(tool => tool.name) }
      observed.push(record)
      const abort = () => { record.cancelled = true }
      options.signal.addEventListener('abort', abort, { once: true })
      try {
        if (!result && task.hold) {
          const gate = Promise.withResolvers()
          held.set(task.label, gate)
          const cancelled = Promise.withResolvers()
          const cancel = () => cancelled.resolve()
          options.signal.addEventListener('abort', cancel, { once: true })
          waiters.get(task.label)?.()
          waiters.delete(task.label)
          try { await Promise.race([gate.promise, cancelled.promise]); options.signal.throwIfAborted() }
          finally { options.signal.removeEventListener('abort', cancel); held.delete(task.label) }
        } else { waiters.get(task.label)?.(); waiters.delete(task.label) }
        if (task.bash && !result) {
          const args = JSON.stringify({ command: `printf PROFILE_IDLE_OK_${task.label}`, description: 'Inspect persistent workspace' })
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'bash', arguments: args } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        } else {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: `Observed ${task.label}` } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      } finally { options.signal.removeEventListener('abort', abort) }
    }
  }
  ctx.llm.registerAdapter(['sandbox-idle-fixture'], new Model())
  ctx.effect(() => () => { for (const gate of held.values()) gate.resolve() })
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/__test/sandbox-idle-model', handler: async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const control = JSON.parse(raw)
    if (control.op === 'release') held.get(control.label)?.resolve()
    else if (control.op === 'wait' && !observed.some(item => item.label === control.label)) {
      await new Promise(resolve => waiters.set(control.label, resolve))
    }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(observed))
  } }))
}
