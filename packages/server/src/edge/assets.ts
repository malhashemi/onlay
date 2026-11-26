/**
 * The web app under the closed `/app/` namespace (ported from the local
 * server's PWA serving, ADR-0023 §3). The served route space is fixed:
 * `/app/` (the shell) plus the exact members of the build's
 * `asset-manifest.json`, read through ASSETS and never served itself. No
 * server-rendered user content: data arrives only through the API at runtime.
 */
import type { Env } from "../env";
import { serviceOrigin } from "./hosts";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "no-cache";
const REVALIDATED_PNGS = new Set([
  "icon-192.png",
  "icon-512.png",
  "icon-192-maskable.png",
  "icon-512-maskable.png",
  "icon-mono-192.png",
  "badge-96.png",
  "apple-touch-icon.png",
]);
/** Onlay's licence and the third-party notices: plain text, replaced in place by each deploy. */
const REVALIDATED_TEXTS = new Set(["LICENSE.txt", "THIRD-PARTY-NOTICES.txt"]);

/** The local server's web app CSP, with `connect-src` naming this origin's WebSocket scheme. */
function appCsp(publicOrigin: string): string {
  const url = new URL(publicOrigin);
  const socket = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${socket}`,
    "frame-src 'self' blob:",
    "child-src blob:",
    "worker-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "manifest-src 'self'",
  ].join("; ");
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

/** A member is a safe relative path, never `..`, a backslash, a leading slash or the manifest. */
function isSafeMember(entry: unknown): entry is string {
  return (
    typeof entry === "string" &&
    entry.length > 0 &&
    !entry.startsWith("/") &&
    !entry.includes("\\") &&
    !entry.includes("..") &&
    !entry.startsWith("download/") &&
    // The landing page's build (src/edge/landing.ts): never part of the web app.
    !entry.startsWith("landing/") &&
    entry !== "asset-manifest.json" &&
    entry !== "index.html"
  );
}

let allowlist: Promise<ReadonlySet<string>> | null = null;

/** The build's allowlist, read once per isolate; a missing or malformed manifest is empty. */
function loadAllowlist(env: Env, origin: string): Promise<ReadonlySet<string>> {
  allowlist ??= (async () => {
    try {
      const res = await env.ASSETS.fetch(new Request(`${origin}/asset-manifest.json`));
      if (!res.ok) {
        await res.body?.cancel();
        return new Set<string>();
      }
      const parsed: unknown = await res.json();
      const list: unknown = Array.isArray(parsed)
        ? parsed
        : (parsed as { assets?: unknown } | null)?.assets;
      return new Set(Array.isArray(list) ? list.filter(isSafeMember) : []);
    } catch {
      return new Set<string>();
    }
  })();
  return allowlist;
}

const notFound = () =>
  new Response("not found", { status: 404, headers: { "X-Content-Type-Options": "nosniff" } });

async function serveFile(env: Env, origin: string, name: string, headers: Record<string, string>) {
  const res = await env.ASSETS.fetch(new Request(`${origin}/${name}`));
  if (!res.ok) {
    await res.body?.cancel();
    return notFound();
  }
  return new Response(res.body, {
    headers: {
      "Content-Type": CONTENT_TYPES[extOf(name)] ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

/**
 * The two downloads the deploy job writes into the assets' `download/`
 * folder: the unpacked extension and the stamp's tarball. Nothing else in
 * that folder is served, and without the file (local dev, tests, e2e) the
 * route is a 404.
 */
const DOWNLOADS: Readonly<Record<string, string>> = {
  "onlay-extension.zip": "application/zip",
  "onlay-stamp.tgz": "application/gzip",
};

/** `/download/<name>`. */
export async function serveDownload(request: Request, env: Env, url: URL): Promise<Response> {
  const name = url.pathname.slice("/download/".length);
  const type = Object.hasOwn(DOWNLOADS, name) ? DOWNLOADS[name] : undefined;
  if (type === undefined) return notFound();
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const res = await env.ASSETS.fetch(new Request(`${url.origin}/download/${name}`));
  if (!res.ok) {
    await res.body?.cancel();
    return notFound();
  }
  const length = res.headers.get("Content-Length");
  const headers: Record<string, string> = {
    ...(length ? { "Content-Length": length } : {}),
    "Content-Type": type,
    "Content-Disposition": `attachment; filename="${name}"`,
    // Each deploy replaces the file under the same name: always revalidate.
    "Cache-Control": REVALIDATE,
    "X-Content-Type-Options": "nosniff",
  };
  if (request.method === "HEAD") {
    await res.body?.cancel();
    return new Response(null, { headers });
  }
  return new Response(res.body, { headers });
}

/** `/app` and `/app/*`. */
export async function serveApp(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405 });
  const path = url.pathname;
  if (path === "/app") return new Response(null, { status: 302, headers: { Location: "/app/" } });
  if (path === "/app/" || path === "/app/index.html") {
    return serveFile(env, url.origin, "index.html", {
      "Content-Security-Policy": appCsp(serviceOrigin(env)),
      // A cross-origin opener keeps no handle on the web app's window.
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cache-Control": REVALIDATE,
    });
  }
  const name = path.slice("/app/".length);
  if (!isSafeMember(name) || !(await loadAllowlist(env, url.origin)).has(name)) return notFound();
  const headers: Record<string, string> = {};
  if (name === "sw.js") {
    headers["Cache-Control"] = REVALIDATE;
    headers["Service-Worker-Allowed"] = "/app/";
  } else if (
    name === "manifest.webmanifest" ||
    REVALIDATED_PNGS.has(name) ||
    REVALIDATED_TEXTS.has(name)
  ) {
    headers["Cache-Control"] = REVALIDATE;
  } else {
    headers["Cache-Control"] = IMMUTABLE;
  }
  return serveFile(env, url.origin, name, headers);
}
