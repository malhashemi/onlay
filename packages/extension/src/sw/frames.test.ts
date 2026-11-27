import { expect, test } from "bun:test";
import {
  createFrameRelay,
  type FrameRegistry,
  type FrameSender,
  frameCreateRefusal,
  frameMayCreate,
  frameMaySync,
  hostUrlFor,
  PICK_KINDS,
} from "./frames";

interface Sent {
  tabId: number;
  msg: Record<string, unknown>;
  to?: { frameId?: number; documentId?: string };
}

function relay(answer: (s: Sent) => unknown = () => ({ ok: true }), generation = 1) {
  let registry: FrameRegistry = {};
  const sent: Sent[] = [];
  const r = createFrameRelay({
    send: async (tabId, msg, to) => {
      const s: Sent = { tabId, msg, ...(to ? { to } : {}) };
      sent.push(s);
      return answer(s);
    },
    load: async () => registry,
    save: async (next) => {
      registry = next;
    },
    generation: () => generation,
  });
  return { r, sent, registry: () => registry };
}

const TOP: FrameSender = {
  tab: { id: 7, url: "https://dossier.example/goals/ceo/?token=x#a" },
  frameId: 0,
  documentId: "DOC-TOP",
  documentLifecycle: "active",
  url: "https://dossier.example/goals/ceo/?token=x#a",
};
const CHILD: FrameSender = {
  tab: { id: 7, url: "https://dossier.example/goals/ceo/?token=x#a" },
  frameId: 3,
  documentId: "DOC-CHILD",
  documentLifecycle: "active",
  url: "https://tree.content.example/page",
  origin: "https://tree.content.example",
};
const OTHER_TAB_TOP: FrameSender = { ...TOP, tab: { id: 9, url: "https://evil.example/" } };

const ANCHOR = { level: "element", selector: "#goal > p" };

test("the shared page is the tab's top URL, redacted, and only for a child frame", () => {
  expect(hostUrlFor(CHILD)).toBe("https://dossier.example/goals/ceo/?…");
  expect(hostUrlFor(TOP)).toBeUndefined();
  expect(hostUrlFor({ ...CHILD, tab: { id: 7 } })).toBeUndefined();
  expect(hostUrlFor({ ...CHILD, tab: { id: 7, url: "chrome://newtab/" } })).toBeUndefined();
});

test("only the top frame starts a pick, and it reaches every frame of its own tab", async () => {
  const { r, sent } = relay();
  expect(await r.handle("framePickAll", { pickId: "p1", kind: "comment" }, CHILD)).toEqual({
    ok: false,
    error: "sender",
  });
  expect(await r.handle("framePickAll", { pickId: "p1", kind: "nope" }, TOP)).toEqual({
    ok: false,
    error: "invalid",
  });
  expect(await r.handle("framePickAll", { pickId: "p1", kind: "comment" }, TOP)).toEqual({
    ok: true,
  });
  expect(sent).toEqual([{ tabId: 7, msg: { type: "pick-start", pickId: "p1", kind: "comment" } }]);
  for (const k of ["comment", "edit", "copy", "token"]) expect(PICK_KINDS.has(k)).toBe(true);
});

test("a child's pick goes to its own tab's top frame, stamped with what the browser reports", async () => {
  const { r, sent, registry } = relay();
  const res = await r.handle(
    "framePicked",
    {
      pickId: "p1",
      kind: "comment",
      anchor: ANCHOR,
      label: "goal",
      // Whether the block is too large, per way of asking: booleans only.
      large: { direct: true, variants: "yes", extra: "<b>x</b>" },
      // Claims a page cannot make stick: the relay never reads them.
      frame: { documentId: "DOC-OTHER", url: "https://forged.example/" },
      tabId: 9,
    },
    CHILD,
  );
  expect(res).toEqual({ ok: true });
  expect(sent[0]).toEqual({
    tabId: 7,
    to: { frameId: 0 },
    msg: {
      type: "frame-picked",
      pickId: "p1",
      kind: "comment",
      anchor: ANCHOR,
      label: "goal",
      large: { direct: true, variants: false },
      frame: {
        documentId: "DOC-CHILD",
        url: "https://tree.content.example/page",
        host: "tree.content.example",
      },
    },
  });
  // …then every frame of the tab ends the pick.
  expect(sent[1]).toEqual({ tabId: 7, msg: { type: "pick-end", pickId: "p1" } });
  expect(registry()).toEqual({
    "7": { "DOC-CHILD": { frameId: 3, url: "https://tree.content.example/page" } },
  });
});

