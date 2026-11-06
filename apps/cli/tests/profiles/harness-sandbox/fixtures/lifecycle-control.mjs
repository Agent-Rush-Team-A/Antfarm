/** Test-only control of the real Loader entry in the isolated Web profile. */

export const inject = ['loader', 'webServer']

/**
 * Register loopback test controls; no route is loaded by a product profile.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Test composition with the real Loader and Web server.
 */
export function apply(ctx) {
  const loader = ctx.loader
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/__test/sandbox-lifecycle', handler: async (request, response) => {
    request.resume()
    if (request.method !== 'POST') { response.writeHead(405).end(); return }
    const disabled = request.url === '/__test/sandbox-lifecycle/disable'
    if (!disabled && request.url !== '/__test/sandbox-lifecycle/enable') { response.writeHead(404).end(); return }
    try {
      const entry = [...loader.entries()].find(entry => entry.options.id === 'workspace-sandbox')
      if (!entry) throw new Error('Test profile has no sandbox management entry')
      await entry.update({ disabled })
      await loader.await()
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ loaded: ctx.get('workspaceSandbox') !== undefined }))
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String(error) }))
    }
  } }))
}
