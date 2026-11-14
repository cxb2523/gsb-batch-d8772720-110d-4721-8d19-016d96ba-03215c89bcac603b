import { defineConfig, devices } from '@playwright/test'

// `just gif`: records docs/demo.gif from `mecha serve --demo` (same server as the e2e run).
// Fixed size, language and colour scheme so a re-recording only changes when the UI does.
export default defineConfig({
  testDir: '.',
  testMatch: 'demo.gif.ts',
  outputDir: '../test-results/gif',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  globalSetup: './global-setup.ts',
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1200, height: 760 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    colorScheme: 'light',
    video: { mode: 'on', size: { width: 1200, height: 760 } },
  },
})
