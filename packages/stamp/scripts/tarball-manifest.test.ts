import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stampVersion, tarballManifest } from "./tarball-manifest";

const SOURCE = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8"));

describe("the stamp tarball's package.json", () => {
  test("keeps the four entry points and leaves nothing workspace-only behind", () => {
    const manifest = tarballManifest(SOURCE, "0.1.7");
    expect(manifest).toMatchObject({
      name: "@onlay/stamp",
      version: "0.1.7",
      type: "module",
      files: ["dist", "THIRD-PARTY-NOTICES.md"],
    });
    expect(manifest.exports).toEqual({
      "./astro": { types: "./dist/astro.d.ts", default: "./dist/astro.js" },
      "./next": { types: "./dist/next.d.ts", default: "./dist/next.js" },
      "./svelte": { types: "./dist/svelte.d.ts", default: "./dist/svelte.js" },
      "./vite": { types: "./dist/vite.d.ts", default: "./dist/vite.js" },
      "./package.json": "./package.json",
    });
    for (const field of [
      "private",
      "scripts",
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "workspaces",
    ])
      expect(field in manifest).toBe(false);
    expect(JSON.stringify(manifest)).not.toContain("workspace:");
  });

  test("the version is semver: 0.0.0 locally, what CI sets otherwise", () => {
    expect(stampVersion(undefined)).toBe("0.0.0");
    expect(stampVersion("0.1.42")).toBe("0.1.42");
    for (const bad of ["0.1", "v0.1.2", "01.2.3", "0.1.2+sha"])
      expect(() => stampVersion(bad)).toThrow(/ONLAY_STAMP_VERSION/);
  });
});
