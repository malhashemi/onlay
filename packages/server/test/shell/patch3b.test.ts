// Patch 3b through the real Worker, MCP endpoint and D1: an MCP access token
// issued before its person signed out everywhere is refused (3b-S1).
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { agentTokenRevoked } from "../../src/directory/credentials";
import { call, devSignIn, uniqueEmail } from "../support/client";
import { accessToken, addWorkosUser, mcpFetch } from "../support/mcp";

const ping = { jsonrpc: "2.0", id: 1, method: "ping" };

describe("3b-S1: sign out everywhere ends MCP access tokens issued before it", () => {
  test("the old token gets the 401 challenge; one issued after works", async () => {
    const user = {
      id: `user_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
      email: uniqueEmail("mcp3b"),
      email_verified: true,
      first_name: "Mia",
      last_name: "Tester",
    };
    addWorkosUser(user);
    const before = await accessToken(user.id); // iat: 5 s ago
    expect((await mcpFetch({ bearer: before, body: ping })).status).toBe(200);
    // The same person signs out everywhere from the web app.
    const web = await devSignIn(user.email);
    expect((await call(web, "POST", "/auth/logout-everywhere")).status).toBe(204);
    const at = await env.DB.prepare("SELECT credentials_revoked_at FROM people WHERE id = ?")
      .bind(web.person.id)
      .first<number>("credentials_revoked_at");
    // Unix seconds, set by SQLite in the revoking batch.
    expect(Math.abs(Number(at) - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(2);
    const refused = await mcpFetch({ bearer: before, body: ping });
    expect(refused.status).toBe(401);
    expect(refused.headers.get("WWW-Authenticate")).toContain('error="unauthorized"');
    // A token issued after the revocation (here: the revocation moved a minute back).
    await env.DB.prepare("UPDATE people SET credentials_revoked_at = ? WHERE id = ?")
      .bind(Math.floor(Date.now() / 1000) - 60, web.person.id)
      .run();
    expect((await mcpFetch({ bearer: await accessToken(user.id), body: ping })).status).toBe(200);
  });

  test("the comparison is in whole seconds, and a token with no iat is refused once a time exists", async () => {
    const who = await devSignIn();
    const facts = (iat: unknown) => ({ iat, jti: "j", subject: "user_x", personId: who.person.id });
    expect(await agentTokenRevoked(env.DB, facts(undefined))).toBe(false);
    await env.DB.prepare("UPDATE people SET credentials_revoked_at = 1000 WHERE id = ?")
      .bind(who.person.id)
      .run();
    expect(await agentTokenRevoked(env.DB, facts(999))).toBe(true);
    // S-2: issued in the revocation's own second is accepted.
    expect(await agentTokenRevoked(env.DB, facts(1000))).toBe(false);
    expect(await agentTokenRevoked(env.DB, facts(1001))).toBe(false);
    expect(await agentTokenRevoked(env.DB, facts(undefined))).toBe(true);
    expect(await agentTokenRevoked(env.DB, facts("1001"))).toBe(true);
  });
});
