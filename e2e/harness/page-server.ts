// The pages people work on: fixture files served on an ephemeral loopback
// port, a different origin from the onlay server. strict.* carry the strictest
// useful Content-Security-Policy, so the overlay is proven under it.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));

const STRICT = "script-src 'self'; style-src 'self'; connect-src 'self'";
const CSP: Record<string, string> = {
  "strict.html": STRICT,
  "strict.css": STRICT,
  "strict.js": STRICT,
};

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  woff2: "font/woff2",
};

export interface PageServer {
  /** `http://<host>:<port>` */
  base: string;
  stop(): Promise<void>;
}

export interface PageServerOptions {
  /** Defaults to e2e/fixtures. */
  fixturesDir?: string;
  /** Defaults to 127.0.0.1; the fidelity suite uses localhost. */
  host?: string;
  /** Per-file Content-Security-Policy; defaults to the strict.* policies. */
  csp?: Record<string, string>;
}

export function startPageServer(opts: PageServerOptions = {}): Promise<PageServer> {
  const dir = opts.fixturesDir ?? FIXTURES;
  const host = opts.host ?? "127.0.0.1";
  const csp = opts.csp ?? CSP;
  const server = createServer(async (req, res) => {
    const name = (req.url ?? "/").replace(/^\/+/, "").split("?")[0] || "article.html";
    if (!/^[a-z0-9._-]+$/.test(name)) {
      res.writeHead(400).end("bad path");
      return;
    }
    let body: Buffer;
    try {
      body = await readFile(join(dir, name));
    } catch {
      res.writeHead(404).end("not found");
      return;
    }
    const headers: Record<string, string> = {
      "Content-Type": MIME[name.split(".").pop() ?? ""] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    };
    const policy = csp[name];
    if (policy) headers["Content-Security-Policy"] = policy;
    res.writeHead(200, headers).end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, host, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        base: `http://${host}:${port}`,
        stop: () =>
          new Promise<void>((r) => {
            server.close(() => r());
            // A browser still open keeps idle sockets; without this, close() waits for them.
            server.closeAllConnections();
          }),
      });
    });
  });
}