test("a child's placement reaches the top frame stamped with the child; a bad one says only that it could not place", async () => {
  const { r, sent } = relay();
  expect(
    await r.handle(
      "framePlaced",
      { pickId: "p1", at: { x: 240, y: 150 }, frame: { documentId: "DOC-X" } },
      CHILD,
    ),
  ).toEqual({ ok: true });
  expect(sent[0]?.to).toEqual({ frameId: 0 });
  expect(sent[0]?.msg).toEqual({
    type: "frame-placed",
    pickId: "p1",
    at: { x: 240, y: 150 },
    frame: {
      documentId: "DOC-CHILD",
      url: "https://tree.content.example/page",
      host: "tree.content.example",
    },
  });
  await r.handle("framePlaced", { pickId: "p1", at: { x: "1", y: 2 } }, CHILD);
  expect(sent[1]?.msg).toMatchObject({ type: "frame-placed", pickId: "p1" });
  expect(sent[1]?.msg).not.toHaveProperty("at");
  await r.handle("framePlaced", { pickId: "p1", stale: true }, CHILD);
  expect(sent[2]?.msg).toMatchObject({ type: "frame-placed", pickId: "p1", stale: true });
  expect(await r.handle("framePlaced", { pickId: "p1" }, TOP)).toEqual({
    ok: false,
    error: "sender",
  });
});

test("a frame that ends a pick says it was ended; a completion's own pick-end does not", async () => {
  const { r, sent } = relay();
  expect(await r.handle("framePickEnd", { pickId: "p1" }, CHILD)).toEqual({ ok: true });
  expect(sent[0]).toEqual({ tabId: 7, msg: { type: "pick-end", pickId: "p1", cancel: true } });
});

test("the top frame cannot send a child's messages, and a malformed anchor goes nowhere", async () => {
  const { r, sent } = relay();
  for (const type of ["framePicked", "frameOpen", "frameReport", "frameCommand", "frameGone"]) {
    expect(await r.handle(type, { pickId: "p", interactionId: "i", spaceId: "s" }, TOP)).toEqual({
      ok: false,
      error: "sender",
    });
  }
  expect(
    await r.handle("framePicked", { pickId: "p", kind: "comment", anchor: { level: "x" } }, CHILD),
  ).toEqual({ ok: false, error: "invalid" });
  expect(sent).toEqual([]);
});

test("a document going away or not active sends nothing", async () => {
  const { r, sent } = relay();
  const cached = { ...CHILD, documentLifecycle: "cached" };
  expect(await r.handle("frameOpen", { interactionId: "i1", spaceId: "s_1" }, cached)).toEqual({
    ok: false,
    error: "sender",
  });
  expect(sent).toEqual([]);
});

test("a call reaches only a document this tab's frames have spoken from", async () => {
  const { r, sent } = relay(() => ({ ok: true, interactionId: "i1" }));
  // Unknown document: refused before anything is sent.
  expect(
    await r.handle("frameCall", { documentId: "DOC-CHILD", call: { op: "reveal" } }, TOP),
  ).toEqual({ ok: false, error: "no-frame" });
  await r.handle("frameOpen", { interactionId: "i1", spaceId: "s_1" }, CHILD);
  sent.length = 0;
  // A child cannot call; another tab's top frame cannot reach this tab's document.
  expect(await r.handle("frameCall", { documentId: "DOC-CHILD", call: {} }, CHILD)).toEqual({
    ok: false,
    error: "sender",
  });
  expect(
    await r.handle("frameCall", { documentId: "DOC-CHILD", call: { op: "reveal" } }, OTHER_TAB_TOP),
  ).toEqual({ ok: false, error: "no-frame" });
  expect(sent).toEqual([]);
  // Its own tab's top frame reaches exactly that document, and hears its answer.
  expect(
    await r.handle("frameCall", { documentId: "DOC-CHILD", call: { op: "reveal" } }, TOP),
  ).toEqual({ ok: true, interactionId: "i1" });
  expect(sent).toEqual([
    {
      tabId: 7,
      to: { documentId: "DOC-CHILD" },
      msg: { type: "frame-call", call: { op: "reveal" } },
    },
  ]);
});

