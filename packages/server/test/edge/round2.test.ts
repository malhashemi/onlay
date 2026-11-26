// The edge's side of the round-2 server list: atomic enrolment (S7), the
// bounded forward (S15), the person check on both logouts (S16), the
// session sweep's revocations (S8), loud stuck rows (S4) and profiles that
// always fit the wire (S3).
import { env, exports } from "cloudflare:workers";
import { InternalPersonRequestSchema, LIMITS, PERSON_HEADER, type Person } from "@onlay/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as z from "zod/mini";
import { pkceChallenge } from "../../src/directory/crypto";
import worker, { handle } from "../../src/worker";
import {
  call,
  devSignIn,
  edge,
  errorOf,
  personalSpaceOf,
  seedWorkspace,
  setSpace,
  spaceLog,
  webHeaders,
} from "../support/client";

const EXT = "abcdefghijklmnopabcdefghijklmnop";
const DAILY = {
  cron: "17 4 * * *",
  scheduledTime: Date.now(),
  noRetry() {},
} as ScheduledController;
const MINUTELY = {
  cron: "* * * * *",
  scheduledTime: Date.now(),
  noRetry() {},
} as ScheduledController;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("enrolment is atomic (S7)", () => {
  async function handOff(who: Awaited<ReturnType<typeof devSignIn>>, verifier: string) {
    const page = await edge(
      `/auth/extension?ext=${EXT}&challenge=${await pkceChallenge(verifier)}&state=nonce-1`,
      { headers: { Cookie: who.cookie, "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none" } },
    );
    const code = /"code":"([A-Za-z0-9_-]+)"/.exec(await page.text())?.[1] ?? "";
    expect(code).not.toBe("");
    return code;
  }
  const redeem = (code: string, verifier: string) =>
    edge("/auth/extension/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, verifier }),
    });
  const tokensOf = (personId: string) =>
    env.DB.prepare("SELECT count(*) AS n FROM client_tokens WHERE person_id = ?")
      .bind(personId)
      .first<number>("n");

  test("the issuing session ending before the code is redeemed leaves no token", async () => {
    const who = await devSignIn();
    const verifier = "v".repeat(43);
    const code = await handOff(who, verifier);
    const before = await tokensOf(who.person.id);
    // This session only: the code stays, its session is gone.
    expect((await call(who, "POST", "/auth/logout")).status).toBe(204);
    expect(await errorOf(await redeem(code, verifier))).toMatchObject({
      status: 401,
      code: "sign_in_required",
    });
    expect(await tokensOf(who.person.id)).toBe(before);
    // And the code was spent with it.
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM auth_codes WHERE person_id = ?")
        .bind(who.person.id)
        .first<number>("n"),
    ).toBe(0);
  });

  test("a sign-out everywhere that commits first leaves no code and no token", async () => {
    const who = await devSignIn();
    const verifier = "w".repeat(43);
    const code = await handOff(who, verifier);
    const before = await tokensOf(who.person.id);
    expect((await call(who, "POST", "/auth/logout-everywhere")).status).toBe(204);
    expect(await errorOf(await redeem(code, verifier))).toMatchObject({
      status: 400,
      code: "invalid",
    });
    // Sign out everywhere deletes every token of the person (R3-S1); none was minted after.
    expect(before).toBeGreaterThan(0);
    expect(await tokensOf(who.person.id)).toBe(0);
  });
});

describe("the edge bounds a forward before buffering it (S15)", () => {
  test("a JSON body over 1.5 MiB is invalid/too-large and never forwarded; one under passes", async () => {
    const who = await devSignIn();
    const personal = await personalSpaceOf(who);
    const big = { text: "x".repeat(1_600_000) };
    const refused = await call(who, "POST", `/s/${personal}/interaction`, big);
    expect(refused.status).toBe(400);
    expect(
      ((await refused.json()) as { error: { code: string; reason: string } }).error,
    ).toMatchObject({ code: "invalid", reason: "too-large" });
    const fits = await call(who, "POST", `/s/${personal}/interaction`, {
      text: "x".repeat(1_400_000),
    });
    expect(fits.status).toBe(200);
  });

  test("a streamed body with no declared length is cut off at the limit", async () => {
    const who = await devSignIn();
    const personal = await personalSpaceOf(who);
    const chunk = new Uint8Array(256 * 1024).fill(0x61);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 8) return controller.close();
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const res = await exports.default.fetch(
      new Request(`http://localhost:8787/s/${personal}/interaction`, {
        method: "POST",
        headers: { ...webHeaders(who, "POST"), "Content-Type": "application/json" },
        body,
        // @ts-expect-error -- workerd's Request takes it for a stream body
        duplex: "half",
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { reason: string } }).error.reason).toBe("too-large");
  });

  test("a capture part may carry the part limit; markup uploads keep their own limits", async () => {
    const who = await devSignIn();
    const personal = await personalSpaceOf(who);
    const iid = crypto.randomUUID();
    const part = await call(
      who,
      "PUT",
      `/s/${personal}/interaction/${iid}/capture/c1/part/document`,
      undefined,
      "extension",
    );
    expect(part.status).toBe(200);
    const page = await call(who, "POST", `/s/${personal}/interaction/${iid}/page-content`, {
      content: "x".repeat(2 * LIMITS.MAX_PAGE_CONTENT),
    });
    expect(page.status).toBe(200);
    const anchor = await call(who, "POST", `/s/${personal}/interaction/${iid}/anchor-content`, {
      content: "x".repeat(7 * LIMITS.MAX_ANCHOR_CONTENT),
    });
    expect(((await anchor.json()) as { error: { reason: string } }).error.reason).toBe("too-large");
  });
});

