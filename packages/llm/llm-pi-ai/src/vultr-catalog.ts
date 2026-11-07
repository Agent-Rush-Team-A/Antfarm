/** Public Vultr model discovery; directory requests never carry inference credentials. */
import { isAgentModel, normalizeModel, parseCatalog } from '@vultr/model-catalog'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { THINKING_LEVELS } from './catalog.ts'
import type { PiAiModelProfile, PiAiReasoningEfforts } from './catalog.ts'

/** Deployment bounds for one public directory request. */
export interface VultrCatalogRequest {
  /** Configured inference root; the directory is its /models child. */
  baseURL: string
  /** Maximum elapsed request time, including the body read. */
  timeoutMs: number
  /** Maximum decoded response bytes. */
  maxResponseBytes: number
  /** Default response budget, capped by each model's advertised output limit. */
  maxTokens: number
  /** Owning plugin's lifetime. */
  signal?: AbortSignal
}

/**
 * Normalize supported coding models from Vultr's provider document.
 * @param payload - untrusted JSON from the public directory.
 * @param maxTokens - deployment response budget.
 * @returns unique, ready models with tools, streaming and known context capacity.
 * @throws LlmError when no usable models remain.
 */
export function parseVultrModels(payload: unknown, maxTokens: number): PiAiModelProfile[] {
  const models = new Map<string, PiAiModelProfile>()
  try {
    for (const document of parseCatalog(payload).documents) {
      const model = normalizeModel(document)
      if (!isAgentModel(model) || !model.streaming || !model.inputModalities.includes('text')
        || model.contextWindow === null || !Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0) continue
      if (model.maxOutputTokens !== null && (!Number.isSafeInteger(model.maxOutputTokens) || model.maxOutputTokens <= 0)) continue
      const efforts: PiAiReasoningEfforts = {}
      if (model.reasoning !== null) {
        if (!model.reasoning.mandatory) efforts.off = 'none'
        for (const level of THINKING_LEVELS) {
          if (level !== 'off' && model.reasoning.supportedEfforts?.includes(level)) efforts[level] = level
        }
      }
      if (model.reasoning?.mandatory && !Object.keys(efforts).some(key => key !== 'off')) continue
      models.set(model.id, {
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: Math.min(maxTokens, model.maxOutputTokens ?? maxTokens, model.contextWindow),
        input: model.inputModalities.includes('image') ? ['text', 'image'] : ['text'],
        reasoningEfforts: Object.keys(efforts).some(key => key !== 'off') ? efforts : false,
        compat: {
          maxTokensField: 'max_tokens', supportsDeveloperRole: false, supportsStore: false,
          supportsReasoningEffort: model.reasoning !== null,
        },
      })
    }
  } catch (_error) {
    throw new LlmError('Vultr model directory is invalid. Retry loading models.', 'DISCOVERY_FAILED')
  }
  if (models.size === 0) throw new LlmError('Vultr returned no usable coding models. Retry loading models.', 'DISCOVERY_FAILED')
  return [...models.values()]
}

/**
 * Fetch the public directory with a deadline and a byte limit.
 * @param request - deployment-owned endpoint and request bounds.
 * @returns models usable by the existing Chat Completions adapter.
 * @throws LlmError with fixed guidance on HTTP, transport, size or parsing failure.
 */
export async function fetchVultrModels(request: VultrCatalogRequest): Promise<PiAiModelProfile[]> {
  return parseVultrModels(await fetchVultrCatalog(request), request.maxTokens)
}

/**
 * Read bounded public JSON for normalization and persistent directory caching.
 * @param request - deployment-owned endpoint and request limits.
 * @returns untrusted directory JSON; callers must parse it before publishing or caching.
 * @throws LlmError with fixed guidance when directory I/O fails.
 */
export async function fetchVultrCatalog(request: VultrCatalogRequest): Promise<unknown> {
  const timeout = AbortSignal.timeout(request.timeoutMs)
  const signal = request.signal === undefined ? timeout : AbortSignal.any([timeout, request.signal])
  try {
    const response = await fetch(`${request.baseURL.replace(/\/+$/, '')}/models`, {
      headers: { accept: 'application/json', 'X-Vultr-Model-Type': 'chat' }, signal, redirect: 'error',
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error('HTTP failure')
    }
    const declared = Number(response.headers.get('content-length'))
    if (declared > request.maxResponseBytes) {
      await response.body?.cancel()
      throw new Error('Directory exceeds byte limit')
    }
    if (response.body === null) throw new Error('Empty directory')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > request.maxResponseBytes) throw new Error('Directory exceeds byte limit')
        chunks.push(value)
      }
    } finally {
      await reader.cancel().catch((_error: unknown) => { /* The request result is decided; cancellation is cleanup. */ })
      reader.releaseLock()
    }
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'))
  } catch (_error) {
    throw new LlmError('Cannot load Vultr models. Check the connection and retry.', 'DISCOVERY_FAILED')
  }
}