test("a call to a document that went away forgets it", async () => {
  let fail = false;
  const { r, registry } = relay(() => {
    if (fail) throw new Error("Could not establish connection");
    return { ok: true };
  });
  await r.handle("frameOpen", { interactionId: "i1", spaceId: "s_1" }, CHILD);
  fail = true;
  expect(await r.handle("frameCall", { documentId: "DOC-CHILD", call: { op: "x" } }, TOP)).toEqual({
    ok: false,
    error: "no-frame",
  });
  expect(registry()["7"]).toEqual({});
});

test("a closed tab's frames are forgotten", async () => {
  const { r, registry } = relay();
  await r.handle("frameGone", {}, CHILD);
  await r.handle("frameReport", { interactions: [], generation: 1 }, CHILD);
  expect(Object.keys(registry())).toEqual(["7"]);
  await r.tabClosed(7);
  expect(registry()).toEqual({});
});

test("a child's chord is relayed by name only", async () => {
  const { r, sent } = relay();
  expect(await r.handle("frameCommand", { command: "comment; evil()" }, CHILD)).toEqual({
    ok: false,
    error: "invalid",
  });
  expect(await r.handle("frameCommand", { command: "commandBar" }, CHILD)).toEqual({ ok: true });
  expect(sent[sent.length - 1]?.msg).toMatchObject({
    type: "frame-command",
    command: "commandBar",
  });
});

/* ── 2-F4: only a web page owns blocks ── */

test("a blank, srcdoc, data: or opaque-origin frame owns no blocks: its pick and create go nowhere", async () => {
  for (const url of ["about:blank", "about:srcdoc", "data:text/html,x", "blob:https://x/1"]) {
    const { r, sent } = relay();
    const blank = { ...CHILD, url };
    expect(
      await r.handle("framePicked", { pickId: "p1", kind: "comment", anchor: ANCHOR }, blank),
    ).toEqual({ ok: false, error: "sender" });
    expect(sent).toEqual([]);
    expect(frameMayCreate(blank)).toBe(false);
  }
  const opaque = { ...CHILD, origin: "null" };
  // 3-F4: a missing origin, or one another than the URL names, owns nothing either.
  const { origin: _o, ...noOrigin } = CHILD;
  expect(frameMayCreate(noOrigin)).toBe(false);
  expect(frameMayCreate({ ...CHILD, origin: "https://other.example" })).toBe(false);
  expect(
    await relay().r.handle(
      "framePicked",
      { pickId: "p1", kind: "comment", anchor: ANCHOR },
      noOrigin,
    ),
  ).toEqual({ ok: false, error: "sender" });
  expect(frameMayCreate(opaque)).toBe(false);
  const { r } = relay();
  expect(
    await r.handle("framePicked", { pickId: "p1", kind: "comment", anchor: ANCHOR }, opaque),
  ).toEqual({ ok: false, error: "sender" });
  expect(frameMayCreate(CHILD)).toBe(true);
  expect(frameMayCreate({ ...TOP, url: "about:blank" })).toBe(true); // the top frame's own rules apply
});

