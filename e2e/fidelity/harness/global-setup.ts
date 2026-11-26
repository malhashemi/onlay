import { buildRenderBundle } from "./bundle";

/**
 * Builds the real walker + portable renderer browser bundle
 * (`.gen/onlay-render.js`) the fidelity specs inject, fresh, before any spec
 * runs: the gate runs the code that ships.
 */
export default function globalSetup(): void {
  buildRenderBundle();
}
