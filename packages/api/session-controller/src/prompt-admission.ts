/** Per-request preparation and synchronous checks before a prompt enters the Agent inbox. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { SessionPromptRequest, SessionPromptValue } from './types.ts'

/** One trusted prompt operation; callbacks belong only to this admission attempt. */
export interface SessionPromptAdmission {
  readonly request: SessionPromptRequest
  readonly source: MessageSource
  readonly signal: AbortSignal
  /**
   * Prepare after Agent recovery and accepted-request deduplication, before attachments.
   * @param callback - Awaited preparation for the exact recovered Agent.
   */
  prepare(callback: (agent: Agent) => Promise<void>): void
  /**
   * Check and bind the final message immediately before synchronous inbox insertion.
   * @param callback - Synchronous check; throwing prevents insertion, and no await follows it.
   */
  beforeEnqueue(callback: (agent: Agent, message: UserMessage) => undefined): void
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Wrap prompt preparation through final inbox insertion.
     * A listener can reuse a prior admission result; otherwise it delegates with next().
     * @param admission - Trusted source, caller lifetime and operation-local preparation/check registration.
     * @param next - Continue the remaining admission listeners and original prompt operation.
     * @mode waterfall
     */
    'session/prompt-admission'(admission: SessionPromptAdmission, next: () => Promise<SessionPromptValue>): Promise<SessionPromptValue>
  }
}
