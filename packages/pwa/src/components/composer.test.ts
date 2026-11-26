// The token composer: the serialization contract (handle → wire text + one
// deduped token per person, `@agent` → an agent token, protocol caps, the
// truncation guard against phantom mentions), draft round-trip re-resolution
// (wire text persists; restore routes again iff the list knows the handle),
// and the popover accept path (trigger → tap → `@<handle> ` + token).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LIMITS } from "@onlay/protocol";
import { Window } from "happy-dom";
import { AGENT_MENTION, type Mentionable } from "../mentions";
import {
  type Composer,
  type ComposerCtx,
  composer,
  serializeWire,
  wireForEditing,
} from "./composer";

let win: Window | null = null;
const savedGlobals = new Map<string, unknown>();
const DOM_GLOBALS = [
  "window",
  "document",
  "Element",
  "HTMLElement",
  "HTMLTextAreaElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "Node",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
] as const;

function installDom(): void {
  win = new Window({ url: "http://127.0.0.1:8123/app/" });
  const w = win as unknown as Record<string, unknown>;
  const g = globalThis as unknown as Record<string, unknown>;
  for (const k of DOM_GLOBALS) {
    savedGlobals.set(k, g[k]);
    g[k] = w[k];
  }
}

beforeEach(installDom);
afterEach(() => {
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
  // Restore the real globals — a leaked closed Window breaks later test files
  // in this same process (the store.test.ts fake-indexeddb hazard).
  const g = globalThis as unknown as Record<string, unknown>;
  for (const [k, v] of savedGlobals) g[k] = v;
  savedGlobals.clear();
});

const P_ADEL = "p_adeladeladeladeladel";
const P_CLAIRE = "p_claireclaireclairec";
const P_AL = "p_alalalalalalalalalal";

const PEOPLE: Mentionable[] = [
  { handle: "adel", id: P_ADEL, name: "Adel", tint: "#0ea5e9", initials: "AD" },
  { handle: "claire", id: P_CLAIRE, name: "Claire", tint: "#8b5cf6", initials: "CL" },
  { handle: "al", id: P_AL, name: "Al", tint: "#10b981", initials: "AL" },
];

function knows(handle: string): Mentionable | undefined {
  return handle === "agent" ? AGENT_MENTION : PEOPLE.find((a) => a.handle === handle);
}

function makeCtx(): { ctx: ComposerCtx; drafts: Map<string, string> } {
  const drafts = new Map<string, string>();
  const directory = new Map<string, Mentionable>(PEOPLE.map((a) => [a.handle, a]));
  const ctx: ComposerCtx = {
    directory,
    loadDirectory: () => Promise.resolve(),
    store: {
      getDraft: (c, k) => Promise.resolve(drafts.get(`${c}:${k}`) ?? null),
      putDraft: (c, k, v) => {
        drafts.set(`${c}:${k}`, v);
        return Promise.resolve();
      },
      deleteDraft: (c, k) => {
        drafts.delete(`${c}:${k}`);
        return Promise.resolve();
      },
    },
    personId: "c1",
  };
  return { ctx, drafts };
}

function mount(c: Composer): HTMLTextAreaElement {
  document.body.appendChild(c.node);
  return c.node.querySelector("textarea") as HTMLTextAreaElement;
}

function typeInto(ta: HTMLTextAreaElement, text: string): void {
  ta.value = text;
  ta.setSelectionRange(text.length, text.length);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A keydown the composer will treat as user-originated (isTrusted-gated send). */
function trustedKeydown(init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { ...init, cancelable: true });
  Object.defineProperty(e, "isTrusted", { value: true });
  return e;
}

/* ── serialization: the output contract ──────────────────────────────── */

