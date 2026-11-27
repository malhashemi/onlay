// What bounds an MCP tool call (spec §5.1, §6, §9): access resolved before
// every forward (a revoked share stops the next request; a stale access epoch
// is retried once), result budgets in inbox, read and wait, the scope of
// needs_you, the default image of look, and the shared per-person write
// bucket.
import { env } from "cloudflare:workers";
import { MCP_MAX_RESULT_CHARS, MCP_THREAD_BUDGET_CHARS } from "@onlay/protocol";
import { beforeAll, describe, expect, test } from "vitest";
import { call, devSignIn, seedWorkspace, uniqueEmail, type Who } from "../support/client";
import {
  agentOf,
  comment,
  gzipDoc,
  interaction,
  interceptSpaces,
  PAGE,
  png,
  replyAs,
  tool,
  uploadCapture,
  wrappedSpaces,
} from "../support/mcp";

let ada: Who;
let gus: Who;
let space: string;

beforeAll(async () => {
  ada = await devSignIn(uniqueEmail("ada"), "Ada Lovelace");
  gus = await devSignIn(uniqueEmail("gus"), "Gus Grissom");
  space = (await seedWorkspace([ada], [gus])).id;
});

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

const witnessParts = (w: number) => [
  { name: "document", role: "document", mime: "application/gzip", bytes: gzipDoc() },
  { name: "witness", role: "witness", mime: "image/png", bytes: png(w, w) },
];

describe("access is resolved before every forward", () => {
  test("a share revoked between look's requests stops the image fetch", async () => {
    const gia = await devSignIn(uniqueEmail("gia"), "Gia Guest");
    const id = await comment(ada, space, "Shared with Gia", { forAgent: false });
    await uploadCapture(ada, space, id, "snapshot", witnessParts(4));
    const shared = await call(
      ada,
      "POST",
      `/api/spaces/${space}/interactions/${id}/shares`,
      { email: gia.person.email },
      "extension",
    );
    expect(shared.status).toBeLessThan(300);
    const ref = `${space}/${id}`;
    expect((await tool(agentOf(gia), "look", { ref })).isError).toBe(false);

    // look reads the item, then its captures, then the image: revoke after the second.
    const revoking = wrappedSpaces(async (n) => {
      if (n === 2) {
        await env.DB.prepare("DELETE FROM shares WHERE interaction_id = ? AND email = ?")
          .bind(id, gia.person.email)
          .run();
      }
      return undefined;
    });
    const out = await tool(agentOf(gia), "look", { ref }, revoking);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("Nothing is at that ref");
    expect(out.content).toHaveLength(1);
  });

  test("a stale-access answer is re-resolved and retried once, then reads as not found", async () => {
    const id = await comment(ada, space, "Epochs");
    const ref = `${space}/${id}`;
    const stale = () =>
      Response.json(
        { error: { code: "conflict", message: "stale", reason: "stale-access" } },
        { status: 409 },
      );
    const once = wrappedSpaces(async (n) => (n === 1 ? stale() : undefined));
    const read = await tool(agentOf(ada), "read", { ref }, once);
    expect(read.isError).toBe(false);
    expect(read.text).toContain(ref);
    const always = wrappedSpaces(async () => stale());
    const refused = await tool(agentOf(ada), "read", { ref }, always);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Nothing is at that ref");
  });
});

