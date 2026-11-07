/** Original native-step admission shared by isolated Workspace tools. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { SandboxExecutionPermit } from './conversation.ts'

/** Checks original turn and definition admission and drains owned tool calls at unload. */
export class SandboxToolAuthority {
  /** Abort lifetime of this tool owner; fuse it with caller and original permit signals. */
  readonly signal: AbortSignal
  private readonly definitions = new Set<ToolDefinition>()
  private readonly admissions = new Map<ToolExecutionToken, { agent: Agent; turn: number; definition: ToolDefinition }>()
  private readonly pending = new Set<Promise<unknown>>()

  constructor(private readonly ctx: Context) {
    const lifecycle = new AbortController()
    this.signal = lifecycle.signal
    const turns = new WeakMap<AbortSignal, { agent: Agent; turn: number }>()
    ctx.on('agent/pre-step', ({ agent, turn, signal }, next) => {
      turns.set(signal, { agent, turn })
      return next()
    }, { global: true })
    ctx.on('tools/pre-execute', (exec, next) => {
      const original = turns.get(exec.signal)
      const definition = exec.toolSet === undefined ? undefined : ctx.tools.get(exec.name, exec.agent, exec.toolSet)
      if (original !== undefined && original.agent === exec.agent && definition !== undefined && this.definitions.has(definition)) {
        this.admissions.set(exec.token, { ...original, definition })
      }
      return next()
    }, { global: true })
    ctx.on('tools/result', (exec) => { this.admissions.delete(exec.token) }, { global: true })
    ctx.effect(() => async () => {
      lifecycle.abort()
      await Promise.allSettled(this.pending)
      this.admissions.clear()
    })
  }

  /**
   * Register one owned definition and its native multiuser exception as Cordis effects.
   * @param definition - Exact definition every executing wrapper must present to permission.
   */
  register(definition: ToolDefinition): void {
    this.definitions.add(definition)
    this.ctx.tools.register(definition)
    this.ctx.multiuser.registerIsolatedTool(definition, (exec) => {
      try { this.permission(exec, definition); return true } catch (_revoked: unknown) { return false }
    })
  }

  /**
   * Recheck the original admission and current native ownership; never open a Workspace.
   * @param exec - Original native tool identity; nested and unadmitted calls are refused.
   * @param definition - Exact executing definition, preventing cross-tool token reuse.
   * @returns Original message and generation permit; revocation throws before remote work.
   */
  permission(exec: Readonly<ToolExecution>, definition: ToolDefinition): SandboxExecutionPermit {
    const original = this.admissions.get(exec.token)
    if (this.signal.aborted || original === undefined || original.agent !== exec.agent
      || original.definition !== definition || exec.toolSet === undefined
      || exec.parent !== undefined || this.ctx.tools.get(exec.name, exec.agent, exec.toolSet) !== definition) {
      throw new HarnessError('This operation has no valid execution permission.', 'SANDBOX_PERMISSION_REVOKED')
    }
    try { return this.ctx.sandboxConversation.forTurn(original.agent, original.turn) } catch (cause) {
      throw new HarnessError('This operation no longer has valid execution permission.', 'SANDBOX_PERMISSION_REVOKED', { cause })
    }
  }

  /**
   * Retain accepted work until it settles so unload can join it.
   * @param operation - Execution whose caller observes its result or failure.
   * @returns The original settlement after releasing its ownership record.
   */
  track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation)
    return operation.finally(() => { this.pending.delete(operation) })
  }
}
