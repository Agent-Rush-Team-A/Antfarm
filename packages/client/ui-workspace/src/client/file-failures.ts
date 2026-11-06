/** Locale-owned file refusal copy shared by the directory view and toast host. */
import type { WorkspaceArtifactFailureReason } from '@deepseek-ai/dsh-api-workspace-artifacts/types'

const KEYS = {
  denied: 'files.denied',
  'not-found': 'files.notFound',
  'too-large': 'files.tooLarge',
  cancelled: 'files.cancelled',
  'invalid-path': 'files.invalidPath',
  'not-regular': 'files.invalidPath',
  io: 'files.failed',
} as const satisfies Record<WorkspaceArtifactFailureReason, keyof typeof import('./locales.ts').zh>

/** Map a file refusal to localized recovery copy.
 * @param reason - stable file refusal category.
 * @returns its actionable workspace dictionary key.
 */
export function fileFailureKey(reason: WorkspaceArtifactFailureReason): typeof KEYS[WorkspaceArtifactFailureReason] {
  return KEYS[reason]
}
