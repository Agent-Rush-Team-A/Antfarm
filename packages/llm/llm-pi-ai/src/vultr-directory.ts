/** One plugin-owned, immutable public model directory with coalesced refreshes. */
import { fetchVultrModels } from './vultr-catalog.ts'
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
  constructor(readonly options: VultrDirectoryOptions) {}

  /** @returns the immutable last-successful model snapshot, or undefined before one loads. */
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
    this.attemptedAt = Date.now()
    const operation = fetchVultrModels({ ...this.options, signal: this.lifetime.signal }).then((models) => {
      if (this.lifetime.signal.aborted) return { status: 'failed' as const, modelCount: 0 }
      this.current = models
      this.outcome = { status: 'ready', modelCount: models.length }
      return this.outcome
    }).catch((_error: unknown) => {
      this.outcome = { status: this.current === undefined ? 'failed' : 'stale', modelCount: this.current?.length ?? 0 }
      return this.outcome
    }).finally(() => { if (this.inflight === operation) this.inflight = undefined })
    this.inflight = operation
    return operation
  }

  /** Abort directory work and wait until it can no longer publish models. */
  async dispose(): Promise<void> { this.lifetime.abort(); await this.inflight }
}
