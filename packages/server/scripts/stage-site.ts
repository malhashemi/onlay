// Put the landing page's build (packages/site/dist) inside the Worker's assets
// directory (packages/pwa/dist, wrangler.jsonc `assets.directory`) under
// `landing/`, where src/edge/landing.ts serves it from. Run after both builds
// (`bun run build:web` does all three): the web app's build empties its dist/.
//
// It refuses a build the Worker would not serve or that would serve a broken
// page:
// - its manifest must pass the Worker's own `landingEntries`, and every listed
//   file must be on disk at the listed size, with nothing unlisted beside them;
// - every `/site/<name>` the page, its stylesheets and its scripts name (and
//   every `./<name>` a script imports) must be listed;
// - the build must be newer than every source it is made from (the site's
//   sources and scripts, render's and protocol's, and the licence and notices
//   it serves): a stale build is refused.
// (That the page sends and stores nothing is the site build's own check,
// packages/site/scripts/scan.ts, and the e2e smoke set's landing walk.)
//
// `--check` stages nothing: it refuses unless the staged copy passes the same
// checks and is exactly the current, fresh site build. Deploying by hand
// (`bun run --filter @onlay/server deploy`) runs it first.
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { LANDING_DIR, landingEntries } from "../src/edge/landing-manifest";

const ROOT = join(import.meta.dir, "..", "..", "..");
const SITE_DIST = join(ROOT, "packages", "site", "dist");
const ASSETS = join(ROOT, "packages", "pwa", "dist");
const OUT = join(ASSETS, LANDING_DIR);
/** What the site's build is made from. */
const SOURCES = [
  join(ROOT, "packages", "site", "src"),
  join(ROOT, "packages", "site", "scripts"),
  join(ROOT, "packages", "render", "src"),
  join(ROOT, "packages", "protocol", "src"),
];
/** The single files it is made from too: the licence and notices it serves. */
const SOURCE_FILES = [join(ROOT, "LICENSE"), join(ROOT, "THIRD-PARTY-NOTICES.md")];

function fail(message: string): never {
  console.error(`stage-site: ${message}`);
  process.exit(1);
}

function rel(path: string): string {
  return relative(ROOT, path);
}

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

/** The served paths a built file names: `/site/<name>`, and a script's `./<name>` imports. */
function references(path: string, text: string): string[] {
  const named = [...text.matchAll(/\/site\/([A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9])/g)].map(
    (m) => `/site/${m[1]}`,
  );
  if (!path.endsWith(".js")) return named;
  const imported = [...text.matchAll(/["'`]\.\/([A-Za-z0-9][A-Za-z0-9._-]*\.js)["'`]/g)].map(
    (m) => `/site/${m[1]}`,
  );
  return [...named, ...imported];
}

/** Checks one copy of the build (the site's dist/ or the staged landing/); returns its manifest's text. */
function checkBuild(dir: string): { manifestText: string; count: number; bytes: number } {
  const manifestPath = join(dir, "asset-manifest.json");
  if (!existsSync(manifestPath)) fail(`${rel(manifestPath)} is missing: run bun run build:web`);
  const manifestText = readFileSync(manifestPath, "utf8");
  const manifest: unknown = JSON.parse(manifestText);
  const files = landingEntries(manifest);
  if (files === null) fail(`${rel(manifestPath)} is not one the Worker serves`);

  const listed = (manifest as { files: Array<{ path: string; bytes: number }> }).files;
  const onDisk = (served: string) => join(dir, served === "/" ? "index.html" : served.slice(1));
  for (const f of listed) {
    const on = onDisk(f.path);
    if (!existsSync(on)) fail(`${f.path} is listed but not in ${rel(dir)}`);
    if (statSync(on).size !== f.bytes) fail(`${rel(on)} is not the size the manifest says`);
  }
  // Nothing in site/ that the manifest does not list: what is staged is what is served.
  const built = readdirSync(join(dir, "site")).map((name) => `/site/${name}`);
  for (const path of built) if (!files.has(path)) fail(`${rel(onDisk(path))} is not listed`);

  for (const path of ["/", ...built.filter((p) => /\.(?:js|css|svg)$/.test(p))]) {
    const text = readFileSync(onDisk(path), "utf8");
    for (const ref of references(path, text)) {
      if (!files.has(ref)) fail(`${path} names ${ref}, which the manifest does not list`);
    }
  }
  return {
    manifestText,
    count: listed.length,
    bytes: listed.reduce((n, f) => n + f.bytes, 0),
  };
}

/** The site's build is newer than every source it is made from. */
function checkFresh(): void {
  const builtAt = statSync(join(SITE_DIST, "asset-manifest.json")).mtimeMs;
  for (const file of [...SOURCES.flatMap((dir) => filesUnder(dir)), ...SOURCE_FILES]) {
    if (statSync(file).mtimeMs > builtAt) {
      fail(`${rel(file)} changed after the landing page was built: run bun run build:web`);
    }
  }
}

if (!existsSync(join(ASSETS, "index.html"))) fail("build the web app first (bun run build:web)");
if (!existsSync(join(SITE_DIST, "asset-manifest.json"))) {
  fail("build the landing page first (bun run build:web)");
}
const site = checkBuild(SITE_DIST);
checkFresh();

if (process.argv.includes("--check")) {
  const staged = checkBuild(OUT);
  if (staged.manifestText !== site.manifestText) {
    fail(`${rel(OUT)} is not the current landing page build: run bun run build:web`);
  }
  console.log(`the staged landing page is the current build: ${staged.count} files`);
} else {
  rmSync(OUT, { recursive: true, force: true });
  cpSync(join(SITE_DIST, "index.html"), join(OUT, "index.html"));
  cpSync(join(SITE_DIST, "asset-manifest.json"), join(OUT, "asset-manifest.json"));
  cpSync(join(SITE_DIST, "site"), join(OUT, "site"), { recursive: true });
  checkBuild(OUT);
  console.log(
    `staged the landing page in ${rel(OUT)}/: ${site.count} files, ${(site.bytes / 1024 / 1024).toFixed(1)} MB`,
  );
}
