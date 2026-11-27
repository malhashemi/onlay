/// <reference types="chrome" />
// Several variant sets per page (spec §8): each docked in its own Edit's
// sidecar, every frame carrying its set's space, one preview per root, the
// per-page bookmark as `{setId, spaceId}` entries, guests without discard or
// steer, and page roots that upload the page once the Edit lands.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SpaceSummary } from "@onlay/protocol";
import { createPreviewEngine } from "@onlay/render";
import { Window } from "happy-dom";
import { type AppInternals, createApp } from "./app";
import { noteLookOmission } from "./capture/variant-pass";
import { createKeptLayer } from "./kept-layer";
import {
  createVariantController,
  readBookmarks,
  type SetBookmark,
  updateBookmarks,
  type VariantStateMessage,
} from "./variants";

const SPACE = "s_aaaaaaaaaaaaaaaaaaaa";
const GUEST_SPACE = "s_bbbbbbbbbbbbbbbbbbbb";
const URL = "https://acme.test/page";

let win: Window | null = null;
let sent: Array<Record<string, unknown>> = [];

function installDom(): void {
  win = new Window({ url: URL });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = win;
  g.document = win.document;
  for (const k of [
    "Document",
    "DOMParser",
    "DocumentFragment",
    "Element",
    "HTMLElement",
    "HTMLTextAreaElement",
    "HTMLInputElement",
    "MutationObserver",
    "Node",
    "Text",
    "Event",
    "KeyboardEvent",
    "localStorage",
  ])
    g[k] = (win as unknown as Record<string, unknown>)[k];
  g.crypto = win.crypto ?? globalThis.crypto;
  g.location = win.location;
  sent = [];
  g.chrome = {
    runtime: {
      sendMessage: (m: Record<string, unknown>) => {
        sent.push(m);
        return Promise.resolve({ ok: true });
      },
    },
  };
  win.document.body.innerHTML = `<h1 id="hero">Hello</h1><p id="copy">Body</p>`;
  // A latch the old build left in the page's own storage (cleaned up on load).
  win.localStorage.setItem("onlayEditCap:legacy-edit", "1");
}

beforeEach(installDom);
afterEach(() => {
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
  delete (globalThis as unknown as Record<string, unknown>).chrome;
});

const flush = () => new Promise((r) => setTimeout(r, 0));

const spaces: SpaceSummary[] = [
  { id: SPACE, kind: "workspace", name: "acme", role: "member" },
  { id: GUEST_SPACE, kind: "workspace", name: "other", role: "guest" },
] as SpaceSummary[];

function setup() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const app = createApp({ shadow, host, isTopFrame: true, toast: () => {} }) as ReturnType<
    typeof createApp
  > &
    AppInternals;
  app._setSelf({ id: "p_me", name: "Me", tint: "#333", initials: "ME" });
  app._setSpaces(spaces, SPACE);
  // The Edits these sets belong to live on this page.
  seedEdits(app, SPACE, ["A", "B", "P"]);
  seedEdits(app, GUEST_SPACE, ["G"]);
  const layer = createKeptLayer({
    createEngine: () => createPreviewEngine(document),
    selfId: () => "p_me",
    scope: () => SCOPE,
    pageUrl: () => location.href,
    urlOf: (id) => app.byId(id)?.url,
    stateOf: () => undefined,
    store: { load: async () => ({}), save: () => {} },
    onChange: () => {},
    onDisplaced: (id) => controller.displaced(id),
  });
  let stored: Record<string, SetBookmark[]> = {};
  const cleared: string[] = [];
  const opened: string[] = [];
  const uploads: Array<{ spaceId: string; id: string; truncated: boolean; content: string }> = [];
  const controller = createVariantController(app, {
    layer,
    openChangeJob: (id) => opened.push(id),
    scope: () => SCOPE,
    captureLatch: LATCH,
    bookmarks: {
      load: async () => stored,
      save: async (_scope, m) => {
        stored = m;
      },
      clear: async (scope) => {
        cleared.push(scope);
        stored = {};
      },
    },
    uploadPageContent: async (spaceId, id, content, truncated) => {
      uploads.push({ spaceId, id, content, truncated });
      return true;
    },
  });
  return { app, layer, controller, opened, uploads, bookmarks: () => stored, cleared, shadow };
}

const SCOPE = "p_me|https://app.onlay.dev";

/** These Edits already captured their context (scoped per person, server, space). */
const LATCH = {
  load: async () => ({
    [`${SCOPE}|${SPACE}|A-edit`]: 1,
    [`${SCOPE}|${SPACE}|B-edit`]: 1,
    [`${SCOPE}|${GUEST_SPACE}|G-edit`]: 1,
  }),
  save: () => {},
};

/** Edit snapshots on this page, as `interactions-state` would carry them. */
function seedEdits(app: AppInternals, spaceId: string, sets: string[]): void {
  app._setInteractions(
    spaceId,
    sets.map(
      (id) =>
        ({
          id: `${id}-edit`,
          kind: "change",
          state: "open",
          url: URL,
          authorId: "p_me",
          anchor: { level: "page" },
          waitingOn: [],
          thread: [],
        }) as unknown as Parameters<AppInternals["_setInteractions"]>[1][number],
    ),
  );
}