test("a frame onlay can't anchor in tells the top frame's hint line the pick's id, and nothing else (A-3)", async () => {
  const { r, sent, registry } = relay();
  const opaque = { ...CHILD, url: "about:srcdoc", origin: "null" };
  expect(
    await r.handle("framePickHint", { pickId: "p1", text: "Click here", frame: {} }, opaque),
  ).toEqual({ ok: true });
  expect(sent).toEqual([
    { tabId: 7, to: { frameId: 0 }, msg: { type: "pick-hint", pickId: "p1" } },
  ]);
  // Not remembered as a document that owns blocks: the top frame cannot call it.
  expect(registry()).toEqual({});
  sent.length = 0;
  expect(await r.handle("framePickHint", { pickId: "p1" }, TOP)).toEqual({
    ok: false,
    error: "sender",
  });
  expect(await r.handle("framePickHint", { pickId: "x y" }, opaque)).toEqual({
    ok: false,
    error: "invalid",
  });
  expect(
    await r.handle("framePickHint", { pickId: "p1" }, { ...opaque, documentLifecycle: "cached" }),
  ).toEqual({ ok: false, error: "sender" });
  expect(sent).toEqual([]);
});

test("a picked anchor inside a frame of the child's page keeps its frame path (A-3)", async () => {
  const { r, sent } = relay();
  const anchor = { ...ANCHOR, framePath: ["iframe#blank"] };
  expect(await r.handle("framePicked", { pickId: "p1", kind: "comment", anchor }, CHILD)).toEqual({
    ok: true,
  });
  expect(sent[0]?.msg.anchor).toEqual(anchor);
  expect(
    await r.handle(
      "framePicked",
      {
        pickId: "p2",
        kind: "comment",
        anchor: { ...ANCHOR, framePath: ["a", "b", "c", "d", "e"] },
      },
      CHILD,
    ),
  ).toEqual({ ok: false, error: "invalid" });
});

/* ── 2-F5: reports from another account, and documents that went away ── */

test("a report made under another account generation is not relayed", async () => {
  const { r, sent } = relay(undefined, 5);
  expect(await r.handle("frameReport", { interactions: [], generation: 4 }, CHILD)).toEqual({
    ok: false,
    error: "invalid",
  });
  expect(await r.handle("frameReport", { interactions: [] }, CHILD)).toEqual({
    ok: false,
    error: "invalid",
  });
  expect(sent).toEqual([]);
  expect(await r.handle("frameReport", { interactions: [], generation: 5 }, CHILD)).toEqual({
    ok: true,
  });
  expect(sent[0]?.msg).toMatchObject({ type: "frame-report", generation: 5 });
});

test("a document that navigated or was removed is forgotten and the top frame told", async () => {
  const gone = new Set<string>();
  const { r, sent, registry } = relay((s) => {
    if (s.to?.documentId && gone.has(s.to.documentId)) throw new Error("no receiving end");
    return { ok: true };
  });
  const OTHER = { ...CHILD, documentId: "DOC-OLD", frameId: 6 };
  await r.handle("frameOpen", { interactionId: "i1", spaceId: "s_1" }, OTHER);
  gone.add("DOC-OLD");
  await r.handle("frameReport", { interactions: [], generation: 1 }, CHILD);
  await new Promise((res) => setTimeout(res, 0));
  expect(registry()["7"]?.["DOC-OLD"]).toBeUndefined();
  expect(sent.some((m) => m.msg.type === "frame-gone" && m.to?.frameId === 0)).toBe(true);
  // The top page navigating forgets all of the tab's documents.
  await r.tabNavigated(7);
  expect(registry()["7"]).toBeUndefined();
});

/* ── 3-F3: the pick's account generation is checked right before sending ── */

test("a frame create made under another account generation than the one held now is refused", () => {
  expect(frameCreateRefusal(CHILD, 4, 4)).toBeNull();
  expect(frameCreateRefusal(CHILD, 3, 4)).toBe("page-changed");
  expect(frameCreateRefusal(CHILD, undefined, 4)).toBe("page-changed");
  expect(frameCreateRefusal({ ...CHILD, url: "about:blank" }, 4, 4)).toBe("not-a-page");
  // The top frame's own creates are not picks of a child frame.
  expect(frameCreateRefusal(TOP, undefined, 4)).toBeNull();
});

