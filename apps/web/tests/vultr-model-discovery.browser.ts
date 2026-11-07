/** Browser evidence for the recorded personal Vultr model-discovery scenario. */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect } from 'vitest'
import { normalizeWebSessionVolatiles } from './scaffold.ts'

/**
 * Save a personal key, choose a discovered model, and return the persisted turn.
 * @param options - Private runtime, authenticated account and recorded task.
 * @returns The observer's persisted Session and working directory.
 */
export async function driveVultrModelDiscovery(options: {
  url: string
  key: string
  task: string
  password: string
  refresh: boolean
}): Promise<{ log: string; cwd: string }> {
  const { url, key, task, password, refresh } = options
  const directory = fileURLToPath(new URL('./expected/vultr-model-discovery/', import.meta.url))
  await mkdir(directory, { recursive: true })
  const screenshots = fileURLToPath(new URL('../../../.artifacts/screenshots/', import.meta.url))
  await mkdir(screenshots, { recursive: true })
  const screenshotDirectory = await mkdtemp(join(screenshots, 'vultr-model-discovery-'))
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  try {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 720 } })
    const login = await context.request.post(new URL('/auth/login', url).href,
      { headers: { origin: new URL(url).origin }, data: { username: 'alice', password } })
    expect(login.status()).toBe(200)
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => { errors.push(String(error)) })
    await page.goto(url)
    await page.getByRole('button', { name: 'My credentials', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'My credentials', exact: true })
    await dialog.getByText('No credentials saved.', { exact: true }).waitFor()
    await dialog.getByLabel('Name', { exact: true }).fill('Vultr API Key')
    await dialog.getByLabel('Credential value', { exact: true }).fill(key)
    await dialog.getByRole('button', { name: 'Save credential', exact: true }).click()
    await dialog.getByText('2 models available. Choose a model in the conversation.', { exact: true }).waitFor()
    expect(await dialog.getByLabel('Credential value', { exact: true }).inputValue()).toBe('')
    const credentials = await dialog.ariaSnapshot()
    if (refresh) await writeFile(join(directory, 'credentials.expected.md'), credentials + '\n')
    else expect(credentials + '\n').toBe(await readFile(join(directory, 'credentials.expected.md'), 'utf8'))
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await page.screenshot({ path: join(screenshotDirectory, `credentials-${colorScheme}.png`) })
    }
    await page.setViewportSize({ width: 390, height: 844 })
    const bounds = await dialog.boundingBox()
    expect(bounds?.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
    await page.screenshot({ path: join(screenshotDirectory, 'credentials-mobile.png') })
    await page.setViewportSize({ width: 1280, height: 720 })
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    const add = page.getByRole('button', { name: 'Add workspace', exact: true })
    await add.click()
    await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor()
    const trigger = page.getByRole('button', { name: /^Select model/ })
    await trigger.click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    const picker = page.getByRole('menu', { name: 'Model', exact: true })
    const selection = await picker.ariaSnapshot()
    if (refresh) await writeFile(join(directory, 'models.expected.md'), selection + '\n')
    else expect(selection + '\n').toBe(await readFile(join(directory, 'models.expected.md'), 'utf8'))
    await picker.locator('[data-provider-id="vultr"][data-model-id="glm-5.2"]').click()
    await expect.poll(() => trigger.innerText()).toContain('GLM 5.2')
    const input = page.locator('[data-composer-input][contenteditable="true"]').first()
    await input.fill(task); await input.press('Enter')
    const observedResponse = await context.request.post(new URL('/__test/vultr-snapshot', url).href)
    expect(observedResponse.status()).toBe(200)
    const observed = await observedResponse.json() as { log: string; cwd: string }
    expect(errors).toEqual([])
    return { ...observed, log: normalizeWebSessionVolatiles(observed.log) }
  } finally { await browser.close() }
}
