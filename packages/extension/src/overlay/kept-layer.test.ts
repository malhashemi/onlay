// The kept layer (spec §8): kept programs in `at` order, default shown for
// the person who kept them, the viewer's choice persisted, suspended around
// captures, retired with the Edit, and stacked under variant previews.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { KeptEdit, MutationProgram } from "@onlay/protocol";
import { createPreviewEngine } from "@onlay/render";
import { Window } from "happy-dom";
import { createKeptLayer, type KeptLayer, type ShownStore } from "./kept-layer";

let win: Window | null = null;

function installDom(html: string): void {
  win = new Window({ url: "https://acme.test/page" });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = win;
  g.document = win.document;
  for (const k of [
    "Document",
    "DOMParser",
    "DocumentFragment",
    "Element",
    "HTMLElement",
    "MutationObserver",
    "Node",
    "Text",
  ])
    g[k] = (win as unknown as Record<string, unknown>)[k];
  win.document.body.innerHTML = html;
}

beforeEach(() => installDom(`<h1 id="t">Original</h1><p class="copy">Body</p>`));
afterEach(() => {
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const ME = "p_me";
const OTHER = "p_other";
const SPACE = "s_aaaaaaaaaaaaaaaaaaaa";

function kept(id: string, over: Partial<KeptEdit> = {}): KeptEdit {
  return {
    interactionId: id,
    root: { kind: "page" },
    program: [{ op: "setText", target: "#t", text: id }],
    by: ME,
    at: 1,
    label: `label ${id}`,
    ...over,
  };
}

const PAGE = "https://acme.test/page";
const SCOPE = "p_me|https://app.onlay.dev";
const HERE = { url: PAGE, spaceId: SPACE };

const IDS = {
  a: "11111111-1111-4111-8111-111111111111",
  b: "22222222-2222-4222-8222-222222222222",
  c: "33333333-3333-4333-8333-333333333333",
};

function memoryStore(initial: Record<string, boolean> = {}) {
  const saved: Array<Record<string, boolean>> = [];
  const store: ShownStore = {
    load: async () => ({ ...initial }),
    save: (c) => void saved.push({ ...c }),
  };
  return { store, saved };
}

async function layer(
  opts: {
    store?: ShownStore;
    states?: Record<string, string>;
    urls?: Record<string, string>;
    page?: { url: string };
  } = {},
): Promise<{ layer: KeptLayer; changes: () => number; states: Record<string, string> }> {
  let changes = 0;
  const states = opts.states ?? {};
  const page = opts.page ?? { url: PAGE };
  const l = createKeptLayer({
    createEngine: (onEnded) => createPreviewEngine(document, onEnded ? { onEnded } : {}),
    selfId: () => ME,
    scope: () => SCOPE,
    pageUrl: () => page.url,
    urlOf: (id) => opts.urls?.[id] ?? PAGE,
    stateOf: (id) => states[id],
    store: opts.store ?? memoryStore().store,
    onChange: () => {
      changes += 1;
    },
    setTimer: () => 0,
  });
  await tick();
  return { layer: l, changes: () => changes, states };
}

const text = () => document.getElementById("t")?.textContent;

describe("kept layer", () => {
  test("applies kept programs in `at` order, whatever order they arrive in", async () => {
    const { layer: l } = await layer();
    l.setKept(SPACE, [kept(IDS.b, { at: 20 }), kept(IDS.a, { at: 10 })]);
    expect(text()).toBe(IDS.b); // the later keep lands last
    expect(l.rows().map((r) => r.interactionId)).toEqual([IDS.a, IDS.b]);
    expect(l.shownCount()).toBe(2);
  });

  test("shown by default for the person who kept it, hidden for everyone else", async () => {
    const { layer: l } = await layer();
    l.setKept(SPACE, [kept(IDS.a, { by: OTHER })]);
    expect(text()).toBe("Original");
    expect(l.isOn(IDS.a)).toBe(false);
    l.setKept(SPACE, [kept(IDS.a, { by: ME })]);
    expect(text()).toBe(IDS.a);
  });

  test("the viewer's switch persists and survives a reload", async () => {
    const mem = memoryStore();
    const { layer: l } = await layer({ store: mem.store });
    l.setKept(SPACE, [kept(IDS.a, { by: OTHER })]);
    l.setOn(IDS.a, true);
    expect(text()).toBe(IDS.a);
    expect(mem.saved.at(-1)).toEqual({ [`${SCOPE}|${SPACE}|${IDS.a}|b:1`]: true });
    l.setOn(IDS.a, false);
    expect(text()).toBe("Original");

    // A fresh page load reads the stored choice before showing anything.
    installDom(`<h1 id="t">Original</h1>`);
    const reload = await layer({
      store: memoryStore({ [`${SCOPE}|${SPACE}|${IDS.a}|b:1`]: true }).store,
    });
    reload.layer.setKept(SPACE, [kept(IDS.a, { by: OTHER })]);
    expect(text()).toBe(IDS.a);
    const hidden = await layer({
      store: memoryStore({ [`${SCOPE}|${SPACE}|${IDS.b}|b:99`]: false }).store,
    });
    hidden.layer.setKept(SPACE, [kept(IDS.b, { by: ME, at: 99 })]);
    expect(text()).toBe(IDS.a); // my own keep, switched off: not shown
  });

  test("suspend takes the whole layer off for a capture; resume puts it back", async () => {
    const { layer: l } = await layer();
    l.setKept(SPACE, [kept(IDS.a)]);
    l.showPreview("set-1", ".copy", [{ op: "setText", target: ":scope", text: "Variant" }], HERE);
    l.suspend();
    expect(text()).toBe("Original");
    expect(document.querySelector(".copy")?.textContent).toBe("Body");
    // The witness pass applies alone while suspended.
    const r = l.passEngine.apply([{ op: "setText", target: ":scope", text: "Look" }], ".copy");
    expect(r.ok).toBe(true);
    expect(text()).toBe("Original");
    expect(document.querySelector(".copy")?.textContent).toBe("Look");
    l.passEngine.restore();
    l.resume();
    expect(text()).toBe(IDS.a);
    expect(document.querySelector(".copy")?.textContent).toBe("Variant");
  });

  test("a look's program never goes on another page: a route change mid-look takes it off for good (2-E1)", async () => {
    const page = { url: PAGE };
    const { layer: l } = await layer({ page });
    l.suspend();
    const r = l.passEngine.apply([{ op: "setText", target: ":scope", text: "Look" }], ".copy");
    expect(r.ok).toBe(true);
    expect(document.querySelector(".copy")?.textContent).toBe("Look");
    // The app moves to another route; before the route check runs, something recomputes.
    page.url = `${PAGE}?route=2`;
    l.resume();
    l.suspend();
    expect(document.querySelector(".copy")?.textContent).toBe("Body");
    expect(l.passEngine.applied(r.ok ? r.token : 0)).toBe(false);
    // The route check: the look is gone, and coming back does not bring it back.
    l.pageChanged();
    page.url = PAGE;
    l.pageChanged();
    expect(document.querySelector(".copy")?.textContent).toBe("Body");
    expect(l.passEngine.active).toBe(false);
  });

  test("a route change takes off the previews of the old page before anything else runs (2-E1)", async () => {
    const page = { url: PAGE };
    const { layer: l } = await layer({ page });
    l.showPreview("set-1", ".copy", [{ op: "setText", target: ":scope", text: "Variant" }], HERE);
    expect(document.querySelector(".copy")?.textContent).toBe("Variant");
    page.url = `${PAGE}?route=2`;
    l.pageChanged();
    expect(document.querySelector(".copy")?.textContent).toBe("Body");
    // Back on the old route the preview stays gone: its set is told it was displaced.
    page.url = PAGE;
    l.pageChanged();
    expect(document.querySelector(".copy")?.textContent).toBe("Body");
  });

  test("an Edit that reaches implemented, resolved or dropped comes off the page", async () => {
    const { layer: l, states } = await layer();
    states[IDS.a] = "kept";
    l.setKept(SPACE, [kept(IDS.a)]);
    expect(text()).toBe(IDS.a);
    states[IDS.a] = "implemented";
    l.setKept(SPACE, [kept(IDS.a)]); // even a stale entry is not shown
    expect(text()).toBe("Original");
    expect(l.rows()).toEqual([]);
    states[IDS.a] = "kept";
    l.setKept(SPACE, [kept(IDS.a)]);
    l.setKept(SPACE, []); // the server stopped listing it
    expect(text()).toBe("Original");
  });

  test("a preview on the same root wins while it is shown", async () => {
    const { layer: l } = await layer();
    l.setKept(SPACE, [kept(IDS.a, { root: { kind: "page" } })]);
    l.showPreview(
      "set-1",
      { kind: "page" },
      [{ op: "setClass", target: ".copy", add: ["v"], remove: [] }],
      HERE,
    );
    expect(text()).toBe("Original");
    expect(document.querySelector(".copy")?.className).toBe("copy v");
    l.clearPreview("set-1");
    expect(text()).toBe(IDS.a);
  });

  test("a preview on another root stacks above the kept layer and comes off cleanly", async () => {
    const { layer: l } = await layer();
    l.setKept(SPACE, [kept(IDS.a)]);
    l.showPreview("set-1", ".copy", [{ op: "setText", target: ":scope", text: "V" }], HERE);
    expect(text()).toBe(IDS.a);
    expect(document.querySelector(".copy")?.textContent).toBe("V");
    l.clearPreview("set-1");
    expect(document.querySelector(".copy")?.textContent).toBe("Body");
  });

  test("one set per root: showing another set's preview displaces the first", async () => {
    const displaced: string[] = [];
    const l = createKeptLayer({
      createEngine: () => createPreviewEngine(document),
      selfId: () => ME,
      scope: () => SCOPE,
      pageUrl: () => PAGE,
      urlOf: () => PAGE,
      stateOf: () => undefined,
      store: memoryStore().store,
      onChange: () => {},
      onDisplaced: (id) => displaced.push(id),
    });
    const prog = (t: string): MutationProgram => [{ op: "setText", target: ":scope", text: t }];
    l.showPreview("set-1", ".copy", prog("one"), HERE);
    l.showPreview("set-2", "#t", prog("two"), HERE);
    expect(displaced).toEqual([]);
    l.showPreview("set-3", ".copy", prog("three"), HERE);
    expect(displaced).toEqual(["set-1"]);
    expect(document.querySelector(".copy")?.textContent).toBe("three");
    expect(text()).toBe("two");
  });

  test("a kept program that no longer resolves is reported, never thrown", async () => {
    const { layer: l } = await layer();
    l.setKept(SPACE, [
      kept(IDS.a, {
        root: {
          kind: "block",
          element: { selector: "#missing", tag: "div", classes: [], textSnippet: "", markup: "" },
        },
      }),
      kept(IDS.b, { at: 2 }),
    ]);
    expect(l.isUnresolved(IDS.a)).toBe(true);
    expect(l.rows().find((r) => r.interactionId === IDS.a)?.unresolved).toBe(true);
    expect(text()).toBe(IDS.b);
    expect(l.shownCount()).toBe(1);
  });

  test("a picked preview stays on until its kept entry takes over", async () => {
    const { layer: l } = await layer();
    const program: MutationProgram = [{ op: "setText", target: "#t", text: "Picked" }];
    l.showPreview("set-1", { kind: "page" }, program, HERE);
    l.handOff("set-1", IDS.c);
    expect(text()).toBe("Picked");
    l.setKept(SPACE, [kept(IDS.c, { program, setId: "set-1" })]);
    expect(text()).toBe("Picked");
    expect(l.shownCount()).toBe(1); // now the kept layer shows it
    l.setOn(IDS.c, false);
    expect(text()).toBe("Original");
  });

  test("lifted takes everything off around raw page edits", async () => {
    const { layer: l } = await layer();
    l.setKept(SPACE, [kept(IDS.a)]);
    let seen = "";
    l.lifted(() => {
      seen = text() ?? "";
    });
    expect(seen).toBe("Original");
    expect(text()).toBe(IDS.a);
  });
});

describe("hand edits hand over", () => {
  test("whenKept runs with the layer off once the Edit is kept", async () => {
    const { layer: l } = await layer();
    // A raw tray edit, as the batch tray applies it.
    const t = document.getElementById("t") as HTMLElement;
    t.textContent = "Tray";
    let seenDuring = "";
    l.whenKept(IDS.a, () => {
      seenDuring = t.textContent ?? "";
      t.textContent = "Original"; // the tray unwinds
    });
    expect(t.textContent).toBe("Tray");
    l.setKept(SPACE, [kept(IDS.a, { program: [{ op: "setText", target: "#t", text: "Tray" }] })]);
    expect(seenDuring).toBe("Tray");
    expect(t.textContent).toBe("Tray"); // now through the kept layer
    l.setOn(IDS.a, false);
    expect(t.textContent).toBe("Original");
  });
});

describe("removing a slot unwinds the whole stack first", () => {
  test("removing the earlier of two edits on the same property leaves the later one, then nothing", async () => {
    const { layer: l } = await layer();
    const color = (v: string): MutationProgram => [
      { op: "setStyle", target: "#t", props: [{ prop: "color", value: v }] },
    ];
    const t = () => (document.getElementById("t") as HTMLElement).style.getPropertyValue("color");
    l.setKept(SPACE, [
      kept(IDS.a, { at: 1, program: color("red") }),
      kept(IDS.b, { at: 2, program: color("blue") }),
    ]);
    expect(t()).toBe("blue");
    l.setKept(SPACE, [kept(IDS.b, { at: 2, program: color("blue") })]);
    expect(t()).toBe("blue");
    expect(l.shownCount()).toBe(1);
    l.setKept(SPACE, []);
    expect(t()).toBe("");
    expect(l.shownCount()).toBe(0);
  });

  test("replacing the earlier edit's program re-applies both in order", async () => {
    const { layer: l } = await layer();
    const text2 = (v: string): MutationProgram => [{ op: "setText", target: "#t", text: v }];
    l.setKept(SPACE, [
      kept(IDS.a, { at: 1, program: text2("A") }),
      kept(IDS.b, { at: 2, program: text2("B") }),
    ]);
    l.setKept(SPACE, [
      kept(IDS.a, { at: 1, program: text2("A2") }),
      kept(IDS.b, { at: 2, program: text2("B") }),
    ]);
    expect(text()).toBe("B");
    l.setKept(SPACE, [kept(IDS.a, { at: 1, program: text2("A2") })]);
    expect(text()).toBe("A2");
    l.setKept(SPACE, []);
    expect(text()).toBe("Original");
  });

  test("clearing a preview under a stacked kept edit on the same block restores exactly", async () => {
    const { layer: l } = await layer();
    const color = (v: string): MutationProgram => [
      { op: "setStyle", target: ":scope", props: [{ prop: "color", value: v }] },
    ];
    l.showPreview("set-1", ".copy", color("green"), HERE);
    l.setKept(SPACE, [
      kept(IDS.a, {
        at: 1,
        program: [{ op: "setStyle", target: ".copy", props: [{ prop: "color", value: "red" }] }],
      }),
    ]);
    l.clearPreview("set-1");
    const c = (document.querySelector(".copy") as HTMLElement).style.getPropertyValue("color");
    expect(c).toBe("red");
  });
});

describe("one person, one server, one page", () => {
  test("a choice made by one person does not follow the next person on the profile", async () => {
    const mem = memoryStore();
    const scope = { v: "p_a|https://app.onlay.dev" as string | null };
    const l = createKeptLayer({
      createEngine: () => createPreviewEngine(document),
      selfId: () => "p_x",
      scope: () => scope.v,
      pageUrl: () => PAGE,
      urlOf: () => PAGE,
      stateOf: () => undefined,
      store: mem.store,
      onChange: () => {},
      setTimer: () => 0,
    });
    await tick();
    l.setKept(SPACE, [kept(IDS.a, { by: OTHER })]);
    l.setOn(IDS.a, true);
    expect(text()).toBe(IDS.a);
    scope.v = "p_b|https://app.onlay.dev";
    expect(l.setScope(scope.v)).toBe(true);
    expect(text()).toBe("Original"); // everything came off with the account change
    l.setKept(SPACE, [kept(IDS.a, { by: OTHER })]);
    expect(l.isOn(IDS.a)).toBe(false);
    expect(text()).toBe("Original");
  });

  test("signing out takes previews and kept programs off and forgets them", async () => {
    const displaced: string[] = [];
    const l = createKeptLayer({
      createEngine: () => createPreviewEngine(document),
      selfId: () => ME,
      scope: () => SCOPE,
      pageUrl: () => PAGE,
      urlOf: () => PAGE,
      stateOf: () => undefined,
      store: memoryStore().store,
      onChange: () => {},
      onDisplaced: (id) => displaced.push(id),
      setTimer: () => 0,
    });
    await tick();
    l.setKept(SPACE, [kept(IDS.a)]);
    l.showPreview("set-1", ".copy", [{ op: "setText", target: ":scope", text: "V" }], HERE);
    l.setScope(null);
    expect(text()).toBe("Original");
    expect(document.querySelector(".copy")?.textContent).toBe("Body");
    expect(l.rows()).toEqual([]);
    expect(displaced).toEqual(["set-1"]);
  });

  test("losing a space takes that space's previews off too", async () => {
    const { layer: l } = await layer();
    l.showPreview("set-1", ".copy", [{ op: "setText", target: ":scope", text: "V" }], HERE);
    l.keepSpaces(["s_bbbbbbbbbbbbbbbbbbbb"]);
    expect(document.querySelector(".copy")?.textContent).toBe("Body");
  });

  test("a kept Edit applies only on its exact page: no prefix, and the fragment counts", async () => {
    const page = { url: `${PAGE}/details` };
    const { layer: l } = await layer({ page });
    l.setKept(SPACE, [kept(IDS.a)]);
    expect(text()).toBe("Original");
    page.url = PAGE;
    l.pageChanged();
    expect(text()).toBe(IDS.a);
    // A hash-routed app's other record is another page.
    page.url = `${PAGE}#section`;
    l.pageChanged();
    expect(text()).toBe("Original");
    page.url = `${PAGE}?tab=2`;
    l.pageChanged();
    expect(text()).toBe("Original");
  });

  test("a preview for another page's Edit is refused and stays off", async () => {
    const { layer: l } = await layer();
    const r = l.showPreview("set-1", ".copy", [{ op: "setText", target: ":scope", text: "V" }], {
      url: `${PAGE}0`,
      spaceId: SPACE,
    });
    expect(r).toEqual({ ok: false, reason: "other-page" });
    expect(document.querySelector(".copy")?.textContent).toBe("Body");
  });
});

describe("a switch belongs to what the viewer approved", () => {
  test("a revised pick no longer carries the viewer's switch; the default applies again", async () => {
    const { layer: l } = await layer();
    const picked = (version: number, text: string) =>
      kept(IDS.a, {
        by: OTHER,
        setId: "set-1",
        variantId: "v1",
        version,
        program: [{ op: "setText", target: "#t", text }],
      });
    l.setKept(SPACE, [picked(1, "Approved")]);
    l.setOn(IDS.a, true);
    expect(text()).toBe("Approved");
    // An agent revises the picked variant in place: same variant, new version.
    l.setKept(SPACE, [picked(2, "Swapped")]);
    expect(l.isOn(IDS.a)).toBe(false);
    expect(text()).toBe("Original");
  });

  test("without a named revision, a changed program is a different approval", async () => {
    const { layer: l } = await layer();
    const entry = (t: string) =>
      kept(IDS.a, {
        by: OTHER,
        setId: "set-1",
        program: [{ op: "setText", target: "#t", text: t }],
      });
    l.setKept(SPACE, [entry("Approved")]);
    l.setOn(IDS.a, true);
    l.setKept(SPACE, [entry("Approved")]);
    expect(text()).toBe("Approved");
    l.setKept(SPACE, [entry("Swapped")]);
    expect(text()).toBe("Original");
  });

  test("the person who kept it still sees a revision by default", async () => {
    const { layer: l } = await layer();
    l.setKept(SPACE, [kept(IDS.a, { by: ME, setId: "s", variantId: "v", version: 2 })]);
    expect(l.isOn(IDS.a)).toBe(true);
  });
});

describe("a partly refused program is never shown as if it applied (R2-C7)", () => {
  test("nothing applied: not shown, and it says it can't be shown here", async () => {
    const { layer: l } = await layer();
    l.setKept(SPACE, [
      kept(IDS.a, {
        program: [{ op: "setStyle", target: "#t", props: [{ prop: "--x", value: "1" }] }],
      }),
    ]);
    expect(l.shownCount()).toBe(0);
    expect(l.rows()[0]).toMatchObject({ unresolved: true, refused: 0 });
  });

  test("some refused: shown, with the count on its row", async () => {
    const { layer: l } = await layer();
    l.setKept(SPACE, [
      kept(IDS.a, {
        program: [
          { op: "setText", target: "#t", text: "Applied" },
          { op: "setStyle", target: "#t", props: [{ prop: "--x", value: "1" }] },
        ],
      }),
    ]);
    expect(text()).toBe("Applied");
    expect(l.shownCount()).toBe(1);
    expect(l.rows()[0]).toMatchObject({ unresolved: false, refused: 1 });
  });
});

describe("a re-render that changes which steps land ends a kept edit (review)", () => {
  test("it comes off whole, counts as not shown, and stays off until its switch", async () => {
    const { layer: l, changes } = await layer();
    const entry = kept(IDS.a, {
      program: [
        { op: "setText", target: "#t", text: "Kept" },
        { op: "setStyle", target: ".copy", props: [{ prop: "color", value: "red" }] },
      ],
    });
    l.setKept(SPACE, [entry]);
    expect(text()).toBe("Kept");
    expect(l.shownCount()).toBe(1);
    const before = changes();
    // The page re-renders without one of its targets, and the engines' observer
    // runs its pass (driven here: happy-dom holds that observer's callback only
    // through a WeakRef, and a garbage collection silently stops its records).
    document.querySelector(".copy")?.remove();
    l.passEngine.reapply();
    expect(text()).toBe("Original");
    expect(l.shownCount()).toBe(0);
    expect(l.rows()[0]).toMatchObject({ on: true, unresolved: true });
    expect(changes()).toBeGreaterThan(before);
    // The layer recomputing for anything else leaves it off.
    l.setKept(SPACE, [entry]);
    expect(text()).toBe("Original");
    // The viewer's switch puts it back, over the page as it is now.
    l.setOn(IDS.a, false);
    l.setOn(IDS.a, true);
    expect(text()).toBe("Kept");
    expect(l.rows()[0]).toMatchObject({ unresolved: false, refused: 1 });
  });
});

describe("a preview that ends gives its root back (review)", () => {
  test("a kept edit the preview held off on the same root comes back at once", async () => {
    const { layer: l } = await layer();
    l.setKept(SPACE, [kept(IDS.a, { program: [{ op: "setText", target: "#t", text: "Kept" }] })]);
    expect(text()).toBe("Kept");
    l.showPreview(
      "set-1",
      { kind: "page" },
      [{ op: "setText", target: ".copy", text: "Variant" }],
      HERE,
    );
    // The preview wins its root while shown.
    expect(text()).toBe("Original");
    // The page re-renders without the preview's target: the preview ends.
    document.querySelector(".copy")?.remove();
    l.passEngine.reapply();
    expect(text()).toBe("Kept");
    expect(l.shownCount()).toBe(1);
  });
});
