/** Validated deployment settings for one-VM-per-Workspace execution. */
import Schema from '@deepseek-ai/schemastery'

/** Cloud credentials and resources are selected by deployment, never by a model or browser. */
export interface Config {
  apiKeyFile: string
  /** Private persistent directory outside registered project roots. */
  stateRoot: string
  /** Stable identifier shared across Harness restarts. */
  deploymentId: string
  region: string
  plan: string
  osId: number
  /** Existing private SSH client key; the public key is derived locally. */
  sshKeyFile: string
  /** Verified, relocatable helper archive built from the deployed source tree. */
  helperArchive: string
  /** SHA-256 of the archive before any installation. */
  helperArchiveHash: string
  /** SHA-256 of the helper executable inside the archive. */
  helperHash: string
  /** Absolute workspace directory writable by workspace-exec. */
  remoteRoot?: string
  /** Account control endpoint; tests may use an isolated HTTP endpoint. */
  apiEndpoint?: string
  maxInstances?: number
  requestTimeoutMs?: number
  operationTimeoutMs?: number
  pollIntervalMs?: number
  maxInventoryPages?: number
  maxApiResponseBytes?: number
  maxSavedBytes?: number
  maxSavedFiles?: number
  maxExecutions?: number
  maxOutputBytes?: number
  graceMs?: number
}

/** Resolved provider configuration. */
export type ResolvedConfig = Required<Config>

/**
 * Resolve the API origin before passing any credentials to it.
 * @param address - Deployment endpoint, with HTTP accepted for loopback fixtures.
 * @returns Endpoint without a trailing slash.
 */
export function vultrEndpoint(address: string): string {
  const endpoint = new URL(address)
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:'
    && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname))) throw new Error('Vultr endpoint must use HTTPS or test loopback')
  if (endpoint.username || endpoint.password || endpoint.search
    || endpoint.hash) throw new Error('Vultr API endpoint cannot contain credentials, query or fragment')
  return address.replace(/\/$/u, '')
}

/** Explicit cloud allocation with bounded polling, capacity, and file-copy budgets. */
export const Config: Schema<Config, ResolvedConfig> = Schema.object({
  apiKeyFile: Schema.string().required(), stateRoot: Schema.string().required(), deploymentId: Schema.string().required(),
  region: Schema.string().required(), plan: Schema.string().required(), osId: Schema.natural().min(1).required(),
  sshKeyFile: Schema.string().required(), helperArchive: Schema.string().required(),
  helperArchiveHash: Schema.string().required(), helperHash: Schema.string().required(),
  remoteRoot: Schema.string().default('/workspace'),
  apiEndpoint: Schema.string().default('https://api.vultr.com/v2'),
  maxInstances: Schema.natural().min(1).max(100).default(2),
  requestTimeoutMs: Schema.natural().min(1).max(120_000).default(30_000),
  operationTimeoutMs: Schema.natural().min(1).max(7_200_000).default(1_800_000),
  pollIntervalMs: Schema.natural().min(1).max(60_000).default(3000),
  maxInventoryPages: Schema.natural().min(1).max(1000).default(100),
  maxApiResponseBytes: Schema.natural().min(1).max(64 * 1024 * 1024).default(4 * 1024 * 1024),
  maxSavedBytes: Schema.natural().min(1).default(1024 * 1024 * 1024),
  maxSavedFiles: Schema.natural().min(1).max(1_000_000).default(100_000),
  maxExecutions: Schema.natural().min(1).max(100_000).default(1024),
  maxOutputBytes: Schema.natural().min(1).max(8 * 1024 * 1024).default(64 * 1024),
  graceMs: Schema.natural().min(1).max(60_000).default(5000),
})
