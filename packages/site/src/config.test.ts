// The page's addresses agree with the Worker that serves it: the extension
// ids it pings are the ones production's EXTENSION_IDS names, the page's own
// origin is the site's, and the service is the production service unless a
// build names another.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXTENSION_IDS, installHref, PAGE_ORIGIN, SERVICE_ORIGIN, STORE_LISTED } from "./config";

const WRANGLER = join(import.meta.dir, "..", "..", "server", "wrangler.jsonc");

/** Every `EXTENSION_IDS` value in wrangler.jsonc, in order: the top level (production) first. */
function workerExtensionIds(): string[][] {
  const text = readFileSync(WRANGLER, "utf8");
  return [...text.matchAll(/"EXTENSION_IDS":\s*"([^"]*)"/g)].map((m) =>
    (m[1] ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

describe("the page's config", () => {
  test("pings exactly the extension ids production's Worker accepts", () => {
    const [production, ...others] = workerExtensionIds();
    expect(production).toEqual([...EXTENSION_IDS]);
    // Every other environment's ids are among them (env.dev: the unpacked build).
    for (const ids of others) for (const id of ids) expect(EXTENSION_IDS).toContain(id);
  });

  test("names the site as its own origin, and the production service by default", () => {
    expect(PAGE_ORIGIN).toBe("https://onlay.dev");
    if (!process.env.ONLAY_SERVICE_ORIGIN) expect(SERVICE_ORIGIN).toBe("https://app.onlay.dev");
  });

  test("leads the install buttons to /install until the store listing is live", () => {
    expect(STORE_LISTED).toBe(false);
    expect(installHref()).toBe("/install");
  });
});
