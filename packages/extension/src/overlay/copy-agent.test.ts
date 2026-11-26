/// <reference types="chrome" />
// Copy for agent in the overlay, byte for byte against spec §9 through the
// formatter the web app shares: one item, an unanchored item, this page's
// round (one block per space), and "changed since copied".
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RawInteractionSnapshot, SpaceSummary } from "@onlay/protocol";
import { interactionUpdatedAt, type KeyValue } from "@onlay/render/copy-for-agent";
import { Window } from "happy-dom";
import { type AppInternals, createApp } from "./app";
import {
  changedSince,
  itemText,
  pendingForAgent,
  rememberCopied,
  roundText,
  setCopiedStore,
} from "./copy-agent";

const A = "s_aaaaaaaaaaaaaaaaaaaa";
const B = "s_bbbbbbbbbbbbbbbbbbbb";
const URL = "https://acme.test/pricing";
const ID1 = "11111111-2222-4333-8444-555555555555";
const ID2 = "21111111-2222-4333-8444-555555555555";
const ID3 = "31111111-2222-4333-8444-555555555555";

let win: Window | null = null;
beforeEach(() => {
  win = new Window({ url: URL });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = win;
  g.document = win.document;
  g.location = win.location;
});
afterEach(() => {
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
  setCopiedStore(null);
});

function memoryKv(): KeyValue {
  const map = new Map<string, string>();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}

function snap(id: string, over: Partial<RawInteractionSnapshot> = {}): RawInteractionSnapshot {
  return {
    id,
    kind: "change",
    url: URL,
    anchor: { level: "page" },
    authorId: "p_me",
    participants: ["p_me"],
    waitingOn: [],
    state: "open",
    thread: [],
    createdAt: 1000,
    agentWork: { status: "pending", requestedBy: "p_me", requestedAt: 1000 },
    ...over,
  } as RawInteractionSnapshot;
}

function app() {
  const host = document.createElement("div");
  const a = createApp({
    shadow: host.attachShadow({ mode: "open" }),
    host,
    isTopFrame: true,
    toast: () => {},
  }) as ReturnType<typeof createApp> & AppInternals;
  a._setServerOrigin("https://app.onlay.dev");
  a._setSelf({ id: "p_me", name: "Me", tint: "#333", initials: "ME" });
  a._setSpaces(
    [
      { id: A, kind: "workspace", name: "acme", role: "member" },
      { id: B, kind: "personal", name: "Personal", role: "member" },
    ] as SpaceSummary[],
    A,
  );
  return a;
}

