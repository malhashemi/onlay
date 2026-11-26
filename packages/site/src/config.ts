// The landing page's switches and addresses. Everything that names a place
// outside this page (the store, the service, the extension) is here, once.

/** The origin this page is served from (the site): its canonical address. */
export const PAGE_ORIGIN = "https://onlay.dev";

/**
 * THE service origin: the web app, the MCP endpoint and its config, and
 * sign-in all hang off this one value. The page stays on the site origin and
 * never reads a session; the service lives on its own.
 *
 * It is read while the page is built (the links and the code samples are
 * static markup), so a build may point it elsewhere with
 * `ONLAY_SERVICE_ORIGIN=http://localhost:8787 bun run build:site`.
 */
export const SERVICE_ORIGIN: string = buildEnv("ONLAY_SERVICE_ORIGIN") ?? "https://app.onlay.dev";

function buildEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const value = env?.[name]?.trim().replace(/\/+$/, "");
  return value ? value : undefined;
}

/** A service address: the web app link, the MCP URL, its config. */
export function serviceUrl(path: string): string {
  return `${SERVICE_ORIGIN}${path}`;
}

/** The Chrome Web Store listing. Submitted, not published yet. */
export const CHROME_WEB_STORE_URL =
  "https://chromewebstore.google.com/detail/ifolhmiajgkaecdfghbnkchpeibajnbj";

/**
 * THE store switch. While false the install buttons lead to `/install` and
 * say so; flip it once the listing is live and they lead to the store.
 */
export const STORE_LISTED: boolean = false;

/** The page's own paths: served from the site origin, so they stay relative. */
export const PATHS = {
  install: "/install",
  privacy: "/privacy",
} as const;

/** Where the install buttons lead. */
export function installHref(): string {
  return STORE_LISTED ? CHROME_WEB_STORE_URL : PATHS.install;
}

/**
 * THE film. Its source files, relative to `src/`; the build names the served
 * copies by their content. Its master is made outside this repository; swap
 * the cut by encoding a new master with `scripts/film.sh` (it writes
 * `media/film.mp4` and the poster), then set its length here: the copy
 * derives its "0:38" and "38 seconds" from this number.
 * It has sound, so it never plays by itself: only on the visitor's request,
 * with the browser's controls showing.
 */
export const FILM = {
  src: "media/film.mp4",
  poster: "media/film-poster.webp",
  seconds: 38,
  width: 1920,
  height: 1080,
} as const;

/**
 * The extension ids that may answer the `onlay-ping` (the same check the web
 * app runs, with the ids it gets from `/api/me`): the downloaded build and the
 * Chrome Web Store build. Keep in step with the Worker's `EXTENSION_IDS`.
 */
export const EXTENSION_IDS: readonly string[] = [
  "jpgekbcbbgdojakpjpefffljbmiimlbb",
  "ifolhmiajgkaecdfghbnkchpeibajnbj",
];
