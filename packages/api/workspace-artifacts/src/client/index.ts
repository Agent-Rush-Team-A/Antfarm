/** Optional browser file capability with cancellation and bounded download ownership. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-workspace-artifacts/remote'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { WorkspaceArtifactListing, WorkspaceArtifactResult } from '../types.ts'
import { downloadArtifact, saveArtifact } from './transfer.ts'

/** Browser file operations available only while the Host provider is selected. */
export interface WorkspaceArtifactFiles {
  /**
   * Read one workspace-relative directory.
   * @param workspaceId - workspace identity.
   * @param path - directory relative to the workspace; empty for root.
   * @param signal - caller lifetime, combined with provider lifetime.
   * @returns bounded metadata or a browser-safe refusal.
   */
  listFiles(workspaceId: WorkspaceId, path: string, signal: AbortSignal): Promise<WorkspaceArtifactResult<WorkspaceArtifactListing>>
  /**
   * Receive a complete file before handing it to the browser download manager.
   * @param workspaceId - workspace identity.
   * @param path - workspace-relative regular file.
   * @param maxBytes - listing's cap, enforced while buffering.
   * @param signal - caller lifetime, combined with provider lifetime.
   * @returns whether a complete download gesture was issued.
   */
  downloadFile(workspaceId: WorkspaceId, path: string, maxBytes: number, signal: AbortSignal): Promise<WorkspaceArtifactResult<void>>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional file browser operations; withdrawal cancels and drains pending work. */
    workspaceArtifactFiles: WorkspaceArtifactFiles
  }
}

/** Generated Remote namespace supplied by application assembly. */
export const inject = ['remote', 'remote.workspaceArtifacts']

/** @param ctx - browser context carrying the generated workspace file namespace. */
export function apply(ctx: Context): void {
  const lifetime = new AbortController()
  const operations = new Set<Promise<unknown>>()
  const track = <T>(operation: Promise<T>): Promise<T> => {
    operations.add(operation)
    const settled = (): void => { operations.delete(operation) }
    void operation.then(settled, settled)
    return operation
  }
  ctx.provide('workspaceArtifactFiles', {
    listFiles: (workspaceId, path, signal) => track((async () => {
      const combined = AbortSignal.any([signal, lifetime.signal])
      try {
        combined.throwIfAborted()
        const result = await ctx.remote.workspaceArtifacts.list({ workspaceId }, path, combined)
        combined.throwIfAborted()
        if (result.ok) return result
        return { ok: false, error: { reason: result.error.code === 'workspace-artifact/failed'
          ? result.error.details.reason : 'denied' } } as const
      } catch (_cause) {
        return { ok: false, error: { reason: combined.aborted ? 'cancelled' : 'io' } } as const
      }
    })()),
    downloadFile: (workspaceId, path, maxBytes, signal) => track((async () => {
      const combined = AbortSignal.any([signal, lifetime.signal])
      const result = await downloadArtifact(workspaceId, path, maxBytes, combined)
      if (!result.ok) return result
      if (combined.aborted) return { ok: false, error: { reason: 'cancelled' } } as const
      try {
        saveArtifact(result.value, path.slice(path.lastIndexOf('/') + 1))
        return { ok: true, value: undefined } as const
      } catch (_cause) {
        return { ok: false, error: { reason: 'io' } } as const
      }
    })()),
  })
  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.allSettled([...operations])
  }, 'workspace artifacts: stop browser operations and settle downloads')
}
