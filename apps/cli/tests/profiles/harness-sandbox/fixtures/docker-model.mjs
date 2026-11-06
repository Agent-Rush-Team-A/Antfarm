/** Scripted external model and observations for real-Docker conversation acceptance. */
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { sessionFormatCatalog } from '../../../../../../packages/session/session-format-catalog/lib/index.js'

export const inject = ['llm', 'webServer', 'agents', 'sessions', 'sessionPersistence', 'loader']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Isolated built Web profile. */
export function apply(ctx) {
  const held = new Map()
  const requests = []
  class Model extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async * stream(options) {
      const input = options.messages.findLast(message => message.role === 'user' && message.source.kind === 'user')
      const task = JSON.parse(input.content[0].text)
      const id = `docker-${task.label}`
      requests.push({ sessionId: options.sessionId, label: task.label, tools: options.tools,
        contexts: options.messages.filter(message => message.source?.kind === 'runtime-context'),
        results: options.messages.filter(message => message.role === 'tool' && message.toolCallId === id) })
      if (!options.messages.some(message => message.role === 'tool' && message.toolCallId === id)) {
        if (task.hold) {
          const gate = Promise.withResolvers()
          held.set(task.label, gate)
          await gate.promise
        }
        const args = JSON.stringify(task.args)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'bash', arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: `Observed ${task.label}` } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  ctx.llm.registerAdapter(['docker-acceptance'], new Model())
  ctx.effect(() => () => { for (const gate of held.values()) gate.resolve() })
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/__test/docker', handler: async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const control = JSON.parse(raw)
    let value
    if (control.op === 'release') { held.get(control.label)?.resolve(); value = { released: held.delete(control.label) } }
    else if (control.op === 'held') value = { held: held.has(control.label) }
    else if (control.op === 'reload') {
      const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'workspace-sandbox')
      await entry.update({ disabled: true }); await ctx.loader.await()
      await entry.update({ disabled: false }); await ctx.loader.await()
      value = { loaded: ctx.get('workspaceSandbox') !== undefined }
    } else {
      const agent = ctx.agents.get(control.sessionId)
      if (control.wait) await agent.whenIdle()
      await ctx.sessions.flush(agent.session)
      const handle = await ctx.sessionPersistence.open(agent.id, 'read')
      try {
        const { events } = await handle.read()
        const log = [sessionFormatCatalog.encodeCurrentHeader({ ...handle.header, delegationDepth: handle.header.delegationDepth ?? 0 }, handle.inheritedEventCount),
          ...events.map(event => sessionFormatCatalog.encodeCurrentEvent(event))].map(row => JSON.stringify(row)).join('\n') + '\n'
        value = { log, events, requests: requests.filter(item => item.sessionId === agent.id),
          activity: ctx.get('workspaceSandbox')?.activityForUser(control.userId, control.workspaceId) }
      } finally { await handle.close() }
    }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(value))
  } }))
}
