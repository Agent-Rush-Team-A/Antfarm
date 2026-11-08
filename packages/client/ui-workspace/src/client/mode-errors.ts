/** Safe, localized guidance shared by configuration and Session admission. */
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceModeCommandError } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { WorkspaceKey } from './locales.ts'

/**
 * Select stable recovery guidance without exposing transport diagnostics.
 * @param error - Structured mode or Session failure.
 * @param fallback - Caller-owned guidance for unrelated failures.
 * @returns Localized safe next action.
 */
export function modeFailureKey(error: unknown, fallback: WorkspaceKey = 'mode.failed'): WorkspaceKey {
  const failure = error instanceof Error && 'rpcError' in error
    ? (error as WorkspaceModeCommandError).rpcError : remoteErrorOf(error)
  switch (failure?.code) {
    case 'workspace/mode-locked': return 'mode.locked'
    case 'workspace/mode-revision-conflict': return 'mode.conflict'
    case 'workspace/mode-unsupported': return 'mode.unsupported'
    case 'workspace/mode-single-vm-capacity': return 'mode.singleVmCapacity'
    case 'workspace/mode-runtime-unavailable': return 'mode.runtime'
    case 'workspace/mode-recovery-required': return 'mode.recovery-required'
    case 'workspace/session-limit': case 'session/reuse-unavailable': return 'mode.singleLimit'
    case 'workspace/session-operation-forbidden': return 'mode.forbidden'
    case 'remote-access/denied': return 'mode.denied'
    case 'gateway/cancelled': return 'mode.unknown'
    case 'workspace/mode-switch-failed':
      return failure.details.outcomeUnknown ? 'mode.unknown'
        : failure.details.recoveryRequired ? 'mode.recovery-required' : 'mode.failed'
    default: return fallback
  }
}
