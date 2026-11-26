// Seams between the server's round 2 and the clients and MCP seats' round 2,
// through the real edge, MCP endpoint and space Durable Object.
import type { InboxResponse } from "@onlay/protocol";
import { LIMITS, programBytes } from "@onlay/protocol";
import { beforeAll, describe, expect, test } from "vitest";
import {
  call,
  devSignIn,
  personalSpaceOf,
  seedWorkspace,
  uniqueEmail,
  type Who,
} from "../support/client";
import { agentOf, comment, PAGE, pageEdit, type Rpc, tool } from "../support/mcp";

let ada: Who;
let bea: Who;
let space: string;

beforeAll(async () => {
  ada = await devSignIn(uniqueEmail("ada"), "Ada Lovelace");
  bea = await devSignIn(uniqueEmail("bea"), "Bea Moreau");
  space = (await seedWorkspace([ada], [bea])).id;
});

describe("1. variants posted through MCP name the person the agent acts as", () => {
  test("by is the acting person in GET /variant-set/:id", async () => {
    const { setId, editId } = await pageEdit(ada, space);
    const posted = await tool(agentOf(ada), "post_variants", {
      ref: `${space}/${editId}`,
      variants: [
        {
          label: "Quieter",
          program: [{ op: "setClass", target: "main", add: ["calm"], remove: [] }],
        },
      ],
    });
    expect(posted.isError).toBe(false);
    const set = (await (
      await call(ada, "GET", `/s/${space}/variant-set/${setId}`, undefined, "extension")
    ).json()) as Rpc;
    expect(set.set.variants.map((v: Rpc) => v.by)).toEqual([ada.person.id]);
    // A teammate's agent, asked to, writes as the teammate: no look for Ada.
    const onBehalf = await tool(agentOf(bea), "post_variants", {
      ref: `${space}/${editId}`,
      onBehalf: true,
      variants: [
        {
          label: "Bolder",
          program: [{ op: "setClass", target: "main", add: ["bold"], remove: [] }],
        },
      ],
    });
    expect(onBehalf.isError).toBe(false);
    const after = (await (
      await call(ada, "GET", `/s/${space}/variant-set/${setId}`, undefined, "extension")
    ).json()) as Rpc;
    expect(after.set.variants.map((v: Rpc) => v.by)).toEqual([ada.person.id, bea.person.id]);
  });
});

describe("4. opening a shared thread in the extension pays the share debt", () => {
  test("a guest's by-id read with a client token (class full) clears `shared`", async () => {
    const owner = await devSignIn();
    const guest = await devSignIn();
    const personal = await personalSpaceOf(owner);
    const id = await comment(owner, personal, "have a look", false);
    expect(
      (
        await call(owner, "POST", `/api/spaces/${personal}/interactions/${id}/shares`, {
          email: guest.person.email,
        })
      ).status,
    ).toBe(201);
    const before = (await (
      await call(guest, "GET", "/api/inbox", undefined, "extension")
    ).json()) as InboxResponse;
    expect(before.needsYou).toContainEqual(
      expect.objectContaining({ interactionId: id, because: "shared" }),
    );
    expect(
      (await call(guest, "GET", `/s/${personal}/interaction/${id}`, undefined, "extension")).status,
    ).toBe(200);
    const after = (await (
      await call(guest, "GET", "/api/inbox", undefined, "extension")
    ).json()) as InboxResponse;
    expect(after.needsYou.map((r) => r.interactionId)).not.toContain(id);
  });
});

describe("5. the MCP inbox's url and origin reach /attention before its cap", () => {
  test("a quiet page's row is found under a busy site's 55 newer ones", async () => {
    const team = await seedWorkspace([ada], [bea]);
    const mention = { tokens: [{ t: "actor", actorId: ada.person.id }] };
    const post = (url: string, text: string) =>
      call(
        bea,
        "POST",
        `/s/${team.id}/interaction`,
        { kind: "comment", url, anchor: { level: "page" }, body: { text, ...mention } },
        "extension",
      );
    const QUIET = "https://quiet.example/page";
    const quiet = ((await (await post(QUIET, "@Ada quiet one")).json()) as Rpc)
      .interactionId as string;
    for (let i = 0; i < LIMITS.MAX_ATTENTION_ROWS + 5; i++) {
      expect((await post(`https://busy.example/p${i}`, `@Ada busy ${i}`)).status).toBe(200);
    }
    const ref = `${team.id}/${quiet}`;
    const all = await tool(agentOf(ada), "inbox", { space: team.id });
    expect(all.text).not.toContain(ref);
    const byUrl = await tool(agentOf(ada), "inbox", { space: team.id, url: QUIET });
    expect(byUrl.isError).toBe(false);
    expect(byUrl.text).toContain(ref);
    const byOrigin = await tool(agentOf(ada), "inbox", {
      space: team.id,
      origin: "https://quiet.example",
    });
    expect(byOrigin.text).toContain(ref);
  }, 60_000);
});

describe("7. a full variant set fits the MCP body cap and the edge's JSON cap", () => {
  test("four programs of about 256 KiB, posted in one call, are stored", async () => {
    const { setId, editId } = await pageEdit(ada, space, { url: `${PAGE}?full` });
    // Each program just under MAX_PROGRAM_BYTES; together just under MAX_SET_PROGRAM_BYTES.
    const per = Math.floor(LIMITS.MAX_SET_PROGRAM_BYTES / 4) - 512;
    const program = (n: number) => {
      const ops = 8;
      const html = (k: number, len: number) => `<p>${String(n * 10 + k).padEnd(len, "x")}</p>`;
      const draft = Array.from({ length: ops }, (_, k) => ({
        op: "insertFragment" as const,
        target: ":scope",
        position: "append" as const,
        html: html(k, 1),
      }));
      const room = Math.floor((per - programBytes(draft)) / ops);
      return draft.map((o, k) => ({ ...o, html: html(k, room) }));
    };
    const variants = [0, 1, 2, 3].map((n) => ({ label: `Full ${n}`, program: program(n) }));
    for (const v of variants)
      expect(programBytes(v.program)).toBeLessThanOrEqual(LIMITS.MAX_PROGRAM_BYTES);
    const total = variants.reduce((n, v) => n + programBytes(v.program), 0);
    expect(total).toBeGreaterThan(LIMITS.MAX_SET_PROGRAM_BYTES - 4_096);
    expect(total).toBeLessThanOrEqual(LIMITS.MAX_SET_PROGRAM_BYTES);
    const envelope = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "post_variants", arguments: { ref: `${space}/${editId}`, variants } },
    });
    expect(envelope.length).toBeLessThan(1.5 * 1024 * 1024);
    const posted = await tool(agentOf(ada), "post_variants", {
      ref: `${space}/${editId}`,
      variants,
    });
    expect(posted.isError).toBe(false);
    const set = (await (
      await call(ada, "GET", `/s/${space}/variant-set/${setId}`, undefined, "extension")
    ).json()) as Rpc;
    expect(set.set.variants).toHaveLength(4);
    // The same set as a JSON body through the edge is under its 1.5 MiB cap: the
    // space answers it (an agent-only route), the edge never says too-large.
    const viaEdge = await call(
      ada,
      "POST",
      `/s/${space}/variant-set/${setId}/variants`,
      { variants },
      "extension",
    );
    const body = (await viaEdge.json()) as Rpc;
    expect(body.error?.reason).not.toBe("too-large");
  }, 60_000);
});
