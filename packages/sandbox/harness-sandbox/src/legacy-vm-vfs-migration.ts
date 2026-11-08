/** Offline import of completed legacy VM file caches; cloud resources remain owned by the legacy provider. */
import { lstat, realpath } from 'node:fs/promises'
import type { WorkspaceModeChange } from '@deepseek-ai/dsh-workspace/types'
import type { WorkspaceModeResources } from './mode-runtime.ts'
import type { CloudRecord, CloudWorkspaceStore } from './vultr-storage.ts'

/** Import refusal leaves the legacy record, file cache and saved snapshots unchanged. */
export class LegacyVmVfsMigrationError extends Error {
  /**
   * @param reason - Condition preventing safe offline import.
   * @param options - Original cache verification failure, when available.
   */
  constructor(readonly reason: 'legacy-not-closed' | 'cache-missing' | 'cache-unavailable' | 'identity-conflict',
    options?: ErrorOptions) {
    super('Legacy VM file import refused: ' + reason, options)
    this.name = 'LegacyVmVfsMigrationError'
  }
}

/** The caller owns exclusive legacy record access and the destination's durable directory transaction. */
export interface LegacyVmVfsMigration {
  readonly record: CloudRecord
  readonly store: Pick<CloudWorkspaceStore, 'copyPath'>
  /** Stable import identity reused after interruption; the Workspace mode need not change. */
  readonly change: WorkspaceModeChange
  readonly target: Pick<WorkspaceModeResources, 'stage' | 'publish'>
  /** Reject if the captured legacy record or destination ownership is no longer current. */
  assertCurrent(): void
}

/**
 * Import only a published complete cache from a confirmed closed legacy generation.
 * Stage and publication retain their transaction's retry evidence on failure. No cloud API,
 * source metadata mutation or snapshot retirement occurs; the caller retains exclusive ownership
 * until this promise settles and must not admit new execution before confirmed publication.
 * @param migration - Validated legacy record, source cache owner and durable VFS destination transaction.
 * @param signal - Import owner's cancellation; retry reuses the same change identity.
 * @returns Confirmation that destination publication and synchronization completed.
 */
export async function importLegacyVmCache(migration: LegacyVmVfsMigration, signal: AbortSignal): Promise<void> {
  const { record, change } = migration
  signal.throwIfAborted()
  migration.assertCurrent()
  assertLegacyVmClosed(record)
  if (change.workspaceId !== record.workspaceId || change.project !== record.project || change.from !== 'multi-vm') {
    throw new LegacyVmVfsMigrationError('identity-conflict')
  }
  if (record.cache === undefined) throw new LegacyVmVfsMigrationError('cache-missing')
  let root: string
  try {
    root = migration.store.copyPath(record.workspaceId, record.cache)
    const info = await lstat(root)
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root
      || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
      throw new Error('Published legacy cache is not a private canonical directory')
    }
  } catch (error) { throw new LegacyVmVfsMigrationError('cache-unavailable', { cause: error }) }
  signal.throwIfAborted()
  migration.assertCurrent()
  await migration.target.stage(change, { root }, signal)
  signal.throwIfAborted()
  migration.assertCurrent()
  await migration.target.publish(change, signal)
}

/**
 * Refuse offline migration while the legacy owner still has unresolved cloud or file writes.
 * @param record - Validated legacy allocation and saved-file record.
 */
export function assertLegacyVmClosed(record: CloudRecord): void {
  if (record.state !== 'closed' || record.phase !== 'closed' || record.instanceId !== undefined
    || record.candidateCache !== undefined || record.mutation !== undefined || record.failure !== undefined
    || record.resumePhase !== undefined || record.pendingSnapshotId !== undefined
    || record.snapshotDescription !== undefined || record.oldSnapshotId !== undefined) {
    throw new LegacyVmVfsMigrationError('legacy-not-closed')
  }
}
