import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import Llm from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import * as PiAi from '../src/index.ts'
import { resolveModelDiscovery } from '../src/config.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function harness(cachePath?: string) {
  let body = await readFile(new URL('./fixtures/vultr-catalog.json', import.meta.url), 'utf8')
  let status = 200
  let calls = 0
  const host = createServer((_request, response) => { calls++; response.writeHead(status); response.end(body) })
  await new Promise<void>((resolve) => { host.listen(0, '127.0.0.1', resolve) })
  cleanups.push(async () => {
    host.closeAllConnections()
    await new Promise<void>((resolve, reject) => host.close((error) => { if (error) reject(error); else resolve() }))
  })
  const address = host.address()
  if (address === null || typeof address === 'string') throw new Error('Missing address')
  const ctx = new Context()
  await ctx.plugin(Llm)
  const config: PiAi.Options = { providers: { vultr: {
    api: 'openai-completions', baseURL: `http://127.0.0.1:${address.port}/v1`, credentialScope: 'request',
    modelDiscovery: { type: 'vultr', ...cachePath === undefined ? {} : { cachePath } }, models: [{ id: 'fallback', name: 'Fallback model' }],
  } } }
  const fiber = ctx.plugin(PiAi, config)
  await fiber
  cleanups.push(() => ctx.fiber.dispose())
  return { ctx, fiber, config, calls: () => calls, refuse: () => { status = 503 }, empty: () => { body = '{"data":[]}' } }
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

it('expires a restored directory at its original fetch time rather than the restart time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vultr-directory-expiry-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'catalog.json')
  const f = await harness(path)
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  cleanups.push(async () => { clock.mockRestore() })
  const payload: unknown = JSON.parse(await readFile(new URL('./fixtures/vultr-catalog.json', import.meta.url), 'utf8'))
  await writeFile(path, JSON.stringify({ version: 1, baseURL: f.config.providers!.vultr!.baseURL, fetchedAt: now - 240_000, payload }))
  expect(await f.ctx.llm.listModels('vultr')).toHaveLength(2)
  expect(f.calls()).toBe(0)
  clock.mockReturnValue(now + 60_001)
  f.refuse()
  expect(await f.ctx.llm.listModels('vultr')).toHaveLength(2)
  expect(f.calls()).toBe(1)
  expect(await f.ctx.waterfall('llm-pi-ai/refresh-models', { provider: 'vultr', force: false },
    () => Promise.resolve({ status: 'unsupported' as const, modelCount: 0 }))).toEqual({ status: 'stale', modelCount: 2 })
})

it('restores a public directory across reloads and preserves the cache on failed refreshes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vultr-directory-cache-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'catalog.json')
  const f = await harness(path)
  const before = await f.ctx.llm.listModels('vultr')
  const cache = await readFile(path, 'utf8')
  expect(cache).not.toContain('authorization')
  await f.fiber.dispose(); f.refuse()
  await f.ctx.plugin(PiAi, f.config)
  expect(await f.ctx.llm.listModels('vultr')).toEqual(before)
  expect(f.calls()).toBe(1)
  expect(await f.ctx.waterfall('llm-pi-ai/refresh-models', { provider: 'vultr', force: true },
    () => Promise.resolve({ status: 'unsupported' as const, modelCount: 0 }))).toEqual({ status: 'stale', modelCount: 2 })
  expect(await readFile(path, 'utf8')).toBe(cache)
})

it('refuses a corrupt or foreign-endpoint cache and keeps first-load fallback models', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vultr-directory-cache-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'catalog.json')
  for (const value of ['{bad-json', JSON.stringify({ version: 1, baseURL: 'https://other.example/v1', fetchedAt: Date.now(), payload: {} })]) {
    await writeFile(path, value)
    const f = await harness(path); f.refuse()
    expect((await f.ctx.llm.listModels('vultr')).map(model => model.id)).toEqual(['fallback'])
    expect(f.calls()).toBe(1)
  }
})
