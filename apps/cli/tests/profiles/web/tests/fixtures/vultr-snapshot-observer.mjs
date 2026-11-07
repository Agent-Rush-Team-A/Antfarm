/** Durable Session observation for the personal Vultr model-discovery snapshot. */
import { sessionFormatCatalog } from '../../../../../../../packages/session/session-format-catalog/lib/index.js'

export const inject = ['webServer', 'agents', 'sessions', 'sessionPersistence']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Built Web test profile. */
export function apply(ctx) {
  const completed = Promise.withResolvers()
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') completed.resolve(session)
  }, { global: true })
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/__test/vultr-snapshot', handler: async (request, response) => {
    request.resume()
    const session = await completed.promise
    await ctx.agents.get(session.id).whenIdle()
    await ctx.sessions.flush(session)
    const handle = await ctx.sessionPersistence.open(session.id, 'read')
    try {
      const { events } = await handle.read()
      const header = sessionFormatCatalog.encodeCurrentHeader({ ...handle.header,
        delegationDepth: handle.header.delegationDepth ?? 0 }, handle.inheritedEventCount)
      const log = [header, ...events.map(event => sessionFormatCatalog.encodeCurrentEvent(event))]
        .map(row => JSON.stringify(row)).join('\n') + '\n'
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ log, cwd: session.header.cwd }))
    } finally { await handle.close() }
  } }))
}
