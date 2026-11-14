import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

// The scene recorded into docs/demo.gif (demo mode: fake data, no secrets, no network).
// Keep it short: the dashboard at a glance, a check, one detail sheet, the add dialog.
const URL = readFileSync(join(import.meta.dirname, '.session-url'), 'utf8').trim()
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('demo gif', async ({ page }) => {
  await page.goto(URL)
  await expect(page.locator('[data-testid="credential-card"]').first()).toBeVisible()
  await pause(1800)

  await page.getByRole('button', { name: /check all/i }).click()
  await pause(2200)

  await page.getByRole('button', { name: 'Org admin', exact: true }).click()
  await expect(page.getByTestId('budget-form')).toBeVisible()
  await pause(2600)
  await page.keyboard.press('Escape')
  await pause(800)

  await page.mouse.wheel(0, 420)
  await pause(1600)
  await page.mouse.wheel(0, -420)
  await pause(800)

  await page.getByRole('button', { name: 'Add credential' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await pause(1800)
  await page.keyboard.press('Escape')
  await pause(900)
})
