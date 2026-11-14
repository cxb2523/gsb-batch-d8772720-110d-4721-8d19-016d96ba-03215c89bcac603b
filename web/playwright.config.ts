import { defineConfig, devices } from '@playwright/test'

// Runs against `mecha serve --demo` serving the production build (src/mecha/static).
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  globalSetup: './e2e/global-setup.ts',
  use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
})
