// Edge → space (spec §5.1) against the echoing stand-in: the access check,
// the exact caller header, stripped headers, the rewritten path, and the
// fan-outs behind /api/inbox and /api/origins.
import { env } from "cloudflare:workers";
import { type Caller, decodeCaller, decodeSpaceFacts, type InboxResponse } from "@onlay/protocol";
import { describe, expect, test } from "vitest";
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
import type { Echo } from "../support/echo-space";

const IID = "8a6e0804-2bd0-4672-b79d-d97027f9071c";

async function echoOf(res: Response): Promise<{ echo: Echo; caller: Caller | null }> {
  expect(res.status).toBe(200);
  const echo = (await res.json()) as Echo;
  return { echo, caller: decodeCaller(echo.headers["x-onlay-caller"] ?? "") };
}

/** The space's access epoch in D1, as the edge reads it. */
async function epochOf(spaceId: string): Promise<number> {
  const epoch = await env.DB.prepare("SELECT access_epoch FROM spaces WHERE id = ?")
    .bind(spaceId)
    .first<number>("access_epoch");
  if (epoch === null) throw new Error("no space");
  return epoch;
}

/** The generation the person's newest credential in `table` was stamped with (the header's `credentialGeneration`). */
async function generationOf(
  table: "sessions" | "client_tokens",
  personId: string,
): Promise<number> {
  return Number(
    await env.DB.prepare(
      `SELECT generation FROM ${table} WHERE person_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(personId)
      .first<number>("generation"),
  );
}

async function credentialId(
  table: "sessions" | "client_tokens",
  personId: string,
): Promise<string> {
  const id = await env.DB.prepare(
    `SELECT id FROM ${table} WHERE person_id = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(personId)
    .first<string>("id");
  return id ?? "";
}

describe("routing into a space", () => {
  test("a stranger gets not_found and a visitor sign_in_required", async () => {
    const admin = await devSignIn();
    const stranger = await devSignIn();
    const ws = await seedWorkspace([admin]);
    expect(await errorOf(await call(stranger, "GET", `/s/${ws.id}/interaction`))).toMatchObject({
      status: 404,
      code: "not_found",
    });
    expect(await errorOf(await edge(`/s/${ws.id}/interaction`))).toMatchObject({
      status: 401,
      code: "sign_in_required",
    });
    expect((await call(stranger, "GET", "/s/not-a-space/interaction")).status).toBe(404);
  });

  test("a member's caller header is exactly right, and the path is rewritten", async () => {
    const admin = await devSignIn(undefined, "Omar Faris");
    const member = await devSignIn();
    const ws = await seedWorkspace([admin], [member]);
    const { echo, caller } = await echoOf(
      await call(admin, "GET", `/s/${ws.id}/interaction?url=https%3A%2F%2Fa.test%2F`),
    );
    expect(echo.path).toBe("/interaction");
    expect(echo.search).toBe("?url=https%3A%2F%2Fa.test%2F");
    expect(caller).toEqual({
      personId: admin.person.id,
      name: "Omar Faris",
      initials: "OF",
      tint: admin.person.tint,
      // A member's alias: their email's local part (the space shows it only to members).
      alias: admin.person.email.split("@")[0],
      class: "interaction",
      access: { kind: "member", role: "admin" },
      credentialId: await credentialId("sessions", admin.person.id),
      accessEpoch: await epochOf(ws.id),
      credentialGeneration: await generationOf("sessions", admin.person.id),
    });
    const asMember = await echoOf(
      await call(member, "GET", `/s/${ws.id}/directory`, undefined, "extension"),
    );
    expect(asMember.caller).toMatchObject({
      class: "full",
      access: { kind: "member", role: "member" },
      credentialId: await credentialId("client_tokens", member.person.id),
    });
  });

  test("a guest's caller header carries exactly their shared interactions", async () => {
    const owner = await devSignIn();
    const guest = await devSignIn();
    const personal = await personalSpaceOf(owner);
    expect(
      (
        await call(owner, "POST", `/api/spaces/${personal}/interactions/${IID}/shares`, {
          email: guest.person.email,
        })
      ).status,
    ).toBe(201);
    const { caller } = await echoOf(
      await call(guest, "GET", `/s/${personal}/interaction/${IID}`, undefined, "extension"),
    );
    expect(caller).toEqual({
      personId: guest.person.id,
      name: guest.person.name,
      initials: guest.person.initials,
      tint: guest.person.tint,
      class: "full",
      access: { kind: "guest", interactionIds: [IID] },
      credentialId: await credentialId("client_tokens", guest.person.id),
      // The share moved the space's access epoch; the edge forwards the one it read.
      accessEpoch: await epochOf(personal),
      credentialGeneration: await generationOf("client_tokens", guest.person.id),
    });
    expect(caller?.accessEpoch).toBeGreaterThan(0);
  });

  test("inbound X-Onlay-* headers and credentials never reach the space; bodies do", async () => {
    const who = await devSignIn();
    const personal = await personalSpaceOf(who);
    const forged = Buffer.from(JSON.stringify({ personId: "p_aaaaaaaaaaaaaaaaaaaa" })).toString(
      "base64url",
    );
    const res = await edge(`/s/${personal}/interaction/${IID}/reply`, {
      method: "POST",
      headers: {
        ...webHeaders(who, "POST"),
        "X-Onlay-Caller": forged,
        "x-onlay-internal": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "hello" }),
    });
    const { echo, caller } = await echoOf(res);
    expect(caller?.personId).toBe(who.person.id);
    expect(Object.keys(echo.headers).filter((name) => name.startsWith("x-onlay-"))).toEqual([
      "x-onlay-caller",
      "x-onlay-space",
    ]);
    expect(decodeSpaceFacts(echo.headers["x-onlay-space"] ?? null)).toEqual({
      kind: "personal",
      name: "Personal",
    });
    expect(echo.headers.cookie).toBeUndefined();
    expect(echo.headers.authorization).toBeUndefined();
    expect(echo.method).toBe("POST");
    expect(echo.body).toBe(JSON.stringify({ text: "hello" }));
  });

  test("the internal control routes are unreachable from outside", async () => {
    const who = await devSignIn();
    const personal = await personalSpaceOf(who);
    for (const path of ["/internal/purge", "/internal", "/internal/people", "//x/internal/purge"]) {
      expect((await call(who, "POST", `/s/${personal}${path}`, {})).status).toBe(404);
    }
    expect((await spaceLog(personal)).map((entry) => entry.path)).not.toContain("/internal/purge");
  });

  test("a client protocol below MIN_CLIENT_PROTOCOL is upgrade_required", async () => {
    const who = await devSignIn();
    const personal = await personalSpaceOf(who);
    const res = await edge(`/s/${personal}/directory`, {
      headers: { ...webHeaders(who), "Onlay-Protocol": "1" },
    });
    expect(await errorOf(res)).toMatchObject({ status: 426, code: "upgrade_required" });
    expect(
      (await edge("/api/me", { headers: { ...webHeaders(who), "Onlay-Protocol": "2" } })).status,
    ).toBe(200);
  });
});

describe("fan-outs", () => {
  test("/api/inbox merges each space's attention newest first, tagged with spaceId", async () => {
    const who = await devSignIn();
    const other = await devSignIn();
    const personal = await personalSpaceOf(who);
    const ws = await seedWorkspace([other], [who]);
    const row = (interactionId: string, ts: number) => ({
      interactionId,
      kind: "comment",
      state: "open",
      anchorLabel: "page-level",
      text: "hi",
      fromActorId: other.person.id,
      waitingOnIds: [],
      ts,
    });
    await setSpace(personal, "/__test/attention", {
      needsYou: [row(IID, 100)],
      waiting: [],
      recent: [],
    });
    const later = "b0c5a5e2-1d0e-4f43-9d6a-3b1f6f2b7c11";
    await setSpace(ws.id, "/__test/attention", {
      needsYou: [row(later, 200)],
      waiting: [],
      recent: [],
      needsYouCount: 3,
    });

    const body = (await (await call(who, "GET", "/api/inbox")).json()) as InboxResponse;
    expect(body.needsYou.map((r) => [r.interactionId, r.spaceId])).toEqual([
      [later, ws.id],
      [IID, personal],
    ]);
    expect(body.needsYouCount).toBe(4);
  });

  test("/api/origins lists each space's origins", async () => {
    const who = await devSignIn();
    const personal = await personalSpaceOf(who);
    await setSpace(personal, "/__test/origins", { origins: ["https://a.test"] });
    const body = (await (await call(who, "GET", "/api/origins")).json()) as {
      spaces: Record<string, string[]>;
    };
    expect(body.spaces).toEqual({ [personal]: ["https://a.test"] });
  });
});

describe("static routes", () => {
  test("/healthz, /privacy, and the web app's closed allowlist with its CSP", async () => {
    expect(await (await edge("/healthz")).json()).toMatchObject({ ok: true });
    const privacy = await edge("/privacy");
    expect(privacy.status).toBe(200);
    expect(await privacy.text()).toContain("30 days");

    const shell = await edge("/app/");
    expect(shell.status).toBe(200);
    const csp = shell.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("connect-src 'self' ws://localhost:8787");
    expect(csp).toContain("frame-ancestors 'none'");
    expect((await edge("/app")).headers.get("Location")).toBe("/app/");

    const asset = await edge("/app/app.abc123.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("Cache-Control")).toContain("immutable");
    expect((await edge("/app/sw.js")).headers.get("Service-Worker-Allowed")).toBe("/app/");
    // The third-party notices: plain text, revalidated (each deploy replaces them in place).
    const notices = await edge("/app/THIRD-PARTY-NOTICES.txt");
    expect(notices.status).toBe(200);
    expect(notices.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(notices.headers.get("Cache-Control")).toBe("no-cache");
    expect(notices.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await notices.text()).toContain("Third-party notices");
    for (const path of [
      "/app/unlisted.js",
      "/app/asset-manifest.json",
      "/app/../wrangler.jsonc",
      "/app/nope.js",
    ]) {
      expect((await edge(path)).status).toBe(404);
    }
    expect((await edge("/app/", { method: "POST" })).status).toBe(405);
  });
});