describe("result budgets", () => {
  test("inbox lists at most 40 items per list, newest first, then how many more", async () => {
    const lia = await devSignIn(uniqueEmail("lia"), "Lia Lister");
    const busy = (await seedWorkspace([lia])).id;
    for (let i = 0; i < 45; i++) await comment(lia, busy, `Item number ${i}`);
    const out = await tool(agentOf(lia), "inbox", { space: busy });
    expect(out.text.length).toBeLessThanOrEqual(MCP_MAX_RESULT_CHARS);
    const yours = out.text.split("Teammates'")[0] ?? "";
    expect(yours).toContain("(45, newest first)");
    expect(yours.match(/^- s_/gm)).toHaveLength(40);
    expect(yours.indexOf("Item number 44")).toBeLessThan(yours.indexOf("Item number 43"));
    expect(yours).not.toContain("Item number 4\u27e7");
    expect(yours).toMatch(
      /5 more items not shown; call inbox with after s_\S+ and the same filters for the next ones\./,
    );
  });

  test("inbox stops a list at its share of the result when items are long", async () => {
    const lou = await devSignIn(uniqueEmail("lou"), "Lou Long");
    const busy = (await seedWorkspace([lou])).id;
    const long = `${PAGE}?q=${"u".repeat(1_800)}`;
    for (let i = 0; i < 40; i++)
      await comment(lou, busy, `L${i} ${"w".repeat(180)}`, { url: long });
    const out = await tool(agentOf(lou), "inbox", { space: busy });
    expect(out.text.length).toBeLessThanOrEqual(MCP_MAX_RESULT_CHARS);
    expect(out.text).not.toContain("onlay cut this result");
    expect(out.text).toMatch(
      /\d+ more items? not shown; call inbox with after s_\S+ and the same filters for the next ones\./,
    );
    expect(out.text).toContain("Waiting on your person: nothing.");
  });

  test("read shows the newest messages that fit, and before pages back; the rest keeps its limits", async () => {
    const id = await comment(ada, space, "A long thread");
    const markup = `<section>${"<p>plan</p>".repeat(1_200)}</section>`;
    await call(
      ada,
      "POST",
      `/s/${space}/interaction/${id}/anchor-content`,
      { content: markup },
      "extension",
    );
    for (let i = 1; i <= 10; i++) await replyAs(gus, space, id, `reply ${i} ${"x".repeat(3_000)}`);
    const ref = `${space}/${id}`;
    const out = await tool(agentOf(ada), "read", { ref });
    expect(out.text.length).toBeLessThanOrEqual(MCP_MAX_RESULT_CHARS);
    expect(out.text).toContain("--- anchor (untrusted content");
    expect(out.text).toContain("Showing the first 8,000");
    expect(out.text).toContain("reply 10 ");
    expect(out.text).not.toContain("reply 1 ");
    const head =
      /Thread \(11 messages; the newest (\d+) shown, oldest first\)\.\n(\d+) earlier messages left out: call read with before "(m\d+)" to see them\./.exec(
        out.text,
      );
    expect(head).not.toBeNull();
    const [, shown, left, before] = head ?? [];
    expect(Number(shown) + Number(left)).toBe(11);
    const thread = out.text.slice(
      out.text.indexOf("Thread ("),
      out.text.indexOf("Captured markup"),
    );
    expect(thread.length).toBeLessThanOrEqual(MCP_THREAD_BUDGET_CHARS + 300);

    const older = await tool(agentOf(ada), "read", { ref, before });
    expect(older.isError).toBe(false);
    expect(older.text).toContain(`Thread before "${before}"`);
    expect(older.text).not.toContain("--- anchor");
    expect(older.text).not.toContain("reply 10 ");
    expect(older.text).toContain(`reply ${11 - Number(shown) - 1} `);
    const unknown = await tool(agentOf(ada), "read", { ref, before: "m999" });
    expect(unknown.isError).toBe(true);
  });

  test("wait shows the 5 newest new messages and counts the rest", async () => {
    const id = await comment(ada, space, "Waiting on many");
    const ref = `${space}/${id}`;
    // Seven replies land between wait reading the item and asking the space to wait.
    const busy = wrappedSpaces(async (n) => {
      if (n === 1) for (let i = 1; i <= 7; i++) await replyAs(gus, space, id, `burst ${i}`);
      return undefined;
    });
    const out = await tool(agentOf(ada), "wait", { ref, timeoutSeconds: 5 }, busy);
    expect(out.text).toContain(
      "7 new messages; the newest 5 shown, oldest first (read the item for the other 2):",
    );
    expect(out.text).toContain("burst 7");
    expect(out.text).toContain("burst 3");
    expect(out.text).not.toContain("burst 2");
  });
});

describe("needs_you follows the inbox scope", () => {
  test("a page or site filter narrows what waits on the person too", async () => {
    const other = "https://elsewhere.example/about";
    const id = await comment(ada, space, "Thoughts on this page?", { url: other, forAgent: false });
    await replyAs(gus, space, id, "Looks fine to me");
    const ref = `${space}/${id}`;
    const waiting = (text: string) => text.split("Waiting on your person")[1] ?? "";
    expect(waiting((await tool(agentOf(ada), "inbox", { space })).text)).toContain(ref);
    expect(waiting((await tool(agentOf(ada), "inbox", { space, url: other })).text)).toContain(ref);
    const onPage = await tool(agentOf(ada), "inbox", { space, url: PAGE });
    expect(waiting(onPage.text)).not.toContain(ref);
    const onSite = await tool(agentOf(ada), "inbox", { space, origin: "https://example.com" });
    expect(waiting(onSite.text)).not.toContain(ref);
    const sameSite = await tool(agentOf(ada), "inbox", { origin: "https://elsewhere.example" });
    expect(waiting(sameSite.text)).toContain(ref);
  });
});