describe("serializeWire", () => {
  test("a known handle ships as @<name> + one actor token", () => {
    const out = serializeWire("ping @claire please", knows);
    expect(out.text).toBe("ping @Claire please");
    // The token says where its mention sits in the sent text (M-4).
    expect(out.tokens).toEqual([
      { t: "actor", actorId: P_CLAIRE, spans: [{ start: 5, length: 7 }] },
    ]);
  });

  test("a handle inside an email address is not a mention (2-M4)", () => {
    const out = serializeWire("mail a@claire.example, then @claire, thanks", knows);
    expect(out.text).toBe("mail a@claire.example, then @Claire, thanks");
    expect(out.tokens).toEqual([
      { t: "actor", actorId: P_CLAIRE, spans: [{ start: 28, length: 7 }] },
    ]);
  });

  test("an unknown @name stays plain — no token, nothing routes", () => {
    const out = serializeWire("hey @ghost", knows);
    expect(out.text).toBe("hey @ghost");
    expect(out.tokens).toBeUndefined();
  });

  test("@agent ships an agent token and keeps its text", () => {
    const out = serializeWire("@agent fix this, thanks @claire", knows);
    expect(out.text).toBe("@agent fix this, thanks @Claire");
    expect(out.tokens).toEqual([
      { t: "agent", spans: [{ start: 0, length: 6 }] },
      { t: "actor", actorId: P_CLAIRE, spans: [{ start: 24, length: 7 }] },
    ]);
  });

  test("repeat mentions dedupe to one token; case folds to the handle", () => {
    const out = serializeWire("@Claire then @claire again", knows);
    expect(out.text).toBe("@Claire then @Claire again");
    // One token, one span per mention.
    expect(out.tokens).toEqual([
      {
        t: "actor",
        actorId: P_CLAIRE,
        spans: [
          { start: 0, length: 7 },
          { start: 13, length: 7 },
        ],
      },
    ]);
  });

  test("tokens cap at LIMITS.MAX_TOKENS_PER_MSG", () => {
    const many = Array.from({ length: LIMITS.MAX_TOKENS_PER_MSG + 4 }, (_, i) => `@a${i}`);
    const out = serializeWire(many.join(" "), (h) => ({
      handle: h,
      id: h,
      name: h,
      initials: "",
      tint: "",
    }));
    expect(out.tokens?.length).toBe(LIMITS.MAX_TOKENS_PER_MSG);
  });

  test("text trims and caps", () => {
    const out = serializeWire("  hello world  ", knows, 5);
    expect(out.text).toBe("hello");
  });

  test("a mention cut by the cap ships no token (phantom-mention guard)", () => {
    // "hi @alice yes" capped at 6 leaves "hi @al" — and `al` IS a real person.
    // The run is still open at the cut, so it must not wake al.
    const out = serializeWire("hi @alice yes", knows, 6);
    expect(out.text).toBe("hi @al");
    expect(out.tokens).toBeUndefined();
  });

  test("a name crossing the cap is not resolved: it ships plain, cut at the cap", () => {
    const out = serializeWire("hi @claire yes", knows, 8);
    expect(out.text).toBe("hi @clai");
    expect(out.tokens).toBeUndefined();
  });

  test("editing turns each token's @<name> back into the handle the field resolves", () => {
    const body = serializeWire("@claire and @agent, ping @al", knows);
    const wire = wireForEditing(body, [...PEOPLE, AGENT_MENTION]);
    expect(wire).toBe("@claire and @agent, ping @al");
    expect(serializeWire(wire, knows)).toEqual(body);
  });

  test("a mention ending exactly at the cap still routes", () => {
    const out = serializeWire("hi @al yes", knows, 6);
    expect(out.text).toBe("hi @Al");
    expect(out.tokens).toEqual([{ t: "actor", actorId: P_AL, spans: [{ start: 3, length: 3 }] }]);
  });
});

/* ── the composer: popover accept, drafts, clear ─────────────────────── */

