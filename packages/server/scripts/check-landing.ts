// Check a deployed landing page against the build this checkout made
// (packages/site/dist): CI runs it after each deploy, and it runs as well
// against `wrangler dev`.
//
//   bun run packages/server/scripts/check-landing.ts https://onlay.dev https://app.onlay.dev
//
// The page must be exactly the built document (its SHA-256) under its exact
// policy, linking to the service's web app and clearing nobody's storage (only
// the old web app's /app/sw.js still does); the script and stylesheets it
// names must answer 200 with their type, immutable, and exactly the built
// bytes; the film must answer a two-byte range with 206, the exact
// Content-Range and exactly those two bytes; the service host must refuse a
// landing file; and the manifest must not be served. Exits 1 on any miss.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LANDING_CSP } from "../src/edge/landing-manifest";

const [site, service] = process.argv.slice(2);
if (!site || !service) {
  console.error("usage: check-landing.ts <site origin> <service origin>");
  process.exit(2);
}
const DIST = join(import.meta.dir, "..", "..", "site", "dist");
const IMMUTABLE = "public, max-age=31536000, immutable";

let failed = 0;
function check(ok: boolean, what: string, got: string): void {
  if (ok) console.log(`ok   ${what}`);
  else {
    failed += 1;
    console.log(`::error::${what}: got ${got}`);
  }
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const built = (served: string): Uint8Array =>
  new Uint8Array(readFileSync(join(DIST, served === "/" ? "index.html" : served.slice(1))));

/** A request with no compression asked for, so the bytes compared are the bytes served. */
async function get(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    redirect: "manual",
    headers: { "Accept-Encoding": "identity", ...headers },
  });
  return { res, body: new Uint8Array(await res.arrayBuffer()) };
}

const manifest = JSON.parse(readFileSync(join(DIST, "asset-manifest.json"), "utf8")) as {
  files: Array<{ path: string; contentType: string; bytes: number }>;
};
const html = readFileSync(join(DIST, "index.html"), "utf8");

// The document.
const page = await get(`${site}/`);
check(page.res.status === 200, `${site}/ answers 200`, String(page.res.status));
const csp = page.res.headers.get("Content-Security-Policy");
check(csp === LANDING_CSP, `${site}/ has the page's exact policy`, String(csp));
check(
  sha256(page.body) === sha256(built("/")),
  `${site}/ is exactly the document this run built (sha256 ${sha256(built("/")).slice(0, 12)})`,
  `sha256 ${sha256(page.body).slice(0, 12)}, ${page.body.length} bytes`,
);
const title = /<title>[^<]*<\/title>/.exec(html)?.[0] ?? "<no title>";
check(new TextDecoder().decode(page.body).includes(title), `${site}/ carries ${title}`, "no");
check(html.includes(`href="${service}/app/"`), `the page links to ${service}/app/`, "no link");
check(
  page.res.headers.get("Clear-Site-Data") === null,
  `${site}/ does not clear visitors' storage`,
  String(page.res.headers.get("Clear-Site-Data")),
);

// The files the page names to boot: its module script and its stylesheets.
const named = [
  ...[...html.matchAll(/<script type="module" src="(\/site\/[^"]+)"/g)].map((m) => m[1]),
  ...[...html.matchAll(/<link rel="stylesheet" href="(\/site\/[^"]+)"/g)].map((m) => m[1]),
].filter((p): p is string => p !== undefined);
check(named.length >= 2, "the page names its script and stylesheets", `${named.length} files`);
for (const path of named) {
  const want = manifest.files.find((f) => f.path === path);
  const { res, body } = await get(`${site}${path}`);
  check(res.status === 200, `${path} answers 200`, String(res.status));
  check(
    res.headers.get("Content-Type") === want?.contentType,
    `${path} is ${want?.contentType}`,
    String(res.headers.get("Content-Type")),
  );
  check(
    res.headers.get("Cache-Control") === IMMUTABLE,
    `${path} is immutable`,
    String(res.headers.get("Cache-Control")),
  );
  check(sha256(body) === sha256(built(path)), `${path} is the built file`, `${body.length} bytes`);
}

// The film, in a range.
const film = manifest.files.find((f) => f.contentType === "video/mp4");
if (film === undefined) check(false, "the build has a film", "none");
else {
  const { res, body } = await get(`${site}${film.path}`, { Range: "bytes=0-1" });
  check(res.status === 206, `${film.path} answers bytes=0-1 with 206`, String(res.status));
  const range = res.headers.get("Content-Range");
  check(
    range === `bytes 0-1/${film.bytes}`,
    `${film.path} says Content-Range: bytes 0-1/${film.bytes}`,
    String(range),
  );
  const first = built(film.path).subarray(0, 2);
  check(
    body.length === 2 && body[0] === first[0] && body[1] === first[1],
    `${film.path} sends exactly its first two bytes`,
    `${body.length} bytes`,
  );
}

// What must not be served.
const css = named.find((p) => p.endsWith(".css"));
if (css !== undefined) {
  const { res } = await get(`${service}${css}`);
  check(res.status === 404, `${service}${css} is refused (404)`, String(res.status));
}
const leaked = await get(`${site}/site/asset-manifest.json`);
check(leaked.res.status === 404, "the manifest is not served (404)", String(leaked.res.status));

// The old web app's service worker is still retired where only it asks.
const oldWorker = await get(`${site}/app/sw.js`);
check(
  oldWorker.res.status === 404 && oldWorker.res.headers.get("Clear-Site-Data") === '"storage"',
  `${site}/app/sw.js is 404 and clears storage`,
  `${oldWorker.res.status} ${oldWorker.res.headers.get("Clear-Site-Data")}`,
);

if (failed > 0) {
  console.log(`${failed} landing page check(s) failed`);
  process.exit(1);
}
console.log("the landing page is served as built");
