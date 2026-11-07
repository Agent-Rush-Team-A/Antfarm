import { expect, it, onTestFinished, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { PeerId, Principal, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { barrier, modeFixture } from '../../../workspace/workspace/tests/mode-fixture.ts'
import WorkspaceController from '../src/index.ts'
import type { WorkspaceFollowFrame } from '../src/types.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    'mode-test': { readonly kind: 'mode-test'; readonly name: string }
  }
}

async function fixture() {
  const f = await modeFixture()
  f.ctx.provide('typert', {
    lookups: { configure: () => () => {} }, contexts: { configureHost: () => () => {} }, resources: { register: () => () => {} },
  } as never)
  new RemoteAccess(f.ctx)
  const controller = new WorkspaceController(f.ctx, { documentsDirectory: f.path })
  f.ctx.effect(() => f.registry.modes.registerRuntime(f.adapter))
  return { ...f, controller }
}

function caller(ctx: Context, principal: Principal): Context {
  const signal = new AbortController().signal
  const invocation: RemoteInvocation = {
    request: { namespace: 'workspace', method: 'setMode', args: {} }, service: 'workspaceController', signal,
    peer: { id: 'mode-peer' as PeerId, ctx, principal, interactions: 'answer', signal, dispose: async () => {} },
    uplink: <In>(): AsyncIterable<In> => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
  }
  return ctx.extend({ invocation })
}

it('reads mode metadata and permanently rejects edits after the first ordinary Session', async () => {
  const f = await fixture(), id = f.workspace.id
  expect(await f.controller.getMode({ workspaceId: id })).toEqual({ config: f.workspace.modeConfig })
  await f.controller.setMode({ workspaceId: id, mode: 'single-vm', expectedRevision: 0 }, f.options.signal)
  await f.registry.withSessionCreation(id, SessionId('first'), async (admission) => {
    f.headers.set(admission.sessionId, {
      id: admission.sessionId, cwd: f.path, createdAt: 1, isSeeded: false, version: SESSION_FORMAT_VERSION,
    })
    return { sessionId: admission.sessionId, value: undefined }
  }, f.options)
  await expect(f.controller.setMode({ workspaceId: id, mode: 'single-vm', expectedRevision: f.workspace.modeConfig.revision }, f.options.signal))
    .rejects.toMatchObject({
      code: 'workspace/mode-locked', details: { firstSessionId: 'first', lockReason: 'first-session-created' },
    })
  await expect(f.controller.archiveSession({ sessionId: SessionId('first'), stopActivity: true }))
    .rejects.toMatchObject({ code: 'workspace/session-operation-forbidden' })
})

it.each([-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid wire revision %s before any runtime operation', async (expectedRevision) => {
  const f = await fixture()
  await expect(f.controller.setMode({ workspaceId: f.workspace.id, mode: 'single-vm', expectedRevision }, f.options.signal))
    .rejects.toMatchObject({ code: 'gateway/bad-request' })
  expect(f.adapter.prepare).not.toHaveBeenCalled()
})

it('refuses direct non-owner reads and writes without changing mode', async () => {
  const f = await fixture()
  const guest = caller(f.ctx, { kind: 'mode-test', name: 'stranger' }).workspaceController
  await expect(guest.getMode({ workspaceId: f.workspace.id })).rejects.toMatchObject({ code: 'remote-access/denied' })
  await expect(guest.setMode({ workspaceId: f.workspace.id, mode: 'single-vm', expectedRevision: 0 }, f.options.signal))
    .rejects.toMatchObject({ code: 'remote-access/denied' })
  expect(f.workspace.modeConfig.revision).toBe(0)
})

it('captures the caller and rechecks its grant after waiting for a file lease', async () => {
  const f = await fixture()
  let allowed = true
  f.ctx.remoteAccess.registerPolicy('mode-test', {
    bindings: principal => principal.name === 'owner' && allowed ? [{
      role: { name: 'mode-owner', resource: 'workspace', actions: ['workspace/getMode', 'workspace/setMode'] },
      resource: { kind: 'workspace', id: f.workspace.id },
    }] : [],
  })
  const owner = caller(f.ctx, { kind: 'mode-test', name: 'owner' }).workspaceController
  await expect(owner.getMode({ workspaceId: f.workspace.id })).resolves.toMatchObject({ config: { revision: 0 } })
  const lease = await f.registry.modes.acquireUse(f.workspace.id, f.options)
  const change = owner.setMode({ workspaceId: f.workspace.id, mode: 'single-vm', expectedRevision: 0 }, f.options.signal)
  allowed = false; lease.release()
  await expect(change).rejects.toMatchObject({ code: 'remote-access/denied' })
  expect(f.adapter.prepare).not.toHaveBeenCalled()
})

it('publishes revisioned transitional and ready metadata through the Workspace feed', async () => {
  const f = await fixture(), abort = new AbortController()
  const iterator = f.controller.follow(abort.signal)[Symbol.asyncIterator]()
  onTestFinished(async () => { abort.abort(); await iterator.return?.() })
  const initial = await iterator.next()
  expect(initial.value).toMatchObject({ type: 'baseline', value: { items: [{ modeConfig: { revision: 0 } }] } })
  const entered = barrier(), finish = barrier()
  f.adapter.prepare = vi.fn(async () => { entered.resolve(); await finish.promise })
  const change = f.controller.setMode({ workspaceId: f.workspace.id, mode: 'single-docker', expectedRevision: 0 }, f.options.signal)
  await entered.promise
  const preparing = await iterator.next()
  expect(preparing.value).toMatchObject({ type: 'upsert', workspace: { modeConfig: { revision: 1, mode: 'multi-vm', operationState: 'switching' } } })
  finish.resolve(); await change
  const frames: WorkspaceFollowFrame[] = []
  while (frames.length < 2) {
    const frame = await iterator.next()
    if (frame.done) throw new Error('Workspace feed ended before settled publication')
    frames.push(frame.value)
  }
  expect(frames.at(-1)).toMatchObject({ type: 'upsert', workspace: { modeConfig: { revision: 3, mode: 'single-docker', operationState: 'ready' } } })
})
