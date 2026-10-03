import { defineConfig, devices } from "@playwright/test";

/** Records the organizer journey as a video (demo footage). Usage: npm run demo:video */
const out = process.env.CLEARING_VIDEO_DIR ?? "demo-video";
export default defineConfig({
  testDir: "./e2e",
  testMatch: /journey\.spec\.ts/,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: out,
  use: { baseURL: process.env.CLEARING_BASE_URL ?? "http://localhost:3100", video: { mode: "on", size: { width: 1440, height: 900 } } },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
});
