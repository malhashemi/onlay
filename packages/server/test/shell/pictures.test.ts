// Who may fetch a person's picture, and who sees their alias, through the real
// edge, outbox and space; and the name and picture rule on the MCP path.
import { env } from "cloudflare:workers";
import type { MeResponse, PersonSummary } from "@onlay/protocol";
import { afterEach, describe, expect, test } from "vitest";
import {
  call,
  devSignIn,
  edge,
  personalSpaceOf,
  seedWorkspace,
  uniqueEmail,
  type Who,
  webHeaders,
} from "../support/client";
import { jpegOf, pngOf } from "../support/images";
import { accessToken, addWorkosUser, mcpFetch, upstreams } from "../support/mcp";

afterEach(() => {
  upstreams.delete("https://workoscdn.com");
});

async function upload(who: Who, bytes: Uint8Array): Promise<string> {
  const res = await edge("/api/me/picture", {
    method: "PUT",
    headers: { ...webHeaders(who, "PUT"), "Content-Type": "image/png" },
    body: bytes,
  });
  expect(res.status).toBe(200);
  const url = ((await res.json()) as MeResponse).person.avatarUrl ?? "";
  return url.split("/").at(-1) ?? "";
}

async function directory(who: Who, spaceId: string): Promise<PersonSummary[]> {
  const res = await call(who, "GET", `/s/${spaceId}/directory`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { people: PersonSummary[] }).people;
}

async function answer(who: Who, path: string, as: "web" | "extension" = "web") {
  const res = await call(who, "GET", path, undefined, as);
  const type = res.headers.get("Content-Type");
  const body = type?.startsWith("image/")
    ? String((await res.arrayBuffer()).byteLength)
    : await res.text();
  return { status: res.status, type, body };
}

describe("who may fetch a picture", () => {
  test("members, and a guest for the people of their shared thread; everyone else the same not_found", async () => {
    const ann = await devSignIn(uniqueEmail("ann"), "Ann Admin");
    const bo = await devSignIn(uniqueEmail("bo"), "Bo Member");
    const cy = await devSignIn(uniqueEmail("cy"), "Cy Guest");
    const dee = await devSignIn(uniqueEmail("dee"), "Dee Stranger");
    const ws = await seedWorkspace([ann], [bo]);
    const annKey = await upload(ann, pngOf(64, 64));
    const boKey = await upload(bo, jpegOf(64, 64));

    // Bo starts a thread and shares it with Cy: Cy may see Bo, not Ann.
    const created = await call(bo, "POST", `/s/${ws.id}/interaction`, {
      kind: "comment",
      body: { text: "a look?" },
    });
    expect(created.status).toBe(200);
    const id = ((await created.json()) as { interactionId: string }).interactionId;
    const shared = await call(bo, "POST", `/api/spaces/${ws.id}/interactions/${id}/shares`, {
      email: cy.person.email,
    });
    expect(shared.status).toBe(201);

    const annPath = `/s/${ws.id}/people/${ann.person.id}/picture/${annKey}`;
    const boPath = `/s/${ws.id}/people/${bo.person.id}/picture/${boKey}`;

    // The directory names the same paths.
    const asBo = await directory(bo, ws.id);
    expect(asBo.find((p) => p.id === ann.person.id)?.avatarUrl).toBe(annPath);

    expect(await answer(bo, annPath)).toMatchObject({ status: 200, type: "image/png" });
    // The extension's token reads it the same way.
    expect(await answer(bo, annPath, "extension")).toMatchObject({ status: 200 });
    expect(await answer(cy, boPath)).toMatchObject({ status: 200, type: "image/jpeg" });

    const missing = [
      await answer(cy, annPath), // a guest, someone outside their shared thread
      await answer(dee, annPath), // a stranger to the space
      await answer(bo, `/s/${ws.id}/people/p_aaaaaaaaaaaaaaaaaaaa/picture/${annKey}`), // nobody
      await answer(bo, `/s/${ws.id}/people/${ann.person.id}/picture/aaaaaaaaaaaaaaaa`), // another key
      await answer(bo, `/s/${ws.id}/people/${dee.person.id}/picture/${annKey}`), // not in the space
    ];
    for (const m of missing) expect(m.status).toBe(404);
    // A member's and a guest's refusal read alike (the stranger's is the edge's own not_found).
    const inSpace = missing.filter((_, i) => i !== 1);
    expect(new Set(inSpace.map((m) => m.body)).size).toBe(1);

    // Ann takes her picture down: the old path is gone everywhere.
    await call(ann, "PATCH", "/api/me", { picture: "none" });
    expect((await answer(bo, annPath)).status).toBe(404);
    expect((await directory(bo, ws.id)).find((p) => p.id === ann.person.id)?.avatarUrl).toBe(
      undefined,
    );
  });

  test("a removed member's picture is no longer served by the space", async () => {
    const ann = await devSignIn();
    const bo = await devSignIn();
    const ws = await seedWorkspace([ann], [bo]);
    const key = await upload(bo, pngOf(20, 20));
    const path = `/s/${ws.id}/people/${bo.person.id}/picture/${key}`;
    expect((await answer(ann, path)).status).toBe(200);
    const removed = await call(ann, "DELETE", `/api/workspaces/${ws.id}/members/${bo.person.id}`);
    expect(removed.status).toBe(204);
    expect((await answer(ann, path)).status).toBe(404);
  });
});