describe("look", () => {
  test("defaults to the newest capture with a witness; an attachment only by its id", async () => {
    const id = await comment(ada, space, "Which look?", { forAgent: false });
    const ref = `${space}/${id}`;
    await uploadCapture(ada, space, id, "snapshot", witnessParts(4));
    await new Promise((r) => setTimeout(r, 5));
    const noWitness = await uploadCapture(ada, space, id, "snapshot", [
      { name: "document", role: "document", mime: "application/gzip", bytes: gzipDoc() },
      { name: "hero.png", role: "asset", mime: "image/png", bytes: png(8, 8) },
    ]);
    await new Promise((r) => setTimeout(r, 5));
    const attached = await uploadCapture(ada, space, id, "attachment", [
      { name: "file", role: "file", mime: "image/png", bytes: png(16, 16) },
    ]);
    const first = await tool(agentOf(ada), "look", { ref });
    expect(first.isError).toBe(false);
    expect(first.content[1]?.data).toBe(base64(png(4, 4)));
    const file = await tool(agentOf(ada), "look", { ref, captureId: attached });
    expect(file.content[1]?.data).toBe(base64(png(16, 16)));
    const asset = await tool(agentOf(ada), "look", { ref, captureId: noWitness });
    expect(asset.isError).toBe(true);
    expect(asset.text).toContain("holds no image");
  });
});

