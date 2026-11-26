// Build @onlay/pwa → packages/pwa/dist/ (D-SERVE-SRC: build:cli copies this into
// packages/onlay/assets/pwa). Two entrypoints:
//   main.ts → app.<hash>.js  (ESM module — a normal web page, no MV3 IIFE rule)
//   sw.ts   → sw.js          (STABLE name; the SW URL must be stable across
//                             deploys) with the precache array + SHELL_VERSION
//                             INJECTED at build (ADVISORY-6) so the SW never
//                             fetches a manifest at install.
// The shell CSS (tokens/fonts/app) and app.js are content-hashed + immutable;
// index.html / sw.js / manifest are no-cache. dist/asset-manifest.json is the
// server's closed static-file allowlist source — read from disk by the server,
// NEVER served (GET /app/asset-manifest.json → generic 404).
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@onlay/protocol";
import { CODE_BLOCK_CSS } from "@onlay/render/code-block";
import { SPACE_SELECT_CSS } from "@onlay/render/space-select";
import { Resvg } from "@resvg/resvg-js";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");
const DIST = join(ROOT, "dist");

rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, "assets", "fonts"), { recursive: true });

function hash8(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 8);
}

/* ── main.ts → app.<hash>.js (ESM) + lazy chunks ───────────────────── */
// Split so the syntax highlighter (Shiki, its grammars) is a chunk of its
// own, fetched by the first code block a page shows. Chunks are named by
// their content hash and imported relative to app.js, under /app/.
const mainBuild = await Bun.build({
  entrypoints: [join(SRC, "main.ts")],
  target: "browser",
  format: "esm",
  minify: false,
  splitting: true,
  naming: { entry: "[name].[ext]", chunk: "chunk-[hash].[ext]" },
});
if (!mainBuild.success) {
  console.error(mainBuild.logs.join("\n"));
  throw new Error("main.ts build failed");
}
const mainOut = mainBuild.outputs.find((o) => o.kind === "entry-point");
if (!mainOut) throw new Error("main.ts build produced no output");
const chunkNames: string[] = [];
for (const out of mainBuild.outputs) {
  if (out.kind !== "chunk") continue;
  const name = out.path.split("/").pop() as string;
  writeFileSync(join(DIST, name), await out.text());
  chunkNames.push(name);
}
const appJs = await mainOut.text();
const appJsName = `app.${hash8(appJs)}.js`;
writeFileSync(join(DIST, appJsName), appJs);
// The chunks app.js needs to boot (its static imports, followed through) are
// shell; the highlighter's chunks load on demand and stay off the precache.
const STATIC_IMPORT = /\bfrom\s*"\.\/(chunk-[a-z0-9]+\.js)"/g;
const bootChunks = new Set<string>();
const follow = (js: string) => {
  for (const m of js.matchAll(STATIC_IMPORT)) {
    const name = m[1] as string;
    if (bootChunks.has(name)) continue;
    bootChunks.add(name);
    follow(readFileSync(join(DIST, name), "utf8"));
  }
};
follow(appJs);

/* ── hashed shell CSS ──────────────────────────────────────────────── */
function copyHashed(srcName: string, base: string, ext: string): string {
  const bytes = readFileSync(join(SRC, srcName));
  const name = `${base}.${hash8(bytes)}.${ext}`;
  writeFileSync(join(DIST, name), bytes);
  return name;
}
const tokensName = copyHashed("tokens.css", "tokens", "css");
const fontsName = copyHashed("fonts.css", "fonts", "css");
// app.css carries the shared code block's styles (@onlay/render) at its end.
const appCssBytes = `${readFileSync(join(SRC, "app.css"), "utf8")}\n${CODE_BLOCK_CSS}\n${SPACE_SELECT_CSS}`;
const appCssName = `app.${hash8(appCssBytes)}.css`;
writeFileSync(join(DIST, appCssName), appCssBytes);

/* ── static assets ─────────────────────────────────────────────────── */
cpSync(join(SRC, "assets", "fonts"), join(DIST, "assets", "fonts"), { recursive: true });
cpSync(join(SRC, "assets", "favicon.svg"), join(DIST, "favicon.svg"));
writeFileSync(join(DIST, "manifest.webmanifest"), readFileSync(join(SRC, "manifest.webmanifest")));
// Onlay's licence and the third-party notices (fonts, icons, Shiki's grammars,
// bundled packages), served as plain text at /app/LICENSE.txt and
// /app/THIRD-PARTY-NOTICES.txt.
const NOTICE_FILES = ["LICENSE.txt", "THIRD-PARTY-NOTICES.txt"];
cpSync(join(ROOT, "../../LICENSE"), join(DIST, "LICENSE.txt"));
cpSync(join(ROOT, "../../THIRD-PARTY-NOTICES.md"), join(DIST, "THIRD-PARTY-NOTICES.txt"));

