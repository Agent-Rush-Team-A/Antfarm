/** Shared initial HTML for the framework-free boot page. */
import { bootCopy } from './boot-copy.ts'

/** Escape localized text and compiled CSS names for HTML. */
function escapeHtml(value: string | undefined): string {
  return (value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * Render the boot indicator before application scripts execute.
 * @param language - Document language used before client localization loads.
 * @param classes - CSS Module names produced by the page's CSS compiler.
 * @returns Initial markup adopted by BootPage when the client entry starts.
 */
export function bootMarkup(language: string, classes: Readonly<Record<string, string | undefined>>): string {
  const copy = bootCopy(language)
  const className = (name: string): string => escapeHtml(classes[name])
  const legs = ['frontFar', 'middleFar', 'rearFar', 'frontNear', 'middleNear', 'rearNear']
    .map(position => `<div class="${className('leg')} ${className(position)}"></div>`).join('')
  return `<div class="${className('boot')}" data-dsh-boot>
<div class="${className('card')}" data-dsh-boot-card>
<div class="${className('wordmark')}" data-dsh-boot-wordmark>${escapeHtml(copy.brand)}</div>
<div class="${className('spinner')}" data-dsh-boot-spinner role="progressbar" aria-label="${escapeHtml(copy.progress)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
<div class="${className('trail')}"></div>
<div class="${className('ant')}" data-dsh-boot-ant aria-hidden="true">${legs}
<div class="${className('abdomen')}"></div><div class="${className('thorax')}"></div><div class="${className('head')}"></div>
<div class="${className('antenna')} ${className('antennaFar')}"></div><div class="${className('antenna')} ${className('antennaNear')}"></div>
</div><div class="${className('progress')}"></div></div>
<div class="${className('hint')}" data-dsh-boot-hint>${escapeHtml(copy.loading)}</div>
</div></div>`
}
