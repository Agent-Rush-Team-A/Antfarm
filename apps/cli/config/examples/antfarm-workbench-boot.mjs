/** Antfarm presentation settings delivered through the supported Web bootstrap. */
import Schema from '@deepseek-ai/schemastery'

export const name = 'antfarm-workbench-boot'
export const inject = ['webServer']
export const Config = Schema.object({
  workbench: Schema.boolean().default(true),
  initiallyExpanded: Schema.boolean().default(true),
  defaultPage: Schema.string().default('workspace-files'),
})

/** @param ctx - Web bootstrap event context. @param config - Public presentation settings. */
export function apply(ctx, config) {
  ctx.on('webserver/index-inject', table => {
    if (config.workbench) table.push({ kind: 'global', name: '__DSH_ANTFARM_WORKBENCH__', value: config })
    table.push({ kind: 'global', name: '__DSH_PRODUCT_TITLE__', value: 'Antfarm' },
      { kind: 'script', placement: 'body', text: 'document.title = globalThis.__DSH_PRODUCT_TITLE__' })
  })
}