describe("aliases", () => {
  test("a member sees fellow members' aliases; a guest sees none, not even their own space's members'", async () => {
    const ann = await devSignIn(uniqueEmail("annalias"), "Ann Admin");
    const bo = await devSignIn(uniqueEmail("boalias"), "Bo Member");
    const cy = await devSignIn(uniqueEmail("cyalias"), "Cy Guest");
    const ws = await seedWorkspace([ann], [bo]);
    const created = await call(bo, "POST", `/s/${ws.id}/interaction`, {
      kind: "comment",
      body: { text: "for Cy" },
    });
    const id = ((await created.json()) as { interactionId: string }).interactionId;
    await call(bo, "POST", `/api/spaces/${ws.id}/interactions/${id}/shares`, {
      email: cy.person.email,
    });
    // Each has been seen by the space once.
    await call(ann, "GET", `/s/${ws.id}/directory`);
    await call(cy, "GET", `/s/${ws.id}/interaction/${id}`);

    const asAnn = await directory(ann, ws.id);
    expect(asAnn.find((p) => p.id === bo.person.id)?.alias).toBe(bo.person.email.split("@")[0]);
    expect(asAnn.find((p) => p.id === ann.person.id)?.alias).toBe(ann.person.email.split("@")[0]);
    // A guest holding a share is listed for members, without an alias.
    const guestRow = asAnn.find((p) => p.id === cy.person.id);
    expect(guestRow).toBeDefined();
    expect(guestRow?.alias).toBeUndefined();

    const asCy = await directory(cy, ws.id);
    expect(asCy.map((p) => p.id).sort()).toEqual([bo.person.id, cy.person.id].sort());
    for (const p of asCy) expect(p.alias).toBeUndefined();
    // Nothing else carries one: the thread and the welcome frame name people without it.
    const thread = await (await call(ann, "GET", `/s/${ws.id}/interaction/${id}`)).text();
    expect(thread).not.toContain('"alias"');
    // No full email anywhere in the directory.
    expect(JSON.stringify(asAnn)).not.toContain("@example.com");
  });
});

