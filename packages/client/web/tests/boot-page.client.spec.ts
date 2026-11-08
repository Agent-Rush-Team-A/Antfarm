// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { BootPage } from '../src/boot-page.ts'

afterEach(() => { document.body.innerHTML = ''; document.documentElement.lang = '' })

function mount() {
  const el = document.createElement('div')
  document.body.append(el)
  return { el, page: new BootPage(el) }
}

describe('BootPage', () => {
  it('draws the loading skeleton before any plugin state arrives', () => {
    const { el } = mount()
    expect(el.firstElementChild?.getAttribute('data-dsh-boot')).toBe('')
    expect(el.textContent).toContain('Antfarm')
    expect(el.textContent).toContain('Preparing Antfarm…')
  })

  it('keeps loading while entries are active or loading', () => {
    const { el, page } = mount()
    page.setTotal(2)
    const spinner = el.querySelector<HTMLElement>('[data-dsh-boot-spinner]')
    expect(spinner?.getAttribute('aria-valuenow')).toBe('0')
    page.setState('a', 'active')
    expect(spinner?.getAttribute('aria-valuenow')).toBe('50')
    page.setState('b', 'loading')
    expect(el.querySelector('[data-dsh-boot-spinner]')).toBe(spinner)
    page.setState('b', 'active')
    expect(spinner?.getAttribute('aria-valuenow')).toBe('100')
    expect(el.textContent).toContain('Preparing Antfarm…')
    expect(el.textContent).not.toContain('Antfarm could not start')
  })

  it('lists failed entries', () => {
    const { el, page } = mount()
    page.setState('@deepseek-ai/dsh-client-ui-layout', 'failed')
    page.setState('ok', 'active')
    page.setState('@deepseek-ai/dsh-client-ui-tool', 'failed')
    expect(el.textContent).toContain('@deepseek-ai/dsh-client-ui-layout')
    expect(el.textContent).toContain('@deepseek-ai/dsh-client-ui-tool')
    expect(el.textContent).not.toContain('ok')
    expect(el.textContent).not.toContain('Preparing Antfarm…')
  })

  it('shows the complete sweep report', () => {
    const { el, page } = mount()
    const report = 'web boot: 1 entry did not activate\nx: pending (waiting for service: y)'
    page.fail(report)
    page.setState('a', 'active')
    expect(el.textContent).toContain(report)
    expect(el.textContent).not.toContain('Preparing Antfarm…')
  })

  it('detaches on disposal', () => {
    const { el, page } = mount()
    page.dispose()
    expect(el.childNodes).toHaveLength(0)
  })

  it('uses the document language before the locale plugin loads', () => {
    document.documentElement.lang = 'zh-CN'
    const { el, page } = mount()
    expect(el.textContent).toContain('正在准备 Antfarm…')
    expect(el.querySelector('[role="progressbar"]')?.getAttribute('aria-label')).toBe('Antfarm 加载进度')
    page.fail('connection failed')
    expect(el.textContent).toContain('Antfarm 未能启动')
    expect(el.textContent).toContain('connection failed')
  })
})
