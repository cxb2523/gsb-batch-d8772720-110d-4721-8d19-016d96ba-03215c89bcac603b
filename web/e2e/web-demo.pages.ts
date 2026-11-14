import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

// The static web demo (GitHub Pages build), served under /mecha/ by e2e/pages-setup.ts.
const URL = readFileSync(join(import.meta.dirname, '.pages-url'), 'utf8').trim()

/**
 * Fail on console errors, page errors, CSP violations and on *any* request outside the
 * demo's own files: the page must not send anything anywhere.
 */
async function guard(page: Page): Promise<{ problems: string[]; requests: string[] }> {
  const problems: string[] = []
  const requests: string[] = []
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`)
    })
  })
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text())
  })
  page.on('pageerror', (e) => problems.push(e.message))
  page.on('request', (r) => {
    requests.push(r.url())
    if (!r.url().startsWith(URL))
      problems.push(`request outside the demo: ${r.method()} ${r.url()}`)
  })
  return { problems, requests }
}

async function open(page: Page) {
  await page.goto(URL)
  await expect(page.locator('[data-testid="credential-card"]').first()).toBeVisible()
}

test('fixed notice, CSP in a meta tag, Open Graph, nothing sent anywhere', async ({ page }) => {
  const { problems, requests } = await guard(page)
  await open(page)
  const banner = page.getByTestId('static-banner')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('uvx mecha-keys')
  await expect(banner).toContainText(/made-up data/i)
  await expect(banner.getByRole('button', { name: /close|dismiss/i })).toHaveCount(0)

  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content')
  expect(csp).toContain("connect-src 'none'")
  expect(csp).toContain("script-src 'self'")
  expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/)
  // The browser enforces it: a fetch from the page is refused.
  const blocked = await page.evaluate(() =>
    fetch('/mecha/index.html').then(
      () => false,
      () => true,
    ),
  )
  expect(blocked).toBe(true)
  problems.splice(0) // the blocked fetch above logs a CSP violation on purpose

  expect(await page.locator('meta[property="og:image"]').getAttribute('content')).toBe(
    'https://joaquinruiz.github.io/mecha/social.png',
  )
  expect(await page.title()).toBe('Mecha · web demo')
  const social = await page.request.get(`${URL}social.png`)
  expect(social.status()).toBe(200)

  await page.getByRole('button', { name: /check all/i }).click()
  await expect(page.getByTestId('last-global')).toContainText(/last check/i)
  await page.waitForTimeout(3500) // let check-all run through every card
  expect(requests.every((u) => u.startsWith(URL))).toBe(true)
  expect(problems).toEqual([])
})

test('"Add" offers sample keys only: no field to paste a key', async ({ page }) => {
  const { problems } = await guard(page)
  await open(page)
  const before = await page.locator('[data-testid="credential-card"]').count()
  await page.getByRole('button', { name: 'Add credential' }).click()
  const dialog = page.getByTestId('add-dialog')
  await expect(dialog.getByTestId('sample-picker')).toBeVisible()
  await expect(dialog.getByRole('textbox')).toHaveCount(0)
  await expect(dialog.locator('textarea, input')).toHaveCount(0)
  // No .env import, no linking: sample keys and the demo's recorded scan only.
  await expect(dialog.getByRole('tab')).toHaveCount(2)
  await dialog.getByRole('button', { name: /OpenRouter/ }).click()
  await expect(dialog).toBeHidden()
  await expect(page.locator('[data-testid="credential-card"]')).toHaveCount(before + 1)
  await expect(
    page.getByRole('button', { name: 'Sample OpenRouter key', exact: true }),
  ).toBeVisible()
  expect(problems).toEqual([])
})

test('probe with the hourly limit dialog; budget and manual expiry disabled', async ({ page }) => {
  const { problems } = await guard(page)
  await open(page)
  const card = page
    .locator('[data-testid="credential-card"]')
    .filter({ has: page.getByRole('button', { name: /Active probe/ }) })
    .first()
  const probe = card.getByRole('button', { name: /Active probe/ })
  await probe.click()
  await expect(page.getByText(/Probe done/).first()).toBeVisible()
  await probe.click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toBeVisible()
  await expect(confirm.getByRole('button', { name: /^Cancel$/ })).toBeFocused()
  await confirm.getByRole('button', { name: /^Cancel$/ }).click()

  await page.getByRole('button', { name: 'Org admin', exact: true }).click()
  const budget = page.getByTestId('budget-form')
  await expect(budget).toBeVisible()
  await expect(budget.getByTestId('static-disabled')).toContainText(
    /not available in the web demo/i,
  )
  await expect(budget.getByRole('button', { name: /^Save$/ })).toBeDisabled()
  await expect(page.getByLabel('Manual expiry')).toBeDisabled()
  expect(problems).toEqual([])
})

test('delete works in memory and a reload brings the demo back', async ({ page }) => {
  const { problems } = await guard(page)
  await open(page)
  const before = await page.locator('[data-testid="credential-card"]').count()
  await page.getByRole('button', { name: 'Leaked in a gist', exact: true }).click()
  await page.getByRole('button', { name: /^Delete$/ }).click()
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: /^Delete$/ })
    .click()
  await expect(page.locator('[data-testid="credential-card"]')).toHaveCount(before - 1)
  await page.reload()
  await expect(page.locator('[data-testid="credential-card"]')).toHaveCount(before)
  expect(problems).toEqual([])
})

test('footer and language switch work in the web demo', async ({ page }) => {
  const { problems, requests } = await guard(page)
  await open(page)
  const footer = page.getByRole('contentinfo')
  await expect(footer).toContainText('Made by JoaquinRuiz')
  await expect(footer.getByRole('link')).toHaveCount(5)
  await page.getByTestId('lang-toggle').click()
  await expect(page.getByRole('button', { name: /^Comprobar todo$/ })).toBeVisible()
  await expect(footer).toContainText('Hecho por JoaquinRuiz')
  await expect(page.getByTestId('static-banner')).toContainText('Demo web con datos inventados')
  expect(requests.every((u) => u.startsWith(URL))).toBe(true) // links are not followed
  expect(problems).toEqual([])
})

for (const theme of ['dark', 'light'] as const) {
  test(`no axe violations in the ${theme} theme`, async ({ page }) => {
    await page.addInitScript((t) => window.localStorage.setItem('mecha.theme', t), theme)
    await open(page)
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])
  })
}

test('scan tab replays the demo result of a made-up home; sheet shows where', async ({ page }) => {
  const { problems } = await guard(page)
  await open(page)
  await page
    .getByRole('button', { name: /Add credential|Añadir credencial/ })
    .first()
    .click()
  const dialog = page.getByTestId('add-dialog')
  await dialog.getByRole('tab', { name: /^Scan$|^Escanear$/ }).click()
  const panel = dialog.getByTestId('scan-panel')
  await panel.getByRole('button', { name: /Scan my home folder|Escanear mi carpeta/ }).click()
  await expect(panel.getByRole('button', { name: /^Stop$|^Detener$/ })).toBeVisible()
  const report = panel.getByTestId('scan-report')
  await expect(report).toBeVisible({ timeout: 10_000 })
  await expect(report).toContainText('~/.zsh_history:1042')
  // Still nothing to paste a key into, with the scan's results on screen.
  await expect(dialog.getByRole('textbox')).toHaveCount(0)
  await expect(dialog.locator('textarea, input:not([type="checkbox"])')).toHaveCount(0)
  await report.getByRole('checkbox', { name: /projects\/chatbot\/\.env/ }).check()
  await report.getByRole('button', { name: /Import 1|Importar 1/ }).click()
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: 'OPENAI_API_KEY', exact: true }).click()
  // Imported with where it was found.
  await expect(page.getByTestId('exposures')).toContainText('~/projects/chatbot/.env:3')
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Demo day key', exact: true }).click()
  const where = page.getByTestId('exposures')
  await expect(where).toContainText('~/projects/workshop/.env:1')
  await where.getByRole('button', { name: /Scan these files again|Volver a escanear/ }).click()
  await expect(where).toContainText('~/.zsh_history:1042')
  expect(problems).toEqual([])
})
