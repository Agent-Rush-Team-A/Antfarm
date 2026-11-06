/** Native accounts and tool pipeline; only the remote filesystem transport is substituted. */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as ObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { vi, onTestFinished } from 'vitest'
import * as Files from '../../src/files.ts'
import { conversationFixture } from './conversation.ts'
import { BashModel } from './bash.ts'

export async function filesFixture(guarded = true, config: Files.Config = {}) {
  const model = new BashModel()
  const f = await conversationFixture(model)
  const worlds = await Promise.all([f.alice, f.bob].map(async (account, index) => {
    const root = join(f.home, `remote-${index}`)
    await mkdir(root)
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: root })
    const lifetime = new AbortController()
    onTestFinished(async () => { lifetime.abort(); await ctx.fiber.dispose() })
    return { account, root, fs: ctx.fs, lifetime }
  }))
  const files = vi.spyOn(f.ctx.sandboxRunnerClient, 'files').mockImplementation(async (workspaceId, _generation, signal) => {
    const world = worlds.find(world => world.account.workspace.id === workspaceId)
    if (world === undefined) throw new Error('No remote Workspace binding')
    const lifetime = AbortSignal.any([world.lifetime.signal, ...(signal === undefined ? [] : [signal])])
    return { fs: world.fs, root: world.root, signal: lifetime, assertCurrent: () => { lifetime.throwIfAborted() } }
  })
  if (guarded) await f.ctx.plugin(ObservationPolicy)
  const fiber = f.ctx.plugin(Files, config)
  await fiber
  const results: Array<{ exec: ToolExecution; result: ToolExecutionResult }> = []
  const logged: SessionEvent<'tool/result'>[] = []
  f.ctx.on('tools/result', (exec, result) => { results.push({ exec, result }) }, { global: true })
  f.ctx.on('session/event', (_session, event) => { if (event.type === 'tool/result') logged.push(event) }, { global: true })
  const run = async (name: string, args: unknown, target = f.agent, account = f.alice) => {
    model.toolName = name
    model.args = args
    const admitted = await f.prompt(randomUUID(), undefined, target, account)
    f.release()
    await target.whenIdle()
    return { admitted, result: results.at(-1)!.result }
  }
  return { ...f, fiber, model, files, worlds, results, logged, run }
}
