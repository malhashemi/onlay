// The extension sign-in (spec §4): allowed extension ids, the one-time code
// bound to the PKCE challenge, single use, and expiry.
import { env } from "cloudflare:workers";
import type { ExtensionTokenResponse } from "@onlay/protocol";
import { describe, expect, test } from "vitest";
import { pkceChallenge } from "../../src/directory/crypto";
import { call, devSignIn, edge, errorOf, ORIGIN, type Who } from "../support/client";

const EXT = "abcdefghijklmnopabcdefghijklmnop";

function verifier(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** Opens the hand-off page as the signed-in person's browser tab; the minted code. */
async function handOff(who: Who, challenge: string, ext = EXT): Promise<Response> {
  return edge(`/auth/extension?ext=${ext}&challenge=${challenge}&state=nonce-1`, {
    headers: { Cookie: who.cookie, "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none" },
  });
}

async function codeOf(res: Response): Promise<string> {
  const html = await res.text();
  const match = /"code":"([A-Za-z0-9_-]+)"/.exec(html);
  if (!match?.[1]) throw new Error("no code on the page");
  expect(html).toContain('"state":"nonce-1"');
  expect(html).toContain("chrome.runtime");
  return match[1];
}

function redeem(code: string, codeVerifier: string): Promise<Response> {
  return edge("/auth/extension/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, verifier: codeVerifier }),
  });
}

describe("extension sign-in", () => {
  test("an extension id not in EXTENSION_IDS is refused", async () => {
    const who = await devSignIn();
    const res = await handOff(
      who,
      await pkceChallenge(verifier()),
      "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
    );
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('"code"');
  });

  test("a visitor is sent through sign-in and back", async () => {
    const res = await edge(
      `/auth/extension?ext=${EXT}&challenge=${await pkceChallenge(verifier())}&state=s`,
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "", ORIGIN);
    expect(location.pathname).toBe("/auth/login");
    expect(location.searchParams.get("return_to")).toMatch(/^\/auth\/extension\?ext=/);
  });

  test("the code redeems once, with the right verifier, for a working client token", async () => {
    const who = await devSignIn();
    const v = verifier();
    const page = await handOff(who, await pkceChallenge(v));
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Security-Policy")).toMatch(/script-src 'nonce-/);
    const code = await codeOf(page);

    const res = await redeem(code, v);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ExtensionTokenResponse;
    expect(body.person.id).toBe(who.person.id);
    expect(body.token).toMatch(/^onl_[A-Za-z0-9_-]{43}$/);
    const me = await call({ ...who, token: body.token }, "GET", "/api/me", undefined, "extension");
    expect(me.status).toBe(200);

    expect(await errorOf(await redeem(code, v))).toMatchObject({ status: 400, code: "invalid" });
  });

  test("a wrong verifier is refused, and spends the code", async () => {
    const who = await devSignIn();
    const v = verifier();
    const code = await codeOf(await handOff(who, await pkceChallenge(v)));
    expect((await redeem(code, verifier())).status).toBe(400);
    expect((await redeem(code, v)).status).toBe(400);
  });

  test("an expired code is refused", async () => {
    const who = await devSignIn();
    const v = verifier();
    const code = await codeOf(await handOff(who, await pkceChallenge(v)));
    await env.DB.prepare("UPDATE auth_codes SET expires_at = ? WHERE person_id = ?")
      .bind(Date.now() - 1, who.person.id)
      .run();
    expect((await redeem(code, v)).status).toBe(400);
  });
});
