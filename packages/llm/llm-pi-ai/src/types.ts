/** Request metadata exposed to pi-ai transport-header contributors. */

import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

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
