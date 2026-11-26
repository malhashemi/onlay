// Serve packages/site/dist/ the way it will ship: the page at `/`, its files
// under `/site/` with their content types and caching from the build's
// manifest, and the page's Content-Security-Policy on every response, so what
// is checked here is what the Worker will serve.
//
//   bun run --filter @onlay/site preview            (builds first if needed)
//   PORT=4180 bun run --filter @onlay/site preview
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIST = join(import.meta.dir, "..", "dist");

/** The policy the page is built for: its own files only, no inline script or style, and no requests. */
export const CSP = [
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

if (!existsSync(join(DIST, "asset-manifest.json"))) {
  const built = Bun.spawnSync(["bun", "run", join(import.meta.dir, "build.ts")], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (built.exitCode !== 0) process.exit(built.exitCode ?? 1);
}

interface Served {
  path: string;
  contentType: string;
  cache: "immutable" | "no-cache";
}
/** Read on every request, so a rebuild shows without restarting the preview. */
function manifest(): { index: string; files: Map<string, Served> } {
  const raw = JSON.parse(readFileSync(join(DIST, "asset-manifest.json"), "utf8")) as {
    index: string;
    files: Served[];
  };
  return { index: raw.index, files: new Map(raw.files.map((f) => [f.path, f])) };
}

const headers = (f: Served): Record<string, string> => ({
  "Content-Type": f.contentType,
  "Cache-Control": f.cache === "immutable" ? "public, max-age=31536000, immutable" : "no-cache",
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
});

/** The Worker's own pages the landing page links to: stand-ins, so no link here is dead. */
const STAND_INS = new Set(["/install", "/privacy"]);

const port = Number(process.env.PORT ?? 4173);
const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);
    const { index, files } = manifest();
    const f = files.get(url.pathname);
    if (f) {
      const rel = f.path === "/" ? index : f.path.slice(1);
      const file = Bun.file(join(DIST, rel));
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get("range") ?? "");
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), file.size - 1) : file.size - 1;
        return new Response(file.slice(start, end + 1), {
          status: 206,
          headers: {
            ...headers(f),
            "Content-Range": `bytes ${start}-${end}/${file.size}`,
            "Accept-Ranges": "bytes",
          },
        });
      }
      return new Response(file, { headers: { ...headers(f), "Accept-Ranges": "bytes" } });
    }
    if (STAND_INS.has(url.pathname)) {
      return new Response(`Preview stand-in for ${url.pathname} (the Worker serves this page).\n`, {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Security-Policy": CSP },
      });
    }
    return new Response("Not found\n", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Security-Policy": CSP },
    });
  },
});
console.log(`@onlay/site preview: http://localhost:${server.port}/`);
