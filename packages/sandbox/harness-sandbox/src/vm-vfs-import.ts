/** Import closed legacy VM files before the mode facade admits any execution. */
import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { WorkspaceModeChange, WorkspaceModeChangeId } from '@deepseek-ai/dsh-workspace/types'
import { assertLegacyVmClosed, importLegacyVmCache } from './legacy-vm-vfs-migration.ts'
import type { WorkspaceModeCopyLimits } from './mode-copy.ts'
import type { WorkspaceModeTarget } from './mode-routing.ts'
import type { SingleVmWorkspaces } from './single-vm-workspaces.ts'
import { CloudWorkspaceStore } from './vultr-storage.ts'

/** Explicit old storage coordinates and the new shared VFS destination. */
export interface LegacyVfsWorkspaceImportConfig {
  readonly stateRoot: string
  readonly registry: Pick<WorkspaceRegistry, 'list' | 'get'>
  readonly workspaces: SingleVmWorkspaces
  readonly backend: WorkspaceModeTarget['execution']
  readonly limits: WorkspaceModeCopyLimits
}

/**
 * Import registered multi-session VM workspaces while holding the old provider's exclusive store lock.
 * Confirmed caches supply files; a workspace never allocated by that provider imports its registered directory.
 * Stable destination journals make retries preserve subsequently written VFS files. Old records and snapshots
 * remain unchanged. A running or uncertain legacy allocation rejects before any destination writes.
 * @param config - Existing legacy state root and registry-owned destination resources.
 * @param signal - Composition startup lifetime.
 * @returns Completed, synchronized imports with the legacy store lock released.
 */
export async function importLegacyVfsWorkspaces(config: LegacyVfsWorkspaceImportConfig, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const info = await lstat(config.stateRoot)
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(config.stateRoot) !== config.stateRoot) {
    throw new Error('Legacy VM stateRoot must be an existing canonical directory')
  }
  const store = new CloudWorkspaceStore(config.stateRoot)
  await store.initialize()
  try {
    const records = await store.load()
    for (const record of records) assertLegacyVmClosed(record)
    const retained = new Map(records.map(record => [record.workspaceId, record]))
    const target = config.workspaces.importResources('multi-vm', config.backend, config.limits)
    for (const workspace of config.registry.list()) {
      if (workspace.modeConfig.mode !== 'multi-vm') continue
      const mode = workspace.modeConfig
      const assertCurrent = (): void => {
        signal.throwIfAborted()
        if (config.registry.get(workspace.id) !== workspace || workspace.modeConfig.mode !== mode.mode
          || workspace.modeConfig.revision !== mode.revision || workspace.modeConfig.operationState !== 'ready') {
          throw new Error('Legacy VM import requires an unchanged ready workspace registration')
        }
      }
      assertCurrent()
      const change: WorkspaceModeChange = {
        changeId: brandString<WorkspaceModeChangeId>(createHash('sha256')
          .update('legacy-vfs:' + config.stateRoot + ':' + workspace.id).digest('hex')),
        workspaceId: workspace.id, project: workspace.path, from: 'multi-vm', to: 'multi-vm', previousRevision: 0,
      }
      const record = retained.get(workspace.id)
      if (record !== undefined) {
        await importLegacyVmCache({ record, store, change, target, assertCurrent }, signal)
      } else {
        await target.stage(change, { root: workspace.path }, signal)
        assertCurrent()
        await target.publish(change, signal)
      }
    }
  } finally { await store.close() }
}