// PWA icons are rendered from checked-in SVG sources so binary blobs do not
// live in the repository.
for (const [source, name, size] of [
  ["icon-any.svg", "icon-192.png", 192],
  ["icon-any.svg", "icon-512.png", 512],
  ["icon-any.svg", "apple-touch-icon.png", 180],
  ["icon-maskable.svg", "icon-192-maskable.png", 192],
  ["icon-maskable.svg", "icon-512-maskable.png", 512],
  ["icon-mono.svg", "icon-mono-192.png", 192],
  ["icon-mono.svg", "badge-96.png", 96],
] as const) {
  const svg = readFileSync(join(SRC, "assets", "icons", source));
  const png = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
  writeFileSync(join(DIST, name), png);
}

/* ── the served-asset allowlist (relative to /app/) ────────────────── */
const fontFiles = [
  "IBMPlexSans-Regular.woff2",
  "IBMPlexSans-Medium.woff2",
  "IBMPlexSans-SemiBold.woff2",
  "IBMPlexMono-Regular.woff2",
  "IBMPlexMono-Medium.woff2",
  "IBMPlexMono-SemiBold.woff2",
].map((f) => `assets/fonts/${f}`);

const servedAssets = [
  appJsName,
  tokensName,
  fontsName,
  appCssName,
  ...chunkNames,
  // The service worker is a served route (http.ts `servePwaAsset` special-cases
  // its Cache-Control + `Service-Worker-Allowed`), but `servePwa` still gates
  // EVERY basename through this allowlist — so `sw.js` must be a member or
  // `GET /app/sw.js` 404s and the offline layer (ADR-0023 §6) never registers.
  "sw.js",
  "manifest.webmanifest",
  "favicon.svg",
  "icon-192.png",
  "icon-512.png",
  "icon-192-maskable.png",
  "icon-512-maskable.png",
  "icon-mono-192.png",
  "badge-96.png",
  "apple-touch-icon.png",
  ...fontFiles,
  ...NOTICE_FILES,
];
// The server serves these from `rt.pwaAssets`; asset-manifest.json is NOT a
// member, so GET /app/asset-manifest.json collapses to the generic 404.
writeFileSync(join(DIST, "asset-manifest.json"), `${JSON.stringify(servedAssets, null, 2)}\n`);

/* ── index.html with hashed asset names substituted ────────────────── */
// Written BEFORE SHELL_VERSION so the version can hash the shell's actual bytes.
let html = readFileSync(join(SRC, "app.html"), "utf8");
html = html
  .replace('href="fonts.css"', `href="${fontsName}"`)
  .replace('href="tokens.css"', `href="${tokensName}"`)
  .replace('href="app.css"', `href="${appCssName}"`)
  .replace('src="app.js"', `src="${appJsName}"`);
writeFileSync(join(DIST, "index.html"), html);

/* ── the SW precache set + SHELL_VERSION ───────────────────────────── */
// The shell is client-agnostic static bytes (no participant data). Precache the
// document + code + styles + fonts + icons under /app/ so a cold boot works.
const precache = [
  "/app/",
  "/app/index.html",
  `/app/${appJsName}`,
  `/app/${tokensName}`,
  `/app/${fontsName}`,
  `/app/${appCssName}`,
  ...[...bootChunks].map((c) => `/app/${c}`),
  "/app/manifest.webmanifest",
  "/app/favicon.svg",
  "/app/icon-192.png",
  "/app/icon-512.png",
  "/app/icon-192-maskable.png",
  "/app/icon-512-maskable.png",
  "/app/icon-mono-192.png",
  "/app/badge-96.png",
  "/app/apple-touch-icon.png",
  ...fontFiles.map((f) => `/app/${f}`),
];
// Version from the precached BYTES, not the URL strings (ADVISORY-11): a change
// to a stable-path member (manifest, favicon, fonts) with no name change still
// busts the shell cache on `activate`. `/app/` resolves to the index document.
const shellHash = createHash("sha256");
for (const u of precache) {
  const rel = u.slice("/app/".length);
  shellHash.update(readFileSync(join(DIST, rel === "" ? "index.html" : rel)));
}
const shellVersion = shellHash.digest("hex").slice(0, 8);

/* ── sw.ts → sw.js (stable name, injected precache/version) ────────── */
const swBuild = await Bun.build({
  entrypoints: [join(SRC, "sw.ts")],
  target: "browser",
  format: "esm",
  minify: false,
  define: {
    __ONLAY_PRECACHE__: JSON.stringify(precache),
    __ONLAY_SHELL_VERSION__: JSON.stringify(shellVersion),
    __ONLAY_PROTOCOL__: JSON.stringify(String(PROTOCOL_VERSION)),
  },
});
if (!swBuild.success) {
  console.error(swBuild.logs.join("\n"));
  throw new Error("sw.ts build failed");
}
const swOut = swBuild.outputs[0];
if (!swOut) throw new Error("sw.ts build produced no output");
writeFileSync(join(DIST, "sw.js"), await swOut.text());

console.log(
  `built packages/pwa/dist/  (shell ${shellVersion}, app ${appJsName}, chunks ${chunkNames.join(" ") || "none"})`,
);
