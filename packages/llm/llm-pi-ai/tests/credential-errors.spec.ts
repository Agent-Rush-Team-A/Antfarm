/** Personal credentials stay out of provider failures and thrown diagnostics. */
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmError, ProviderRequestId } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import type { AssistantMessageEvent, AssistantMessageEventStream } from '@earendil-works/pi-ai'
import * as modelHelpers from '../src/models.ts'
import { resolveProfiles } from '../src/config.ts'
import { assemble } from './assemble.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

const key = 'PRIVATEPREFIX-middle/+?-PRIVATESUFFIX'
const masked = 'PRIVATEPREFIX***PRIVATESUFFIX'
const authMessage = 'The model service rejected the credential. Check your personal API key and its permissions.'

afterEach(async () => {
  vi.restoreAllMocks()
  await closeMockServers()
})

function adapterWithStream(stream: () => AssistantMessageEventStream): PiAiAdapter {
  const createModels = modelHelpers.createModels
  vi.spyOn(modelHelpers, 'createModels').mockImplementation((options) => {
    const models = createModels(options)
    vi.spyOn(models, 'streamSimple').mockImplementation(stream)
    return models
  })
  return new PiAiAdapter({
    profiles: () => resolveProfiles({ deepseek: { credentialScope: 'request' } }),
    resolveApiKey: () => Promise.resolve(key),
    auth: memoryAuth(),
  })
}

it.each([
  ['full', key],
  ['masked', masked],
  ['prefix', 'PRIVATEPREFIX***'],
  ['suffix', '***PRIVATESUFFIX'],
  ['URL encoded', encodeURIComponent(key)],
  ['base64 encoded', Buffer.from(key).toString('base64')],
])('replaces %s credential echoes in HTTP failures with safe guidance', async (_name, echo) => {
  const server = await mockServer([{ status: 401, body: JSON.stringify({ error: { message: `Incorrect API key provided: ${echo}` } }) }])
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, { providers: { deepseek: { credentialScope: 'request', baseURL: server.url } } })
  ctx.on('llm-pi-ai/resolve-api-key', () => Promise.resolve(key))
  const result = await assemble(ctx, { model: 'deepseek-flash', messages: [] })
  expect(result.finish).toEqual({ kind: 'error', failure: { code: 'AUTH', message: authMessage } })
  expect(server.headers[0]?.authorization).toBe(`Bearer ${key}`)
  expect(JSON.stringify(result)).not.toContain(echo)
  expect(JSON.stringify(result)).not.toMatch(/PRIVATEPREFIX|PRIVATESUFFIX/)
})

it.each([
  [403, 'permission denied', 'AUTH'],
  [429, 'rate limit', 'RATE_LIMIT'],
  [429, 'insufficient_quota', 'QUOTA'],
  [503, 'service unavailable', 'SERVER'],
  [413, 'payload too large', 'INVALID_REQUEST'],
  [400, 'context length exceeded', 'CONTEXT_WINDOW_EXCEEDED'],
])('keeps the %s error category for %s without provider diagnostics', async (status, detail, code) => {
  const server = await mockServer([{ status, body: JSON.stringify({ error: { message: `${detail}: ${masked}` } }) }])
  const adapter = new PiAiAdapter({
    profiles: () => resolveProfiles({ deepseek: { credentialScope: 'request', baseURL: server.url } }),
    resolveApiKey: () => Promise.resolve(key),
    auth: memoryAuth(),
  })
  const chunks = []
  for await (const chunk of adapter.stream({ provider: 'deepseek', model: 'deepseek-flash', messages: [] })) chunks.push(chunk)
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code } } })
  expect(JSON.stringify(chunks)).not.toContain(masked)
})

it.each([
  new LlmError(`credential ${masked} rejected`, 'RATE_LIMIT', {
    status: 429, providerRetryAfterMs: 1234, requestId: ProviderRequestId(key), cause: new Error(key),
  }),
  new Error(`SDK failed with ${masked}`, { cause: new Error(key) }),
  `SDK rejected ${masked}`,
])('drops raw thrown diagnostics and causes while keeping safe failure facts', async (original) => {
  const adapter = adapterWithStream(() => { throw original })
  const drain = async () => {
    for await (const _chunk of adapter.stream({ provider: 'deepseek', model: 'deepseek-flash', messages: [] })) { /* drain */ }
  }
  const error = await drain().catch((error: unknown) => error)
  expect(error).toBeInstanceOf(LlmError)
  if (!(error instanceof LlmError)) throw new Error('Expected a typed model failure')
  expect(error.cause).toBeUndefined()
  expect(error.failure).toEqual(original instanceof LlmError
    ? { message: 'The model service rate limit was reached. Try again later.', code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 1234 }
    : { message: 'The model request failed. Check the model configuration or contact the administrator.', code: 'PI_AI_ERROR' })
  expect(error.stack).not.toMatch(/PRIVATEPREFIX|PRIVATESUFFIX/)
  expect(JSON.stringify(error)).not.toMatch(/PRIVATEPREFIX|PRIVATESUFFIX/)
})

it('keeps caller cancellation ahead of a concurrent personal provider error without its cause', async () => {
  const controller = new AbortController()
  const adapter = adapterWithStream(() => {
    controller.abort()
    throw new LlmError(`credential ${masked} rejected`, 'AUTH', { cause: new Error(key) })
  })
  const drain = async () => {
    for await (const _chunk of adapter.stream({ provider: 'deepseek', model: 'deepseek-flash', messages: [], signal: controller.signal })) { /* drain */ }
  }
  const error = await drain().catch((error: unknown) => error)
  expect(error).toMatchObject({ code: 'ABORTED' })
  expect(error).not.toHaveProperty('cause')
})

it('sanitizes an iterator rejection while retaining the image-offload count', async () => {
  const original = new LlmError(`provider diagnostic ${masked}`, 'IMAGE_OFFLOAD_REQUIRED', {
    offloadImages: 2, requestId: ProviderRequestId(key), cause: new Error(key),
  })
  const adapter = adapterWithStream(() => {
    const events = createAssistantMessageEventStream()
    vi.spyOn(events, Symbol.asyncIterator).mockImplementation(async function* (): AsyncGenerator<AssistantMessageEvent> {
      throw original
    })
    return events
  })
  const drain = async () => {
    for await (const _chunk of adapter.stream({ provider: 'deepseek', model: 'deepseek-flash', messages: [] })) { /* drain */ }
  }
  const error = await drain().catch((error: unknown) => error)
  expect(error).toBeInstanceOf(LlmError)
  if (!(error instanceof LlmError)) throw new Error('Expected a typed model failure')
  expect(error.failure).toEqual({
    code: 'IMAGE_OFFLOAD_REQUIRED', offloadImages: 2,
    message: 'The model request failed. Check the model configuration or contact the administrator.',
  })
  expect(error.cause).toBeUndefined()
  expect(error.stack).not.toMatch(/PRIVATEPREFIX|PRIVATESUFFIX/)
})
