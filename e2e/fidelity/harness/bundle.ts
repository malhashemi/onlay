import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("./render-entry.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
export const RENDER_BUNDLE = fileURLToPath(new URL("../.gen/onlay-render.js", import.meta.url));

/**
 * Bundle the REAL walker + portable renderer into one classic-IIFE script the
 * fidelity gate injects into a fixture page via `addScriptTag({ path })`. IIFE
 * (not ESM) so the injected script needs no module loader and attaches
 * `window.__onlayFidelity` synchronously.
 *
 * Built through a `bun build` subprocess because Playwright's global setup runs
 * under Node (no `Bun.build`), mirroring the functional e2e global-setup's
 * `spawn("bun", ["run", "build"])`.
 */
export function buildRenderBundle(): string {
  const result = spawnSync(
    "bun",
    ["build", ENTRY, "--outfile", RENDER_BUNDLE, "--target=browser", "--format=iife"],
    { cwd: REPO_ROOT, stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error("fidelity render bundle failed (bun build)");
  }
  return RENDER_BUNDLE;
}