describe("the shared write bucket", () => {
  test("each writing tool is charged to write:<person>, and a full bucket refuses with when to retry", async () => {
    const wes = await devSignIn(uniqueEmail("wes"), "Wes Writer");
    const own = (await seedWorkspace([wes])).id;
    const id = await comment(wes, own, "Count me");
    const ref = `${own}/${id}`;
    const count = () =>
      env.DB.prepare("SELECT count FROM rate_counters WHERE key = ?")
        .bind(`write:${wes.person.id}`)
        .first<number>("count");
    const before = (await count()) ?? 0;
    expect((await tool(agentOf(wes), "take", { ref })).isError).toBe(false);
    expect((await tool(agentOf(wes), "read", { ref })).isError).toBe(false);
    expect(await count()).toBe(before + 1);

    const window = Math.floor(Date.now() / 60_000) * 60_000;
    await env.DB.prepare(
      "INSERT INTO rate_counters (key, window_start, count) VALUES (?1, ?2, 120) ON CONFLICT (key) DO UPDATE SET window_start = ?2, count = 120",
    )
      .bind(`write:${wes.person.id}`, window)
      .run();
    const refused = await tool(agentOf(wes), "reply", { ref, text: "one too many" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/^Slow down: .* Try this write again in \d+ s\.$/);
    const s = await interaction(wes, own, id);
    expect(s.thread.map((m: { body: { text: string } }) => m.body.text)).not.toContain(
      "one too many",
    );
    expect((await tool(agentOf(wes), "read", { ref })).isError).toBe(false);
  });
});

describe("inbox scope, continuation and fan-out", () => {
  test("url narrows before the 40-item cap, and after continues the same list in order", async () => {
    const ivy = await devSignIn(uniqueEmail("ivy"), "Ivy Inbox");
    const busy = (await seedWorkspace([ivy])).id;
    const quiet = "https://example.com/quiet";
    for (let i = 0; i < 3; i++) await comment(ivy, busy, `Quiet ${i}`, { url: quiet });
    for (let i = 0; i < 45; i++) await comment(ivy, busy, `Busy ${i}`);
    const scoped = await tool(agentOf(ivy), "inbox", { space: busy, url: quiet });
    const scopedYours = scoped.text.split("Teammates'")[0] ?? "";
    expect(scopedYours).toContain("(3, newest first)");
    expect(scopedYours).not.toContain("more item");

    const first = await tool(agentOf(ivy), "inbox", { space: busy, url: PAGE });
    const cursor =
      /5 more items not shown; call inbox with after (s_\S+) and the same filters for the next ones\./.exec(
        first.text,
      )?.[1];
    expect(cursor).toBeDefined();
    const next = await tool(agentOf(ivy), "inbox", { space: busy, url: PAGE, after: cursor });
    expect(next.isError).toBe(false);
    expect(next.text).toContain(`(45, newest first; continuing after ${cursor}):`);
    expect(next.text.match(/^- s_/gm)).toHaveLength(5);
    for (let i = 0; i < 5; i++) expect(next.text).toContain(`Busy ${i}\u27e7`);
    expect(next.text).not.toContain("Busy 5\u27e7");
    expect(next.text).not.toContain("Teammates'");
    const gone = await tool(agentOf(ivy), "inbox", {
      space: busy,
      url: PAGE,
      after: `${busy}/00000000-0000-4000-8000-000000000000`,
    });
    expect(gone.isError).toBe(true);
    expect(gone.text).toContain("Call inbox without after");
  });

  test("url and origin are passed to each space's attention read", async () => {
    const seen: string[] = [];
    const watching = interceptSpaces(async (_id, request, real) => {
      const url = new URL(request.url);
      if (url.pathname === "/attention") seen.push(url.search);
      return real(request);
    });
    await tool(
      agentOf(ada),
      "inbox",
      { space, url: PAGE, origin: "https://example.com" },
      watching,
    );
    expect(seen).toHaveLength(1);
    const q = new URLSearchParams(seen[0]);
    expect(q.get("url")).toBe(PAGE);
    expect(q.get("origin")).toBe("https://example.com");
  });

  test("at most 6 spaces at once; a slow space is aborted at 5 s and a failing one named", async () => {
    const fay = await devSignIn(uniqueEmail("fay"), "Fay Fanout");
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push((await seedWorkspace([fay])).id);
    await comment(fay, ids[0] ?? "", "Answered in time");
    const [, slow, broken] = ids;
    let inFlight = 0;
    let most = 0;
    let aborted = false;
    const fanning = interceptSpaces(async (id, request, real) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      try {
        if (id === slow) {
          return await new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener("abort", () => {
              aborted = true;
              reject(request.signal.reason);
            });
          });
        }
        if (id === broken) return Response.json({ error: { code: "invalid" } }, { status: 500 });
        await new Promise((r) => setTimeout(r, 30));
        return await real(request);
      } finally {
        inFlight -= 1;
      }
    });
    const started = Date.now();
    const out = await tool(agentOf(fay), "inbox", {}, fanning);
    const took = Date.now() - started;
    expect(out.isError).toBe(false);
    expect(most).toBeLessThanOrEqual(6);
    expect(aborted).toBe(true);
    expect(took).toBeGreaterThanOrEqual(4_500);
    expect(took).toBeLessThan(15_000);
    expect(out.text).toContain("Answered in time");
    const skippedLine =
      out.text.split("\n").find((l) => l.startsWith("Skipped, try again later:")) ?? "";
    expect(skippedLine).toContain(
      `ws-${(slow ?? "").slice(2, 14)}\u27e7 (it didn't answer in time)`,
    );
    expect(skippedLine).toContain(`ws-${(broken ?? "").slice(2, 14)}\u27e7 (it failed to answer)`);
  });
});

describe("the request body fits a full variant set", () => {
  test("post_variants with four programs of nearly 256 KiB each gets through", async () => {
    const { pageEdit } = await import("../support/mcp");
    const { editId } = await pageEdit(ada, space);
    const html = `<p>${"z".repeat(31_900)}</p>`;
    const program = Array.from({ length: 8 }, () => ({
      op: "insertFragment",
      target: ":scope",
      position: "append",
      html,
    }));
    const variants = Array.from({ length: 4 }, (_, i) => ({ label: `Big ${i}`, program }));
    const programBytes = new TextEncoder().encode(JSON.stringify(program)).length;
    expect(programBytes).toBeLessThan(262_144);
    expect(programBytes * 4).toBeLessThan(1_048_576);
    expect(programBytes * 4).toBeGreaterThan(1_000_000);
    const out = await tool(agentOf(ada), "post_variants", { ref: `${space}/${editId}`, variants });
    expect(out.isError, out.text).toBe(false);
    expect(out.text).toContain("the set now has 4");
  });
});
