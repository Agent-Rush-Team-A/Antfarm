/** Stable failure reasons select localized recovery guidance. */
import type { SandboxFailure } from './model.ts'
import type { SandboxCopyKey } from './locales.ts'

const keys = {
  cloud_open_failed: 'cloudOpenFailed',
  cloud_save_failed: 'cloudSaveFailed',
  sandbox_capacity: 'capacity',
  sandbox_closing: 'waitClosing',
  sandbox_cleanup_required: 'cleanupNote',
  invalid_workspace_directory: 'directoryUnavailable',
  sandbox_workspace_conflict: 'conflict',
  sandbox_name_conflict: 'conflict',
  denied: 'denied',
  disconnected: 'disconnected',
  sandbox_not_ready: 'unavailable',
  runner_unavailable: 'unavailable',
  docker_unavailable: 'unavailable',
  sandbox_outcome_unknown: 'unknown',
  runner_outcome_unknown: 'unknown',
  request_failed: 'failed',
  busy: 'failed',
} satisfies Record<SandboxFailure['reason'], SandboxCopyKey>

/**
 * Select recovery guidance without exposing transport diagnostics.
 * @param failure - Query or mutation failure.
 * @returns Locale key; unknown effects take precedence over retry guidance.
 */
export function failureKey(failure: SandboxFailure): SandboxCopyKey {
  return failure.outcomeUnknown ? 'unknown' : keys[failure.reason]
}
