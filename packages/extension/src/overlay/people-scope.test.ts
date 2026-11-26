/// <reference types="chrome" />
// Everyone drawn while drawing a thread is looked up in that thread's own
// space: an author, a quoted author, a reactor, the modal's header and those
// it waits on. A person that space's directory does not hold is the neutral
// stand-in, never the name, alias or picture another space gave the same id.
// The signed-in person's own entry still answers for their own id.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RawInteractionSnapshot, SpaceSummary } from "@onlay/protocol";
import { Window } from "happy-dom";
import { type AppInternals, createApp } from "./app";
import { createInteractionModal } from "./interaction-modal";
import { createThreadPanel } from "./thread";

const SPACE = "s_aaaaaaaaaaaaaaaaaaaa";
const OTHER = "s_bbbbbbbbbbbbbbbbbbbb";
const PAGE = "http://127.0.0.1:8124/page.html";
const ZED_PICTURE = `/s/${OTHER}/people/zed/picture/cccccccccccccccc`;

let win: Window | null = null;

beforeEach(() => {
  win = new Window({ url: PAGE });
  const g = globalThis as unknown as Record<string, unknown>;
  for (const k of ["Element", "HTMLElement", "Node", "Text", "Event", "MutationObserver"])
    g[k] = (win as unknown as Record<string, unknown>)[k];
  g.window = win;
  g.document = win.document;
  g.crypto = win.crypto ?? globalThis.crypto;
  g.location = win.location;
  g.chrome = {
    runtime: { sendMessage: () => Promise.resolve({ ok: false }) },
    storage: { local: { set: () => Promise.resolve() } },
  };
});
afterEach(() => {
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
  delete (globalThis as unknown as Record<string, unknown>).chrome;
});

function makeApp() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const app = createApp({ shadow, host, isTopFrame: true, toast: () => {} }) as ReturnType<
    typeof createApp
  > &
    AppInternals;
  app._setSelf({ id: "me", name: "Me", tint: "#333", initials: "ME" });
  app._setSpaces(
    [
      { id: SPACE, kind: "workspace", name: "Atelier", role: "member" } as SpaceSummary,
      { id: OTHER, kind: "workspace", name: "Elsewhere", role: "member" } as SpaceSummary,
    ],
    SPACE,
  );
  // Zed is known only from another space, with that space's alias and picture.
  app._setDirectory(OTHER, [
    {
      id: "zed",
      name: "Zed Other",
      alias: "zed",
      tint: "#111",
      initials: "ZO",
      avatarUrl: ZED_PICTURE,
    },
  ]);
  app._setDirectory(SPACE, [{ id: "bea", name: "Bea", tint: "#222", initials: "BE" }]);
  return { app, shadow };
}

function snap(): RawInteractionSnapshot {
  return {
    id: "c1",
    kind: "comment",
    url: PAGE,
    anchor: { level: "page" },
    authorId: "zed",
    participants: ["zed", "bea", "me"],
    waitingOn: ["bea", "zed"],
    state: "open",
    thread: [
      {
        msgId: "m1",
        authorId: "zed",
        body: { text: "root" },
        ts: 0,
        reactions: { "👍": ["zed", "bea"] },
      },
      { msgId: "m2", authorId: "me", body: { text: "mine" }, ts: 1, replyTo: { msgId: "m1" } },
    ],
    createdAt: 0,
  } as RawInteractionSnapshot;
}

describe("people drawn in a thread come from its own space", () => {
  test("the scoped lookup never falls back to another space's entry", () => {
    const { app } = makeApp();
    const zed = app.person("zed", SPACE);
    expect(zed.name).toBe("Someone");
    expect(zed.alias).toBeUndefined();
    expect(zed.avatarUrl).toBeUndefined();
    expect(app.person("bea", SPACE).name).toBe("Bea");
    // One's own entry still answers for one's own id.
    expect(app.person("me", SPACE).name).toBe("Me");
    // Unscoped (not a thread): any directory, without its alias.
    expect(app.person("zed").name).toBe("Zed Other");
    expect(app.person("zed").alias).toBeUndefined();
  });

  test("the thread panel: authors, quoted authors and reactors", () => {
    const { app, shadow } = makeApp();
    const panel = createThreadPanel(app);
    shadow.appendChild(panel.element);
    app.onRender(() => panel.render());
    app._setInteractions(SPACE, [snap()]);
    panel.open("c1");
    const text = panel.element.textContent ?? "";
    expect(text).not.toContain("Zed Other");
    const authors = [...panel.element.querySelectorAll(".msg-author")].map((n) => n.textContent);
    expect(authors).toEqual(["Someone", "Me"]);
    expect(panel.element.querySelector(".quote-text")?.textContent).toBe("Someone: root");
    const chip = panel.element.querySelector(".reactions .react") as HTMLElement | null;
    expect(chip?.title).toBe("Someone, Bea");
  });

  test("the interaction modal: its header, who it waits on, and the messages", async () => {
    const { app, shadow } = makeApp();
    const modal = createInteractionModal(app, {
      load: (ref) => Promise.resolve(app.byId(ref.interactionId) ?? null),
      send: () => Promise.resolve({ ok: true }),
    });
    shadow.appendChild(modal.element);
    // Bea asked, and it waits on Zed.
    app._setInteractions(SPACE, [{ ...snap(), authorId: "bea" }]);
    modal.open({ interactionId: "c1", spaceId: SPACE, local: true });
    await new Promise((r) => setTimeout(r, 0));
    const text = modal.element.textContent ?? "";
    expect(text).not.toContain("Zed Other");
    expect(modal.element.querySelector(".im-who .name")?.textContent).toBe("Bea");
    expect(modal.element.querySelector(".im-who .name.dim")?.textContent).toBe("Someone");
    const authors = [...modal.element.querySelectorAll(".msg-author")].map((n) => n.textContent);
    expect(authors).toEqual(["Someone", "Me"]);
    expect(modal.element.querySelector(".quote-text")?.textContent).toBe("Someone: root");
  });
});
