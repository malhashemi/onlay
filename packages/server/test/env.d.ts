// Types the test runtime's `env` and `exports` (cloudflare:workers) after the
// Worker's own bindings, plus what the test config adds.
import type { D1Migration } from "@cloudflare/vitest-plugin";
import type { Env as WorkerEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
    interface GlobalProps {
      mainModule: typeof import("./support/edge-worker");
    }
  }
}
