/** Request metadata exposed to pi-ai transport-header contributors. */

import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

/** Public directory refresh outcome; never indicates whether an inference key works. */
export interface PiAiModelRefreshResult {
  /** Ready directory, retained stale directory, failed first load, or no discovery configured. */
  readonly status: 'ready' | 'stale' | 'failed' | 'unsupported'
  /** Models advertised after the attempt, including configured fallback models. */
  readonly modelCount: number
}

/** Host-owned request for a configured route's public model directory. */
export interface PiAiModelRefreshRequest {
  /** Registered provider route; callers cannot substitute an endpoint. */
  readonly provider: string
  /** Bypass freshness and failure backoff for an explicit retry. */
  readonly force: boolean
}

/** Host-only inputs for credential authorization before an inference call. */
export interface PiAiCredentialRequest {
  /** Exact registered provider route. */
  readonly provider: string
  /** Resolved model endpoint, or the configured endpoint when listing. */
  readonly baseURL?: string
  /** Model id for inference; omitted for catalog reads. */
  readonly model?: string
  /** Profile's reference, independent of the consumer's personal display name. */
  readonly apiKeyEnv?: string
  /** Resolved authority policy; request routes refuse global fallback. */
  readonly credentialScope?: 'global' | 'request'
  /** Session initiating inference; omitted for catalog reads. */
  readonly sessionId?: GenerateOptions['sessionId']
  /** Model-hidden purpose inherited from generation. */
  readonly purpose?: GenerateOptions['purpose']
  /** Caller-owned inference cancellation. */
  readonly signal?: AbortSignal
}

/** Model-hidden routing metadata from the exact prepared adapter call. */
export interface PiAiRequestHeaderContext extends Readonly<Pick<GenerateOptions<string>,
  'provider' | 'model' | 'sessionId' | 'purpose'>> {
  /** Resolved endpoint of the model selected for this call. */
  readonly baseURL: string
}
