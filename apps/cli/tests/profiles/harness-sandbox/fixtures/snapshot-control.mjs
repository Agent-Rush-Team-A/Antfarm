/** External scripted model and durable observations for the shipped sandbox profile. */
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { sessionFormatCatalog } from '../../../../../../packages/session/session-format-catalog/lib/index.js'

export const inject = ['llm', 'webServer', 'agents', 'tools', 'sessions', 'sessionPersistence']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Built test profile. @param {{script: object[], repeatScript?: boolean}} config - Recorded external model chunks. */
export function apply(ctx, config) {
  const requests = []
  let cursor = 0
  class Model extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async * stream(options) {
      requests.push({ messages: options.messages, tools: options.tools })
      const index = config.repeatScript ? cursor % config.script.length : cursor
      cursor++
      const entry = config.script[index]
      if (entry?.kind !== 'chunks') throw new Error('Snapshot model script exhausted')
      for (const chunk of entry.chunks) yield chunk
    }
  }
  ctx.llm.registerAdapter(['sandbox-snapshot'], new Model())
  const completed = Promise.withResolvers()
  const presentations = []
  ctx.on('tools/result', (exec, result) => {
    const definition = ctx.tools.get(exec.name, exec.agent, exec.toolSet)
    presentations.push({ call: definition.presentCall(exec.arguments), result: definition.presentResult(exec.arguments, result) })
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') completed.resolve(session)
  }, { global: true })
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/__test/sandbox-snapshot', handler: async (request, response) => {
    request.resume()
    const session = await completed.promise
    await ctx.agents.get(session.id).whenIdle()
    await ctx.sessions.flush(session)
    const handle = await ctx.sessionPersistence.open(session.id, 'read')
    let log
    try {
      const { events } = await handle.read()
      log = [sessionFormatCatalog.encodeCurrentHeader({ ...handle.header, delegationDepth: handle.header.delegationDepth ?? 0 }, handle.inheritedEventCount),
        ...events.map(event => sessionFormatCatalog.encodeCurrentEvent(event))].map(row => JSON.stringify(row)).join('\n') + '\n'
    } finally { await handle.close() }
    if (cursor !== config.script.length && !(config.repeatScript && cursor % config.script.length === 0)) {
      throw new Error('Snapshot did not consume the complete model script')
    }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ log, requests, presentations }))
  } }))
}
