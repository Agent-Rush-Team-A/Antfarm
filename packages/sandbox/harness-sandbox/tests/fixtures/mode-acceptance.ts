/** Loader entry for the real Docker workspace-mode user flow. */
import { acceptance } from './mode-loader.ts'
import type { Context } from '@deepseek-ai/cordis'
export const name = acceptance.name
export const inject = acceptance.inject
export const apply = (ctx: Context): void => { acceptance.apply(ctx) }