describe("a guest cannot test a guess at an alias", () => {
  test("a guest's span over a member's real alias reads back as a wrong guess does; a member's is kept", async () => {
    const bo = await devSignIn(uniqueEmail("boguess"), "Bo Member");
    const cy = await devSignIn(uniqueEmail("cyguess"), "Cy Guest");
    const ws = await seedWorkspace([bo]);
    const created = await call(bo, "POST", `/s/${ws.id}/interaction`, {
      kind: "comment",
      body: { text: "for Cy" },
    });
    const id = ((await created.json()) as { interactionId: string }).interactionId;
    await call(bo, "POST", `/api/spaces/${ws.id}/interactions/${id}/shares`, {
      email: cy.person.email,
    });
    const alias = bo.person.email.split("@")[0] ?? "";
    const reply = (who: Who, guess: string, clientId: string) =>
      call(who, "POST", `/s/${ws.id}/interaction/${id}/reply`, {
        body: {
          text: `@${guess} hi`,
          tokens: [
            { t: "actor", actorId: bo.person.id, spans: [{ start: 0, length: guess.length + 1 }] },
          ],
        },
        clientId,
      });
    expect((await reply(cy, alias, "guess-right")).status).toBe(200);
    expect((await reply(cy, "nobody-at-all", "guess-wrong")).status).toBe(200);
    expect((await reply(bo, alias, "member-alias")).status).toBe(200);
    const read = (await (await call(cy, "GET", `/s/${ws.id}/interaction/${id}`)).json()) as {
      interaction: {
        thread: Array<{ body: { text: string; tokens?: Array<{ spans?: unknown }> } }>;
      };
    };
    const spansOf = (text: string) =>
      read.interaction.thread.find((m) => m.body.text === text)?.body.tokens?.[0]?.spans;
    // Right or wrong, the guest's span is dropped the same way.
    expect(spansOf(`@${alias} hi`)).toBeUndefined();
    expect(spansOf("@nobody-at-all hi")).toBeUndefined();
    // A member's own span over a fellow member's alias stands.
    const bos = (await (
      await call(bo, "GET", `/s/${ws.id}/interaction/${id}`)
    ).json()) as typeof read;
    const kept = bos.interaction.thread.filter((m) => m.body.text === `@${alias} hi`);
    expect(kept.some((m) => m.body.tokens?.[0]?.spans !== undefined)).toBe(true);
  });
});

describe("the MCP path keeps the same name and picture rule", () => {
  const DAY = 86_400_000;
  const age = (userId: string) =>
    env.DB.prepare("UPDATE people SET verified_at = ? WHERE workos_user_id = ?")
      .bind(Date.now() - DAY - 1_000, userId)
      .run();
  const personOf = (userId: string) =>
    env.DB.prepare(
      "SELECT name, name_set_at, (SELECT count(*) FROM person_pictures pp WHERE pp.person_id = people.id) AS pictures FROM people WHERE workos_user_id = ?",
    )
      .bind(userId)
      .first<{ name: string; name_set_at: number | null; pictures: number }>();
  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };

  test("the provider's name and picture at the first sign-in and at a refresh; a name set stays", async () => {
    let fetched = 0;
    upstreams.set("https://workoscdn.com", async () => {
      fetched += 1;
      return new Response(pngOf(96, 96));
    });
    const email = uniqueEmail("agentname");
    const user = {
      id: `user_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
      email,
      email_verified: true,
    };
    addWorkosUser(user);
    const token = await accessToken(user.id);
    expect((await mcpFetch({ bearer: token, body: ping })).status).toBe(200);
    expect((await personOf(user.id))?.name).toBe(email.split("@")[0]);

    addWorkosUser({
      ...user,
      first_name: "Rami",
      last_name: "Saleh",
      profile_picture_url: "https://workoscdn.com/images/v1/r",
    } as typeof user);
    await age(user.id);
    expect((await mcpFetch({ bearer: token, body: ping })).status).toBe(200);
    expect(await personOf(user.id)).toMatchObject({ name: "Rami Saleh", pictures: 1 });
    expect(fetched).toBe(1);

    // The person names themself: a later refresh leaves the name alone.
    await env.DB.prepare(
      "UPDATE people SET name = 'Rami S.', initials = 'RS', name_set_at = ? WHERE workos_user_id = ?",
    )
      .bind(Date.now(), user.id)
      .run();
    addWorkosUser({ ...user, first_name: "Rami", last_name: "Al-Saleh" } as typeof user);
    await age(user.id);
    expect((await mcpFetch({ bearer: token, body: ping })).status).toBe(200);
    expect((await personOf(user.id))?.name).toBe("Rami S.");
  });
});

describe("a personal space shows its person", () => {
  test("the person's own picture reaches their personal space's directory", async () => {
    const who = await devSignIn();
    const key = await upload(who, pngOf(40, 40));
    const space = await personalSpaceOf(who);
    const people = await directory(who, space);
    expect(people.find((p) => p.id === who.person.id)?.avatarUrl).toBe(
      `/s/${space}/people/${who.person.id}/picture/${key}`,
    );
  });
});
