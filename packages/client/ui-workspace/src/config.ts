/** Opt-in Antfarm presentation over the existing workspace services. */
import Schema from '@deepseek-ai/schemastery'

/** Browser presentation selected by the deployment. */
export interface Config {
  /** Show the task dashboard, workspace file panel and visible upload actions. @default false */
  workbench?: boolean
}

/** Workspace UI deployment settings. */
export const Config: Schema<Config> = Schema.object({ workbench: Schema.boolean().default(false) })