describe("copy for agent text", () => {
  test("one item: the spec's three lines", () => {
    expect(itemText(app(), { id: ID1, spaceId: A, kind: "change", url: URL })).toBe(
      "Onlay: Edit on https://acme.test/pricing (acme)\n" +
        `https://app.onlay.dev/app/#/t/${A}/${ID1}\n` +
        `read {"ref": "${A}/${ID1}"}`,
    );
  });

  test("an unanchored item drops the page", () => {
    expect(itemText(app(), { id: ID1, spaceId: B, kind: "comment" }).split("\n")[0]).toBe(
      "Onlay: Comment (Personal)",
    );
  });

  test("the round: one block per space with pending items", () => {
    const a = app();
    a._setInteractions(A, [snap(ID1), snap(ID2)]);
    a._setInteractions(B, [
      snap(ID3),
      snap("41111111-2222-4333-8444-555555555555", { state: "resolved" }),
    ]);
    const { text, ids } = roundText(a, URL);
    expect(ids.length).toBe(3);
    expect(text).toBe(
      "Onlay: 2 item(s) for an agent on https://acme.test/pricing (acme)\n" +
        `https://app.onlay.dev/app/#/round/${A}?url=https%3A%2F%2Facme.test%2Fpricing\n` +
        `With the onlay MCP tools: inbox {"space": "${A}", "url": "https://acme.test/pricing"}, then for each item take, read, and answer.\n` +
        "\n" +
        "Onlay: 1 item(s) for an agent on https://acme.test/pricing (Personal)\n" +
        `https://app.onlay.dev/app/#/round/${B}?url=https%3A%2F%2Facme.test%2Fpricing\n` +
        `With the onlay MCP tools: inbox {"space": "${B}", "url": "https://acme.test/pricing"}, then for each item take, read, and answer.`,
    );
  });

  test("the round covers the tab's frames: each page with pending items, the top page first (A-2)", () => {
    const a = app();
    a._setInteractions(A, [snap(ID1)]);
    const FRAME = "https://content.test/page";
    const frameItem = { ...snap(ID2), spaceId: A, url: FRAME };
    const elsewhere = { ...snap(ID3), spaceId: B, url: FRAME };
    const { text, ids } = roundText(a, URL, [
      { url: FRAME, interactions: [frameItem, elsewhere] },
      // A frame with nothing pending is not named.
      { url: "https://quiet.test/", interactions: [{ ...snap(ID1), spaceId: A }] },
    ]);
    expect(ids.map((s) => s.id)).toEqual([ID1, ID2, ID3]);
    expect(text).toBe(
      "Onlay: 2 items for an agent on 2 pages (acme)\n" +
        `https://app.onlay.dev/app/#/round/${A}?url=https%3A%2F%2Facme.test%2Fpricing\n` +
        `https://app.onlay.dev/app/#/round/${A}?url=https%3A%2F%2Fcontent.test%2Fpage\n` +
        "With the onlay MCP tools, call:\n" +
        `inbox {"space": "${A}", "url": "https://acme.test/pricing"}\n` +
        `inbox {"space": "${A}", "url": "https://content.test/page"}\n` +
        "Then for each item, take, read, and answer.\n" +
        "\n" +
        "Onlay: 1 item(s) for an agent on https://content.test/page (Personal)\n" +
        `https://app.onlay.dev/app/#/round/${B}?url=https%3A%2F%2Fcontent.test%2Fpage\n` +
        `With the onlay MCP tools: inbox {"space": "${B}", "url": "https://content.test/page"}, then for each item take, read, and answer.`,
    );
    // Nothing on the top page: the frame's page alone, as one line.
    const b = app();
    expect(roundText(b, URL, [{ url: FRAME, interactions: [frameItem] }]).text).toBe(
      "Onlay: 1 item(s) for an agent on https://content.test/page (acme)\n" +
        `https://app.onlay.dev/app/#/round/${A}?url=https%3A%2F%2Fcontent.test%2Fpage\n` +
        `With the onlay MCP tools: inbox {"space": "${A}", "url": "https://content.test/page"}, then for each item take, read, and answer.`,
    );
  });

  test("taken and answered items are not pending; an expired lease is", () => {
    const now = 10_000;
    const items = [
      snap(ID1, {
        agentWork: { status: "taken", requestedBy: "p", requestedAt: 1, leaseUntil: now + 1 },
      }),
      snap(ID2, {
        agentWork: { status: "taken", requestedBy: "p", requestedAt: 1, leaseUntil: now - 1 },
      }),
      snap(ID3, { agentWork: { status: "answered", requestedBy: "p", requestedAt: 1 } }),
    ].map((s) => ({ ...s, spaceId: A }));
    expect(pendingForAgent(items, now).map((s) => s.id)).toEqual([ID2]);
  });
});

describe("changed since copied", () => {
  test("marks an interaction that changed after this viewer copied it", () => {
    const kv = memoryKv();
    setCopiedStore(kv);
    const a = app();
    const s = {
      ...snap(ID1, {
        createdAt: 100,
        agentWork: { status: "pending", requestedBy: "p_me", requestedAt: 100 },
      }),
      spaceId: A,
    };
    expect(changedSince(kv, a, s)).toBe(false);
    rememberCopied(kv, a, [s], 200);
    expect(changedSince(kv, a, s)).toBe(false);
    const replied = {
      ...s,
      thread: [{ msgId: "m1", authorId: "p_me", body: { text: "hi" }, ts: 300 }],
    };
    expect(interactionUpdatedAt(replied)).toBe(300);
    expect(changedSince(kv, a, replied)).toBe(true);
  });
});