describe("composer", () => {
  test("a fresh directory pull populates an initially empty mention popover", async () => {
    const { ctx } = makeCtx();
    ctx.directory.clear();
    ctx.loadDirectory = () => {
      for (const p of PEOPLE) ctx.directory.set(p.handle, p);
      return Promise.resolve();
    };
    const c = composer(ctx, { placeholder: "Reply…" });
    const ta = mount(c);
    typeInto(ta, "@cl");
    expect(c.node.querySelector(".pick-row")).toBeNull();
    await tick();
    const row = c.node.querySelector(".pick-row") as HTMLElement;
    expect(row.textContent).toContain("Claire");
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(c.value()).toEqual({
      text: "@Claire",
      tokens: [{ t: "actor", actorId: P_CLAIRE, spans: [{ start: 0, length: 7 }] }],
    });
  });

  test("@ trigger opens the actor popover; tapping inserts wire text + token", () => {
    const { ctx } = makeCtx();
    const c = composer(ctx, { placeholder: "Reply…" });
    const ta = mount(c);
    typeInto(ta, "@cl");
    const row = c.node.querySelector(".pick-row") as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain("Claire");
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(ta.value).toBe("@claire ");
    expect(c.value()).toEqual({
      text: "@Claire",
      tokens: [{ t: "actor", actorId: P_CLAIRE, spans: [{ start: 0, length: 7 }] }],
    });
  });

  test("@ finds a person by any word of their name or by their alias, without accents", () => {
    const { ctx } = makeCtx();
    const P_M = "p_mmmmmmmmmmmmmmmmmmmm";
    ctx.directory.set("r-odile-varga", {
      handle: "r-odile-varga",
      id: P_M,
      name: "R. Odíle Varga",
      tint: "#0ea5e9",
      initials: "RV",
      alias: "rvarga",
    });
    const c = composer(ctx, { placeholder: "Reply…" });
    const ta = mount(c);
    for (const q of ["@varg", "@ODILE", "@rvarg"]) {
      typeInto(ta, q);
      const names = [...c.node.querySelectorAll(".pick-row .pick-name")].map((n) => n.textContent);
      expect(names).toContain("R. Odíle Varga");
    }
    // The alias shows beside the name, and accepting still writes the name.
    const row = [...c.node.querySelectorAll(".pick-row")].find((r) =>
      r.textContent?.includes("Varga"),
    ) as HTMLElement;
    expect(row.querySelector(".pick-hint")?.textContent).toBe("rvarga");
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(c.value()).toEqual({
      text: "@R. Odíle Varga",
      tokens: [{ t: "actor", actorId: P_M, spans: [{ start: 0, length: 15 }] }],
    });
  });

  test(":query suggests emoji; accepting inserts the plain glyph, never a token", () => {
    const { ctx } = makeCtx();
    const c = composer(ctx, { placeholder: "Reply…" });
    const ta = mount(c);
    typeInto(ta, "nice :fir");
    const row = c.node.querySelector(".pick-row") as HTMLElement;
    expect(row.textContent).toContain("🔥");
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(ta.value).toBe("nice 🔥 ");
    expect(c.value()).toEqual({ text: "nice 🔥" });
  });

  test("keyboard: ArrowDown + Enter accepts the highlighted actor", () => {
    const { ctx } = makeCtx();
    const c = composer(ctx, { placeholder: "Reply…" });
    const ta = mount(c);
    typeInto(ta, "@a"); // matches adel, claire("a" in name? no — id/name contains) and al
    const rows = c.node.querySelectorAll(".pick-row");
    expect(rows.length).toBeGreaterThan(1);
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true }));
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    const second = rows[1]?.textContent ?? "";
    expect(ta.value.startsWith("@")).toBe(true);
    expect(second).toContain(ta.value.trim());
  });

  test("draft round-trip: wire text persists; restore re-promotes known ids only", async () => {
    const { ctx, drafts } = makeCtx();
    drafts.set("c1:reply:i1", "see @claire and @ghost");
    let restored = false;
    const c = composer(ctx, {
      placeholder: "Reply…",
      draftKey: "reply:i1",
      onDraftRestored: () => {
        restored = true;
      },
    });
    const ta = mount(c);
    await tick();
    expect(restored).toBe(true);
    expect(ta.value).toBe("see @claire and @ghost");
    expect(c.value()).toEqual({
      text: "see @Claire and @ghost",
      tokens: [{ t: "actor", actorId: P_CLAIRE, spans: [{ start: 4, length: 7 }] }],
    });
  });

  test("typing saves the draft after the 300ms debounce", async () => {
    const { ctx, drafts } = makeCtx();
    const c = composer(ctx, { placeholder: "Reply…", draftKey: "reply:i2" });
    const ta = mount(c);
    typeInto(ta, "ping @claire");
    expect(drafts.has("c1:reply:i2")).toBe(false);
    await new Promise((r) => setTimeout(r, 350));
    expect(drafts.get("c1:reply:i2")).toBe("ping @claire");
  });

  test("flush() persists the in-flight draft before the 300ms debounce fires", async () => {
    const { ctx, drafts } = makeCtx();
    const c = composer(ctx, { placeholder: "Reply…", draftKey: "reply:i9" });
    const ta = mount(c);
    typeInto(ta, "typed just now");
    expect(drafts.has("c1:reply:i9")).toBe(false); // debounce still pending
    c.flush();
    await tick();
    expect(drafts.get("c1:reply:i9")).toBe("typed just now");
  });

  test("clear() empties the field, cancels the pending save, drops the draft", async () => {
    const { ctx, drafts } = makeCtx();
    drafts.set("c1:reply:i3", "old");
    const c = composer(ctx, { placeholder: "Reply…", draftKey: "reply:i3" });
    const ta = mount(c);
    await tick();
    typeInto(ta, "unsent words");
    c.clear();
    await new Promise((r) => setTimeout(r, 350));
    expect(ta.value).toBe("");
    expect(drafts.has("c1:reply:i3")).toBe(false);
  });

  test("blur without returning focus closes the trigger popover", async () => {
    const { ctx } = makeCtx();
    const c = composer(ctx, { placeholder: "Reply…" });
    const ta = mount(c);
    typeInto(ta, "@cl");
    expect(c.node.querySelector(".pick-row")).not.toBeNull();
    ta.dispatchEvent(new Event("blur"));
    await new Promise((r) => setTimeout(r, 150));
    expect(c.node.querySelector(".pick-row")).toBeNull();
  });

  test("focus returning inside the blur grace window keeps the popover open", async () => {
    // The toolbar '@' path in Chromium: mousedown blurs, click refocuses and
    // opens — a stale grace timer must not kill the popover it re-opened.
    const { ctx } = makeCtx();
    const c = composer(ctx, { placeholder: "Reply…" });
    const ta = mount(c);
    typeInto(ta, "@cl");
    ta.dispatchEvent(new Event("blur"));
    ta.dispatchEvent(new Event("focus"));
    await new Promise((r) => setTimeout(r, 150));
    expect(c.node.querySelector(".pick-row")).not.toBeNull();
  });

  test("Enter sends (popover closed); Shift+Enter and synthetic Enter do not", () => {
    const { ctx } = makeCtx();
    let sends = 0;
    const c = composer(ctx, { placeholder: "Reply…", onSubmit: () => sends++ });
    const ta = mount(c);
    typeInto(ta, "hello");

    // Shift+Enter is a newline, never a send.
    ta.dispatchEvent(trustedKeydown({ key: "Enter", shiftKey: true }));
    expect(sends).toBe(0);

    // A synthetic (untrusted) Enter must never send.
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    expect(sends).toBe(0);

    // A trusted, unshifted Enter with the popover closed sends.
    const e = trustedKeydown({ key: "Enter" });
    ta.dispatchEvent(e);
    expect(sends).toBe(1);
    expect(e.defaultPrevented).toBe(true);
  });

  test("Enter accepts the open popover row instead of sending", () => {
    const { ctx } = makeCtx();
    let sends = 0;
    const c = composer(ctx, { placeholder: "Reply…", onSubmit: () => sends++ });
    const ta = mount(c);
    typeInto(ta, "@cl");
    expect(c.node.querySelector(".pick-row")).not.toBeNull();
    ta.dispatchEvent(trustedKeydown({ key: "Enter" }));
    expect(sends).toBe(0);
    expect(ta.value).toBe("@claire ");
  });

  test("Shift+Enter with the popover open is a newline, not a row-accept", () => {
    const { ctx } = makeCtx();
    const c = composer(ctx, { placeholder: "Reply…" });
    const ta = mount(c);
    typeInto(ta, "@cl");
    expect(c.node.querySelector(".pick-row")).not.toBeNull();
    const e = trustedKeydown({ key: "Enter", shiftKey: true });
    ta.dispatchEvent(e);
    // The composer must not swallow it into an accept — the textarea keeps its
    // own default (newline), so value() still holds the raw trigger.
    expect(ta.value).toBe("@cl");
    expect(e.defaultPrevented).toBe(false);
  });

  test("auto-repeat and IME-composition Enter never send", () => {
    const { ctx } = makeCtx();
    let sends = 0;
    const c = composer(ctx, { placeholder: "Reply…", onSubmit: () => sends++ });
    const ta = mount(c);
    typeInto(ta, "hello");
    ta.dispatchEvent(trustedKeydown({ key: "Enter", repeat: true }));
    ta.dispatchEvent(trustedKeydown({ key: "Enter", isComposing: true }));
    expect(sends).toBe(0);
  });

  test("a directory-known @mention paints a tinted pill in the backdrop", () => {
    const { ctx } = makeCtx();
    const c = composer(ctx, { placeholder: "Reply…" });
    const ta = mount(c);
    typeInto(ta, "ping @claire and @ghost");
    const pills = c.node.querySelectorAll(".mention-hl");
    // Only the KNOWN person gets a pill; @ghost stays plain.
    expect(pills.length).toBe(1);
    const pill = pills[0] as HTMLElement;
    expect(pill.textContent).toBe("@claire");
    expect(pill.style.getPropertyValue("--tint")).toBe("#8b5cf6");
  });

  test("a per-screen cap flows into value()'s token accounting", () => {
    const { ctx } = makeCtx();
    const c = composer(ctx, { placeholder: "Comment…", cap: 6 });
    const ta = mount(c);
    typeInto(ta, "hi @alice yes");
    expect(c.value()).toEqual({ text: "hi @al" });
  });
});
