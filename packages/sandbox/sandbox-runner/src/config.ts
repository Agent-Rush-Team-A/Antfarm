/** Trusted deployment settings and the Docker create request for one workspace. */

import { createHash, randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import Schema from '@deepseek-ai/schemastery'

/** Settings owned by the Runner deployment, not by workspace callers. */
export interface Config {
  /** Absolute path to the local Docker Engine socket. */
  dockerSocket: string
  /** Absolute Linux path for the local Runner API. Omit for a service without a listener. */
  runnerSocket?: string
  /** Deployment label value, unique among Runners using this Engine. */
  deploymentId: string
  /** Canonical absolute path to the pre-existing, trusted workspace parent. */
  workspaceRoot: string
  /** Preloaded image reference pinned by a SHA-256 digest. */
  image: string
  /** Non-root numeric UID inside the container. */
  uid: number
  /** Non-root numeric GID inside the container. */
  gid: number
  /** Total deadline for a Docker request, in milliseconds. */
  requestTimeoutMs?: number
}

/** Deployment settings after the Loader applies the request deadline default. */
export type ResolvedConfig = Config & {
  /** Effective Docker request deadline, in milliseconds. */
  requestTimeoutMs: number
}

/** Loader schema for the deployment settings. */
export const Config: Schema<Config, ResolvedConfig> = Schema.object({
  dockerSocket: Schema.string().required(),
  runnerSocket: Schema.string(),
  deploymentId: Schema.string().pattern(/^[a-z0-9][a-z0-9-]{0,47}$/u).required(),
  workspaceRoot: Schema.string().required(),
  image: Schema.string().pattern(/^[^\s@]+@sha256:[a-f0-9]{64}$/u).required(),
  uid: Schema.natural().min(1).max(0xffff_fffe).required(),
  gid: Schema.natural().min(1).max(0xffff_fffe).required(),
  requestTimeoutMs: Schema.natural().min(1).max(2_147_483_647).default(10_000),
})

/** Label used to select this deployment's containers. */
export const deploymentLabel = 'org.agentrush.sandbox.deployment'

/** Label identifying the project that owns a container. */
export const projectLabel = 'org.agentrush.sandbox.project'

/** Project identity written to Runner containers. */
export const project = 'agentrush'

/** Label carrying the workspace registry identity. */
export const workspaceLabel = 'org.agentrush.sandbox.workspace'

/** Label distinguishing a pending create from earlier requests for the same workspace. */
export const creationLabel = 'org.agentrush.sandbox.creation'

/** Stable name for read-only lookup or creation.
 * @param deploymentId - Trusted deployment identity.
 * @param workspaceId - Workspace registry identity.
 * @returns Docker container name for the workspace in this deployment.
 */
export function sandboxName(deploymentId: string, workspaceId: WorkspaceId): string {
  return `agentrush-sandbox-${deploymentId}-${createHash('sha256').update(workspaceId).digest('hex')}`
}

/** The requested path cannot be used as a workspace bind mount. */
export class InvalidWorkspaceDirectoryError extends Error {
  /** @param cause - Filesystem failure, when a directory could not be resolved. */
  constructor(cause?: unknown) {
    super('Expected an existing direct child directory of the workspace root, without symlinks', { cause })
    this.name = 'InvalidWorkspaceDirectoryError'
  }
}

interface CreateRequest {
  name: string
  token: string
  body: Record<string, unknown>
}

/** Validate the bind source before preparing the request.
 * @param config - Trusted deployment settings.
 * @param workspaceId - Workspace registry identity.
 * @param directory - Requested host path.
 * @returns The stable name and create body for that workspace.
 */
export async function resolveCreateRequest(config: Config, workspaceId: WorkspaceId, directory: string): Promise<CreateRequest> {
  if (resolve(directory) !== directory || dirname(directory) !== config.workspaceRoot) {
    throw new InvalidWorkspaceDirectoryError()
  }
  const root = await realpath(config.workspaceRoot).catch((cause: unknown) => {
    throw new InvalidWorkspaceDirectoryError(cause)
  })
  const entry = await lstat(directory).catch((cause: unknown) => {
    throw new InvalidWorkspaceDirectoryError(cause)
  })
  if (root !== config.workspaceRoot || !entry.isDirectory() || entry.isSymbolicLink()) {
    throw new InvalidWorkspaceDirectoryError()
  }

  const token = randomUUID()
  return {
    token,
    name: sandboxName(config.deploymentId, workspaceId),
    body: {
      Image: config.image,
      User: `${config.uid}:${config.gid}`,
      WorkingDir: '/workspace',
      Entrypoint: ['/usr/bin/sleep'],
      Cmd: ['infinity'],
      Healthcheck: { Test: ['NONE'] },
      Labels: {
        [projectLabel]: project,
        [deploymentLabel]: config.deploymentId,
        [workspaceLabel]: workspaceId,
        [creationLabel]: token,
      },
      HostConfig: {
        ReadonlyRootfs: true,
        NetworkMode: 'none',
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        RestartPolicy: { Name: 'no' },
        NanoCpus: 1_000_000_000,
        Memory: 512 * 1024 * 1024,
        MemorySwap: 512 * 1024 * 1024,
        PidsLimit: 64,
        Tmpfs: { '/tmp': 'size=32m,mode=1777' },
        Mounts: [{
          Type: 'bind',
          Source: directory,
          Target: '/workspace',
          ReadOnly: false,
          BindOptions: { NonRecursive: true, Propagation: 'rprivate', CreateMountpoint: false },
        }],
      },
    },
  }
}
