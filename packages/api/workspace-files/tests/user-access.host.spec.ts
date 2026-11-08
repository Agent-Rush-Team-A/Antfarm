/** User previews use registered workspace roots and reject escaping file targets. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { ArtifactFailure, artifactFailure, openArtifact, streamArtifact, listArtifacts } from '@deepseek-ai/dsh-fs-local/workspace-artifacts'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceFiles } from '../src/index.ts'
import { failureOf, openWorkspace, signal, type Harness } from './harness.ts'

let harness: Harness
let files: WorkspaceFiles

beforeEach(async () => {
  harness = await openWorkspace('dsh-workspace-files-user-')
  harness.endpoint()
  harness.ctx.provide('workspaceRegistry', {
    findSession: (id: SessionId) => id === harness.scope.sessionId ? { id: WorkspaceId('viewer'), path: harness.workspace } : undefined,
  } as never)
  harness.ctx.provide('workspaceArtifacts', {
    openDownload: async (_id: unknown, path: string, lifetime: AbortSignal, _peer: unknown, maxBytes: number) => {
      const file = await openArtifact(harness.workspace, path, false, lifetime)
      const bytes = (await file.stat()).size
      if (bytes > maxBytes) { await file.close(); throw new ArtifactFailure('too-large') }
      return { bytes, ...streamArtifact(file, bytes, lifetime, () => { lifetime.throwIfAborted() }) }
    },
    list: async (_scope: unknown, path: string, lifetime: AbortSignal) => {
      try { return { path, ...await listArtifacts(harness.workspace, path, 2000, lifetime), maxDownloadBytes: 1024 * 1024 } }
      catch (cause) { throw new RemoteError('workspace-artifact/failed', 'Listing failed.', { reason: artifactFailure(cause, lifetime).reason }) }
    },
  } as never)
  const view = harness.ctx.extend({ invocation: {
    peer: { principal: { kind: 'user', userId: 'visitor' } }, request: { method: 'read' },
  } as never })
  const service = view.get('workspaceFiles')
  if (service === undefined) throw new Error('Workspace Files did not load')
  files = service
  await writeFile(join(harness.workspace, 'report.md'), '# Revenue\n814\n')
  await writeFile(join(harness.outside, 'secret.txt'), 'FOREIGN_SECRET')
})

afterEach(async () => { await harness.dispose() })

describe.skipIf(process.platform !== 'linux')('user workspace preview access', () => {
  it('reads and lists retained files using the registered workspace instead of the supplied header root', async () => {
    const scope = { ...harness.scope, workspaceRoot: harness.outside }
    expect(await files.read(scope, 'report.md', {}, signal())).toMatchObject({ text: '# Revenue\n814', eof: true })
    expect(await files.read(scope, '/workspace/report.md', {}, signal())).toMatchObject({ text: '# Revenue\n814' })
    expect(await files.stat(scope, 'report.md', signal())).toMatchObject({ bytes: 14 })
    const bytes = await files.readBytes(scope, 'report.md', {}, signal())
    expect(new TextDecoder().decode(bytes.data)).toBe('# Revenue\n814\n')
    expect(await files.list(scope, '/workspace', signal())).toMatchObject({ entries: [{ name: 'report.md', type: 'file' }] })
    const stop = new AbortController()
    const watch = files.changes(scope, 'report.md', stop.signal)[Symbol.asyncIterator]()
    try { expect(await watch.next()).toMatchObject({ value: { kind: 'ready' } }) }
    finally { stop.abort(); await watch.return?.() }
  })

  it.each(['../outside/secret.txt', '/workspace/../outside/secret.txt'])('rejects escaping relative path %s', async (path) => {
    expect(await failureOf(files.read(harness.scope, path, {}, signal()))).toMatchObject({ code: 'workspace-file/outside-workspace' })
    expect(await failureOf(files.readBytes(harness.scope, path, {}, signal()))).toMatchObject({ code: 'workspace-file/outside-workspace' })
    expect(await failureOf(files.stat(harness.scope, path, signal()))).toMatchObject({ code: 'workspace-file/outside-workspace' })
  })

  it('rejects absolute foreign files and symlinked ancestor directories across reads and watches', async () => {
    await symlink(harness.outside, join(harness.workspace, 'foreign'), 'dir')
    for (const path of [join(harness.outside, 'secret.txt'), 'foreign/secret.txt']) {
      const code = path.startsWith('foreign/') ? 'workspace-file/not-found' : 'workspace-file/outside-workspace'
      expect(await failureOf(files.read(harness.scope, path, {}, signal()))).toMatchObject({ code })
      expect(await failureOf(files.readBytes(harness.scope, path, {}, signal()))).toMatchObject({ code })
      expect(await failureOf(files.stat(harness.scope, path, signal()))).toMatchObject({ code })
      if (path.startsWith('foreign/')) {
        const watch = files.changes(harness.scope, path, signal())[Symbol.asyncIterator]()
        expect(await failureOf(watch.next())).toMatchObject({ code: 'workspace-file/outside-workspace' })
        await watch.return?.()
      } else {
        expect(() => files.changes(harness.scope, path, signal())).toThrow('Path is outside the workspace')
      }
    }
    expect(await failureOf(files.list(harness.scope, 'foreign', signal()))).toMatchObject({ code: 'workspace-artifact/failed' })
  })

  it('rejects related files outside the registered workspace', async () => {
    await mkdir(join(harness.workspace, 'nested'))
    await writeFile(join(harness.workspace, 'nested', 'index.html'), '<img src="../../outside/secret.txt">')
    expect(await failureOf(files.readBytes(harness.scope, '../../outside/secret.txt', { baseFile: 'nested/index.html' }, signal())))
      .toMatchObject({ code: 'workspace-file/outside-workspace' })
  })

  it('refuses user previews without registered session membership', async () => {
    const scope = { ...harness.scope, sessionId: SessionId('unregistered') }
    expect(await failureOf(files.read(scope, 'report.md', {}, signal()))).toMatchObject({ code: 'remote-access/denied' })
    expect(() => files.changes(scope, 'report.md', signal())).toThrow('Workspace files are unavailable')
  })
})
