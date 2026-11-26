import { defineConfig } from "@playwright/test";

/**
 * The smoke set CI runs (spec §11): the unpacked extension in real Chromium
 * against `wrangler dev` with the dev sign-in stub, one journey at a time.
 * Global setup builds both clients and starts the stack (harness/stack.ts).
 */
export default defineConfig({
  testDir: "./smoke",
  globalSetup: "./harness/global-setup.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  outputDir: "./test-results",
  use: {
    channel: "chromium",
    trace: "retain-on-failure",
  },
});
