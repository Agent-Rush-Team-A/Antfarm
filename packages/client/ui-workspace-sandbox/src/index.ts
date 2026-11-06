/** Host declaration for the optional workspace sandbox browser plugin. */
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.ts'
export { Config } from './config.ts'

/** @param _ctx - Host context; sandbox management remains in Harness. @param _config - Cadence projected to the browser. */
export function apply(_ctx: Context, _config: Config): void {}