function state(setId: string, over: Partial<VariantStateMessage> = {}): VariantStateMessage {
  return {
    setId,
    spaceId: SPACE,
    status: "previewing",
    selector: "#hero",
    variants: [
      {
        variantId: "v1",
        label: "Bold",
        program: [{ op: "setText", target: ":scope", text: `${setId}-1` }],
        version: 1,
      },
      {
        variantId: "v2",
        label: "Calm",
        program: [{ op: "setText", target: ":scope", text: `${setId}-2` }],
        version: 1,
      },
    ],
    changeInteractionId: `${setId}-edit`,
    ...over,
  };
}

const variantFrames = () => sent.filter((m) => String(m.type).startsWith("variant-"));

describe("several sets per page", () => {
  test("two sets on different blocks coexist, each docked in its own sidecar", () => {
    const { controller } = setup();
    const mountA = document.createElement("div");
    const mountB = document.createElement("div");
    controller.openSet("A", mountA);
    controller.openSet("B", mountB);
    controller.onVariantState(state("A"));
    controller.onVariantState(state("B", { selector: "#copy" }));
    expect(controller.setIds()).toEqual(["A", "B"]);
    expect(mountA.querySelector(".variant-panel")).not.toBeNull();
    expect(mountB.querySelector(".variant-panel")).not.toBeNull();
    expect(mountA.querySelector(".variant-panel")).not.toBe(mountB.querySelector(".variant-panel"));
    expect(document.getElementById("hero")?.textContent).toBe("A-1");
    expect(document.getElementById("copy")?.textContent).toBe("B-1");
  });

  test("opening another Edit's variants on the same block switches the preview", () => {
    const { controller } = setup();
    controller.openSet("A", document.createElement("div"));
    controller.onVariantState(state("A"));
    expect(document.getElementById("hero")?.textContent).toBe("A-1");
    controller.openSet("B", document.createElement("div"));
    controller.onVariantState(state("B"));
    expect(document.getElementById("hero")?.textContent).toBe("B-1");
  });

  test("every variant frame carries its set's space", async () => {
    const { controller, shadow } = setup();
    const mount = document.createElement("div");
    shadow.appendChild(mount);
    controller.openSet("A", mount);
    controller.onVariantState(state("A"));
    controller.sync();
    await flush();
    expect(variantFrames().length).toBeGreaterThan(0);
    for (const f of variantFrames()) expect(f.spaceId).toBe(SPACE);
  });

  test("the per-page bookmark holds {setId, spaceId} for each live set", async () => {
    const { controller, bookmarks } = setup();
    controller.openSet("A", document.createElement("div"));
    controller.onVariantState(state("A"));
    await flush();
    controller.openSet("B", document.createElement("div"));
    controller.onVariantState(state("B", { selector: "#copy" }));
    await flush();
    expect(bookmarks()[URL]).toEqual([
      { setId: "A", spaceId: SPACE },
      { setId: "B", spaceId: SPACE },
    ]);
    controller.onVariantState(state("A", { status: "resolved", outcome: "discarded" }));
    await flush();
    expect(bookmarks()[URL]).toEqual([{ setId: "B", spaceId: SPACE }]);
  });

  test("a reload re-syncs every bookmarked set in its own space", async () => {
    const fresh = setup();
    // The bookmark from a previous visit, written in the current shape.
    const map = updateBookmarks({}, URL, { setId: "A", spaceId: SPACE }, true);
    const both = updateBookmarks(map, URL, { setId: "B", spaceId: GUEST_SPACE }, true);
    sent = [];
    const c = createVariantController(fresh.app, {
      layer: fresh.layer,
      scope: () => SCOPE,
      captureLatch: LATCH,
      bookmarks: { load: async () => both, save: async () => {}, clear: async () => {} },
    });
    c.sync();
    await flush();
    const syncs = sent.filter((m) => m.type === "variant-sync");
    expect(syncs.map((m) => [m.setId, m.spaceId])).toEqual([
      ["A", SPACE],
      ["B", GUEST_SPACE],
    ]);
  });

  test("bookmarks keep only entries that name their space", () => {
    expect(
      readBookmarks({ [URL]: [{ setId: "x" }, { setId: "y", spaceId: SPACE }], old: "id" }),
    ).toEqual({ [URL]: [{ setId: "y", spaceId: SPACE }] });
  });

  test("a guest picks and comments but neither discards nor asks for more", () => {
    const { controller } = setup();
    const mount = document.createElement("div");
    controller.openSet("G", mount);
    controller.onVariantState(state("G", { spaceId: GUEST_SPACE }));
    const discard = [...mount.querySelectorAll("button")].find((b) => b.textContent === "Discard");
    const more = [...mount.querySelectorAll("button")].find((b) => b.textContent === "+");
    const pick = [...mount.querySelectorAll("button")].find((b) => b.textContent === "Pick active");
    expect(discard?.style.display).toBe("none");
    expect(more?.style.display).toBe("none");
    expect(pick?.style.display).not.toBe("none");
  });

  test("a previewed variant that applied none of its ops cannot be picked, and says why (R3-C9)", () => {
    const { controller } = setup();
    const mount = document.createElement("div");
    controller.openSet("A", mount);
    const variants: VariantStateMessage["variants"] = [
      {
        variantId: "v1",
        label: "Inert",
        // Every op refused (a custom property): nothing reaches the page.
        program: [{ op: "setStyle", target: ":scope", props: [{ prop: "--x", value: "1" }] }],
        version: 1,
      },
      {
        variantId: "v2",
        label: "Real",
        program: [{ op: "setText", target: ":scope", text: "Z-2" }],
        version: 1,
      },
    ];
    controller.onVariantState(state("A", { variants }));
    expect(document.getElementById("hero")?.textContent).toBe("Hello");
    const pick = [...mount.querySelectorAll("button")].find(
      (b) => b.textContent === "Pick active",
    ) as HTMLButtonElement;
    const note = mount.querySelector(".variant-note") as HTMLElement;
    expect(pick.disabled).toBe(true);
    expect(note.style.display).not.toBe("none");
    expect(note.textContent).toBe(
      "Nothing in this variant could be applied on this page, so it can't be picked.",
    );
    // A variant that applies can be picked, with no note.
    const other = document.createElement("div");
    const fresh = setup();
    fresh.controller.openSet("B", other);
    fresh.controller.onVariantState(state("B"));
    expect(document.getElementById("hero")?.textContent).toBe("B-1");
    const pickB = [...other.querySelectorAll("button")].find(
      (b) => b.textContent === "Pick active",
    ) as HTMLButtonElement;
    expect(pickB.disabled).toBe(false);
    expect((other.querySelector(".variant-note") as HTMLElement).style.display).toBe("none");
  });

  test("a variant the pass took no look of says why on its row (3b-C5)", () => {
    const { controller } = setup();
    const mount = document.createElement("div");
    controller.openSet("A", mount);
    controller.onVariantState(state("A"));
    const note = mount.querySelector(".variant-status + .variant-note") as HTMLElement;
    expect(note.style.display).toBe("none");
    // The pass skipped the variant on preview: the line appears at once.
    noteLookOmission("A", "v1", 1, "too-large");
    expect(note.style.display).not.toBe("none");
    expect(note.textContent).toBe("No automatic look: this variant grows past the block.");
  });

  test("a picked variant stays on the page instead of being restored", () => {
    const { controller } = setup();
    controller.openSet("A", document.createElement("div"));
    controller.onVariantState(state("A"));
    expect(document.getElementById("hero")?.textContent).toBe("A-1");
    controller.onVariantState(state("A", { status: "implementing", outcome: "picked" }));
    expect(document.getElementById("hero")?.textContent).toBe("A-1");
  });

  test("a page-root set previews against the body and uploads the page once its Edit lands", async () => {
    const { controller, uploads } = setup();
    controller.startFromChange(null, "make it dark", 3, "change", SPACE);
    const create = sent.find((m) => m.type === "variant-create");
    expect(create?.root).toEqual({ kind: "page" });
    expect(create?.spaceId).toBe(SPACE);
    const nonce = String(create?.nonce);
    const { selector: _block, ...rest } = state("P");
    const page: VariantStateMessage = {
      ...rest,
      nonce,
      rootKind: "page",
      variants: [
        {
          variantId: "v1",
          label: "Dark",
          program: [
            {
              op: "setStyle",
              target: ":scope",
              props: [{ prop: "background-color", value: "black" }],
            },
          ],
          version: 1,
        },
      ],
    };
    controller.onVariantState(page);
    controller.onVariantState(page);
    await flush();
    expect(uploads.length).toBe(1);
    expect(uploads[0]?.id).toBe("P-edit");
    expect(uploads[0]?.content).toContain("Hello");
    expect(uploads[0]?.content).not.toContain("<script");
    expect(document.body.style.getPropertyValue("background-color")).toBe("black");
  });

  test("the create settles when its set lands, or with why it didn't (M-2)", async () => {
    const { controller, app } = setup();
    const landed = controller.startFromChange(null, "make it dark", 3, "change", SPACE);
    const nonce = String(sent.find((m) => m.type === "variant-create")?.nonce);
    controller.onVariantState({ ...state("P"), nonce, rootKind: "page" });
    expect(await landed).toEqual({ ok: true, interactionId: "P-edit" });

    const refused = controller.startFromChange(null, "make it light", 3, "change", SPACE);
    const second = sent.filter((m) => m.type === "variant-create").at(-1);
    expect(second?.nonce).not.toBe(nonce);
    app._onReceipt({
      kind: "create",
      nonce: String(second?.nonce),
      ok: false,
      reason: "space-full",
    });
    expect(await refused).toEqual({ ok: false, reason: "space-full" });

    // Asking again for the refused one is its retry: the same nonce.
    void controller.startFromChange(null, "make it light", 3, "change", SPACE);
    const retry = sent.filter((m) => m.type === "variant-create").at(-1);
    expect(retry?.nonce).toBe(second?.nonce);
    app._connectionLost(new Set([SPACE]));
  });

  test("a page edit carries the document's provenance stamp", () => {
    document.documentElement.setAttribute(
      "data-onlay-provenance",
      "github.com/acme/site@abc;main;clean",
    );
    const { controller } = setup();
    controller.startFromChange(null, "x", 1, "change", SPACE);
    const create = sent.find((m) => m.type === "variant-create");
    expect(create?.provenance).toBe("github.com/acme/site@abc;main;clean");
  });
});

