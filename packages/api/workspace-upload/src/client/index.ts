/** Optional browser upload capability; its lifetime follows the Host provider. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-workspace-upload/remote'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { WorkspaceUploadBrowserResult } from '../types.ts'
import { uploadWorkspaceFile } from './transfer.ts'

/** Browser operations supplied only while workspace upload is selected. */
export interface WorkspaceUploads {
  /**
   * Upload one file, preserving existing entries and unconfirmed outcomes.
   * @param workspaceId - registered workspace owning the selected session.
   * @param file - browser-selected file sent without encoding.
   * @param signal - caller lifetime, combined with this provider's lifetime.
   * @returns confirmed publication or a structured refusal/unknown outcome.
   */
  uploadFile(workspaceId: WorkspaceId, file: File, signal: AbortSignal): Promise<WorkspaceUploadBrowserResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Browser workspace uploads, absent when the Host provider is not mounted. */
    workspaceUploads: WorkspaceUploads
  }
}

/** Generated Remote namespace installed by the application assembly. */
export const inject = ['remote', 'remote.workspaceUpload']

/**
 * Provide uploads for this plugin lifetime and drain them on withdrawal.
 * @param ctx - browser context with the generated workspace upload namespace.
 */
export function apply(ctx: Context): void {
  const lifetime = new AbortController()
  const operations = new Set<Promise<WorkspaceUploadBrowserResult>>()
  ctx.provide('workspaceUploads', {
    uploadFile: (workspaceId, file, signal) => {
      if (lifetime.signal.aborted || signal.aborted) {
        return Promise.resolve({ ok: false, error: { reason: 'cancelled', stored: false } })
      }
      const operation = uploadWorkspaceFile(
        (id, signal) => ctx.remote.workspaceUpload.limits({ workspaceId: id }, signal), workspaceId, file,
        AbortSignal.any([signal, lifetime.signal]),
      )
      operations.add(operation)
      const settled = (): void => { operations.delete(operation) }
      void operation.then(settled, settled)
      return operation
    },
  })
  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.allSettled([...operations])
  }, 'workspace upload: stop browser intake and settle transfers')
}
