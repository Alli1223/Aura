import { defineConfig, devices } from '@playwright/test';

// The Aura instance the suite drives. In CI this is the built Docker container
// (published on 8096 with the fixture media mounted); locally it is any running
// build/dev instance. Overridable with E2E_BASE_URL.
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:8096';

// The suite exercises a single, shared, stateful backend (one database, and a
// deliberately once-only "first user becomes admin" side effect), so it MUST
// run serially in a single worker and in a deterministic file order
// (01-, 02-, 03-…). Retries in CI are safe because every helper is idempotent
// (login-or-register for the admin; fresh unique usernames for other users).
export default defineConfig({
  testDir: './tests',
  globalSetup: './tests/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : [['list']],
  use: {
    baseURL,
    headless: true,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