describe("one page, one person, the whole set", () => {
  test("a set whose Edit lives on another page never previews here", () => {
    const { controller, app } = setup();
    seedEdits(app, SPACE, []);
    app._setInteractions(SPACE, [
      {
        id: "A-edit",
        kind: "change",
        state: "open",
        url: `${URL}/details`,
        anchor: { level: "page" },
        waitingOn: [],
        thread: [],
      } as never,
    ]);
    const mount = document.createElement("div");
    controller.openSet("A", mount);
    controller.onVariantState(state("A"));
    expect(document.getElementById("hero")?.textContent).toBe("Hello");
  });

  test("a truncated frame is filled in over HTTP before cycling or picking", async () => {
    const fresh = setup();
    let release: (v: { variants: VariantStateMessage["variants"] }) => void = () => {};
    const c = createVariantController(fresh.app, {
      layer: fresh.layer,
      scope: () => SCOPE,
      captureLatch: LATCH,
      bookmarks: { load: async () => ({}), save: async () => {}, clear: async () => {} },
      fetchSet: () =>
        new Promise((r) => {
          release = r;
        }),
    });
    const mount = document.createElement("div");
    c.openSet("A", mount);
    const shown = state("A");
    c.onVariantState({ ...shown, truncated: true, variants: shown.variants.slice(1) });
    const pick = [...mount.querySelectorAll("button")].find((b) => b.textContent === "Pick active");
    expect(pick?.disabled).toBe(true);
    expect(document.getElementById("hero")?.textContent).toBe("Hello");
    release({ variants: shown.variants });
    await flush();
    expect(pick?.disabled).toBe(false);
    expect(document.getElementById("hero")?.textContent).toBe("A-1");
  });

  test("an account change drops every set and its bookmarks; a lost space drops its sets", async () => {
    const { controller, bookmarks, cleared } = setup();
    controller.openSet("A", document.createElement("div"));
    controller.onVariantState(state("A"));
    controller.openSet("G", document.createElement("div"));
    controller.onVariantState(state("G", { spaceId: GUEST_SPACE, selector: "#copy" }));
    await flush();
    controller.scopeChanged(SCOPE, SCOPE, [SPACE]);
    await flush();
    expect(controller.setIds()).toEqual(["A"]);
    expect(document.getElementById("copy")?.textContent).toBe("Body");
    expect(bookmarks()[URL]).toEqual([{ setId: "A", spaceId: SPACE }]);
    controller.scopeChanged(SCOPE, null, []);
    expect(controller.setIds()).toEqual([]);
    await flush();
    expect(cleared).toEqual([SCOPE]);
    expect(document.getElementById("hero")?.textContent).toBe("Hello");
  });

  test("the page body is read with the kept layer off, and not uploaded once the page moved", async () => {
    const { controller, uploads, layer } = setup();
    layer.showPreview(
      "other",
      "#hero",
      [{ op: "setText", target: ":scope", text: "Kept elsewhere" }],
      {
        url: URL,
        spaceId: SPACE,
      },
    );
    controller.startFromChange(null, "dark", 1, "change", SPACE);
    const nonce = String(sent.find((m) => m.type === "variant-create")?.nonce);
    const { selector: _s, ...rest } = state("P");
    controller.onVariantState({ ...rest, nonce, rootKind: "page" });
    await flush();
    expect(uploads[0]?.content).toContain("Hello");
    expect(uploads[0]?.content).not.toContain("Kept elsewhere");

    controller.startFromChange(null, "light", 1, "change", SPACE);
    const second = String(sent.filter((m) => m.type === "variant-create").at(-1)?.nonce);
    (window as unknown as { history: History }).history.pushState({}, "", "/elsewhere");
    controller.onVariantState({
      ...rest,
      setId: "Q",
      changeInteractionId: "Q-edit",
      nonce: second,
      rootKind: "page",
    });
    await flush();
    expect(uploads.map((u) => u.id)).toEqual(["P-edit"]);
  });
});

