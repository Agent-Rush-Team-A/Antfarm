/** Native read/write/edit bound to the original authenticated Workspace turn. */
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { assertSupportedJsonSchema, validateJsonSchemaValue, ToolArgsError, type JsonSchemaNode, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import * as NativeFs from '@deepseek-ai/dsh-tool-fs'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-system-prompt'
import z from '@deepseek-ai/schemastery'
import type {} from './conversation.ts'
import { WorkspaceToolFileSystem } from './file-system.ts'
import { SandboxToolAuthority } from './tool-authority.ts'
import type { WorkspaceRuntimeFiles } from './backend.ts'

/** Isolated native Workspace text tools. */
export const name = 'sandbox-files'
/** Services providing trusted turn, Workspace and remote generation. */
export const inject = ['tools', 'fs', 'systemPrompt', 'workingDirectory', 'multiuser', 'workspaceRegistry', 'sandboxConversation', 'sandboxRunnerClient', 'workspaceSandboxState']

/** Native read limits; the operation set is fixed to read/write/edit. */
export interface Config {
  /** Maximum and default returned lines; uses the native tool default. */
  readLimit?: number
  /** Maximum returned characters per line; uses the native tool default. */
  readMaxLineLength?: number
  /** Maximum returned bytes; uses the native tool default. */
  readMaxBytes?: number
}
const nativeDefaults = NativeFs.Config({}) as Required<NativeFs.Config>
/** Validate native read bounds before registering tools. */
export const Config: z<Config> = z.object({
  readLimit: z.natural().min(1).default(nativeDefaults.readLimit),
  readMaxLineLength: z.natural().min(1).default(nativeDefaults.readMaxLineLength),
  readMaxBytes: z.natural().min(1).default(nativeDefaults.readMaxBytes),
})

/**
 * Register native tools on a private filesystem and retain their schemas, prompts and result renderers.
 * @param ctx - Original tool registry and native authorization owners.
 * @param config - Validated native read caps.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = Config(config) as Required<Config>
  const authority = new SandboxToolAuthority(ctx)
  const remote = ctx.isolate('fs')
  await remote.plugin(WorkspaceToolFileSystem)
  const adapter = remote.get('fs')
  if (!(adapter instanceof WorkspaceToolFileSystem)) throw new Error('Workspace text tools require their operation-bound filesystem')
  const execute = async (
    args: unknown, exec: ToolRunContext, native: ToolDefinition, definition: ToolDefinition, parameters: JsonSchemaNode,
  ) => {
    const permit = authority.permission(exec, definition)
    const violations = validateJsonSchemaValue(parameters, args, '')
    if (violations.length > 0) throw new ToolArgsError(violations)
    const signal = AbortSignal.any([exec.signal, permit.signal, authority.signal])
    const release = await permit.resources.retain()
    const finish = ctx.workspaceSandboxState.beginExecution(permit.workspaceId)
    try {
      let files: WorkspaceRuntimeFiles
      try { files = await permit.resources.backend.files(permit.workspaceId, permit.containerId, signal) }
      catch (cause) {
        throw new HarnessError('Workspace files are unavailable. Check the sandbox status before continuing.', 'SANDBOX_FILES_UNAVAILABLE', { cause })
      }
      const check = () => {
        signal.throwIfAborted()
        const current = authority.permission(exec, definition)
        if (current.workspaceId !== permit.workspaceId || current.containerId !== permit.containerId
          || current.version !== permit.version) {
          throw new HarnessError('This file operation no longer has execution permission.', 'SANDBOX_PERMISSION_REVOKED')
        }
      }
      check()
      const project = ctx.workspaceRegistry.get(permit.workspaceId)?.path
      if (project === undefined) throw new HarnessError('Workspace is no longer available.', 'SANDBOX_PERMISSION_REVOKED')
      const root = await files.fs.resolve(files.root, { signal: files.signal })
      files.assertCurrent()
      if (files.fs.processPath(root) !== files.root) {
        throw new HarnessError('Workspace directory changed. Check the sandbox status before continuing.', 'SANDBOX_INVALID_PATH')
      }
      return await adapter.run({ permit, files, project, root, check }, () => native.execute(args, { ...exec, signal }))
    } finally { try { await release() } finally { finish() } }
  }
  await remote.plugin({
    name: 'workspace-native-text-tools', inject: NativeFs.inject,
    apply: (nativeCtx) => {
      // Remote text streams avoid the helper's whole-file RPC transfer cap.
      NativeFs.apply(nativeCtx, NativeFs.Config({
        readLimit: resolved.readLimit, readMaxLineLength: resolved.readMaxLineLength, readMaxBytes: resolved.readMaxBytes,
        readStreamMinSize: 1, read: true, write: true, edit: true, readImage: false, applyPatch: false,
      }), (native) => {
        const parameters = { ...native.parameters, additionalProperties: false }
        assertSupportedJsonSchema(parameters)
        const definition: ToolDefinition = {
          ...native, parameters, execute: (args, exec) => authority.track(execute(args, exec, native, definition, parameters)),
        }
        authority.register(definition)
      })
    },
  })
}
