// The edge and directory side of round 3: credential generations (R3-S1),
// the small delivery before a forward (R3-S6) and bounded revocation notices
// for expired sessions (R3-S7).
import { env } from "cloudflare:workers";
import { decodeCaller } from "@onlay/protocol";
import { describe, expect, test } from "vitest";
import worker from "../../src/worker";
import {
  call,
  devSignIn,
  edge,
  personalSpaceOf,
  seedWorkspace,
  setSpace,
  spaceLog,
} from "../support/client";

const generationOf = (personId: string) =>
  env.DB.prepare("SELECT credential_generation FROM people WHERE id = ?")
    .bind(personId)
    .first<number>("credential_generation");
const count = (sql: string, ...binds: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...binds)
    .first<number>("n");

describe("credential generations (R3-S1)", () => {
  test("sign out everywhere advances the generation and deletes every credential, with no time rule", async () => {
    const first = await devSignIn();
    const second = await devSignIn(first.person.email);
    const id = first.person.id;
    expect(await generationOf(id)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM sessions WHERE person_id = ?", id)).toBe(2);
    expect((await call(second, "POST", "/auth/logout-everywhere")).status).toBe(204);
    expect(await generationOf(id)).toBe(1);
    expect(await count("SELECT count(*) AS n FROM sessions WHERE person_id = ?", id)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM client_tokens WHERE person_id = ?", id)).toBe(0);
    // Signing in again at once: stamped with the new generation, and it works.
    const again = await devSignIn(first.person.email);
    expect(
      await count("SELECT count(*) AS n FROM sessions WHERE person_id = ? AND generation = 1", id),
    ).toBe(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM client_tokens WHERE person_id = ? AND generation = 1",
        id,
      ),
    ).toBe(1);
    const personal = await personalSpaceOf(again);
    const echoed = (await (
      await call(again, "GET", `/s/${personal}/directory`, undefined, "extension")
    ).json()) as { headers: Record<string, string> };
    const header = decodeCaller(echoed.headers["x-onlay-caller"] ?? "");
    expect(header?.credentialGeneration).toBe(1);
  });

  test("a credential stamped below its person's generation is dead at the edge", async () => {
    const who = await devSignIn();
    expect((await call(who, "POST", "/auth/logout-everywhere")).status).toBe(204);
    const again = await devSignIn(who.person.email);
    // As a previous Worker racing the sign-out would have inserted it: generation 0.
    await env.DB.prepare("UPDATE client_tokens SET generation = 0 WHERE person_id = ?")
      .bind(who.person.id)
      .run();
    expect((await call(again, "GET", "/api/me", undefined, "extension")).status).toBe(401);
    expect((await call(again, "GET", "/api/me")).status).toBe(200);
  });
});

describe("the delivery before a forward is small (R3-S6)", () => {
  async function seedRows(spaceId: string, kind: string, n: number, personId: string) {
    const now = Date.now();
    await env.DB.batch(
      Array.from({ length: n }, (_, i) =>
        env.DB.prepare(
          "INSERT INTO space_outbox (id, space_id, kind, body_json, created_at, priority, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).bind(
          `ob_seed_${kind}_${i}_${crypto.randomUUID().slice(0, 8)}`,
          spaceId,
          kind,
          JSON.stringify({ personId }),
          now + i,
          kind === "access" ? 1 : 3,
          Date.now() + 600_000, // backing off: only the forward's own delivery could reach them
        ),
      ),
    );
  }

  test("at most 10 authorization rows, never a person row; the rest wait for the scheduled retry", async () => {
    const who = await devSignIn();
    const ws = await seedWorkspace([who]);
    await seedRows(ws.id, "person", 3, who.person.id);
    await seedRows(ws.id, "access", 15, who.person.id);
    expect((await call(who, "GET", `/s/${ws.id}/attention`, undefined, "extension")).status).toBe(
      200,
    );
    const log = await spaceLog(ws.id);
    expect(log.filter((e) => e.path === "/internal/access-changed")).toHaveLength(10);
    expect(log.filter((e) => e.path === "/internal/person")).toHaveLength(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM space_outbox WHERE space_id = ? AND kind = 'access'",
        ws.id,
      ),
    ).toBe(5);
    expect(
      await count(
        "SELECT count(*) AS n FROM space_outbox WHERE space_id = ? AND kind = 'person'",
        ws.id,
      ),
    ).toBe(3);
  });

  test("within 1 second in all: a slow space gets what fits, then the forward goes", async () => {
    const who = await devSignIn();
    const ws = await seedWorkspace([who]);
    await seedRows(ws.id, "access", 10, who.person.id);
    await setSpace(ws.id, "/__test/slow", { ms: 400 });
    const start = Date.now();
    const res = await call(who, "GET", `/s/${ws.id}/attention`, undefined, "extension");
    const took = Date.now() - start;
    expect(res.status).toBe(200);
    const delivered = (await spaceLog(ws.id)).filter(
      (e) => e.path === "/internal/access-changed",
    ).length;
    expect(delivered).toBeLessThanOrEqual(3);
    // The 1 s budget, then the forward itself (400 ms here), with room for the runtime.
    expect(took).toBeLessThan(2_500);
    // Cut short by the budget: not counted as the space's failure.
    expect(
      await count(
        "SELECT count(*) AS n FROM space_outbox WHERE space_id = ? AND attempts > 0",
        ws.id,
      ),
    ).toBe(0);
  });
});

describe("expired-session notices name at most 200 ids each (R3-S7)", () => {
  test("250 expired sessions of one person make two notices per space: 200 and 50", async () => {
    const who = await devSignIn();
    const ws = await seedWorkspace([who]);
    await env.DB.batch(
      Array.from({ length: 250 }, (_, i) =>
        env.DB.prepare(
          "INSERT INTO sessions (id, person_id, token_hash, created_at, renewed_at, expires_at) VALUES (?, ?, ?, 1, 1, 2)",
        ).bind(
          `ses_x_${String(i).padStart(3, "0")}_${crypto.randomUUID().slice(0, 6)}`,
          who.person.id,
          crypto.randomUUID(),
        ),
      ),
    );
    await worker.scheduled(
      { cron: "17 4 * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController,
      env,
    );
    const notices = (await spaceLog(ws.id))
      .filter((e) => e.path === "/internal/credential-revoked")
      .map((e) => (JSON.parse(e.body) as { credentialIds: string[] }).credentialIds.length)
      .sort((a, b) => b - a);
    expect(notices).toEqual([200, 50]);
    expect((await call(who, "GET", "/api/me")).status).toBe(200);
    expect(await edge("/healthz").then((r) => r.status)).toBe(200);
  });
});
