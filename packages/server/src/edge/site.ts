/**
 * The public site: the pages anyone may read, with no credential read or set.
 * In two-origin mode they are served on `SITE_ORIGIN` alone; with one origin,
 * beside everything else (src/edge/hosts.ts).
 */
import type { Env } from "../env";
import { serveDownload } from "./assets";
import { linksOf } from "./hosts";
import { htmlResponse, installPage, privacyPage } from "./pages";

/**
 * `Clear-Site-Data: "storage"` on the site host's `/app` and `/app/*`.
 *
 * Why it exists: the web app used to live at `https://onlay.dev/app/`. A
 * browser that used it there still holds, under this origin, the old web
 * app's service worker (which serves its cached shell without asking the
 * network), its Cache Storage, IndexedDB (cached reads, drafts) and
 * localStorage (person id, copied refs). This header removes all of that for
 * this origin only (never cookies, never another host). Chromium honours it
 * on the old worker's own update fetch of `/app/sw.js`, which is why that
 * path answers 404 with it, and on a navigation to `/app` or `/app/*` that
 * reaches the Worker (an old bookmark).
 *
 * Only ever sent by the site host, and only on those paths, which no visitor
 * of today's site asks for: never on `/` (the landing page) or `/site/*`,
 * where it would wipe every visitor's storage for nothing.
 */
export function retireOldAppStorage(response: Response): Response {
  const copy = new Response(response.body, response);
  copy.headers.set("Clear-Site-Data", '"storage"');
  return copy;
}

/** The old web app's paths on the site host. */
export function isOldAppPath(path: string): boolean {
  return path === "/app" || path.startsWith("/app/");
}

/** The public pages' paths, apart from `/`. */
export function isPublicPage(path: string): boolean {
  return path === "/install" || path === "/privacy" || path.startsWith("/download/");
}

/** `/install`, `/privacy` and `/download/*`; null for any other path. */
export async function handlePublicPage(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  const path = url.pathname;
  if (path === "/privacy") return htmlResponse(privacyPage());
  if (path === "/install") return htmlResponse(installPage(env.EXTENSION_VERSION, linksOf(env)));
  if (path.startsWith("/download/")) return serveDownload(request, env, url);
  return null;
}
