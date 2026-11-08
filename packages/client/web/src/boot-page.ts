/**
 * Framework-free boot page and failure report. It remains available when a
 * client plugin fails because React arrives only with the UI renderer.
 * @module @deepseek-ai/dsh-client-web/src/boot-page
 */
import type { LoaderEntryState } from './loader-status.ts'
import { bootCopy, type BootCopy } from './boot-copy.ts'
import { bootMarkup } from './boot-markup.ts'
import css from './boot-page.module.css'

/** Create a div with one module class and optional text. */
function div(className: string | undefined, text?: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = className ?? ''
  if (text !== undefined) el.textContent = text
  return el
}

/** Kernel-owned page mounted below the application's root element. */
export class BootPage {
  private readonly root: HTMLDivElement
  private readonly card: HTMLDivElement
  private readonly wordmark: HTMLDivElement
  private readonly spinner: HTMLDivElement
  private readonly hint: HTMLDivElement
  private readonly copy: BootCopy
  private readonly states = new Map<string, LoaderEntryState>()
  private readonly active = new Set<string>()
  private total = 0
  private failure: string | undefined

  /**
   * Adopt the initial HTML indicator, or attach it for a programmatic entry.
   * @param container - Application mount point.
   */
  constructor(container: HTMLElement) {
    this.copy = bootCopy(container.ownerDocument.documentElement.lang)
    if (container.querySelector(':scope > [data-dsh-boot]') === null) {
      container.insertAdjacentHTML('beforeend', bootMarkup(container.ownerDocument.documentElement.lang, css))
    }
    const element = (selector: string): HTMLDivElement => {
      const found = container.querySelector<HTMLDivElement>(selector)
      if (found === null) throw new Error(`Boot page is missing ${selector}`)
      return found
    }
    this.root = element(':scope > [data-dsh-boot]')
    this.card = element('[data-dsh-boot-card]')
    this.wordmark = element('[data-dsh-boot-wordmark]')
    this.spinner = element('[data-dsh-boot-spinner]')
    this.hint = element('[data-dsh-boot-hint]')
    this.wordmark.textContent = this.copy.brand
    this.hint.textContent = this.copy.loading
    this.spinner.setAttribute('aria-label', this.copy.progress)
    this.updateProgress()
  }

  /**
   * Set the number of loader entries represented by the progress arc.
   * @param total - Complete boot roster size.
   */
  setTotal(total: number): void {
    this.total = total
    this.updateProgress()
  }

  /**
   * Project one loader entry's fiber state.
   * @param id - Loader entry name.
   * @param state - Projected fiber state.
   */
  setState(id: string, state: LoaderEntryState): void {
    this.states.set(id, state)
    if (state === 'active') this.active.add(id)
    this.updateProgress()
    this.render()
  }

  /**
   * Display the boot failure report.
   * @param message - Failure report text.
   */
  fail(message: string): void {
    this.failure = message
    this.render()
  }

  /** Detach the page before or after the UI renderer takes the mount point. */
  dispose(): void {
    this.root.remove()
  }

  /** Redraw the state-dependent content below the wordmark. */
  private render(): void {
    const failed = [...this.states].filter(([, state]) => state === 'failed').map(([id]) => id)
    if (this.failure === undefined && failed.length === 0) {
      if (this.spinner.parentElement !== this.card) {
        this.card.replaceChildren(this.wordmark, this.spinner, this.hint)
      }
      return
    }
    const report = div(css.failed)
    report.append(div(css.failedTitle, this.copy.failed))
    for (const id of failed) report.append(div(css.failedItem, id))
    if (this.failure !== undefined) report.append(div(css.failedItem, this.failure))
    this.card.replaceChildren(this.wordmark, report)
  }

  /** Update visible and accessible progress as loader entries activate. */
  private updateProgress(): void {
    const ratio = this.total === 0 ? 0 : Math.min(this.active.size / this.total, 1)
    const percentage = String(Math.round(ratio * 100))
    this.spinner.style.setProperty('--dsh-boot-progress', `${percentage}%`)
    this.spinner.setAttribute('aria-valuenow', percentage)
  }
}
