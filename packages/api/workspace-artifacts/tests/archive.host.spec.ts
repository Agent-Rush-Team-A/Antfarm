/** Archived provider admission remains an expected refusal through real Connection routes. */
import type { Context } from '@deepseek-ai/cordis'
import { WorkspaceFileAccess } from '@deepseek-ai/dsh-fs/workspace-access'
import { WorkspaceModeError } from '@deepseek-ai/dsh-workspace'
import { describe, expect, it } from 'vitest'
import { id, setup } from './fixture.ts'

function refusingFiles(error: Error, beforeDownload = (): void => {}) {
  return (ctx: Context): WorkspaceFileAccess => {
    class RefusingFiles extends WorkspaceFileAccess {
      async list(): Promise<never> { throw error }
      async download(): Promise<never> { beforeDownload(); throw error }
      async upload(): Promise<never> { throw error }
    }
    return new RefusingFiles(ctx)
  }
}

describe.skipIf(process.platform !== 'linux')('workspace archival file refusals', () => {
  it('returns HTTP 403 and typed listing denial when provided storage rejects an archived workspace', async () => {
    const failure = new WorkspaceModeError('workspace/archived', { workspaceId: id })
    const f = await setup(3, refusingFiles(failure))
    const response = await f.send(f.request())
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ ok: false, error: { reason: 'denied' } })
    await expect(f.service.list({ workspaceId: id }, '', new AbortController().signal))
      .rejects.toMatchObject({ code: 'workspace-artifact/failed', details: { reason: 'denied' },
        cause: { reason: 'denied', cause: failure } })
    await expect(f.service.openDownload(id, 'file', new AbortController().signal, f.peer, 3))
      .rejects.toMatchObject({ reason: 'denied', cause: failure })
  })

  it('retains HTTP 500 for an unclassified storage failure', async () => {
    const f = await setup(3, refusingFiles(new Error('VFS mount unavailable')))
    const response = await f.send(f.request())
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ ok: false, error: { reason: 'io' } })
  })

  it('reports cancellation when admission fails after the request is cancelled', async () => {
    const controller = new AbortController()
    const failure = new WorkspaceModeError('workspace/archived', { workspaceId: id })
    const f = await setup(3, refusingFiles(failure, () => { controller.abort() }))
    const response = await f.send(f.request(undefined, { signal: controller.signal }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ ok: false, error: { reason: 'cancelled' } })
  })
})
