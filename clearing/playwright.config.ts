import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests run against the production server (`next start` on :3100).
 * The pre-installed Chromium (PLAYWRIGHT_BROWSERS_PATH) matches @playwright/test 1.56.1;
 * never run `playwright install` here.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  outputDir: "test-results",
  use: {
    baseURL: process.env.CLEARING_BASE_URL ?? "http://localhost:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run start",
    url: "http://localhost:3100/api/status",
    reuseExistingServer: true,
    timeout: 60_000,
    env: {
      CLEARING_PACE_MS: process.env.CLEARING_PACE_MS ?? "60",
      CLEARING_DB_PATH: process.env.CLEARING_DB_PATH ?? ".data/e2e.sqlite",
    },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } }, testMatch: /edges\.spec\.ts/ },
  ],
});
