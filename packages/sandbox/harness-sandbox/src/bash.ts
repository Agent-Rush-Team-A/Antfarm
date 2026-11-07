/** Foreground Bash tool that uses only a message's original Runner execution permission. */
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { renderCommandOutput, parseExitStatus } from '@deepseek-ai/dsh-tool-bash/render'
import { z } from 'zod'
import type {} from './conversation.ts'
import { runBashExecution } from './bash-execution.ts'
import { SandboxToolAuthority } from './tool-authority.ts'
import type { RunnerExecutionId, RunnerExecutionRequest } from './execution.ts'

/** Optional isolated tool plugin name. */
export const name = 'sandbox-bash'
/** Services required to resolve trusted permission and run only through the local Runner. */
export const inject = ['tools', 'multiuser', 'sandboxConversation', 'sandboxRunnerClient', 'workspaceSandbox', 'workspaceSandboxState']

const argsSchema = z.strictObject({
  command: z.string().refine(value => value.isWellFormed() && !value.includes('\0') && value.trim().length > 0),
  description: z.string().trim().min(1),
  timeoutMs: z.int().min(1).max(60_000).default(30_000),
  workdir: z.string().optional(),
})

/**
 * Normalize a model directory within /workspace using POSIX rules on every host.
 * @param path - Optional absolute container or relative workspace directory.
 * @returns The relative Runner directory; invalid or escaping paths throw before dispatch.
 */
export function runnerWorkdir(path?: string): string {
  if (path === undefined) return '.'
  if (!path.trim() || !path.isWellFormed() || path.includes('\0') || path.includes('\\') || /^[a-z]:/iu.test(path)
    || path.split('/').includes('..') || path.startsWith('/') && path !== '/workspace' && !path.startsWith('/workspace/')) {
    throw new HarnessError('Invalid workdir: use a directory inside /workspace.', 'SANDBOX_INVALID_WORKDIR')
  }
  const relative = path.startsWith('/workspace') ? path.slice('/workspace'.length).replace(/^\/+/u, '') || '.' : path
  return posix.normalize(relative)
}

/**
 * Register the isolated foreground tool and drain its executions on plugin unload.
 * @param ctx - Tool registry, native conversation permission and owned Runner services.
 */
export function apply(ctx: Context): void {
  const authority = new SandboxToolAuthority(ctx)

  const execute = async (input: unknown, exec: ToolRunContext) => {
    const parsed = argsSchema.safeParse(input)
    if (!parsed.success) throw new HarnessError('Invalid Bash arguments. Use command, description, workdir and an integer timeoutMs from 1 to 60000.', 'SANDBOX_INVALID_ARGS')
    const check = () => authority.permission(exec, definition)
    const permit = check()
    const workdir = runnerWorkdir(parsed.data.workdir)
    const request: RunnerExecutionRequest = {
      executionId: brandString<RunnerExecutionId>(randomUUID()), expectedContainerId: permit.containerId,
      command: parsed.data.command, workdir, timeoutMs: parsed.data.timeoutMs,
    }
    const signal = AbortSignal.any([exec.signal, permit.signal, authority.signal])
    const release = await permit.resources.retain()
    const finish = ctx.workspaceSandboxState.beginExecution(permit.workspaceId)
    try {
      const result = await runBashExecution(ctx, permit, request, signal, () => { check() })
      return { cwd: posix.join('/workspace', workdir), exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
    } finally { try { await release() } finally { finish() } }
  }
  const definition: ToolDefinition = defineTool({
    name: 'bash',
    description: 'Execute a foreground bash command and return stdout, stderr and exit status. Each call starts a fresh shell; use workdir to choose a directory within /workspace. Output may be truncated. Provide description before command.',
    parameters: {
      description: { type: 'string', required: true, description: 'Concise active-voice description of the command.' },
      command: { type: 'string', required: true, description: 'The bash command to execute.' },
      workdir: { type: 'string', description: 'Directory within /workspace. Omitted means /workspace.' },
      timeoutMs: { type: 'integer', description: 'Command deadline in milliseconds, 1–60000. Default 30000; the process is stopped on expiry.' },
    },
    isConcurrencySafe: () => true,
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        cwd: { type: 'string', required: true }, exitCode: { type: 'integer', required: true },
        stdout: { type: 'object', required: true, additionalProperties: false, properties: {
          text: { type: 'string', required: true }, truncated: { type: 'boolean', required: true },
        } },
        stderr: { type: 'object', required: true, additionalProperties: false, properties: {
          text: { type: 'string', required: true }, truncated: { type: 'boolean', required: true },
        } },
      } },
      render: (_args, value) => {
        const text = renderCommandOutput(value)
        return [{ type: 'text', text: value.exitCode === 0 ? text : `${text}${text.endsWith('\n') ? '' : '\n'}[exit code: ${value.exitCode}]` }]
      },
      presentationMeta: (_args, value) => ({ exitCode: value.exitCode }),
    },
    execute: (args, exec) => authority.track(execute(args, exec)),
    presentCall: args => ({ card: 'terminal', title: args.command, description: args.description,
      cwd: posix.join('/workspace', runnerWorkdir(args.workdir)) }),
    presentResult: (_args, result) => {
      const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      if (result.isError) return { card: 'generic', content: [{ type: 'text', text }] }
      const status = z.object({ exitCode: z.int().min(0).max(255) }).safeParse(result.meta)
      if (!status.success) return { card: 'generic', content: [{ type: 'text', text }] }
      return { card: 'terminal', output: status.data.exitCode === 0 ? text : parseExitStatus(text).body, exitCode: status.data.exitCode }
    },
  })
  authority.register(definition)
}
