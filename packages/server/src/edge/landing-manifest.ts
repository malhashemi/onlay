/**
 * The landing page's build as the Worker serves it: where it sits in the
 * assets directory, and which of its manifest's files may be served. No
 * Worker types here: `scripts/stage-site.ts` checks a build with the same
 * rules before it is staged.
 */
/** The landing page's folder inside the assets directory. */
export const LANDING_DIR = "landing";

/** The policy the page was built and tested under (packages/site/scripts/preview.ts). */
export const LANDING_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "media-src 'self'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** The only types a landing file may have, by its extension; the manifest must agree. */
const TYPES: Readonly<Record<string, string>> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  woff2: "font/woff2",
  mp4: "video/mp4",
  webp: "image/webp",
  svg: "image/svg+xml",
  // Onlay's licence and the third-party notices.
  txt: "text/plain; charset=utf-8",
};

/** A served file name: one path segment under `/site/`, a name and an extension we know. */
const SERVED_PATH = /^\/site\/[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*\.([a-z0-9]+)$/;

/** One file the Worker may serve: its type and its exact length in bytes. */
export interface LandingFile {
  type: string;
  bytes: number;
}

function isLength(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0;
}

/**
 * The files a landing manifest may serve: served path → type and length.
 * Every entry must be a plain `/site/<name>` with a known extension, the type
 * that extension has, `immutable` caching and a positive length, listed once;
 * `/` must be the no-cache HTML document, listed once. Anything else in the
 * manifest makes the whole build unservable (null), so a malformed build
 * serves nothing rather than part.
 */
export function landingEntries(manifest: unknown): ReadonlyMap<string, LandingFile> | null {
  const m = manifest as { index?: unknown; base?: unknown; files?: unknown } | null;
  if (m === null || typeof m !== "object") return null;
  if (m.index !== "index.html" || m.base !== "/site/" || !Array.isArray(m.files)) return null;
  const files = new Map<string, LandingFile>();
  let document = false;
  for (const raw of m.files) {
    const f = raw as { path?: unknown; contentType?: unknown; cache?: unknown; bytes?: unknown };
    if (f === null || typeof f !== "object" || !isLength(f.bytes)) return null;
    if (f.path === "/") {
      if (document) return null;
      if (f.contentType !== "text/html; charset=utf-8" || f.cache !== "no-cache") return null;
      document = true;
      continue;
    }
    if (typeof f.path !== "string" || f.path.includes("..")) return null;
    const ext = SERVED_PATH.exec(f.path)?.[1];
    const type = ext === undefined ? undefined : TYPES[ext];
    if (type === undefined || f.contentType !== type || f.cache !== "immutable") return null;
    if (files.has(f.path)) return null;
    files.set(f.path, { type, bytes: f.bytes });
  }
  return document ? files : null;
}