describe("nothing is captured from someone else's Edit", () => {
  test("a page set whose Edit someone else wrote uploads nothing from this page", async () => {
    const { controller, uploads, app } = setup();
    controller.startFromChange(null, "dark", 1, "change", SPACE);
    const nonce = String(sent.find((m) => m.type === "variant-create")?.nonce);
    app._setInteractions(SPACE, [
      {
        id: "P-edit",
        kind: "change",
        state: "open",
        url: URL,
        authorId: "p_someone_else",
        anchor: { level: "page" },
        waitingOn: [],
        thread: [],
      } as never,
    ]);
    const { selector: _s, ...rest } = state("P");
    controller.onVariantState({ ...rest, nonce, rootKind: "page" });
    await flush();
    expect(uploads).toEqual([]);
  });

  test("a capture waits for this tab's own snapshot to show the Edit as this person's", async () => {
    const { controller, uploads, app } = setup();
    app._setInteractions(SPACE, []); // the snapshot has not caught up yet
    controller.startFromChange(null, "dark", 1, "change", SPACE);
    const nonce = String(sent.find((m) => m.type === "variant-create")?.nonce);
    const { selector: _s, ...rest } = state("P");
    controller.onVariantState({ ...rest, nonce, rootKind: "page" });
    await flush();
    expect(uploads).toEqual([]);
    seedEdits(app, SPACE, ["P"]);
    controller.snapshotsChanged();
    await flush();
    expect(uploads.map((u) => u.id)).toEqual(["P-edit"]);
  });
});

test("the block markup sent with a variant request is the redacted transport form, never raw", () => {
  const { controller } = setup();
  const block = document.createElement("form");
  block.innerHTML = `<input type="hidden" name="csrf" value="s3cr3t"><input value="typed"><a href="/x?t=1">x</a>`;
  document.body.appendChild(block);
  controller.startFromChange(block, "tidy", 1, "change", SPACE);
  const create = sent.find((m) => m.type === "variant-create") as {
    root: { element: { markup: string } };
  };
  const markup = create.root.element.markup;
  expect(markup).not.toContain("s3cr3t");
  expect(markup).not.toContain("typed");
  expect(markup).not.toContain("t=1");
});

