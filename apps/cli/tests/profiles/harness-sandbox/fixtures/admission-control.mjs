/** Deterministic external model and observations for the built Web admission path. */
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

const command = 'printf PROFILE_RUNNER_OK; exit 7'

class AdmissionModel extends LlmAdapter {
  seenResult = Promise.withResolvers()
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async * stream(options) {
    if (options.messages.some(message => message.role === 'user'
      && message.content.some(block => block.type === 'text' && block.text === 'profile-runner-bash'))) {
      const result = options.messages.find(message => message.role === 'tool' && message.toolCallId === 'runner-profile-call')
      if (result) {
        this.seenResult.resolve({ content: result.content, tools: options.tools,
          directory: options.messages.flatMap(message => message.role === 'user' ? message.content : [])
            .filter(block => block.type === 'text' && block.text.includes('Current working directory:')).map(block => block.text) })
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'execution completed' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'execution completed' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } else {
        const args = JSON.stringify({ command: command, description: 'Inspect Runner result' })
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: 'runner-profile-call', name: 'bash', argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'runner-profile-call', name: 'bash', arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      }
      return
    }
    await new Promise((resolve) => {
      if (options.signal.aborted) resolve()
      else options.signal.addEventListener('abort', resolve, { once: true })
    })
    options.signal.throwIfAborted()
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Required production services; sandbox permission is resolved dynamically. */
export const inject = ['llm', 'webServer', 'agents', 'tools']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Isolated built-process fixture. */
export function apply(ctx) {
  const model = new AdmissionModel()
  ctx.llm.registerAdapter(['sandbox-admission-fixture'], model)
  const completed = Promise.withResolvers()
  ctx.on('tools/result', (exec, result) => {
    if (exec.name === 'bash' && exec.arguments.command === command) {
      const definition = ctx.tools.get('bash', exec.agent)
      completed.resolve({ result, description: definition.description, presentation: definition.presentResult(exec.arguments, result) })
    }
  }, { global: true })
  const observed = []
  const first = Promise.withResolvers()
  const second = Promise.withResolvers()
  ctx.on('agent/request', ({ agent, turn, signal }, next) => {
    const permit = ctx.get('sandboxConversation').forTurn(agent, turn)
    const record = { sessionId: agent.id, turn, requestId: permit.requestId, cancelled: false }
    observed.push(record)
    permit.signal.addEventListener('abort', () => { record.cancelled = true }, { once: true })
    signal.addEventListener('abort', () => { record.modelCancelled = true }, { once: true })
    if (observed.length === 1) first.resolve()
    if (observed.length === 2) second.resolve()
    return next()
  }, { global: true })
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/__test/sandbox-admission', handler: async (request, response) => {
    request.resume()
    if (request.url === '/__test/sandbox-admission/completed') {
      const [execution, modelView] = await Promise.all([completed.promise, model.seenResult.promise])
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ execution, modelView }))
      return
    }
    if (request.url === '/__test/sandbox-admission/first') await first.promise
    else if (request.url === '/__test/sandbox-admission/second') await second.promise
    else if (request.url !== '/__test/sandbox-admission/state') { response.writeHead(404).end(); return }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(observed))
  } }))
}
