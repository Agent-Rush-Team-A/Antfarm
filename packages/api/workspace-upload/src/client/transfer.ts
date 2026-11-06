/** Browser transport for workspace uploads; unconfirmed writes remain visible. */
import z from 'zod'
import type { WorkspaceUploadLimits, WorkspaceUploadResult, WorkspaceUploadBrowserResult } from '../types.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

const resultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.object({ name: z.string(), bytes: z.number().int().nonnegative() }) }),
  z.object({ ok: z.literal(false), error: z.object({
    reason: z.enum(['invalid-request', 'invalid-name', 'too-large', 'exists', 'denied', 'unavailable', 'cancelled', 'io', 'cleanup']),
    stored: z.boolean(),
  }) }),
])

/**
 * Check the deployment cap, then send the original bytes to the scoped route.
 * @param limits - authorized Remote limit reader.
 * @param workspaceId - workspace owning the selected session.
 * @param file - selected browser file, uploaded without encoding or aggregation.
 * @param signal - component lifetime; a lost response has an unknown publication outcome.
 * @returns pre-transfer cancellation, a confirmed response or an unknown publication outcome.
 */
export async function uploadWorkspaceFile(
  limits: (workspaceId: WorkspaceId, signal: AbortSignal) => Promise<RemoteResult<WorkspaceUploadLimits>>,
  workspaceId: WorkspaceId,
  file: File,
  signal: AbortSignal,
): Promise<WorkspaceUploadBrowserResult> {
  let maxBytes: number
  try {
    signal.throwIfAborted()
    const result = await limits(workspaceId, signal)
    signal.throwIfAborted()
    if (!result.ok) return { ok: false, error: { reason: 'denied', stored: false } }
    maxBytes = result.value.maxBytes
  } catch (_error) {
    // The limit read happens before sending bytes; failure has no file effect.
    return { ok: false, error: { reason: signal.aborted ? 'cancelled' : 'denied', stored: false } }
  }
  if (file.size > maxBytes) return { ok: false, error: { reason: 'too-large', stored: false } }
  let result: WorkspaceUploadResult
  try {
    const query = new URLSearchParams({ workspaceId, name: file.name })
    const response = await fetch('api/workspace/uploadFileBinary?' + query.toString(), {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' },
      credentials: 'same-origin', body: file, signal,
    })
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: { reason: 'denied', stored: false } }
    }
    const decoded = resultSchema.safeParse(await response.json())
    if (!decoded.success || response.ok !== decoded.data.ok) {
      return { ok: false, error: { reason: 'unknown', stored: false } }
    }
    result = decoded.data
  } catch (_error) {
    // Bytes may already be published when a response is lost or cancelled.
    return { ok: false, error: { reason: 'unknown', stored: false } }
  }
  return result
}
