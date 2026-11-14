import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

const URL = readFileSync(join(import.meta.dirname, '.session-url'), 'utf8').trim()
const BASE = URL.split('#')[0] as string

/**
 * Fail on any console error, page error or CSP violation (covers the nonce on upgrades).
 * `allow` lists console messages a test expects (e.g. the browser logging an expected 409).
 */
async function guard(page: Page, allow: RegExp[] = []): Promise<string[]> {
  const problems: string[] = []
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`)
    })
  })
  page.on('console', (m) => {
    if (m.type() === 'error' && !allow.some((re) => re.test(m.text()))) problems.push(m.text())
  })
  page.on('pageerror', (e) => problems.push(e.message))
  return problems
}

async function load(page: Page) {
  await page.goto(URL)
  await expect(page.getByTestId('credential-card')).toHaveCount(20)
}

test('no events between the listing and a late stream: no reload', async ({ page }) => {
  const problems = await guard(page)
  // Open the event stream well after the listing arrived (a slow CI made this race real).
  await page.route('**/api/events', async (route) => {
    await new Promise((r) => setTimeout(r, 1500))
    await route.continue()
  })
  const listings: string[] = []
  page.on('request', (r) => {
    if (new globalThis.URL(r.url()).pathname === '/api/credentials') listings.push(r.url())
  })
  await page.goto(URL)
  await expect(page.getByTestId('credential-card')).toHaveCount(20)
  await page.waitForTimeout(2500)
  expect(listings).toHaveLength(1)
  expect(problems).toEqual([])
})

test('an event between the listing and the stream opening causes exactly one reload', async ({
  page,
}) => {
  const problems = await guard(page)
  const token = new globalThis.URL(URL).hash.replace('#t=', '')
  const base = new globalThis.URL(URL).origin
  const headers = { Authorization: `Bearer ${token}` }
  // Hold the event stream until a change has happened on the server meanwhile.
  let release: () => void = () => {}
  const held = new Promise<void>((r) => {
    release = r
  })
  await page.route('**/api/events', async (route) => {
    await held
    await route.continue()
  })
  const listings: string[] = []
  page.on('request', (r) => {
    if (new globalThis.URL(r.url()).pathname === '/api/credentials') listings.push(r.url())
  })
  await page.goto(URL)
  await expect(page.getByTestId('credential-card')).toHaveCount(20)
  expect(listings).toHaveLength(1)
  // A change the page cannot hear about yet (its stream is not open): publishes one event.
  const list = await (await page.request.get(`${base}/api/credentials`, { headers })).json()
  const id = list.credentials[0].credential.id as string
  const patched = await page.request.patch(`${base}/api/credentials/${id}`, {
    headers,
    data: { label: 'Renamed meanwhile' },
  })
  expect(patched.ok()).toBe(true)
  release()
  await expect(page.getByRole('button', { name: 'Renamed meanwhile', exact: true })).toBeVisible()
  await page.waitForTimeout(1500)
  expect(listings).toHaveLength(2) // the initial one and exactly one reload
  expect(problems).toEqual([])
})

test('loads 20 demo credentials in under 1 s (median of 5) with one listing request', async ({
  page,
}) => {
  const problems = await guard(page)
  const durations: number[] = []
  for (let i = 0; i < 5; i++) {
    const requests: string[] = []
    page.on('request', (r) => requests.push(new globalThis.URL(r.url()).pathname))
    await page.goto(i === 0 ? URL : BASE) // token kept in sessionStorage after the first load
    await expect(page.getByTestId('credential-card')).toHaveCount(20)
    await page.waitForFunction(
      () => performance.getEntriesByName('mecha:cards-rendered').length > 0,
    )
    durations.push(
      await page.evaluate(
        () => performance.getEntriesByName('mecha:cards-rendered')[0]?.startTime ?? 1e9,
      ),
    )
    expect(requests.filter((p) => p === '/api/credentials')).toHaveLength(1)
    expect(requests.filter((p) => p.includes('/history'))).toHaveLength(0) // no N+1
    page.removeAllListeners('request')
  }
  durations.sort((a, b) => a - b)
  const median = durations[2] as number
  console.log(
    `cards-rendered: ${durations.map((d) => d.toFixed(0)).join(', ')} ms (median ${median.toFixed(0)})`,
  )
  expect(median).toBeLessThan(1000)
  expect(problems).toEqual([])
})

test('demo badge, every state has text and an icon, not only colour', async ({ page }) => {
  const problems = await guard(page)
  await load(page)
  await expect(page.getByTestId('demo-badge')).toBeVisible()
  for (const card of await page.getByTestId('credential-card').all()) {
    const pill = card.locator('[data-status]')
    await expect(pill).toHaveText(/\S/)
    await expect(pill.locator('svg')).toHaveCount(1)
  }
  // The counters always add up to the total (five states, «local only» included).
  let total = 0
  for (const state of ['green', 'amber', 'red', 'grey', 'local']) {
    await expect(page.getByTestId(`counter-${state}`)).toBeVisible()
    const n = await page.locator(`[data-testid="credential-card"][data-overall="${state}"]`).count()
    expect(n).toBeGreaterThan(0)
    total += n
  }
  expect(total).toBe(20)
  expect(problems).toEqual([])
})

for (const theme of ['dark', 'light'] as const) {
  test(`no axe violations in the ${theme} theme`, async ({ page }) => {
    const problems = await guard(page)
    await page.addInitScript((t) => window.localStorage.setItem('mecha.theme', t), theme)
    await load(page)
    await expect(page.locator('html')).toHaveClass(new RegExp(theme))
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([])
    expect(problems).toEqual([])
  })
}

test('fully usable with the keyboard', async ({ page }) => {
  const problems = await guard(page)
  await load(page)
  // N opens the add dialog (disabled in demo), Esc closes it.
  await page.keyboard.press('n')
  await expect(page.getByTestId('add-dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('add-dialog')).toBeHidden()
  // ⌘K / Ctrl+K palette: jump to a credential.
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByPlaceholder(/jump to a key|salta a una clave/i)).toBeFocused() // lazy-loaded
  await page.keyboard.type('Leaked')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('detail-sheet')).toBeVisible()
  await expect(page.getByTestId('detail-sheet')).toContainText('Leaked in a gist')
  await expect(page.getByTestId('detail-sheet')).toContainText(/history|historial/i)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('detail-sheet')).toBeHidden()
  // Tab reaches a card title button and Enter opens it.
  await page.keyboard.press('/')
  await expect(page.locator('#search')).toBeFocused()
  await page.keyboard.type('Grok')
  await expect(page.getByTestId('credential-card')).toHaveCount(1)
  const title = page
    .getByTestId('credential-card')
    .getByRole('button', { name: 'Grok team key', exact: true })
  await title.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('detail-sheet')).toBeVisible()
  expect(problems).toEqual([])
})

test('check all streams progress and refreshes the cards', async ({ page }) => {
  const problems = await guard(page)
  await load(page)
  await page.getByRole('button', { name: /check all|comprobar todo/i }).click()
  await expect(page.locator('#check-progress')).toHaveText('', { timeout: 10_000 })
  await expect(page.getByTestId('credential-card')).toHaveCount(20)
  expect(problems).toEqual([])
})

test.describe('Spanish browser', () => {
  test.use({ locale: 'es-ES' })

  test('the UI follows the browser language and sets <html lang>', async ({ page }) => {
    const problems = await guard(page)
    await load(page)
    await expect(page.locator('html')).toHaveAttribute('lang', 'es')
    await expect(page.getByRole('button', { name: 'Comprobar todo' })).toBeVisible()
    await expect(page.getByTestId('counter-red')).toContainText('Roto')
    await expect(page.locator('[data-status="local"]').first()).toHaveText('Solo local')
    await page.getByRole('button', { name: 'Leaked in a gist', exact: true }).click()
    await expect(page.getByTestId('detail-sheet')).toContainText('Bloqueada')
    expect(problems).toEqual([])
  })
})

test('the list refreshes every 60 s without events (e.g. a cron mecha check)', async ({ page }) => {
  const problems = await guard(page)
  await page.clock.install()
  const listings: number[] = []
  page.on('request', (r) => {
    if (new globalThis.URL(r.url()).pathname === '/api/credentials') listings.push(Date.now())
  })
  await load(page)
  expect(listings).toHaveLength(1)
  await page.clock.fastForward(61_000)
  await expect.poll(() => listings.length).toBeGreaterThanOrEqual(2)
  expect(problems).toEqual([])
})

test('demo: add a key and delete it in memory, with a confirm dialog focused on Cancel', async ({
  page,
}) => {
  const problems = await guard(page)
  await load(page)
  const fake = `xai-DEMOVIDEO${'a1b2c3d4'.repeat(8)}`
  await page.keyboard.press('n')
  const dialog = page.getByTestId('add-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText(/redacted form|forma redactada/)
  await dialog.getByLabel(/^Secret$|^Secreto$/).fill(fake)
  await expect(dialog).toContainText(/xAI · API key/)
  await dialog.getByLabel(/^Label$|^Etiqueta$/).fill('Shown in the video')
  await dialog.getByRole('button', { name: /^Add$|^Añadir$/ }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId('credential-card')).toHaveCount(21)
  expect(await page.content()).not.toContain(fake)

  await page.getByRole('button', { name: 'Shown in the video', exact: true }).click()
  const sheet = page.getByTestId('detail-sheet')
  await expect(sheet).toBeVisible()
  await sheet.getByRole('button', { name: /^Delete$|^Borrar$/ }).click()
  const confirm = page.getByTestId('delete-dialog')
  await expect(confirm).toBeVisible()
  await expect(confirm).toContainText('Shown in the video')
  await expect(confirm).toContainText('xai-')
  await expect(confirm.getByRole('button', { name: /^Cancel$|^Cancelar$/ })).toBeFocused()
  await page.keyboard.press('Escape') // cancelling keeps the key
  await expect(confirm).toBeHidden()
  await expect(sheet).toBeVisible() // one Escape closes one layer, not the sheet too
  await expect(page.getByTestId('credential-card')).toHaveCount(21)
  await sheet.getByRole('button', { name: /^Delete$|^Borrar$/ }).click()
  await confirm.getByRole('button', { name: /^Delete$|^Borrar$/ }).click()
  await expect(page.getByTestId('credential-card')).toHaveCount(20)
  expect(problems).toEqual([])
})

test('active probe: cost shown, hourly limit asks for confirmation (focus on Cancel)', async ({
  page,
}) => {
  // The second probe within the hour gets 409 probe_too_soon by design; browsers log it.
  const problems = await guard(page, [/status of 409 \(Conflict\)/])
  await load(page)
  const card = page.getByTestId('credential-card').filter({ hasText: 'Prod · chat backend' })
  const probe = card.getByRole('button', { name: /Active probe|Sonda activa/ })
  await expect(probe).toHaveAccessibleName(/USD per probe|USD por sonda/)
  await probe.click()
  await expect(page.getByText(/Probe done|Sonda hecha/).first()).toBeVisible()
  await probe.click() // within the hour
  const dialog = page.getByTestId('probe-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: /^Cancel$|^Cancelar$/ })).toBeFocused()
  await dialog.getByRole('button', { name: /Probe now|Sondear ahora/ }).click()
  await expect(dialog).toBeHidden()
  await card.getByRole('button', { name: 'Prod · chat backend', exact: true }).click()
  const sheet = page.getByTestId('detail-sheet')
  await expect(sheet.getByTestId('probe-section')).toContainText('< 0.01 USD/month')
  await expect(sheet.getByTestId('probe-section')).toContainText(
    /Prices checked|Precios consultados/,
  )
  expect(problems).toEqual([])
})

test('team balance on xAI keys and the OpenAI budget form', async ({ page }) => {
  const problems = await guard(page)
  await load(page)
  await expect(
    page.getByTestId('credential-card').filter({ hasText: 'Grok team key' }),
  ).toContainText('$42.10 (team)')
  await page.getByRole('button', { name: 'Org admin', exact: true }).click()
  const sheet = page.getByTestId('detail-sheet')
  await expect(sheet.getByTestId('budget-form')).toContainText(/auto-recharge|recarga automática/)
  await expect(sheet.getByTestId('funds-info')).toContainText(/estimated|estimado/)
  expect(problems).toEqual([])
})

test('import a .env from the add dialog (redacted preview, then import)', async ({ page }) => {
  const problems = await guard(page)
  await load(page)
  const secret = `xai-ENVIMPORT${'z9y8x7w6'.repeat(8)}`
  await page.keyboard.press('n')
  const dialog = page.getByTestId('add-dialog')
  await dialog.getByRole('tab', { name: /Import \.env|Importar \.env/ }).click()
  const panel = dialog.getByTestId('env-panel')
  await panel.locator('textarea').fill(`# app\nXAI_API_KEY=${secret}\nPORT=8080\n`)
  await panel.getByRole('button', { name: /Preview|Vista previa/ }).click()
  await expect(panel).toContainText('XAI_API_KEY')
  // The preview shows only the redacted form (the secret is just in the field it was pasted in).
  await expect(panel.getByRole('list')).not.toContainText(secret)
  await expect(panel.getByRole('list')).toContainText('xai-ENV')
  await panel.getByRole('button', { name: /Import 1|Importar 1/ }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId('credential-card')).toHaveCount(21)
  // leave the demo as it was
  await page.getByRole('button', { name: 'XAI_API_KEY', exact: true }).click()
  await page
    .getByTestId('detail-sheet')
    .getByRole('button', { name: /^Delete$|^Borrar$/ })
    .click()
  await page
    .getByTestId('delete-dialog')
    .getByRole('button', { name: /^Delete$|^Borrar$/ })
    .click()
  await expect(page.getByTestId('credential-card')).toHaveCount(20)
  expect(problems).toEqual([])
})

