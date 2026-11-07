/** Transition ordering and independent rollback through restart-safe resource owners. */
import { expect, test, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId, WorkspaceModeChange, WorkspaceModeChangeId } from '@deepseek-ai/dsh-workspace/types'
import { WorkspaceModeRuntimeAdapter, type WorkspaceModeResources } from '../src/mode-runtime.ts'

function fixture() {
  const events: string[] = []
  const resources = (name: string) => ({
    checkpoint: vi.fn(async () => { events.push(name + ':checkpoint'); return { root: '/private/checkpoint' } }),
    stage: vi.fn(async () => { events.push(name + ':stage') }),
    publish: vi.fn(async () => { events.push(name + ':publish') }),
    retire: vi.fn(async () => { events.push(name + ':retire') }),
    discard: vi.fn(async () => { events.push(name + ':discard') }),
    restore: vi.fn(async () => { events.push(name + ':restore') }),
  } satisfies WorkspaceModeResources)
  const source = resources('source')
  const target = resources('target')
  const providers = new Map([['multi-vm' as const, source], ['single-docker' as const, target]])
  const runtime = new WorkspaceModeRuntimeAdapter(providers)
  const change: WorkspaceModeChange = {
    changeId: brandString<WorkspaceModeChangeId>('transition-1'), workspaceId: brandString<WorkspaceId>('workspace-1'),
    project: '/workspace/identity', from: 'multi-vm', to: 'single-docker', previousRevision: 5,
  }
  const controller = new AbortController()
  return { source, target, runtime, providers, change, controller, events }
}

test('prepares from the original checkpoint and publishes before retiring source resources', async () => {
  const f = fixture()
  await f.runtime.prepare(f.change, f.controller.signal)
  expect(f.events).toEqual(['source:checkpoint', 'target:stage'])
  expect(f.target.stage).toHaveBeenCalledWith(f.change, { root: '/private/checkpoint' }, f.controller.signal)
  await f.runtime.settle(f.change, 'commit', f.controller.signal)
  expect(f.events).toEqual(['source:checkpoint', 'target:stage', 'target:publish', 'source:retire'])
})

test('unsupported destination is rejected before stopping the source', async () => {
  const f = fixture()
  await expect(f.runtime.prepare({ ...f.change, to: 'single-vm' }, f.controller.signal)).rejects.toMatchObject({ reason: 'unsupported-mode' })
  expect(f.source.checkpoint).not.toHaveBeenCalled()
})

test('cancelled preparation does not publish and remains eligible for rollback', async () => {
  const f = fixture()
  vi.mocked(f.source.checkpoint).mockImplementationOnce(async () => {
    f.controller.abort(new Error('cancelled'))
    return { root: '/private/checkpoint' }
  })
  await expect(f.runtime.prepare(f.change, f.controller.signal)).rejects.toThrow('cancelled')
  expect(f.target.stage).not.toHaveBeenCalled()
  await f.runtime.settle(f.change, 'rollback', new AbortController().signal)
  expect(f.target.discard).toHaveBeenCalledOnce()
  expect(f.source.restore).toHaveBeenCalledOnce()
})

test('failed destination publication preserves the source resources', async () => {
  const f = fixture()
  const failure = new Error('publication failed')
  vi.mocked(f.target.publish).mockRejectedValueOnce(failure)
  await expect(f.runtime.settle(f.change, 'commit', f.controller.signal)).rejects.toBe(failure)
  expect(f.source.retire).not.toHaveBeenCalled()
  expect(f.source.restore).not.toHaveBeenCalled()
})

test('failed destination cleanup does not skip restoration of the source', async () => {
  const f = fixture()
  const failure = new Error('cleanup failed')
  vi.mocked(f.target.discard).mockRejectedValueOnce(failure)
  await expect(f.runtime.settle(f.change, 'rollback', f.controller.signal)).rejects.toMatchObject({ errors: [failure] })
  expect(f.source.restore).toHaveBeenCalledOnce()
})

test('both rollback failures remain visible, including synchronous provider errors', async () => {
  const f = fixture()
  const first = new Error('cleanup failed')
  const second = new Error('restore failed')
  vi.mocked(f.target.discard).mockImplementationOnce(() => { throw first })
  vi.mocked(f.source.restore).mockRejectedValueOnce(second)
  await expect(f.runtime.settle(f.change, 'rollback', f.controller.signal)).rejects.toMatchObject({ errors: [first, second] })
})

test('a replacement adapter replays the durable decision without preparing again', async () => {
  const f = fixture()
  await f.runtime.prepare(f.change, f.controller.signal)
  const replacement = new WorkspaceModeRuntimeAdapter(f.providers)
  await replacement.settle(f.change, 'commit', f.controller.signal)
  expect(f.source.checkpoint).toHaveBeenCalledOnce()
  expect(f.target.stage).toHaveBeenCalledOnce()
  expect(f.target.publish).toHaveBeenCalledWith(f.change, f.controller.signal)
})

test('retirement failure leaves the commit direction unchanged for retry', async () => {
  const f = fixture()
  vi.mocked(f.source.retire).mockRejectedValueOnce(new Error('snapshot locked'))
  await expect(f.runtime.settle(f.change, 'commit', f.controller.signal)).rejects.toThrow('snapshot locked')
  await f.runtime.settle(f.change, 'commit', f.controller.signal)
  expect(f.target.publish).toHaveBeenCalledTimes(2)
  expect(f.source.retire).toHaveBeenCalledTimes(2)
  expect(f.source.restore).not.toHaveBeenCalled()
  expect(f.target.discard).not.toHaveBeenCalled()
})
