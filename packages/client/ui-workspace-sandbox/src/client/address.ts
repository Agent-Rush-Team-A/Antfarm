/** Workspace-only resource addresses, without host paths or container identities. */
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/**
 * Build a workspace-only resource address.
 * @param workspaceId - Native registered identity.
 * @returns Canonical workspace resource address.
 */
export function sandboxAddress(workspaceId: WorkspaceId): string {
  return `dsh-resource://workspacesandbox/${workspaceId}`
}

/**
 * Validate the resource protocol and native workspace identity.
 * @param address - Resource address supplied by a consumer.
 * @returns Valid native identity, or undefined for another or malformed address.
 */
export function parseSandboxAddress(address: string): WorkspaceId | undefined {
  return /^dsh-resource:\/\/workspacesandbox\/[a-zA-Z0-9_-]{1,128}$/.test(address)
    ? address.slice('dsh-resource://workspacesandbox/'.length) as WorkspaceId : undefined
}
