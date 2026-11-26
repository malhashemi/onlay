// The Workers-runtime suite (spec §11): the real Worker and D1 migrations in
// workerd. Two projects:
// - edge: the real edge with an echoing stand-in for the space Durable
//   Object and a WorkOS stand-in (test/support/edge-worker.ts);
// - shell: the real Worker with the real Durable Object.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { TEST_VAPID } from "./src/space/testing/test-vapid";

/** The stand-in landing document; test/edge/landing.test.ts expects these bytes. */
const LANDING_HTML = "<!doctype html><title>Onlay landing stand-in</title>\n";
const LANDING_JS = "// the landing page's script\n";
/** 1,000 bytes, byte i = i % 251, so any range is checkable. */
const LANDING_FILM = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
/** The stand-in third-party notices, served by the web app and the landing page. */
const NOTICES = "# Third-party notices (test stand-in)\n";

/** A stand-in web app build, so tests never depend on building the PWA. */
function testAssets(): string {
  const directory = path.join(import.meta.dirname, "node_modules/.cache/onlay-test-assets");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "index.html"), "<!doctype html><title>onlay</title>\n");
  writeFileSync(path.join(directory, "app.abc123.js"), "// the test build's app\n");
  writeFileSync(path.join(directory, "sw.js"), "// the test build's service worker\n");
  writeFileSync(path.join(directory, "unlisted.js"), "// built but not in the manifest\n");
  writeFileSync(path.join(directory, "THIRD-PARTY-NOTICES.txt"), NOTICES);
  // What the deploy job writes beside the build: one of the two downloads (the
  // other stays absent, as locally) and a file that must never be served. A
  // manifest naming a download still does not reach it through /app/.
  mkdirSync(path.join(directory, "download"), { recursive: true });
  writeFileSync(path.join(directory, "download/onlay-extension.zip"), "PK test zip\n");
  writeFileSync(path.join(directory, "download/notes.txt"), "not a download\n");
  // A stand-in landing page, staged as `bun run build:web` stages the site's
  // build (src/edge/landing.ts): the document, two listed files (the film has
  // known bytes, for ranges), one built but unlisted, and one outside site/.
  // The web app's manifest names one of them, which /app/ must still refuse.
  const landing = path.join(directory, "landing");
  mkdirSync(path.join(landing, "site"), { recursive: true });
  writeFileSync(path.join(landing, "index.html"), LANDING_HTML);
  writeFileSync(path.join(landing, "site/main.abc12345.js"), LANDING_JS);
  writeFileSync(path.join(landing, "site/film.abc12345.mp4"), LANDING_FILM);
  writeFileSync(path.join(landing, "site/THIRD-PARTY-NOTICES.abc12345.txt"), NOTICES);
  writeFileSync(path.join(landing, "site/unlisted.abc12345.js"), "// built, not listed\n");
  writeFileSync(path.join(landing, "notes.txt"), "not a landing file\n");
  const file = (p: string, contentType: string, bytes: number) => ({
    path: p,
    contentType,
    cache: "immutable",
    bytes,
  });
  writeFileSync(
    path.join(landing, "asset-manifest.json"),
    `${JSON.stringify({
      index: "index.html",
      base: "/site/",
      files: [
        {
          path: "/",
          contentType: "text/html; charset=utf-8",
          cache: "no-cache",
          bytes: LANDING_HTML.length,
        },
        file("/site/main.abc12345.js", "text/javascript; charset=utf-8", LANDING_JS.length),
        file("/site/film.abc12345.mp4", "video/mp4", LANDING_FILM.length),
        file("/site/THIRD-PARTY-NOTICES.abc12345.txt", "text/plain; charset=utf-8", NOTICES.length),
      ],
    })}\n`,
  );
  writeFileSync(
    path.join(directory, "asset-manifest.json"),
    `${JSON.stringify([
      "app.abc123.js",
      "sw.js",
      "THIRD-PARTY-NOTICES.txt",
      "download/onlay-extension.zip",
      "landing/index.html",
    ])}\n`,
  );
  return directory;
}

const TEST_BINDINGS = {
  // Loopback: the dev sign-in stub exists only for a loopback origin and host.
  PUBLIC_ORIGIN: "http://localhost:8787",
  WORKOS_API_BASE: "https://workos.test",
  WORKOS_CLIENT_ID: "client_test",
  WORKOS_API_KEY: "sk_test_fake_workos_key",
  SESSION_SECRET: "test-session-secret-0123456789abcdef0123456789abcdef",
  SUPER_ADMINS: "root@example.com, Chief@Example.com",
  EXTENSION_IDS: "abcdefghijklmnopabcdefghijklmnop",
  VAPID_PUBLIC_KEY: TEST_VAPID.publicKey,
  VAPID_PRIVATE_JWK: TEST_VAPID.privateJwk,
};

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  const assets = testAssets();
  const project = (name: string, main: string, include: string[]) => ({
    plugins: [
      cloudflareTest({
        main,
        wrangler: { configPath: "./wrangler.jsonc", environment: "dev" },
        miniflare: {
          assets: { directory: assets, binding: "ASSETS" },
          bindings: { TEST_MIGRATIONS: migrations, ...TEST_BINDINGS },
        },
      }),
    ],
    test: {
      name,
      include,
      setupFiles: ["./test/support/setup.ts"],
      // workerd plus D1 migrations per file is slow on shared CI runners.
      testTimeout: 30_000,
      hookTimeout: 60_000,
    },
  });
  return {
    test: {
      projects: [
        project("edge", "./test/support/edge-worker.ts", ["test/edge/**/*.test.ts"]),
        project("shell", "./src/worker.ts", ["test/shell/**/*.test.ts"]),
      ],
    },
  };
});
