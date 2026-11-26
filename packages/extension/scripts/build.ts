// Build the unpacked-loadable extension into dist/.
//
// sw.ts    → dist/sw.js      (ESM — MV3 `background.type: "module"` is first-class)
// content  → dist/content.js (single classic IIFE — MV3 content scripts cannot be ESM)
// manifest → dist/manifest.json
//
// `bun build --format=iife` is still experimental, so the content bundle is
// ASSERTED to be import/export-free; if the assertion fails we fall back to
// esbuild for that one artifact (maker-approved hedge).
//
// Flags (both need NODE_ENV=production; release zips land in release/):
//   --zip    also zip dist/ → release/onlay-extension.zip (the unpacked
//            download https://onlay.dev/download/onlay-extension.zip serves)
//   --store  build dist-store/ with the Chrome Web Store manifest (no `key`,
//            no loopback entries) and zip it → release/onlay-extension-store.zip
//            (both origins https)
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODE_BLOCK_CSS } from "@onlay/render/code-block";
import { FONTS_CSS, PAGE_TOKENS_CSS } from "../src/ui/tokens";
import {
  connectablePatterns,
  extensionVersion,
  releaseOriginProblem,
  type SourceManifest,
  serverPatterns,
  storeManifest,
  unpackedManifest,
} from "./manifest";

const ROOT = join(import.meta.dir, "..");
const STORE = process.argv.includes("--store");
const ZIP = process.argv.includes("--zip");
const DIST = join(ROOT, STORE ? "dist-store" : "dist");
const RELEASE = join(ROOT, "release");

// ---- the server this build talks to (spec §10) ----
// ONLAY_SERVER_ORIGIN overrides the service's default at build time; a
// non-production build (NODE_ENV !== "production") also reaches the local
// wrangler dev server, and chrome.storage.local.serverOrigin picks between
// them at runtime. The public site (/install, the landing page that pings the
// extension) is ONLAY_SITE_ORIGIN; unset, it is https://onlay.dev for the
// default service and the service's own origin for one set with
// ONLAY_SERVER_ORIGIN (dev and e2e serve everything on one origin).
const SERVER_ORIGIN = new URL(process.env.ONLAY_SERVER_ORIGIN || "https://app.onlay.dev").origin;
const SITE_ORIGIN = new URL(
  process.env.ONLAY_SITE_ORIGIN ||
    (process.env.ONLAY_SERVER_ORIGIN ? SERVER_ORIGIN : "https://onlay.dev"),
).origin;
const PRODUCTION = process.env.NODE_ENV === "production";
const SERVER_PATTERNS = serverPatterns(SERVER_ORIGIN, PRODUCTION);
const CONNECTABLE_PATTERNS = connectablePatterns(SERVER_ORIGIN, SITE_ORIGIN, PRODUCTION);
// ---- the version (CI: 0.2.<run number>; local: 0.0.0) ----
const VERSION = extensionVersion(process.env.ONLAY_EXTENSION_VERSION);
// What anyone downloads or a store reviews is a release build, never a dev one.
if ((STORE || ZIP) && !PRODUCTION)
  throw new Error("--zip and --store package a release: run them with NODE_ENV=production");
// A release (the downloadable zip or the store package) reaches only https,
// non-loopback origins: a localhost .env or dev shell cannot ship.
if (STORE || ZIP) {
  for (const [name, origin] of [
    ["server origin", SERVER_ORIGIN],
    ["site origin", SITE_ORIGIN],
  ] as const) {
    const problem = releaseOriginProblem(name, origin);
    if (problem) throw new Error(`${STORE ? "--store" : "--zip"}: ${problem}`);
  }
}
// ---- the overlay's shadow root ----
// Closed by default, so the host page can never read the overlay's private
// chrome. ONLAY_SHADOW_MODE=open is for the e2e harness only (Playwright cannot
// pierce a closed root). Baked in as a literal: there is no runtime switch.
const SHADOW_MODE_ENV = process.env.ONLAY_SHADOW_MODE ?? "closed";
if (SHADOW_MODE_ENV !== "open" && SHADOW_MODE_ENV !== "closed")
  throw new Error(`ONLAY_SHADOW_MODE must be "open" or "closed", not "${SHADOW_MODE_ENV}"`);
const DEFINE = {
  __ONLAY_SERVER_ORIGIN__: JSON.stringify(SERVER_ORIGIN),
  __ONLAY_SITE_ORIGIN__: JSON.stringify(SITE_ORIGIN),
  // A production build ignores the stored server-origin override (sw/server.ts).
  __ONLAY_PRODUCTION__: JSON.stringify(PRODUCTION),
  __ONLAY_SHADOW_MODE__: JSON.stringify(SHADOW_MODE_ENV),
};
// A release build never ships the open root: refuse, don't warn.
if (SHADOW_MODE_ENV === "open" && PRODUCTION)
  throw new Error("ONLAY_SHADOW_MODE=open is a test build switch; NODE_ENV=production refuses it");
if (SHADOW_MODE_ENV === "open") console.warn("[build] ONLAY_SHADOW_MODE=open — test build only");

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

// ---- service worker (ESM) ----
const swResult = await Bun.build({
  entrypoints: [join(ROOT, "src/sw.ts")],
  outdir: DIST,
  target: "browser",
  format: "esm",
  define: DEFINE,
});
if (!swResult.success) {
  console.error(swResult.logs.join("\n"));
  throw new Error("sw.ts build failed");
}

// ---- classic-IIFE bundles (content script + popup page) ----
// `bun build --format=iife` is still experimental, so each IIFE bundle is
// ASSERTED import/export-free; a fallback to esbuild covers regressions.
const MODULE_SYNTAX = /^\s*(import|export)\b/m;

