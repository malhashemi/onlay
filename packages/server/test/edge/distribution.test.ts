// The public install page, the two downloads beside the web app build, and
// the extension version /healthz reports.
import { env } from "cloudflare:workers";
import { HealthzResponseSchema } from "@onlay/protocol";
import { describe, expect, test } from "vitest";
import { handle } from "../../src/worker";
import { call, devSignIn, edge } from "../support/client";

const ORIGIN = "http://localhost:8787";

describe("/install", () => {
  test("is a static page under the sign-in pages' strict policy, with every step", async () => {
    const res = await edge("/install");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    const html = await res.text();
    expect(html).not.toContain("<script");
    for (const step of [
      'href="/download/onlay-extension.zip"',
      "chrome://extensions",
      "Developer mode",
      "Load unpacked",
      "Pin Onlay",
      "Sign in",
      "reload button",
    ])
      expect(html).toContain(step);
    // The lexicon's bans, on what the page says.
    const text = html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, " ");
    for (const banned of [/element/i, /\bqueue\b/i, /popover/i, /!/])
      expect(text).not.toMatch(banned);
    // No deployed version locally: no version line.
    expect(html).not.toContain("Latest version");
  });

  test("names the deployed version when there is one", async () => {
    const res = await handle(new Request(`${ORIGIN}/install`), {
      ...env,
      EXTENSION_VERSION: "0.1.42",
    });
    expect(await res.text()).toContain("Latest version: 0.1.42<");
  });

  test("the sign-in pages link to it", async () => {
    const failed = await edge("/auth/callback");
    expect(await failed.text()).toContain('<a href="/install">Install the extension</a>');
  });
});

describe("/ (one origin)", () => {
  test("a signed-out visitor gets the landing page under its own policy", async () => {
    const res = await edge("/", { headers: { "Sec-Fetch-Mode": "navigate" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(await res.text()).toContain("Onlay landing stand-in");
    // The privacy page opens with what Onlay is, and says when content and addresses are sent.
    const privacy = await (await edge("/privacy")).text();
    expect(privacy).toContain(
      "<p>Onlay lets people and their agents comment on and edit live web pages together. This page explains",
    );
    expect(privacy).toContain("<h2>When page content is uploaded</h2>");
    expect(privacy).toContain("without a further click from you");
    expect(privacy).toContain("<h2>When a page's address is sent</h2>");
    expect(privacy).toContain("On every other site, nothing about the page is sent.");
  });

  test("a signed-in browser goes on to the web app; a stale or doubled cookie does not", async () => {
    const who = await devSignIn();
    const navigate = (cookie: string) =>
      edge("/", { headers: { Cookie: cookie, "Sec-Fetch-Mode": "navigate" } });
    const res = await navigate(who.cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/app/");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    // Signed out (the cookie names no live session): the landing page.
    const out = await call(who, "POST", "/auth/logout");
    expect(out.status).toBe(204);
    expect((await navigate(who.cookie)).status).toBe(200);
    const other = await devSignIn();
    expect((await navigate(`${who.cookie}; ${other.cookie}`)).status).toBe(200);
    // Only a navigation counts: a cross-site subresource is a visitor.
    const embedded = await edge("/", {
      headers: {
        Cookie: other.cookie,
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "cross-site",
      },
    });
    expect(embedded.status).toBe(200);
    expect((await edge("/", { method: "POST" })).status).toBe(405);
  });
});

describe("/download", () => {
  test("serves the extension zip as a download that always revalidates", async () => {
    const res = await edge("/download/onlay-extension.zip");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="onlay-extension.zip"',
    );
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe("PK test zip\n");

    const head = await edge("/download/onlay-extension.zip", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Type")).toBe("application/zip");
    expect((await edge("/download/onlay-extension.zip", { method: "POST" })).status).toBe(405);
  });

  test("an absent download is a 404, and nothing else in the folder is served", async () => {
    // Not written in this build (as locally and in e2e).
    expect((await edge("/download/onlay-stamp.tgz")).status).toBe(404);
    for (const path of [
      "/download/notes.txt",
      "/download/",
      "/download/../index.html",
      "/download/%2e%2e/index.html",
      "/download/onlay-extension.zip/",
      "/download/ONLAY-EXTENSION.ZIP",
      "/download/constructor",
      "/download/__proto__",
      "/download",
      // The web app's allowlist never reaches the folder, even when a manifest names it.
      "/app/download/onlay-extension.zip",
      "/app/download/notes.txt",
    ])
      expect((await edge(path)).status, path).toBe(404);
  });
});

describe("/healthz", () => {
  test("reports the published extension version only when one is deployed", async () => {
    const local = HealthzResponseSchema.parse(await (await edge("/healthz")).json());
    expect(local.extension).toBeUndefined();
    const deployed = await handle(new Request(`${ORIGIN}/healthz`), {
      ...env,
      SHA: "abc",
      EXTENSION_VERSION: "0.1.42",
    });
    expect(HealthzResponseSchema.parse(await deployed.json())).toEqual({
      ok: true,
      sha: "abc",
      protocol: expect.any(Number),
      extension: "0.1.42",
    });
  });
});
