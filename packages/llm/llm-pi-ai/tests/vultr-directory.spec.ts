import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import Llm from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it } from 'vitest'
import * as PiAi from '../src/index.ts'
import { resolveModelDiscovery } from '../src/config.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function harness() {
  let body = await readFile(new URL('./fixtures/vultr-catalog.json', import.meta.url), 'utf8')
  let status = 200
  let calls = 0
  const host = createServer((_request, response) => { calls++; response.writeHead(status); response.end(body) })
  await new Promise<void>((resolve) => { host.listen(0, '127.0.0.1', resolve) })
  cleanups.push(async () => {
    host.closeAllConnections()
    await new Promise<void>((resolve, reject) => host.close(error => error ? reject(error) : resolve()))
  })
  const address = host.address()
  if (address === null || typeof address === 'string') throw new Error('Missing address')
  const ctx = new Context()
  await ctx.plugin(Llm)
  const fiber = ctx.plugin(PiAi, { providers: { vultr: {
    api: 'openai-completions', baseURL: `http://127.0.0.1:${address.port}/v1`, credentialScope: 'request',
    modelDiscovery: { type: 'vultr' }, models: [{ id: 'fallback', name: 'Fallback model' }],
  } } })
  await fiber
  cleanups.push(() => ctx.fiber.dispose())
  return { ctx, fiber, calls: () => calls, refuse: () => { status = 503 }, empty: () => { body = '{"data":[]}' } }
}

it('loads a live route without credentials and shares concurrent directory reads', async () => {
  const f = await harness()
  const answers = await Promise.all([f.ctx.llm.listModels('vultr'), f.ctx.llm.listModels('vultr')])
  expect(answers[0]?.map(model => model.id)).toEqual(['deepseek-v4.1-flash-1017', 'glm-5.2'])
  expect(answers[1]).toEqual(answers[0]); expect(f.calls()).toBe(1)
  const info = await f.ctx.llm.resolveModelInfo('vultr', 'glm-5.2')
  expect(info.context?.contextWindow).toBe(1048576)
  expect(info.defaultMaxTokens).toBe(8192)
  expect(info.reasoning?.efforts.map(effort => effort.id)).toContain('high')
  expect(await f.ctx.llm.listModels('vultr')).toEqual(answers[0]); expect(f.calls()).toBe(1)
})

it('retains the previous usable directory when an explicit refresh fails or returns empty', async () => {
  const f = await harness()
  const before = await f.ctx.llm.listModels('vultr')
  f.empty()
  const next = () => Promise.resolve({ status: 'unsupported' as const, modelCount: 0 })
  expect(await f.ctx.waterfall('llm-pi-ai/refresh-models', { provider: 'vultr', force: true }, next))
    .toEqual({ status: 'stale', modelCount: 2 })
  expect(await f.ctx.llm.listModels('vultr')).toEqual(before)
  f.refuse()
  expect(await f.ctx.waterfall('llm-pi-ai/refresh-models', { provider: 'vultr', force: true }, next))
    .toEqual({ status: 'stale', modelCount: 2 })
})

it('reports first-load failure while keeping configured fallback models', async () => {
  const f = await harness(); f.refuse()
  expect(await f.ctx.llm.listModels('vultr')).toEqual([expect.objectContaining({ id: 'fallback' })])
  expect(await f.ctx.waterfall('llm-pi-ai/refresh-models', { provider: 'vultr', force: false },
    () => Promise.resolve({ status: 'unsupported' as const, modelCount: 0 }))).toEqual({ status: 'failed', modelCount: 1 })
  expect(f.calls()).toBe(1)
})

it('withdraws both route and refresh capability on plugin disposal', async () => {
  const f = await harness(); await f.ctx.llm.listModels('vultr')
  await f.fiber.dispose()
  expect(f.ctx.llm.listProviders()).toEqual([])
  expect(await f.ctx.waterfall('llm-pi-ai/refresh-models', { provider: 'vultr', force: true },
    () => Promise.resolve({ status: 'unsupported' as const, modelCount: 0 }))).toEqual({ status: 'unsupported', modelCount: 0 })
})

it('rejects unsafe endpoints and invalid deployment limits before discovery', () => {
  const base = { api: 'openai-completions', baseURL: 'https://api.vultrinference.com/v1', modelDiscovery: { type: 'vultr' as const } }
  for (const baseURL of ['http://example.com/v1', 'https://user:password@example.com', 'https://example.com?token=x']) {
    expect(() => resolveModelDiscovery({ ...base, baseURL })).toThrow(/HTTPS/)
  }
  expect(() => resolveModelDiscovery({ ...base, modelDiscovery: { type: 'vultr', timeoutMs: 0 } })).toThrow(/positive/)
  expect(() => resolveModelDiscovery({ ...base, modelDiscovery: { type: 'vultr', cachePath: 'relative.json' } })).toThrow(/absolute/)
})
