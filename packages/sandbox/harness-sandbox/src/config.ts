/** Trusted Runner transport settings, independent of Docker deployment settings. */

import Schema from '@deepseek-ai/schemastery'

/** Settings supplied by the Harness deployment, never by workspace callers. */
export interface RunnerConfig {
  /** Absolute path to the local Runner socket. */
  socketPath: string
  /** Total GET deadline, including connection and response body; defaults to 15,000 ms. */
  queryTimeoutMs?: number
  /** Total PUT/DELETE deadline; defaults to 120,000 ms for multi-request Runner operations. */
  mutationTimeoutMs?: number
  /** Maximum lifecycle/cancel response body in bytes, including errors; defaults to 8192. */
  maxResponseBytes?: number
  /** Total exec transport deadline, independent of the command's timeoutMs; defaults to 120,000 ms. */
  execTimeoutMs?: number
  /** Total cancel deadline, independent of the exec caller's signal; defaults to 15,000 ms. */
  cancelTimeoutMs?: number
  /** Maximum complete exec response body, including JSON escaping and errors; defaults to 1 MiB. */
  maxExecResponseBytes?: number
}

/** Transport settings after schema validation and defaults. */
export type ResolvedConfig = Required<RunnerConfig>

/** Deployment-configurable total deadlines and response limit. */
export const RunnerConfig: Schema<RunnerConfig, ResolvedConfig> = Schema.object({
  socketPath: Schema.string().required(),
  queryTimeoutMs: Schema.natural().min(1).max(2_147_483_647).default(15_000),
  mutationTimeoutMs: Schema.natural().min(1).max(2_147_483_647).default(120_000),
  maxResponseBytes: Schema.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(8192),
  execTimeoutMs: Schema.natural().min(1).max(2_147_483_647).default(120_000),
  cancelTimeoutMs: Schema.natural().min(1).max(2_147_483_647).default(15_000),
  maxExecResponseBytes: Schema.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(1024 * 1024),
})