test("the capture latch never lives in the page's storage, and the old one there is removed", () => {
  const { app, layer } = setup();
  expect(window.localStorage.getItem("onlayEditCap:legacy-edit")).toBe("1");
  // The real store (no stub) takes the page-owned latch away on load.
  createVariantController(app, { layer, scope: () => SCOPE });
  expect(window.localStorage.getItem("onlayEditCap:legacy-edit")).toBeNull();
});

test("an Edit this person can no longer see takes its set, preview and witness work with it", () => {
  const { controller } = setup();
  controller.openSet("A", document.createElement("div"));
  controller.onVariantState(state("A"));
  expect(document.getElementById("hero")?.textContent).toBe("A-1");
  controller.dropForEdits(new Set(["A-edit"]));
  expect(controller.setIds()).toEqual([]);
  expect(document.getElementById("hero")?.textContent).toBe("Hello");
});

/* ── a set in a child frame, driven from the top frame's panel (E-1) ── */

function trustedClick(target: Element): void {
  const e = new (win as Window).Event("click", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "isTrusted", { value: true });
  target.dispatchEvent(e as unknown as Event);
}
const buttonIn = (root: ParentNode, label: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLElement;

describe("a set whose block is in a child frame (E-1)", () => {
  test("the owning frame acts only on a set it holds, previews in its own document and reports no programs", async () => {
    const { controller } = setup();
    // Not this frame's: neither held nor named by its snapshot.
    expect(controller.drive("Z", { act: "open", changeId: "A-edit" })).toBe(false);
    expect(controller.drive("Z", { act: "cycle", delta: 1 })).toBe(false);
    controller.openSet("A");
    controller.onVariantState(state("A"));
    expect(document.getElementById("hero")?.textContent).toBe("A-1");
    expect(controller.drive("A", { act: "cycle", delta: 1 })).toBe(true);
    expect(document.getElementById("hero")?.textContent).toBe("A-2");
    const { sets } = controller.mirrors();
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ setId: "A", spaceId: SPACE, displayIndex: 1, full: true });
    expect(sets[0]?.statusText).toContain("previewing 2/2: Calm");
    expect(JSON.stringify(sets)).not.toContain("program");
    // A pick for another variant than the one shown here is refused, and nothing goes out.
    sent.length = 0;
    expect(controller.drive("A", { act: "pick", variantId: "v1", version: 1 })).toBe(false);
    expect(variantFrames().filter((f) => f.type === "variant-pick")).toEqual([]);
    expect(controller.drive("A", { act: "pick", variantId: "v2", version: 1 })).toBe(true);
    await flush();
    expect(variantFrames().find((f) => f.type === "variant-pick")).toMatchObject({
      setId: "A",
      frameUrl: URL,
      variantId: "v2",
      version: 1,
      spaceId: SPACE,
    });
  });

  test("the top frame's panel mirrors the frame's report and drives it, sending nothing itself", async () => {
    const { app, layer } = setup();
    const acts: Array<{ documentId: string; setId: string; act: unknown }> = [];
    const replies: Array<Record<string, unknown>> = [];
    const top = createVariantController(app, {
      layer,
      scope: () => SCOPE,
      captureLatch: LATCH,
      bookmarks: { load: async () => ({}), save: async () => {}, clear: async () => {} },
      remote: {
        act: async (documentId, setId, act) => {
          acts.push({ documentId, setId, act });
          return true;
        },
        reply: async (_doc, frame) => {
          replies.push(frame);
          return { ok: true };
        },
      },
    });
    document.body.appendChild(top.previewLabel);
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    top.openRemoteSet("R", mount, "doc-1", "R-edit");
    expect(acts).toEqual([
      { documentId: "doc-1", setId: "R", act: { act: "open", changeId: "R-edit" } },
    ]);
    expect(mount.textContent).toContain("syncing variants…");
    top.mirror("doc-1", [
      {
        setId: "R",
        spaceId: SPACE,
        status: "previewing",
        selector: "#goal > p",
        changeInteractionId: "R-edit",
        variants: [
          { variantId: "v1", label: "Bold", version: 1 },
          { variantId: "v2", label: "Calm", version: 3 },
        ],
        displayIndex: 1,
        full: true,
        nothingApplied: false,
        previewing: true,
        statusText: "previewing 2/2: Calm — indicative",
        lookNote: "",
      },
    ]);
    expect(mount.querySelector(".variant-current")?.textContent).toBe("2/2 — Calm");
    expect(mount.textContent).toContain("previewing 2/2: Calm — indicative");
    expect(top.previewLabel.textContent).toBe("Indicative preview — Calm");
    sent.length = 0;
    trustedClick(buttonIn(mount, "›"));
    trustedClick(buttonIn(mount, "Pick active"));
    await flush();
    expect(acts.slice(1).map((a) => a.act)).toEqual([
      { act: "cycle", delta: 1 },
      { act: "pick", variantId: "v2", version: 3 },
    ]);
    // Nothing on this frame's socket, and this document untouched.
    expect(variantFrames()).toEqual([]);
    expect(document.getElementById("hero")?.textContent).toBe("Hello");
    // The frame no longer holds the set: its panel goes.
    top.mirror("doc-1", []);
    expect(mount.querySelector(".variant-panel")).toBeNull();
    expect(top.previewLabel.style.display).toBe("none");
    expect(replies).toEqual([]);
  });

  test("a comment on the frame's active variant is sent by that frame", async () => {
    const { app, layer } = setup();
    const replies: Array<{ doc: string; frame: Record<string, unknown> }> = [];
    const top = createVariantController(app, {
      layer,
      scope: () => SCOPE,
      captureLatch: LATCH,
      bookmarks: { load: async () => ({}), save: async () => {}, clear: async () => {} },
      remote: {
        act: async () => true,
        reply: async (doc, frame) => {
          replies.push({ doc, frame });
          return { ok: true };
        },
      },
    });
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    top.openRemoteSet("R", mount, "doc-1", "R-edit");
    top.mirror("doc-1", [
      {
        setId: "R",
        spaceId: SPACE,
        status: "previewing",
        changeInteractionId: "R-edit",
        variants: [{ variantId: "v1", label: "Bold", version: 1 }],
        displayIndex: 0,
        full: true,
        nothingApplied: false,
        previewing: true,
        statusText: "",
        lookNote: "No automatic look: something on the page covered this block.",
      },
    ]);
    expect(mount.textContent).toContain("No automatic look: something on the page covered");
    const box = mount.querySelector("[contenteditable]") as HTMLElement;
    box.textContent = "Warmer?";
    box.dispatchEvent(new (win as Window).Event("input", { bubbles: true }) as unknown as Event);
    trustedClick(buttonIn(mount, "Comment"));
    await flush();
    expect(replies).toHaveLength(1);
    expect(replies[0]?.doc).toBe("doc-1");
    expect(replies[0]?.frame).toMatchObject({
      type: "interaction-reply",
      interactionId: "R-edit",
      spaceId: SPACE,
      body: { text: "Variant 1/1 — Bold: Warmer?" },
    });
    expect(typeof replies[0]?.frame.clientId).toBe("string");
    expect(sent.filter((m) => m.type === "interaction-reply")).toEqual([]);
  });
});

