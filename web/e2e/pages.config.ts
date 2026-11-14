import { defineConfig, devices } from '@playwright/test'

// The static web demo (web/dist-pages) served like GitHub Pages: only under /mecha/.
export default defineConfig({
  testDir: '.',
  testMatch: 'web-demo.pages.ts',
  outputDir: '../test-results/pages',
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  globalSetup: './pages-setup.ts',
  use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure', locale: 'en-US' },
})
