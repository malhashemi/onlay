import { defineConfig } from "@playwright/test";

/**
 * The Stage-1 fidelity gate (render spec §4). A separate Playwright project from
 * the smoke set: it runs ONLY `fidelity/` against fixture pages on an ephemeral
 * localhost port (no onlay server, no extension), pins `deviceScaleFactor: 1`
 * and a fixed viewport so font-rasterizer / subpixel variance is eliminated
 * (§4.3 step 3 — device-independent comparison is CI's job), and rasterizes both
 * the live block and the reconstruction with one Chromium.
 */
export default defineConfig({
  testDir: "./fidelity",
  globalSetup: "./fidelity/harness/global-setup.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  retries: 0,
  reporter: [["list"]],
  use: {
    channel: "chromium",
    deviceScaleFactor: 1,
    viewport: { width: 900, height: 1000 },
    trace: "retain-on-failure",
  },
});