async function buildIifeWithBun(entry: string): Promise<string | null> {
  try {
    const result = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      format: "iife",
      define: DEFINE,
    });
    if (!result.success) return null;
    const artifact = result.outputs[0];
    if (!artifact) return null;
    return await artifact.text();
  } catch {
    return null;
  }
}

async function buildIifeWithEsbuild(entry: string): Promise<string> {
  const esbuild = await import("esbuild");
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "iife",
    target: "chrome116",
    platform: "browser",
    define: DEFINE,
  });
  const out = result.outputFiles[0];
  if (!out) throw new Error(`esbuild produced no output for ${entry}`);
  return out.text;
}

async function buildIife(name: string, entry: string): Promise<string> {
  let js = await buildIifeWithBun(entry);
  let tool = "bun";
  if (js === null || MODULE_SYNTAX.test(js)) {
    js = await buildIifeWithEsbuild(entry);
    tool = "esbuild";
  }
  if (MODULE_SYNTAX.test(js)) {
    throw new Error(`${name} still contains module syntax — MV3 IIFE bundles cannot be ESM`);
  }
  console.log(`  ${name} via ${tool}`);
  return js;
}

const contentJs = await buildIife("content.js", join(ROOT, "src/content.ts"));
writeFileSync(join(DIST, "content.js"), contentJs);

const popupJs = await buildIife("popup.js", join(ROOT, "src/popup.ts"));
writeFileSync(join(DIST, "popup.js"), popupJs);
copyFileSync(join(ROOT, "src/popup.html"), join(DIST, "popup.html"));
copyFileSync(join(ROOT, "src/popup.css"), join(DIST, "popup.css"));

const optionsJs = await buildIife("options.js", join(ROOT, "src/options.ts"));
writeFileSync(join(DIST, "options.js"), optionsJs);
copyFileSync(join(ROOT, "src/options.html"), join(DIST, "options.html"));
copyFileSync(join(ROOT, "src/options.css"), join(DIST, "options.css"));

const interactionJs = await buildIife("interaction.js", join(ROOT, "src/interaction.ts"));
writeFileSync(join(DIST, "interaction.js"), interactionJs);
copyFileSync(join(ROOT, "src/interaction.html"), join(DIST, "interaction.html"));
// The full view's code blocks share the overlay's block styles (@onlay/render).
writeFileSync(
  join(DIST, "interaction.css"),
  `${readFileSync(join(ROOT, "src/interaction.css"), "utf8")}\n${CODE_BLOCK_CSS}`,
);

// ---- shared design tokens + self-hosted fonts (extension-owned pages) ----
// PAGE_TOKENS_CSS is the custom-property truth for popup/options/interaction;
// FONTS_CSS @font-faces resolve against assets/fonts/ copied beside them.
writeFileSync(join(DIST, "tokens.css"), PAGE_TOKENS_CSS);
writeFileSync(join(DIST, "fonts.css"), FONTS_CSS);
cpSync(join(ROOT, "src/assets"), join(DIST, "assets"), { recursive: true });

// ---- manifest + derived identity ----
// The source manifest lives in src/ ON PURPOSE: the package root must not
// look loadable (a root manifest referencing dist-only scripts produces
// Chrome's confusing "Could not load javascript" error). dist/ is the ONLY
// load-unpacked target.
const source = JSON.parse(readFileSync(join(ROOT, "src/manifest.json"), "utf8")) as SourceManifest;
const unpacked = unpackedManifest(source, {
  patterns: SERVER_PATTERNS,
  connectable: CONNECTABLE_PATTERNS,
  version: VERSION,
});
const manifest = STORE ? storeManifest(unpacked) : unpacked;
writeFileSync(join(DIST, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
copyFileSync(join(ROOT, "src/icon128.png"), join(DIST, "icon128.png"));
// Onlay's licence and the third-party notices travel with the package.
copyFileSync(join(ROOT, "../../LICENSE"), join(DIST, "LICENSE"));
copyFileSync(join(ROOT, "../../THIRD-PARTY-NOTICES.md"), join(DIST, "THIRD-PARTY-NOTICES.md"));

const label = STORE ? "dist-store/" : "dist/";
console.log(
  `built ${label} ${VERSION} for ${SERVER_ORIGIN} (site ${SITE_ORIGIN})${PRODUCTION ? "" : " (+ local dev servers)"}`,
);
if (manifest.key) {
  const spki = Buffer.from(manifest.key, "base64");
  const extensionId = createHash("sha256")
    .update(spki)
    .digest("hex")
    .slice(0, 32)
    .replace(/./g, (c) => "abcdefghijklmnop"[Number.parseInt(c, 16)] as string);
  console.log(`extension id: ${extensionId}`);
  console.log(`EXTENSION_IDS: ${extensionId}`);
} else {
  console.log("no key: the Chrome Web Store assigns this package's id");
}

// ---- release zips ----
if (STORE || ZIP) {
  const name = STORE ? "onlay-extension-store.zip" : "onlay-extension.zip";
  const out = join(RELEASE, name);
  mkdirSync(RELEASE, { recursive: true });
  rmSync(out, { force: true });
  // The build's files at the zip's root, as Chrome and the store expect; -X
  // leaves out the builder's file attributes.
  const zipped = spawnSync("zip", ["-q", "-r", "-X", out, "."], { cwd: DIST, encoding: "utf8" });
  if (zipped.status !== 0)
    throw new Error(`zip failed: ${zipped.error?.message ?? zipped.stderr ?? zipped.status}`);
  console.log(`zipped ${label} → release/${name}`);
}