test("an account change drops every mirrored panel and the frames' preview pill (E-1)", () => {
  const { app, layer } = setup();
  const top = createVariantController(app, {
    layer,
    scope: () => SCOPE,
    captureLatch: LATCH,
    bookmarks: { load: async () => ({}), save: async () => {}, clear: async () => {} },
    remote: { act: async () => true, reply: async () => ({ ok: true }) },
  });
  const mount = document.createElement("div");
  top.openRemoteSet("R", mount, "doc-1", "R-edit");
  top.mirror("doc-1", [
    {
      setId: "R",
      spaceId: SPACE,
      status: "previewing",
      variants: [{ variantId: "v1", label: "Bold", version: 1 }],
      displayIndex: 0,
      full: true,
      nothingApplied: false,
      previewing: true,
      statusText: "",
      lookNote: "",
    },
  ]);
  expect(top.previewLabel.style.display).toBe("block");
  top.scopeChanged(SCOPE, "p_other|https://app.onlay.dev", [SPACE]);
  expect(top.setIds()).toEqual([]);
  expect(mount.querySelector(".variant-panel")).toBeNull();
  expect(top.previewLabel.style.display).toBe("none");
});

/* ── second pass: the pill, and frames with one address (2-E3, 2-E4) ── */

function remoteTop() {
  const { app, layer } = setup();
  const acts: Array<{ documentId: string; setId: string; act: unknown }> = [];
  const top = createVariantController(app, {
    layer,
    scope: () => SCOPE,
    captureLatch: LATCH,
    bookmarks: { load: async () => ({}), save: async () => {}, clear: async () => {} },
    remote: {
      act: async (documentId, setId, act) => {
        acts.push({ documentId, setId, act });
        return true;
      },
      reply: async () => ({ ok: true }),
    },
  });
  document.body.appendChild(top.previewLabel);
  return { top, acts };
}

const mirrorOf = (over: Record<string, unknown> = {}) => ({
  setId: "R",
  spaceId: SPACE,
  status: "previewing" as const,
  changeInteractionId: "R-edit",
  variants: [
    { variantId: "v1", label: "Bold", version: 1 },
    { variantId: "v2", label: "Calm", version: 1 },
  ],
  displayIndex: 0,
  full: true,
  nothingApplied: false,
  previewing: true,
  statusText: "",
  lookNote: "",
  ...over,
});

test("the pill shows only a set this frame accepted and opened, and goes with its space (2-E3)", () => {
  const { top } = remoteTop();
  // Reported but never opened here: no pill.
  top.mirror("doc-1", [mirrorOf()]);
  expect(top.previewLabel.style.display).toBe("none");
  const mount = document.createElement("div");
  top.openRemoteSet("R", mount, "doc-1", "R-edit");
  expect(top.previewLabel.textContent).toBe("Indicative preview — Bold");
  // The frame's next report no longer carries the set: panel and pill go at once.
  top.mirror("doc-1", []);
  expect(mount.querySelector(".variant-panel")).toBeNull();
  expect(top.previewLabel.style.display).toBe("none");
  // An access change for its space takes them off without waiting for a report.
  top.openRemoteSet("R", mount, "doc-1", "R-edit");
  top.mirror("doc-1", [mirrorOf()]);
  expect(top.previewLabel.style.display).toBe("block");
  top.forgetFrameSpaces((sp) => sp === SPACE);
  expect(mount.querySelector(".variant-panel")).toBeNull();
  expect(top.previewLabel.style.display).toBe("none");
});

