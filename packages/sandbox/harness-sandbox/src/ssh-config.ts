/** Trusted fixed-instance bindings for the SSH prerequisite; cloud provisioning remains separate. */
import Schema from '@deepseek-ai/schemastery'
import { SshConnection, type Config as SshConfig } from '@deepseek-ai/dsh-ssh'

/** One externally prepared instance and its installed SSH helper. */
export interface WorkspaceSshBinding extends SshConfig {
  /** Stable externally managed VM identity, distinct between workspaces. */
  instanceId: string
}

/** Deployment settings; callers select only an authorized WorkspaceId. */
export interface Config {
  /** Fixed SSH coordinates keyed by native WorkspaceId; each Workspace uses a distinct VM. */
  bindings: Record<string, WorkspaceSshBinding>
  /** Retained original requests per connection generation; full records refuse new work. */
  maxExecutions?: number
  /** Independent stdout/stderr tail limit in bytes. */
  maxOutputBytes?: number
  /** Remote process termination and output-drain allowance. */
  graceMs?: number
  /** Explicit executable on the remote VM. */
  bash?: string
}

/** Resolved deployment limits; the SSH connection validates its own protocol settings. */
export type ResolvedConfig = Required<Config>

/** Validated fixed-instance provider configuration. */
export const Config: Schema<Config, ResolvedConfig> = Schema.object({
  bindings: Schema.dict(Schema.intersect([SshConnection.Config, Schema.object({ instanceId: Schema.string().required() })])).required(),
  maxExecutions: Schema.natural().min(1).max(100_000).default(1024),
  maxOutputBytes: Schema.natural().min(1).max(8 * 1024 * 1024).default(64 * 1024),
  graceMs: Schema.natural().min(1).max(60_000).default(5000),
  bash: Schema.string().default('/bin/bash'),
})
