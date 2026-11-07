/** Workspace-owned access effects update menu visibility without surviving disposal. */
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { whenAllowed } from '@deepseek-ai/dsh-api-remote-access/src/client/when-allowed.ts'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { expect, it, vi } from 'vitest'
import { sandboxAllowed, sandboxPermission, sandboxModeAllows } from '../src/client/access.ts'
import { parseSandboxAddress, sandboxAddress } from '../src/client/address.ts'

const id = 'sandbox-test' as WorkspaceId

it('reads current access and observes grants and revocations only while the menu is open', async () => {
  const ctx = new Context()
  const answer = createSnapshotStore(false)
  const workspace: Pick<UiWorkspace, 'whenAccess'> = {
    whenAccess: (workspaceId, action, callback) => {
      expect(workspaceId).toBe(id)
      expect(action).toBe('workspaceSandbox/status')
      return whenAllowed(ctx, answer, callback, 'sandbox menu test')
    },
  }
  try {
    expect(sandboxAllowed(workspace, id, 'status')).toBe(false)
    const permission = sandboxPermission(workspace, id)
    const listener = vi.fn()
    const leave = permission.subscribe(listener)
    expect(listener).not.toHaveBeenCalled()
    answer.set(true)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(permission.getSnapshot()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
    answer.set(false)
    expect(listener).toHaveBeenCalledTimes(2)
    answer.set(true)
    expect(listener).toHaveBeenCalledTimes(3)
    leave()
    answer.set(false)
    answer.set(true)
    expect(listener).toHaveBeenCalledTimes(3)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('accepts only canonical native workspace resource addresses', () => {
  expect(parseSandboxAddress(sandboxAddress(id))).toBe(id)
  for (const address of ['dsh-resource://workspacesandbox/../outside', 'dsh-resource://workspacesandbox/a/b',
    'dsh-resource://workspacesandbox/a?path=/tmp', 'dsh-resource://workspacesandbox/%2f',
    'dsh-resource://other/sandbox-test', 'dsh-resource://workspacesandbox/' + 'a'.repeat(129)]) {
    expect(parseSandboxAddress(address)).toBeUndefined()
  }
})


it.each(['single-vm', 'single-docker', 'multi-vm', 'multi-docker'] as const)('admits manual operations only in ready multi modes: %s', (mode) => {
  const config = { workspaceId: id, mode, revision: 0, operationState: 'ready', modeLocked: false,
    lockReason: null, firstSessionId: null } as const
  expect(sandboxModeAllows(config, 'status')).toBe(true)
  for (const operation of ['open', 'close'] as const) {
    expect(sandboxModeAllows(config, operation)).toBe(mode.startsWith('multi'))
    expect(sandboxModeAllows({ ...config, operationState: 'switching' }, operation)).toBe(false)
    expect(sandboxModeAllows(undefined, operation)).toBe(false)
  }
})
