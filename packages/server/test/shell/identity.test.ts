// A known MCP subject is re-checked against WorkOS once its verification is
// more than a day old (the security audit's finding 7, S3): the stored
// email follows a verified change, an email another person holds refuses
// the request, and an unverified email is the sign-in error.
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { devSignIn, uniqueEmail } from "../support/client";
import { accessToken, addWorkosUser, mcpFetch, userLookups } from "../support/mcp";

const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
const DAY = 86_400_000;

async function signedUp() {
  const user = {
    id: `user_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
    email: uniqueEmail("mcp"),
    email_verified: true,
    first_name: "Mia",
    last_name: "Tester",
  };
  addWorkosUser(user);
  const token = await accessToken(user.id);
  expect((await mcpFetch({ bearer: token, body: ping })).status).toBe(200);
  return { user, token };
}

const ageVerification = (userId: string) =>
  env.DB.prepare("UPDATE people SET verified_at = ? WHERE workos_user_id = ?")
    .bind(Date.now() - DAY - 1_000, userId)
    .run();

const emailOf = (userId: string) =>
  env.DB.prepare("SELECT email FROM people WHERE workos_user_id = ?")
    .bind(userId)
    .first<string>("email");

describe("MCP identity refresh (S3)", () => {
  test("within a day nothing is fetched; after a day the verified email is followed", async () => {
    const { user, token } = await signedUp();
    const lookups = userLookups.length;
    expect((await mcpFetch({ bearer: token, body: ping })).status).toBe(200);
    expect(userLookups.length).toBe(lookups);
    const changed = uniqueEmail("moved");
    addWorkosUser({ ...user, email: changed });
    await ageVerification(user.id);
    // The email change ends every credential issued before it (3b-S1), but
    // not the token whose own sign-in brought it (S-2).
    expect((await mcpFetch({ bearer: token, body: ping })).status).toBe(200);
    expect(userLookups.length).toBe(lookups + 1);
    expect(await emailOf(user.id)).toBe(changed);
  });

  test("an email another person holds refuses the request and changes nothing", async () => {
    const { user, token } = await signedUp();
    const other = await devSignIn();
    addWorkosUser({ ...user, email: other.person.email });
    await ageVerification(user.id);
    const res = await mcpFetch({ bearer: token, body: ping });
    expect(res.status).toBe(409);
    expect(await emailOf(user.id)).toBe(user.email);
  });

  test("an unverified email at refresh is the sign-in error", async () => {
    const { user, token } = await signedUp();
    addWorkosUser({ ...user, email_verified: false });
    await ageVerification(user.id);
    const res = await mcpFetch({ bearer: token, body: ping });
    expect(res.status).toBe(401);
  });
});