test("two frames with one address each keep their own panel state; acts go to the frame it was opened from (2-E4)", () => {
  const { top, acts } = remoteTop();
  top.mirror("doc-1", [mirrorOf({ displayIndex: 1 })]);
  top.mirror("doc-2", [mirrorOf({ displayIndex: 0 })]);
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  top.openRemoteSet("R", mount, "doc-2", "R-edit");
  expect(mount.querySelector(".variant-current")?.textContent).toBe("1/2 — Bold");
  // A report from the other frame never repaints this panel.
  top.mirror("doc-1", [mirrorOf({ displayIndex: 1 })]);
  expect(mount.querySelector(".variant-current")?.textContent).toBe("1/2 — Bold");
  trustedClick(buttonIn(mount, "›"));
  expect(acts.map((a) => a.documentId)).toEqual(["doc-2", "doc-2"]);
  // Opened from the first frame: the panel follows it, with its own state.
  top.openRemoteSet("R", mount, "doc-1", "R-edit");
  expect(mount.querySelector(".variant-current")?.textContent).toBe("2/2 — Calm");
  expect(acts.at(-1)?.documentId).toBe("doc-1");
});

/* ── the picked block's pin, through the create's receipt (3-E1) ── */

/** How many edit-context captures were attempted for a set created on #copy. */
async function editContextAttempts(moveBeforeReceipt: boolean): Promise<number> {
  const { controller } = setup();
  const attempts: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => {
    if (String(a[0]).includes("edit-context capture failed")) attempts.push(String(a[0]));
  };
  try {
    const block = document.getElementById("copy") as Element;
    void controller.startFromChange(block, "shorter", 2, "change", SPACE);
    const create = sent.find((m) => m.type === "variant-create");
    if (moveBeforeReceipt) {
      // Before the receipt the page moves the block into another document.
      const other = document.implementation.createHTMLDocument("other");
      other.body.appendChild(other.adoptNode(block));
    }
    controller.onVariantState(
      state("P", { nonce: String(create?.nonce), selector: "#copy", status: "generating" }),
    );
    for (let i = 0; i < 60 && attempts.length === 0; i += 1)
      await new Promise((r) => setTimeout(r, 10));
  } finally {
    console.warn = warn;
  }
  return attempts.length;
}

test("the edit context of a picked block is captured where it was picked (3-E1)", async () => {
  expect(await editContextAttempts(false)).toBe(1);
});

test("a picked block moved into another document before the receipt is not captured, nor looked up again (3-E1)", async () => {
  expect(await editContextAttempts(true)).toBe(0);
});

/* ── audit round: what is uploaded, what waits, what a pick checks ── */

/** Wait for the edit-context capture a test started to finish, so it can't land in the next test. */
async function settleCapture(): Promise<void> {
  const warn = console.warn;
  let done = false;
  console.warn = (...a: unknown[]) => {
    if (String(a[0]).includes("edit-context capture failed")) done = true;
  };
  try {
    for (let i = 0; i < 60 && !done; i += 1) await new Promise((r) => setTimeout(r, 10));
  } finally {
    console.warn = warn;
  }
}

test("after the pick nothing re-reads the block: the create and the upload carry what was seen (audit 2)", async () => {
  document.body.innerHTML = `<div id="panel"><p id="copy">Seen at the pick</p></div>`;
  const { controller } = setup();
  const block = document.getElementById("copy") as Element;
  controller.notePick(block);
  // While the composer is open the panel collapses and new text goes in.
  (document.getElementById("panel") as HTMLElement).style.display = "none";
  block.textContent = "Added after the person stopped seeing it";
  void controller.startFromChange(block, "shorter", 2, "change", SPACE);
  const create = sent.find((m) => m.type === "variant-create");
  const element = (create?.root as { element?: { textSnippet: string; markup: string } })?.element;
  expect(element?.textSnippet).toBe("Seen at the pick");
  expect(element?.markup).toContain("Seen at the pick");
  expect(JSON.stringify(create)).not.toContain("Added after");
  controller.onVariantState(
    state("P", { nonce: String(create?.nonce), selector: "#copy", status: "generating" }),
  );
  await flush();
  const upload = sent.find((m) => m.type === "uploadAnchorContent");
  expect(String(upload?.content)).toContain("Seen at the pick");
  expect(String(upload?.content)).not.toContain("Added after");
  await settleCapture();
});

/** Three variants written for this person (by their agent). */
const own = (setId: string) =>
  [1, 2, 3].map((n) => ({
    variantId: `v${n}`,
    label: `V${n}`,
    program: [{ op: "setText" as const, target: ":scope", text: `${setId}-${n}` }],
    version: 1,
    by: "p_me",
  }));
const outcomes = () => sent.filter((m) => m.type === "variant-outcome");
const ticks = async (n: number) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

test("reports come only from the copy taken at the pick, one variant per slice (audit 1, 5)", async () => {
  document.body.innerHTML = `<p id="copy">Block</p>`;
  const { controller } = setup();
  const block = document.getElementById("copy") as Element;
  controller.notePick(block);
  void controller.startFromChange(block, "shorter", 3, "change", SPACE);
  const create = sent.find((m) => m.type === "variant-create");
  controller.onVariantState(
    state("P", { nonce: String(create?.nonce), selector: "#copy", variants: own("P") }),
  );
  // Nothing in the same turn: each variant gets a slice of its own.
  expect(outcomes()).toHaveLength(0);
  await ticks(1);
  expect(outcomes()).toHaveLength(1);
  await ticks(4);
  expect(outcomes().map((m) => m.variantId)).toEqual(["v1", "v2", "v3"]);
  await settleCapture();
});