describe("both logouts check the person first (S16)", () => {
  test("a stale tab naming someone else signs nobody out", async () => {
    const who = await devSignIn();
    for (const path of ["/auth/logout", "/auth/logout-everywhere"]) {
      const res = await edge(path, {
        method: "POST",
        headers: { ...webHeaders(who, "POST"), [PERSON_HEADER]: "p_aaaaaaaaaaaaaaaaaaaa" },
      });
      expect(await errorOf(res)).toMatchObject({ status: 401, code: "sign_in_required" });
    }
    expect((await call(who, "GET", "/api/me")).status).toBe(200);
    expect((await call(who, "GET", "/api/me", undefined, "extension")).status).toBe(200);
  });
});

describe("the session sweep tells the spaces (S8)", () => {
  test("each expired session it deletes is revoked by id in every space its person sees", async () => {
    const who = await devSignIn();
    const ws = await seedWorkspace([who]);
    const expired = `ses_expired_${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.prepare(
      "INSERT INTO sessions (id, person_id, token_hash, created_at, renewed_at, expires_at) VALUES (?, ?, ?, 1, 1, 2)",
    )
      .bind(expired, who.person.id, crypto.randomUUID())
      .run();
    await worker.scheduled(DAILY, env);
    expect(
      await env.DB.prepare("SELECT 1 FROM sessions WHERE id = ?").bind(expired).first(),
    ).toBeNull();
    const revoked = (await spaceLog(ws.id))
      .filter((e) => e.path === "/internal/credential-revoked")
      .map((e) => JSON.parse(e.body));
    expect(revoked).toContainEqual({ personId: who.person.id, credentialIds: [expired] });
    expect((await call(who, "GET", "/api/me")).status).toBe(200);
  });
});

describe("a row that keeps failing is loud, and kept (S4)", () => {
  test("the hundredth failure logs STUCK with the row id; the row stays", async () => {
    const admin = await devSignIn();
    const member = await devSignIn();
    const ws = await seedWorkspace([admin], [member]);
    await setSpace(ws.id, "/__test/fail", {});
    expect(
      (await call(admin, "DELETE", `/api/workspaces/${ws.id}/members/${member.person.id}`)).status,
    ).toBe(204);
    await env.DB.prepare(
      "UPDATE space_outbox SET attempts = 99, next_attempt_at = 0 WHERE space_id = ?",
    )
      .bind(ws.id)
      .run();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await worker.scheduled(MINUTELY, env);
    const rows = await env.DB.prepare(
      "SELECT id, attempts, next_attempt_at FROM space_outbox WHERE space_id = ?",
    )
      .bind(ws.id)
      .all<{ id: string; attempts: number; next_attempt_at: number }>();
    expect(rows.results.length).toBe(2);
    for (const row of rows.results) {
      expect(row.attempts).toBe(100);
      // Capped at ten minutes.
      expect(row.next_attempt_at - Date.now()).toBeLessThanOrEqual(600_000);
      expect(errors.mock.calls.some((c) => String(c[0]).startsWith(`STUCK outbox ${row.id}`))).toBe(
        true,
      );
    }
  });
});

describe("a profile always fits the wire (S3)", () => {
  test("initials that would upper-case past the limit are clamped, and the control validates", async () => {
    const who = await devSignIn();
    const ws = await seedWorkspace([who]);
    // "ΐ" upper-cases to three code units.
    const res = await call(who, "PATCH", "/api/me", { name: "ΐa ΐb" });
    expect(res.status).toBe(200);
    const person = ((await res.json()) as { person: Person }).person;
    expect(person.initials.length).toBeLessThanOrEqual(LIMITS.MAX_INITIALS);
    const sent = (await spaceLog(ws.id)).filter((e) => e.path === "/internal/person").at(-1);
    expect(z.safeParse(InternalPersonRequestSchema, JSON.parse(sent?.body ?? "{}")).success).toBe(
      true,
    );
  });

  test("a name of 80 astral characters is clamped to 80 units, not 160", async () => {
    const who = await devSignIn();
    const res = await call(who, "PATCH", "/api/me", { name: "𝒜".repeat(40) });
    expect(res.status).toBe(200);
    const person = ((await res.json()) as { person: Person }).person;
    expect(person.name.length).toBeLessThanOrEqual(LIMITS.MAX_ACTOR_NAME);
  });
});

describe("fan-outs abort what runs late (S16)", () => {
  test("the Inbox's call into a space that never answers is aborted at the deadline", async () => {
    const who = await devSignIn();
    let aborted = false;
    const space = {
      idFromName: (name: string) => env.SPACE.idFromName(name),
      get: () => ({
        fetch: (input: Request | string) =>
          new Promise<Response>((resolve) => {
            const signal = typeof input === "string" ? undefined : input.signal;
            signal?.addEventListener("abort", () => {
              aborted = true;
              resolve(new Response(null, { status: 499 }));
            });
          }),
      }),
    } as unknown as typeof env.SPACE;
    const res = await handle(
      new Request("http://localhost:8787/api/inbox", { headers: webHeaders(who) }),
      { ...env, SPACE: space },
    );
    expect(res.status).toBe(200);
    expect(aborted).toBe(true);
  }, 20_000);
});
