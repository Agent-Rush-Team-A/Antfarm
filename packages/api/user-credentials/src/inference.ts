/** Personal inference authorization from the current turn's authenticated prompt source. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { UserId } from '@deepseek-ai/dsh-typert-protocol'
import type { PiAiCredentialRequest } from '@deepseek-ai/dsh-llm-pi-ai'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-api-multiuser'
import { z } from 'zod'

/** Explicit deployment binding; credential names remain scoped to each account. */
export interface InferenceBinding {
  /** Registered pi-ai route receiving the credential. */
  readonly provider: string
  /** Exact HTTPS base endpoint allowed to receive the secret. */
  readonly baseURL: string
  /** Display name looked up only within the initiating account. */
  readonly credentialName: string
}

/** Validate the untrusted configuration before registering any credential consumer. */
export const inferenceBindingsSchema = z.array(z.object({
  provider: z.string().min(1), baseURL: z.url(), credentialName: z.string().trim().min(1).max(128),
}).strict())

function endpoint(value: string): string {
  const url = new URL(value)
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('Personal inference endpoints cannot contain credentials, query parameters or fragments.')
  }
  return url.origin + url.pathname.replace(/\/+$/, '')
}

/**
 * Install consumers only for explicitly configured provider routes.
 * @param ctx - service owner carrying optional Agent and LLM services.
 * @param bindings - validated routes and account-local display names.
 * @param allowLoopbackHttp - explicit opt-in for local test providers.
 * @param read - private lookup returning a temporary decryption buffer.
 */
export function installInferenceBindings(
  ctx: Context,
  bindings: readonly InferenceBinding[],
  allowLoopbackHttp: boolean,
  read: (userId: UserId, name: string) => Buffer | undefined,
): void {
  const routes = new Map<string, InferenceBinding>()
  for (const binding of bindings) {
    const url = new URL(binding.baseURL)
    const loopback = url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    if (url.protocol !== 'https:' && !(allowLoopbackHttp && loopback)) {
      throw new Error('Personal inference requires HTTPS; local HTTP requires explicit test configuration.')
    }
    if (routes.has(binding.provider)) throw new Error('Personal inference provider bindings must be unique.')
    routes.set(binding.provider, { ...binding, baseURL: endpoint(binding.baseURL) })
  }
  if (routes.size === 0) return
  ctx.inject(['agents', 'llm', 'multiuser'], (child) => {
    const claims = new WeakMap<Agent, { turn: number; userId?: UserId; signal: AbortSignal }>()
    child.on('agent/status', ({ agent, status }) => { if (status === 'idle') claims.delete(agent) })
    child.on('agent/pre-step', ({ agent, messages, turn, step, signal }, next) => {
      const prior = claims.get(agent)
      const previous = step === 1 || prior?.turn !== turn ? undefined : prior
      let userId = previous?.userId
      let denied = step !== 1 && userId === undefined
      for (const message of messages) {
        if (message.source.kind !== 'user') continue
        const principal = 'principal' in message.source ? message.source.principal : undefined
        if (principal?.kind !== 'user' || (userId !== undefined && userId !== principal.userId)) denied = true
        else userId = principal.userId
      }
      claims.set(agent, { ...(denied || userId === undefined ? {} : { userId }), turn, signal })
      return next()
    })
    child.on('llm-pi-ai/resolve-api-key', async (request: PiAiCredentialRequest, next) => {
      const binding = routes.get(request.provider)
      if (binding === undefined) return next()
      if (request.credentialScope !== 'request') {
        throw new LlmError('This provider must configure request-scoped credentials. Contact the administrator.', 'PERSONAL_CREDENTIAL_SCOPE')
      }
      const missing = (): LlmError => new LlmError(
        `Save a personal credential named "${binding.credentialName}" in My credentials to use this model.`,
        'PERSONAL_CREDENTIAL_MISSING',
      )
      if (request.baseURL === undefined || endpoint(request.baseURL) !== binding.baseURL) {
        throw new LlmError('The model endpoint does not match its personal credential binding. Contact the administrator.', 'PERSONAL_CREDENTIAL_ENDPOINT')
      }
      request.signal?.throwIfAborted()
      const agent = child.agents.currentInitiator()
      const claim = agent === undefined ? undefined : claims.get(agent)
      if (agent === undefined || agent.status !== 'running' || request.sessionId !== agent.id || claim?.userId === undefined || claim.signal.aborted) {
        throw new LlmError('This model requires a conversation initiated by one signed-in account.', 'PERSONAL_CREDENTIAL_UNAUTHORIZED')
      }
      const userId = claim.userId
      if (!child.multiuser.ownsSession(userId, agent.id)) {
        throw new LlmError('This account no longer has access to the conversation.', 'PERSONAL_CREDENTIAL_UNAUTHORIZED')
      }
      let buffer: Buffer | undefined
      try { buffer = read(userId, binding.credentialName) }
      catch (_error) { throw new LlmError('Personal credential storage is unavailable. Check the saved credential or contact the administrator.', 'PERSONAL_CREDENTIAL_STORAGE') }
      if (buffer === undefined) throw missing()
      try { return buffer.toString('utf8') } finally { buffer.fill(0) }
    })
  })
}
