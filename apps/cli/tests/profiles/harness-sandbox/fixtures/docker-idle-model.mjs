/** Existing scripted external model plus lifecycle observations for real-Docker idle acceptance. */
import { apply as mountModel, inject as modelServices } from './docker-model.mjs'

export const inject = [...modelServices, 'workspaceSandboxState', 'workspaceRegistry', 'multiuser']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Isolated, non-root Harness using the published idle plugin. */
export function apply(ctx) {
  mountModel(ctx)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/__test/idle-docker', handler: async (request, response) => {
    try {
      let raw = ''
      for await (const chunk of request) raw += chunk
      const control = JSON.parse(raw)
      if (control.op !== 'state') throw new Error(`Unknown test operation ${control.op}`)
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ now: performance.now(), activity: ctx.workspaceSandboxState.activity(control.workspaceId),
        registered: ctx.workspaceRegistry.get(control.workspaceId) !== undefined,
        owner: ctx.multiuser.ownerOfWorkspace(control.workspaceId) }))
    } catch (error) { response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String(error) })) }
  } }))
}
