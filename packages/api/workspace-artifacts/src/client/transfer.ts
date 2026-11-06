/** Bounded binary download transport with document-relative deployment URLs. */
import z from 'zod'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { WorkspaceArtifactResult } from '../types.ts'

const failure = z.object({ ok: z.literal(false), error: z.object({ reason: z.enum([
  'invalid-path', 'denied', 'not-found', 'not-regular', 'too-large', 'cancelled', 'io',
]) }) })

/**
 * Buffer a capped complete download before allowing the browser to save it.
 * @param workspaceId - registered workspace, never a Host path.
 * @param path - exact workspace-relative file path.
 * @param maxBytes - cap supplied by the authorized directory listing.
 * @param signal - caller and provider lifetime through complete receipt.
 * @returns a complete Blob, or a refusal without saving any partial content.
 */
export async function downloadArtifact(
  workspaceId: WorkspaceId, path: string, maxBytes: number, signal: AbortSignal,
): Promise<WorkspaceArtifactResult<Blob>> {
  try {
    signal.throwIfAborted()
    const query = new URLSearchParams({ workspaceId, path })
    const response = await fetch('api/workspace/downloadFileBinary?' + query.toString(), {
      credentials: 'same-origin', signal,
    })
    signal.throwIfAborted()
    if (response.status === 401 || response.status === 403) return { ok: false, error: { reason: 'denied' } }
    if (!response.ok) {
      const decoded = failure.safeParse(await response.json())
      signal.throwIfAborted()
      return decoded.success ? decoded.data : { ok: false, error: { reason: 'io' } }
    }
    const length = response.headers.get('content-length')
    if (length !== null && Number(length) > maxBytes) {
      await response.body?.cancel()
      return { ok: false, error: { reason: 'too-large' } }
    }
    const reader = response.body?.getReader()
    if (reader === undefined) return { ok: false, error: { reason: 'io' } }
    const chunks: Uint8Array<ArrayBuffer>[] = []
    let bytes = 0
    let cancellation: Promise<void> | undefined
    const abort = (): void => { cancellation = reader.cancel(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      if (signal.aborted) abort()
      while (true) {
        signal.throwIfAborted()
        const chunk = await reader.read()
        signal.throwIfAborted()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > maxBytes) {
          await reader.cancel()
          return { ok: false, error: { reason: 'too-large' } }
        }
        chunks.push(new Uint8Array(chunk.value))
      }
      if (length !== null && bytes !== Number(length)) return { ok: false, error: { reason: 'io' } }
      return { ok: true, value: new Blob(chunks, { type: 'application/octet-stream' }) }
    } finally {
      signal.removeEventListener('abort', abort)
      try { await cancellation } finally { reader.releaseLock() }
    }
  } catch (_cause) {
    return { ok: false, error: { reason: signal.aborted ? 'cancelled' : 'io' } }
  }
}

/**
 * Hand one completely received Blob to the browser download manager.
 * @param blob - complete, size-checked file bytes.
 * @param name - original leaf filename.
 * @returns after the download gesture; the temporary object URL is revoked.
 */
export function saveArtifact(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  try {
    anchor.href = url
    anchor.download = name
    anchor.hidden = true
    document.body.append(anchor)
    anchor.click()
  } finally {
    anchor.remove()
    URL.revokeObjectURL(url)
  }
}
