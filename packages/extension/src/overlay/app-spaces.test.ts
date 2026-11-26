/// <reference types="chrome" />
// The overlay's space plumbing (spec §10): each space's snapshots are held
// apart and merged, every snapshot knows its space, frames leave tagged with
// the space they belong to, and the composing space defaults to the last one
// used — never a guest space.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RawInteractionSnapshot, SpaceSummary } from "@onlay/protocol";
import { Window } from "happy-dom";
import { type AppInternals, createApp } from "./app";
import { spaceOfFrame } from "./space-of";

const A = "s_aaaaaaaaaaaaaaaaaaaa";
const B = "s_bbbbbbbbbbbbbbbbbbbb";
const G = "s_gggggggggggggggggggg";
const SPACES: SpaceSummary[] = [
  { id: A, kind: "personal", name: "Me", role: "admin" },
  { id: B, kind: "workspace", name: "design", role: "member" },
  { id: G, kind: "workspace", name: "client", role: "guest" },
];

let win: Window | null = null;
let sent: Array<Record<string, unknown>> = [];
let stored: Record<string, unknown> = {};

beforeEach(() => {
  win = new Window({ url: "https://app.example/page" });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = win;
  g.document = win.document;
  g.location = win.location;
  sent = [];
  stored = {};
  g.chrome = {
    runtime: {
      sendMessage: (m: Record<string, unknown>) => {
        sent.push(m);
        return Promise.resolve({ ok: true });
      },
    },
    storage: {
      local: {
        set: (v: Record<string, unknown>) => {
          Object.assign(stored, v);
          return Promise.resolve();
        },
      },
    },
  };
});
afterEach(() => {
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
  delete (globalThis as Record<string, unknown>).chrome;
});

function makeApp(): ReturnType<typeof createApp> & AppInternals {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const app = createApp({ shadow, host, isTopFrame: true, toast: () => {} }) as ReturnType<
    typeof createApp
  > &
    AppInternals;
  app._setSpaces(SPACES, null);
  return app;
}

function snap(id: string): RawInteractionSnapshot {
  return {
    id,
    kind: "comment",
    url: "https://app.example/page",
    anchor: { level: "page" },
    authorId: "p_x",
    participants: [],
    waitingOn: [],
    state: "open",
    thread: [],
    createdAt: 1,
  } as RawInteractionSnapshot;
}

const uuid = (c: string): string =>
  `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;

describe("per-space snapshots", () => {
  test("each space's frame replaces only that space; the view merges and tags", () => {
    const app = makeApp();
    app._setInteractions(A, [snap(uuid("a"))]);
    app._setInteractions(B, [snap(uuid("b")), snap(uuid("c"))]);
    expect(app.interactions().map((s) => [s.id[0], s.spaceId])).toEqual([
      ["a", A],
      ["b", B],
      ["c", B],
    ]);
    app._setInteractions(B, []); // an empty answer (or the privacy gate's) clears B only
    expect(app.interactions().map((s) => s.spaceId)).toEqual([A]);
  });

  test("a space the person lost drops out of the view", () => {
    const app = makeApp();
    app._setInteractions(A, [snap(uuid("a"))]);
    app._setInteractions(B, [snap(uuid("b"))]);
    app._setSpaces(
      SPACES.filter((s) => s.id !== B),
      null,
    );
    expect(app.interactions().map((s) => s.spaceId)).toEqual([A]);
  });
});

describe("frames leave tagged with their space", () => {
  test("a reply goes to its interaction's space; a create to the chosen one", async () => {
    const app = makeApp();
    app._setInteractions(B, [snap(uuid("b"))]);
    await app.send({ type: "interaction-reply", interactionId: uuid("b"), body: { text: "hi" } });
    expect(sent[0]?.spaceId).toBe(B);
    expect(sent[0]?.frameUrl).toBe("https://app.example/page");
    void app.createInteraction({ kind: "comment", anchor: { level: "page" } }, A);
    expect(sent[1]?.type).toBe("interaction-create");
    expect(sent[1]?.spaceId).toBe(A);
  });

  test("a variant frame follows its set's space; syncs carry none and fan out", async () => {
    const app = makeApp();
    app.noteSet("set-1", B);
    await app.send({ type: "variant-cycle", setId: "set-1", index: 0 });
    expect(sent[0]?.spaceId).toBe(B);
    await app.send({ type: "interaction-sync" });
    expect(sent[1]?.spaceId).toBeUndefined();
    await app.send({ type: "attention-sync" });
    expect(sent[2]).toEqual({ v: 1, type: "attention-sync" });
  });

  test("an explicit spaceId wins over the interaction's", () => {
    expect(spaceOfFrame({ spaceId: A, interactionId: uuid("z") })).toBe(A);
    expect(spaceOfFrame({ interactionId: "unknown" })).toBeUndefined();
  });
});

describe("the composing space", () => {
  test("defaults to the personal space, follows the last used, never a guest space", () => {
    const app = makeApp();
    expect(app.composeSpaces().map((s) => s.id)).toEqual([A, B]);
    expect(app.currentSpaceId()).toBe(A);
    app.setCurrentSpace(B);
    expect(app.currentSpaceId()).toBe(B);
    expect(stored.lastSpaceId).toBe(B);
    app._setSpaces(SPACES, G); // a stored guest space is never offered
    expect(app.currentSpaceId()).toBe(A);
    expect(app.isGuest(G)).toBe(true);
    expect(app.multiSpace()).toBe(true);
  });

  test("the thread link points at the web app", () => {
    const app = makeApp();
    app._setServerOrigin("http://localhost:8787");
    expect(app.threadLink(B, "i1")).toBe(`http://localhost:8787/app/#/t/${B}/i1`);
  });
});

