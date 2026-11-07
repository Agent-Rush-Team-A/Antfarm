import { createServer } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { fetchVultrModels, parseVultrModels } from '../src/vultr-catalog.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

function model(id = 'test-chat') {
  return {
    id, name: 'Test chat', schema_version: '2.4',
    input_modalities: [{ type: 'text', supported_inputs: { max_context_length: { value: 32768, unit: 'token' } } }, { type: 'image' }],
    output_modalities: [{ type: 'text', streaming: true, max_length: { value: 2048, unit: 'token' },
      supported_parameters: { tools: { type: 'boolean' }, reasoning_effort: { type: 'enum', values: ['high', 'low'] } } }],
    reasoning: { mandatory: false },
  }
}

async function server(body: string, status = 200, delay = 0) {
  const headers: Array<Record<string, string | string[] | undefined>> = []
  const paths: string[] = []
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const host = createServer((request, response) => {
    headers.push(request.headers); paths.push(request.url ?? '')
    const timer = setTimeout(() => { timers.delete(timer); response.writeHead(status); response.end(body) }, delay)
    timers.add(timer)
  })
  await new Promise<void>((resolve) => { host.listen(0, '127.0.0.1', resolve) })
  cleanups.push(async () => {
    for (const timer of timers) clearTimeout(timer)
    host.closeAllConnections()
    await new Promise<void>((resolve, reject) => host.close(error => error ? reject(error) : resolve()))
  })
  const address = host.address()
  if (address === null || typeof address === 'string') throw new Error('Missing server address')
  return { baseURL: `http://127.0.0.1:${address.port}/v1`, headers, paths,
    timeoutMs: 1000, maxResponseBytes: 10000, maxTokens: 8192 }
}

it('maps capacities, image inputs, protocol flags and advertised reasoning levels', () => {
  expect(parseVultrModels({ data: [model(), model()] }, 8192)).toEqual([{
    id: 'test-chat', name: 'Test chat', contextWindow: 32768, maxTokens: 2048,
    input: ['text', 'image'], reasoningEfforts: { off: 'none', low: 'low', high: 'high' },
    compat: { maxTokensField: 'max_tokens', supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: true },
  }])
})

it('excludes classifiers, media, unavailable models and invalid context capacities', () => {
  const media = { ...model('image'), output_modalities: [{ type: 'image' }] }
  const noTools = { ...model('classifier'), output_modalities: [{ type: 'text', streaming: true }] }
  const badContext = model('bad'); badContext.input_modalities[0]!.supported_inputs!.max_context_length.value = 0
  expect(parseVultrModels({ data: [noTools, media, { ...model('offline'), is_ready: false }, badContext, null, model()] }, 1024))
    .toEqual([expect.objectContaining({ id: 'test-chat', maxTokens: 1024 })])
})

it('does not offer off for mandatory reasoning', () => {
  expect(parseVultrModels({ data: [{ ...model(), reasoning: { mandatory: true } }] }, 8192)[0]?.reasoningEfforts)
    .toEqual({ low: 'low', high: 'high' })
})

it.each([{}, { data: [] }, { data: [null] }])('rejects a directory without usable models', (payload) => {
  expect(() => parseVultrModels(payload, 8192)).toThrow(/Vultr/)
})

it('fetches the public catalog without Authorization', async () => {
  const fixture = await server(JSON.stringify({ data: [model()] }))
  expect(await fetchVultrModels(fixture)).toHaveLength(1)
  expect(fixture.paths).toEqual(['/v1/models'])
  expect(fixture.headers[0]?.authorization).toBeUndefined()
  expect(fixture.headers[0]?.['x-vultr-model-type']).toBe('chat')
})

it('bounds streamed bytes and rejects provider diagnostics without exposing them', async () => {
  const fixture = await server('SECRET-REMOTE-DIAGNOSTIC', 200)
  await expect(fetchVultrModels({ ...fixture, maxResponseBytes: 2 })).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
  const refused = await server('SECRET-REMOTE-DIAGNOSTIC', 503)
  await expect(fetchVultrModels(refused)).rejects.toThrow('Cannot load Vultr models. Check the connection and retry.')
})

it('bounds slow requests and obeys plugin cancellation', async () => {
  const fixture = await server('{}', 200, 1000)
  await expect(fetchVultrModels({ ...fixture, timeoutMs: 10 })).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
  const controller = new AbortController(); controller.abort()
  await expect(fetchVultrModels({ ...fixture, signal: controller.signal })).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
})
