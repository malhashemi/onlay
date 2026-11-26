import { defineConfig } from "@playwright/test";

/**
 * Suites kept out of CI but run by `bun run check:all`: service-worker death
 * and the strict-CSP page, on the same stack as the smoke set.
 */
export default defineConfig({
  testDir: "./specs",
  globalSetup: "./harness/global-setup.ts",
  workers: 1,
  fullyParallel: false,
  // A sign-in may wait out the shared sign-in rate window once (harness/fixtures.ts).
  timeout: 180_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [["list"]],
  outputDir: "./test-results",
  use: {
    channel: "chromium",
    trace: "retain-on-failure",
  },
});
