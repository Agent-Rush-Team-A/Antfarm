/** Permission reads use the Workspace owner's synchronous access effects. */
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceId, WorkspaceModeConfig } from '@deepseek-ai/dsh-workspace/types'

/**
 * Read current workspace permission through the owner’s access effect.
 * @param workspace - Workspace UI adapter.
 * @param id - Native workspace.
 * @param operation - Management action.
 * @returns Current permission, without retaining an observer.
 */
export function sandboxAllowed(workspace: Pick<UiWorkspace, 'whenAccess'>, id: WorkspaceId, operation: 'open' | 'status' | 'close'): boolean {
  let allowed = false
  const leave = workspace.whenAccess(id, `workspaceSandbox/${operation}`, () => { allowed = true; return () => {} })
  leave()
  return allowed
}

/**
 * Observe status access for one mounted workspace menu occurrence.
 * @param workspace - Workspace UI adapter.
 * @param id - Captured menu workspace.
 * @returns Permission observation owned by this menu occurrence.
 */
export function sandboxPermission(workspace: Pick<UiWorkspace, 'whenAccess'>, id: WorkspaceId): HostObservable<boolean> {
  return {
    getSnapshot: () => sandboxAllowed(workspace, id, 'status'),
    subscribe: (listener) => {
      let opening = true
      let active = true
      const leave = workspace.whenAccess(id, 'workspaceSandbox/status', () => {
        if (active && !opening) listener()
        return () => { if (active && !opening) listener() }
      })
      opening = false
      return () => { active = false; leave() }
    },
  }
}


/**
 * @param config - Latest authoritative mode; missing rows cannot accept mutations.
 * @param operation - Status remains available while execution is managed automatically.
 * @returns Whether mode admission allows this manual environment operation.
 */
export function sandboxModeAllows(config: WorkspaceModeConfig | undefined, operation: 'open' | 'status' | 'close'): boolean {
  return operation === 'status' || (config !== undefined && config.operationState === 'ready'
    && (config.mode === 'multi-vm' || config.mode === 'multi-docker'))
}