test('language switch: remembered across reloads; footer credits the author', async ({ page }) => {
  const problems = await guard(page)
  await page.goto(URL)
  await expect(page.locator('[data-testid="credential-card"]').first()).toBeVisible()
  const startsInSpanish = (await page.locator('html').getAttribute('lang')) === 'es'
  const toggle = page.getByTestId('lang-toggle')
  await toggle.click()
  const target = startsInSpanish ? /^Check all$/ : /^Comprobar todo$/
  await expect(page.getByRole('button', { name: target })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: target })).toBeVisible()
  const footer = page.getByRole('contentinfo')
  await expect(footer).toContainText('JoaquinRuiz')
  await expect(footer.getByRole('link', { name: /YouTube/ })).toHaveAttribute(
    'href',
    'https://youtube.com/@jokioki',
  )
  expect(problems).toEqual([])
})

test('scan tab: progress, Stop, redacted findings, import; no path ever in a URL', async ({
  page,
}) => {
  const problems = await guard(page)
  const urls: string[] = []
  page.on('request', (r) => urls.push(r.url()))
  await load(page)
  await page.keyboard.press('n')
  const dialog = page.getByTestId('add-dialog')
  await dialog.getByRole('tab', { name: /^Scan$|^Escanear$/ }).click()
  const panel = dialog.getByTestId('scan-panel')
  await expect(panel).toContainText(/Offline|Sin conexión/)
  await expect(panel.getByLabel(/Also Desktop|También Escritorio/)).toBeVisible()

  // Stopped half-way: nothing kept.
  await panel.getByRole('button', { name: /Scan my home folder|Escanear mi carpeta/ }).click()
  await panel.getByRole('button', { name: /^Stop$|^Detener$/ }).click()
  await expect(panel).toContainText(/Scan stopped|Escaneo detenido/)
  await expect(panel.getByTestId('scan-report')).toHaveCount(0)

  await panel.getByRole('button', { name: /Scan my home folder|Escanear mi carpeta/ }).click()
  await expect(panel.getByTestId('scan-progress')).toBeVisible()
  const report = panel.getByTestId('scan-report')
  await expect(report).toBeVisible({ timeout: 10_000 })
  await expect(report).toContainText(/1,843 files read|1843 ficheros leídos|1.843 ficheros/)
  await expect(report).toContainText('~/.zsh_history:1042')
  await expect(report).toContainText(/shell history|historial de la terminal/)
  await expect(report).toContainText(/cell 4, line 2|celda 4, línea 2/)
  await expect(report.locator('[data-severity="amber"]').first()).toBeVisible()
  expect(await page.content()).not.toContain('/home/demo/.zsh_history') // shown as ~ only

  const axe = await new AxeBuilder({ page }).include('[data-testid="add-dialog"]').analyze()
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([])

  await report.getByRole('checkbox', { name: /projects\/chatbot\/\.env/ }).check()
  await report.getByRole('button', { name: /Import 1|Importar 1/ }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId('credential-card')).toHaveCount(21)

  // The imported key now shows as already in Mecha, with a way to its sheet.
  await page.keyboard.press('n')
  await dialog.getByRole('tab', { name: /^Scan$|^Escanear$/ }).click()
  const stored = dialog.getByTestId('scan-finding').filter({ hasText: 'chatbot/.env' })
  await stored.getByRole('button', { name: /Open|Abrir/ }).click()
  await expect(dialog).toBeHidden()
  const sheet = page.getByTestId('detail-sheet')
  await expect(sheet).toContainText('OPENAI_API_KEY')
  await expect(sheet.getByTestId('exposures')).toContainText('~/projects/chatbot/.env:3')
  await sheet.getByRole('button', { name: /^Delete$|^Borrar$/ }).click()
  await page
    .getByTestId('delete-dialog')
    .getByRole('button', { name: /^Delete$|^Borrar$/ })
    .click()
  await expect(page.getByTestId('credential-card')).toHaveCount(20)

  for (const url of urls) {
    expect(url).not.toMatch(/home|demo%2F|zsh|\.env|ipynb/i)
  }
  expect(problems).toEqual([])
})

test('detail sheet: where a stored key was found, and scanning those files again', async ({
  page,
}) => {
  const problems = await guard(page)
  await load(page)
  await page.getByRole('button', { name: 'Demo day key', exact: true }).click()
  const sheet = page.getByTestId('detail-sheet')
  const where = sheet.getByTestId('exposures')
  await expect(where).toContainText('~/.zsh_history:1042')
  await expect(where).toContainText('~/projects/workshop/.env:1')
  await expect(where).toContainText(/shell history|historial de la terminal/)
  await expect(where).toContainText(/no risk|sin riesgo/)
  await expect(sheet).toContainText(/Also in plaintext|También en texto plano/)
  await where.getByRole('button', { name: /Scan these files again|Volver a escanear/ }).click()
  await expect(where).toContainText('~/.zsh_history:1042')
  const axe = await new AxeBuilder({ page }).include('[data-testid="detail-sheet"]').analyze()
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([])
  expect(problems).toEqual([])
})
