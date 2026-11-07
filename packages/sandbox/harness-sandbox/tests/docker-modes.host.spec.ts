/** Production Docker directory resolution during restart-safe publication. */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorkspaceFileScope } from '@deepseek-ai/dsh-fs/workspace-access'
import type { WorkspaceModeChange, WorkspaceModeChangeId, WorkspaceModeRuntime } from '@deepseek-ai/dsh-workspace/types'
import * as DockerModes from '../src/docker-modes.ts'
import { fixture } from './fixtures/management.ts'

describe.runIf(process.platform === 'linux')('Docker mode directory publication', () => {
  test('recovery restores a missing published root while binary access refuses it', async () => {
    const f = await fixture(1000, false, 1000, 1000, 'multi-docker')
    await f.sandboxFiber.dispose()
    f.control.respond = (response, method) => {
      response.end(JSON.stringify(method === 'PUT'
        ? { state: 'running', containerId: 'a'.repeat(64) } : { state: 'closed' }))
    }
    const modes = f.ctx.workspaceRegistry.modes
    const register = modes.registerRuntime.bind(modes)
    const registered: { runtime?: WorkspaceModeRuntime } = {}
    vi.spyOn(modes, 'registerRuntime').mockImplementation((runtime) => {
      registered.runtime = runtime
      return register(runtime)
    })
    const stateRoot = join(f.home, 'mode-state')
    await f.ctx.plugin(DockerModes, {
      socketPath: f.socketPath, workspaceRoot: f.workspaceRoot, stateRoot, maxFiles: 100, maxBytes: 4096,
    })
    if (registered.runtime === undefined) throw new Error('Docker mode runtime did not register')
    const change: WorkspaceModeChange = {
      changeId: brandString<WorkspaceModeChangeId>(randomUUID()), workspaceId: f.alice.id,
      project: f.alice.workspace.path, from: 'multi-docker', to: 'single-docker', previousRevision: 0,
    }
    const signal = new AbortController().signal
    await writeFile(join(change.project, 'input.csv'), 'amount\n32\n')
    await registered.runtime.prepare(change, signal)
    const hash = createHash('sha256').update('single-docker:' + change.changeId).digest('hex')
    const journalPath = join(stateRoot, hash, 'state.json')
    const journal = z.object({ role: z.object({ kind: z.literal('target'), phase: z.string() }).loose() }).loose()
      .parse(JSON.parse(await readFile(journalPath, 'utf8')))
    journal.role.phase = 'publishing'
    await writeFile(journalPath, JSON.stringify(journal))
    const stage = join(f.workspaceRoot, '.' + basename(change.project) + '.mode-' + hash)
    await rename(change.project, stage + '.previous')
    const scope: WorkspaceFileScope = { workspaceId: change.workspaceId, project: change.project, signal, admit: () => {} }
    await expect(f.ctx.workspaceFileAccess.list(scope, '', 100)).rejects.toMatchObject({ code: 'ENOENT' })
    await registered.runtime.settle(change, 'commit', signal)
    expect(await readFile(join(change.project, 'input.csv'), 'utf8')).toBe('amount\n32\n')
    await registered.runtime.settle(change, 'commit', signal)
    expect(f.calls.some(call => call.method === 'PUT')).toBe(false)
  })
})