describe("spaces past the socket cap", () => {
  function plainApp() {
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const app = createApp({ shadow, host, isTopFrame: true, toast: () => {} }) as ReturnType<
      typeof createApp
    > &
      AppInternals;
    app._setSpaces(SPACES, A);
    return app;
  }

  test("picking a space asks the service worker to connect it", () => {
    const app = plainApp();
    app.setCurrentSpace(B);
    expect(sent).toContainEqual({ type: "useSpace", spaceId: B });
  });

  test("an open composer's space is reported in use, follows its picker, and is released on close", () => {
    const app = plainApp();
    app.holdSpace?.("composer", A);
    expect(sent).toContainEqual({ type: "useSpace", spaceId: A });
    expect(sent.at(-1)).toEqual({ type: "spacesInUse", spaces: [A] });
    app.setCurrentSpace(B);
    expect(sent.at(-1)).toEqual({ type: "spacesInUse", spaces: [B] });
    app.holdSpace?.("composer", null);
    expect(sent.at(-1)).toEqual({ type: "spacesInUse", spaces: [] });
  });
});

describe("staged anchor markup is bound to the page it was picked on (3b-C8)", () => {
  async function submit(movePage: boolean): Promise<string[]> {
    const app = makeApp();
    app._setSelf({ id: "p_me", name: "Me", tint: "#333", initials: "ME" });
    app.setCapture({ html: "<p>picked</p>", truncated: false });
    if (movePage) (win as Window).history.pushState({}, "", "/elsewhere");
    void app.createInteraction(
      { kind: "comment", anchor: { level: "element", selector: "#x" } } as never,
      A,
    );
    const create = sent.find((m) => m.type === "interaction-create");
    app._onReceipt({
      type: "interaction-receipt",
      kind: "create",
      nonce: String(create?.nonce),
      interactionId: uuid("e"),
      ok: true,
    } as never);
    await new Promise((r) => setTimeout(r, 0));
    return sent.map((m) => String(m.type));
  }

  test("submitted on the same page, the markup goes up after the create", async () => {
    expect(await submit(false)).toContain("uploadAnchorContent");
  });

  test("submitted after the page key changed, it is dropped, not sent", async () => {
    expect(await submit(true)).not.toContain("uploadAnchorContent");
  });
});

describe("two sends for the same thread each get their own receipt", () => {
  const receipt = (ok: boolean) =>
    ({
      type: "interaction-receipt",
      kind: "reply",
      interactionId: uuid("f"),
      ok,
      ...(ok ? {} : { reason: "rate-limited" }),
    }) as never;

  test("receipts settle the waiters oldest first", async () => {
    const app = makeApp();
    const first = app.awaitReceipt("reply", uuid("f"));
    const second = app.awaitReceipt("reply", uuid("f"));
    app._onReceipt(receipt(true));
    expect(await first).toEqual({ ok: true });
    app._onReceipt(receipt(false));
    expect(await second).toEqual({ ok: false, error: "rate-limited" });
  });

  test("an earlier waiter still times out after a later one registered", async () => {
    const app = makeApp();
    const first = app.awaitReceipt("reply", uuid("f"), 5);
    const second = app.awaitReceipt("reply", uuid("f"), 5_000);
    expect(await first).toEqual({ ok: false, error: "timeout" });
    app._onReceipt(receipt(true));
    expect(await second).toEqual({ ok: true });
  });
});

describe("2-A3: a document that owns no blocks never syncs a page", () => {
  test("its page syncs go nowhere, on any path; other frames still go out", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp({
      shadow: host.attachShadow({ mode: "open" }),
      host,
      isTopFrame: false,
      toast: () => {},
      ownsBlocks: false,
    });
    for (const type of ["interaction-sync", "variant-sync"]) {
      expect(await app.send({ type } as never)).toEqual({ ok: false, error: "not-a-page" });
    }
    expect(sent).toEqual([]);
    await app.send({ type: "attention-sync" } as never);
    expect(sent.map((m) => m.type)).toEqual(["attention-sync"]);
    // A document that owns blocks syncs as before.
    const owner = makeApp();
    await owner.send({ type: "interaction-sync" } as never);
    expect(sent.map((m) => m.type)).toEqual(["attention-sync", "interaction-sync"]);
  });
});
