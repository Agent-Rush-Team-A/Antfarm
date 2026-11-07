/** One plugin-owned, immutable public model directory with coalesced refreshes. */
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { fetchVultrCatalog, parseVultrModels } from './vultr-catalog.ts'
import type { PiAiModelProfile } from './catalog.ts'
import type { resolveModelDiscovery } from './config.ts'
import type { PiAiModelRefreshResult } from './types.ts'

/** Complete options produced by provider configuration validation. */
export type VultrDirectoryOptions = NonNullable<ReturnType<typeof resolveModelDiscovery>>

/** Keeps the last successful directory; a failed refresh never replaces usable models. */
export class VultrModelDirectory {
  private readonly lifetime = new AbortController()
  private inflight: Promise<PiAiModelRefreshResult> | undefined
  private attemptedAt = 0
  private outcome: PiAiModelRefreshResult = { status: 'failed', modelCount: 0 }
  private current: readonly PiAiModelProfile[] | undefined

  /** @param options - validated deployment endpoint, limits and cache freshness. */
  constructor(readonly options: VultrDirectoryOptions, private readonly report?: (message: string) => void) {}

  /**
   * Read the last successful directory without starting a refresh.
   * @returns the immutable model snapshot, or undefined before one loads.
   */
  models(): readonly PiAiModelProfile[] | undefined { return this.current }

  /**
   * Share a bounded refresh and retain successful models on failure.
   * @param force - bypass freshness and failed-attempt backoff.
   * @returns directory status without provider diagnostics or credentials.
   */
  refresh(force: boolean): Promise<PiAiModelRefreshResult> {
    if (this.lifetime.signal.aborted) return Promise.resolve({ status: 'failed', modelCount: 0 })
    if (this.inflight !== undefined) return this.inflight
    if (!force && this.attemptedAt > 0 && Date.now() - this.attemptedAt < this.options.cacheTtlMs) return Promise.resolve(this.outcome)
    const first = this.attemptedAt === 0
    this.attemptedAt = Date.now()
    const operation = this.load(first, force).catch((_error: unknown) => {
      this.outcome = { status: this.current === undefined ? 'failed' : 'stale', modelCount: this.current?.length ?? 0 }
      if (!this.lifetime.signal.aborted) this.report?.('Vultr model directory could not be refreshed. Retry loading models.')
      return this.outcome
    }).finally(() => { if (this.inflight === operation) this.inflight = undefined })
    this.inflight = operation
    return operation
  }

  private async load(first: boolean, force: boolean): Promise<PiAiModelRefreshResult> {
    if (first) {
      const cached = await this.readCache()
      if (cached !== undefined && !this.lifetime.signal.aborted) {
        this.current = cached.models
        if (!force && Date.now() - cached.fetchedAt < this.options.cacheTtlMs) {
          this.attemptedAt = cached.fetchedAt
          this.outcome = { status: 'ready', modelCount: cached.models.length }
          return this.outcome
        }
      }
    }
    this.lifetime.signal.throwIfAborted()
    const payload = await fetchVultrCatalog({ ...this.options, signal: this.lifetime.signal })
    const models = parseVultrModels(payload, this.options.maxTokens)
    this.lifetime.signal.throwIfAborted()
    await this.writeCache(payload)
    this.lifetime.signal.throwIfAborted()
    this.current = models
    this.outcome = { status: 'ready', modelCount: models.length }
    return this.outcome
  }

  private async readCache(): Promise<{ models: PiAiModelProfile[]; fetchedAt: number } | undefined> {
    if (this.options.cachePath === undefined) return undefined
    try {
      const file = await open(this.options.cachePath, 'r')
      let text: string
      try {
        const size = (await file.stat()).size
        if (size > this.options.maxResponseBytes) throw new Error('Cache exceeds byte limit')
        const buffer = Buffer.alloc(size + 1)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        text = buffer.subarray(0, bytesRead).toString('utf8')
      } finally { await file.close() }
      const value: unknown = JSON.parse(text)
      if (typeof value !== 'object' || value === null) return undefined
      const fetchedAt: unknown = Reflect.get(value, 'fetchedAt')
      if (Reflect.get(value, 'version') !== 1 || Reflect.get(value, 'baseURL') !== this.options.baseURL
        || typeof fetchedAt !== 'number' || !Number.isSafeInteger(fetchedAt) || fetchedAt <= 0 || fetchedAt > Date.now()) return undefined
      return { fetchedAt, models: parseVultrModels(Reflect.get(value, 'payload'), this.options.maxTokens) }
    } catch (_error) {
      // An absent or invalid public cache has no usable models; a bounded network load decides the outcome.
      return undefined
    }
  }

  private async writeCache(payload: unknown): Promise<void> {
    const path = this.options.cachePath
    if (path === undefined) return
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      const value = JSON.stringify({ version: 1, baseURL: this.options.baseURL, fetchedAt: Date.now(), payload })
      if (Buffer.byteLength(value) > this.options.maxResponseBytes) throw new Error('Cache exceeds byte limit')
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(temporary, value, { flag: 'wx', mode: 0o600 })
      await rename(temporary, path)
    } catch (_error) {
      // Usable network models remain valid when local cache persistence fails.
      this.report?.('Vultr models loaded, but the cache could not be saved. Check the cache directory permissions.')
    } finally {
      await rm(temporary, { force: true }).catch((_error: unknown) => {
        this.report?.('Vultr model cache temporary file could not be removed. Check the cache directory permissions.')
      })
    }
  }

  /** Abort directory work and wait until it can no longer publish models. */
  async dispose(): Promise<void> { this.lifetime.abort(); await this.inflight }
}