test("a tab that didn't make the pick never reports, whatever its page holds (audit 1)", async () => {
  document.body.innerHTML = `<p id="copy">Block</p>`;
  const { controller } = setup();
  controller.openSet("A", document.createElement("div"));
  controller.onVariantState(state("A", { selector: "#copy", variants: own("A") }));
  await ticks(6);
  expect(outcomes()).toHaveLength(0);
});

test("a pick whose block moved since no longer reports (audit 1)", async () => {
  document.body.innerHTML = `<p id="copy">Block</p>`;
  const { controller } = setup();
  const block = document.getElementById("copy") as Element;
  controller.notePick(block);
  void controller.startFromChange(block, "shorter", 3, "change", SPACE);
  const create = sent.find((m) => m.type === "variant-create");
  // The list re-renders: another record now sits where the block was.
  const other = document.createElement("p");
  other.id = "copy";
  other.textContent = "Another record";
  block.replaceWith(other);
  controller.onVariantState(
    state("P", { nonce: String(create?.nonce), selector: "#copy", variants: own("P") }),
  );
  await ticks(6);
  expect(outcomes()).toHaveLength(0);
  await settleCapture();
});

test("a set that lands before its Edit's snapshot runs both its capture and its markup upload (audit 7)", async () => {
  document.body.innerHTML = `<p id="copy">Block</p>`;
  const { app, controller } = setup();
  const attempts: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => {
    if (String(a[0]).includes("edit-context capture failed")) attempts.push(String(a[0]));
  };
  try {
    const block = document.getElementById("copy") as Element;
    void controller.startFromChange(block, "shorter", 2, "change", SPACE);
    const create = sent.find((m) => m.type === "variant-create");
    controller.onVariantState(
      state("Q", { nonce: String(create?.nonce), selector: "#copy", status: "generating" }),
    );
    // Neither runs before the Edit is in this tab's snapshot.
    expect(sent.some((m) => m.type === "uploadAnchorContent")).toBe(false);
    seedEdits(app, SPACE, ["A", "B", "P", "Q"]);
    controller.snapshotsChanged();
    for (let i = 0; i < 60 && attempts.length === 0; i += 1)
      await new Promise((r) => setTimeout(r, 10));
  } finally {
    console.warn = warn;
  }
  expect(sent.some((m) => m.type === "uploadAnchorContent")).toBe(true);
  expect(attempts.length).toBe(1);
});

test("a pick re-checks the page: a target gone since the preview refreshes the panel and picks nothing (audit 8)", async () => {
  document.body.innerHTML = `<h1 id="hero"><span class="a">Hello</span></h1>`;
  const { controller } = setup();
  const mount = document.createElement("div");
  controller.openSet("A", mount);
  controller.onVariantState(
    state("A", {
      variants: [
        {
          variantId: "v1",
          label: "Bold",
          program: [{ op: "setText", target: ".a", text: "Bold" }],
          version: 1,
        },
      ],
    }),
  );
  expect(document.querySelector(".a")?.textContent).toBe("Bold");
  // The page re-renders the block without the step's target.
  (document.getElementById("hero") as HTMLElement).replaceChildren("Hello again");
  await flush();
  const before = variantFrames().length;
  expect(controller.drive("A", { act: "pick", variantId: "v1", version: 1 })).toBe(false);
  expect(
    variantFrames()
      .slice(before)
      .some((m) => m.type === "variant-pick"),
  ).toBe(false);
  const pick = [...mount.querySelectorAll("button")].find(
    (b) => b.textContent === "Pick active",
  ) as HTMLButtonElement;
  // Refreshed: nothing of it is on the page now, so it can't be picked.
  expect(pick.disabled).toBe(true);
  expect(mount.querySelector(".variant-status")?.textContent).toBe(
    "The page changed since this preview. Look at it again, then pick.",
  );
});

const createdSnippets = () =>
  sent
    .filter((m) => m.type === "variant-create")
    .map((m) => (m.root as { element?: { textSnippet: string } })?.element?.textSnippet);

test("a pick's snapshot is used once: a later create on the same block reads it afresh (review)", async () => {
  document.body.innerHTML = `<p id="copy">First pick</p>`;
  const { controller } = setup();
  const block = document.getElementById("copy") as Element;
  controller.notePick(block);
  void controller.startFromChange(block, "shorter", 2, "change", SPACE);
  // A later pick in the same block (a text selection takes no snapshot of its own).
  block.textContent = "Second pick";
  void controller.startFromChange(block, "louder", 2, "change", SPACE);
  expect(createdSnippets()).toEqual(["First pick", "Second pick"]);
});

test("a pick whose composer closed without sending leaves no snapshot behind (review)", async () => {
  document.body.innerHTML = `<p id="copy">Abandoned pick</p>`;
  const { controller } = setup();
  const block = document.getElementById("copy") as Element;
  controller.notePick(block);
  controller.forgetPick();
  block.textContent = "Fresh pick";
  void controller.startFromChange(block, "shorter", 2, "change", SPACE);
  expect(createdSnippets()).toEqual(["Fresh pick"]);
});
