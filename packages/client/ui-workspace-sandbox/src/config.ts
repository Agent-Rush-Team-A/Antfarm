/** Polling cadence for visible workspace sandbox controls. */
import z from '@deepseek-ai/schemastery'

/** Deployment-configurable status polling interval. */
export interface Config {
  /** Delay in milliseconds after a completed query while the panel is open. */
  pollIntervalMs: number
}
/** Validated cadence; each poll finishes before the next is scheduled. */
export const Config: z<Config> = z.object({ pollIntervalMs: z.natural().min(1).default(2000) })
