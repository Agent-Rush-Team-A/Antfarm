/** Initial right-panel presentation chosen by the deployment. */
import Schema from '@deepseek-ai/schemastery'

/** Optional default page and first-open posture; saved user layouts remain authoritative. */
export interface Config {
  /** Open a newly created Session's right panel. @default false */
  initiallyExpanded?: boolean
  /** Registered page kind used to seed an empty right panel. */
  defaultPage?: string
}
/** Right-panel deployment schema. */
export const Config: Schema<Config> = Schema.object({
  initiallyExpanded: Schema.boolean().default(false), defaultPage: Schema.string(),
})
