/** Real multi-VM mode admission with scenario-owned HTTP execution and persistent directory files. */
import WorkspaceModeBackend from '../../../../../../packages/sandbox/harness-sandbox/lib/mode-backend.js'
import { RunnerClient } from '../../../../../../packages/sandbox/harness-sandbox/lib/types/runner-client.js'
import { RunnerConfig } from '../../../../../../packages/sandbox/harness-sandbox/lib/types/config.js'
import { WorkspaceModeDirectoryFiles } from '../../../../../../packages/sandbox/harness-sandbox/lib/types/mode-directory-files.js'

export const inject = ['workspaceRegistry']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Isolated Web scenario owner. */
export async function apply(ctx) {
  const client = new RunnerClient(RunnerConfig({ socketPath: process.env.DSH_SANDBOX_RUNNER_SOCKET }))
  let facade
  ctx.effect(() => async () => {
    try { await facade?.dispose() } finally { client.dispose() }
  })
  const execution = {
    open: (id, project) => client.open(id, project),
    close: id => client.close(id),
    status: id => client.status(id),
    execute: (id, request, signal) => client.execute(id, request, signal),
    cancel: (id, request) => client.cancel(id, request),
    files: async () => { throw new Error('This Bash scenario does not use SSH text files') },
  }
  const files = new WorkspaceModeDirectoryFiles(async scope => ({ root: scope.project, assertCurrent() {
    scope.signal.throwIfAborted()
    scope.admit()
    if (ctx.workspaceRegistry.get(scope.workspaceId)?.path !== scope.project) throw new Error('Scenario workspace changed')
  } }))
  facade = ctx.plugin(WorkspaceModeBackend, {
    modes: ctx.workspaceRegistry.modes,
    targets: new Map([['multi-vm', { execution, files }]]),
    runtime: { supportedModes: ['multi-vm'],
      async prepare() { throw new Error('This recorded scenario keeps its initial VM mode') },
      async settle() { throw new Error('This recorded scenario performs no mode transition') },
    },
  })
  await facade
}