test("a report's access revisions reach the top frame, and only well-formed ones (3-F5)", async () => {
  const { r, sent } = relay();
  await r.handle(
    "frameReport",
    {
      interactions: [],
      generation: 1,
      revs: { s_aaaaaaaaaaaaaaaaaaaa: 3, "bad key!": 1, s_b: "x" },
    },
    CHILD,
  );
  expect(sent[0]?.msg).toMatchObject({ type: "frame-report", revs: { s_aaaaaaaaaaaaaaaaaaaa: 3 } });
  expect(Object.keys(sent[0]?.msg.revs as object)).toEqual(["s_aaaaaaaaaaaaaaaaaaaa"]);
});

test("a report carries the frame's sets, kept edits and tray edits, bounded (E-1 … E-3)", async () => {
  const { r, sent } = relay();
  const sets = [{ setId: "set-1" }];
  const kept = { rows: [{ interactionId: "k" }], shown: 1 };
  const ops = [{ op: "setText", detail: "Hi" }];
  await r.handle(
    "frameReport",
    { interactions: [], generation: 1, sets, kept, ops, label: "Indicative preview — Calm" },
    CHILD,
  );
  expect(sent[0]?.msg).toMatchObject({
    type: "frame-report",
    sets,
    kept,
    ops,
  });
  // A preview pill's text is never relayed: the top frame derives it (2-E3).
  expect(sent[0]?.msg.label).toBeUndefined();
  // Over the bounds: left out, the rest of the report still goes.
  sent.length = 0;
  await r.handle(
    "frameReport",
    {
      interactions: [],
      generation: 1,
      sets: Array.from({ length: 13 }, (_, i) => ({ setId: `s${i}` })),
      kept: { rows: Array.from({ length: 65 }, () => ({})) },
    },
    CHILD,
  );
  const msg = sent.find((s) => s.msg.type === "frame-report")?.msg ?? {};
  expect(msg.sets).toBeUndefined();
  expect(msg.kept).toBeUndefined();
});

test("Edit page mode is started by the top frame in every frame of its tab (E-3)", async () => {
  const { r, sent } = relay();
  expect(await r.handle("framePickAll", { pickId: "b1", kind: "batch" }, TOP)).toEqual({
    ok: true,
  });
  expect(sent).toEqual([{ tabId: 7, msg: { type: "pick-start", pickId: "b1", kind: "batch" } }]);
  expect(await r.handle("framePickAll", { pickId: "b2", kind: "batch" }, CHILD)).toEqual({
    ok: false,
    error: "sender",
  });
});

test("a page sync from a child frame needs an address of its own, and its own origin (2-A3)", () => {
  // biome-ignore lint/suspicious/noExplicitAny: a sender shaped as the browser reports it
  const at = (s: any, url: unknown) => frameMaySync(s, url);
  const page = "https://tree.content.example/page?x=1";
  expect(at(CHILD, page)).toBe(true);
  // Opaque (a sandbox without allow-same-origin), missing or another origin: no sync.
  expect(at({ ...CHILD, origin: "null" }, page)).toBe(false);
  const { origin: _o, ...noOrigin } = CHILD;
  expect(at(noOrigin, page)).toBe(false);
  expect(at({ ...CHILD, origin: "https://other.example" }, page)).toBe(false);
  // An addressless document, whatever page URL it names.
  expect(at({ ...CHILD, url: "about:srcdoc" }, page)).toBe(false);
  // A page of another origin than the frame's own.
  expect(at(CHILD, "https://dossier.example/goals/ceo/")).toBe(false);
  expect(at(CHILD, "not a url")).toBe(false);
  expect(at(CHILD, undefined)).toBe(false);
  // The top frame syncs its own address as before.
  expect(at(TOP, "https://dossier.example/goals/ceo/")).toBe(true);
});

test("a report carries the page the frame says it is on now, bounded (3-A1)", async () => {
  const { r, sent } = relay();
  const page = "https://tree.content.example/page?route=2";
  await r.handle("frameReport", { interactions: [], generation: 1, page }, CHILD);
  expect(sent[0]?.msg).toMatchObject({ type: "frame-report", page });
  sent.length = 0;
  await r.handle(
    "frameReport",
    { interactions: [], generation: 1, page: "x".repeat(3_000) },
    CHILD,
  );
  expect(sent[0]?.msg.type).toBe("frame-report");
  expect("page" in (sent[0]?.msg ?? {})).toBe(false);
});
