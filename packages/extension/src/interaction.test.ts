// Unit tests for the interaction page's `attachmentsSection` evidence-card
// builder (the DOM surface that lives in interaction.ts, not in the pure
// view-model). The pure view-model helpers are tested in @onlay/render's
// interaction-view.test.ts; this file owns the one builder that touches the DOM
// and rides chrome's getCapturePart transport, so it must live beside its
// module (a dynamic `import("./interaction")`).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CaptureRef, RawInteractionSnapshot } from "@onlay/protocol";
import { Window } from "happy-dom";

const askSnapshot = (over: Partial<RawInteractionSnapshot> = {}): RawInteractionSnapshot => ({
  id: "11111111-1111-4111-8111-111111111111",
  kind: "ask",
  anchor: { level: "unanchored" },
  authorId: "planner-agent",
  participants: ["planner-agent", "adel"],
  waitingOn: ["adel"],
  state: "open",
  thread: [],
  ask: {
    question: "Ship it?",
    context: "the release is staged",
    waitingOn: ["adel"],
    selection: { min: 1, max: 1, submit: "immediate" },
    options: [
      { id: "yes", label: "Ship" },
      { id: "no", label: "Hold" },
    ],
    answers: [],
  },
  createdAt: Date.now(),
  ...over,
});

const captureRef = (over: Partial<CaptureRef> = {}): CaptureRef => ({
  captureId: "cap00001",
  interactionId: "11111111-1111-4111-8111-111111111111",
  kind: "attachment",
  lineageId: "cap00001",
  revision: 1,
  capturedAt: Date.now(),
  capturedBy: "adel",
  capturedFrom: "cli",
  format: "image/png",
  totalBytes: 2048,
  parts: [{ name: "file", role: "file", mime: "image/png", byteLen: 2048 }],
  caption: "look here",
  ...over,
});

/* ── attachmentsSection: the evidence card (happy-dom) ───────────────── */

// interaction.ts touches the DOM at module-eval only for `getElementById("root")`
// (null under test → its auto-pull never boots) and defines section builders; we
// install happy-dom + a chrome/URL stub, then dynamically import the module and
// exercise attachmentsSection directly.
const DOM_GLOBALS = [
  "window",
  "document",
  "location",
  "Element",
  "HTMLElement",
  "Node",
  "Event",
  "MouseEvent",
  "CSSStyleSheet",
  "DOMParser",
  "crypto",
  "chrome",
  "navigator",
  "URL",
  "Blob",
] as const;
const domSaved: Record<string, PropertyDescriptor | undefined> = {};

let capturePartReply: { ok: boolean; b64?: string; mime?: string } = { ok: false };
const mintedUrls: string[] = [];

function chromeMock(): unknown {
  return {
    runtime: {
      sendMessage: (msg: { type?: string }) =>
        msg?.type === "getCapturePart"
          ? Promise.resolve(capturePartReply)
          : Promise.resolve({ ok: false }),
      onMessage: { addListener: () => {} },
    },
    storage: {
      local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      onChanged: { addListener: () => {} },
    },
  };
}

const snapshotWith = (captures: CaptureRef[]): RawInteractionSnapshot =>
  askSnapshot({ kind: "comment", ask: undefined, captures });

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("attachmentsSection (happy-dom evidence card)", () => {
  let win: Window | null = null;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic module handle for the guarded entry.
  let mod: any;

  beforeEach(async () => {
    win = new Window({ url: "chrome-extension://x/interaction.html" });
    capturePartReply = { ok: false };
    mintedUrls.length = 0;
    const g = globalThis as unknown as Record<string, unknown>;
    for (const k of DOM_GLOBALS) domSaved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    g.window = win;
    g.document = win.document;
    g.location = win.location;
    for (const k of [
      "Element",
      "HTMLElement",
      "Node",
      "Event",
      "MouseEvent",
      "CSSStyleSheet",
      "DOMParser",
    ])
      g[k] = (win as unknown as Record<string, unknown>)[k];
    g.navigator = win.navigator;
    g.crypto = win.crypto;
    g.chrome = chromeMock();
    // Blob is a bun global; give URL a createObjectURL/revoke the module can call.
    const FakeURL = win.URL as unknown as {
      createObjectURL?: (b: unknown) => string;
      revokeObjectURL?: (u: string) => void;
    };
    FakeURL.createObjectURL = () => {
      const u = `blob:stub/${mintedUrls.length}`;
      mintedUrls.push(u);
      return u;
    };
    FakeURL.revokeObjectURL = () => {};
    g.URL = FakeURL;
    g.Blob = (globalThis as unknown as { Blob: unknown }).Blob;
    mod = await import("./interaction");
  });

  afterEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    for (const k of DOM_GLOBALS) {
      if (domSaved[k]) Object.defineProperty(globalThis, k, domSaved[k]);
      else delete g[k];
    }
    win = null;
  });

  test("renders an evidence card — paperclip, tag, untrusted marker, NOT a render context", () => {
    const section = mod.attachmentsSection(snapshotWith([captureRef()])) as HTMLElement;
    expect(section).not.toBeNull();
    expect(section.className).toBe("attachments");
    const card = section.querySelector(".attachment-card");
    expect(card).not.toBeNull();
    // paperclip glyph (an svg path), the "attachment" tag, and the untrusted marker
    expect(card?.querySelector(".attachment-glyph svg path")).not.toBeNull();
    expect(card?.querySelector(".attachment-tag")?.textContent).toBe("attachment");
    expect(card?.querySelector(".attachment-untrusted")?.textContent).toBe("untrusted");
    // clearly evidence, NEVER a render context: no iframe, no variant stage/host
    expect(section.querySelector("iframe, .variant-stage, .stage-host")).toBeNull();
  });

  test("the legacy block preview renders only inside a sandboxed frame, never in this page", () => {
    const set = {
      setId: "set-1",
      status: "previewing",
      element: {
        selector: "#hero",
        tag: "div",
        classes: [],
        textSnippet: "Hi",
        markup: `<div id="hero" style="color:red"><img src="https://evil.example/p.gif"><script>alert(1)</script>Hi</div>`,
      },
      variants: [
        {
          variantId: "v1",
          label: "Bold",
          program: [{ op: "setText", target: ":scope", text: "Hello" }],
          version: 1,
        },
      ],
    };
    const pristine = mod.stagePristine(set) as Element;
    expect(pristine.ownerDocument).not.toBe(document);
    const stage = mod.variantStage(
      set,
      pristine,
      "11111111-2222-4333-8444-555555555555",
      async () => {},
    ) as HTMLElement;
    document.body.appendChild(stage);
    const frame = stage.querySelector("iframe") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.srcdoc).toContain("default-src 'none'");
    expect(frame.srcdoc).not.toContain("<script");
    // Nothing captured was imported into the extension's own document.
    expect(document.querySelector("img, #hero")).toBeNull();
    expect(stage.querySelector(".stage-host")?.shadowRoot ?? null).toBeNull();
  });

  test("no attachments → null section", () => {
    expect(mod.attachmentsSection(snapshotWith([]))).toBeNull();
  });

  test("caption is set via textContent (untrusted), never parsed as markup", () => {
    const section = mod.attachmentsSection(
      snapshotWith([captureRef({ caption: "<img src=x onerror=alert(1)> hi" })]),
    ) as HTMLElement;
    const cap = section.querySelector(".attachment-caption");
    expect(cap?.textContent).toBe("<img src=x onerror=alert(1)> hi");
    // textContent, not innerHTML: the "<img>" is inert text, not a child element.
    expect(cap?.querySelector("img")).toBeNull();
  });

  test("image path: decodes b64 from getCapturePart and mounts an object URL", async () => {
    capturePartReply = { ok: true, b64: btoa("PNGBYTES"), mime: "image/png" };
    const section = mod.attachmentsSection(snapshotWith([captureRef()])) as HTMLElement;
    const img = section.querySelector(".attachment-image") as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src") ?? "").toBe(""); // async — not yet resolved
    await flush();
    expect(mintedUrls.length).toBe(1);
    expect(img?.src).toBe(mintedUrls[0]);
  });

  test("non-image path: a download affordance, no inline render", () => {
    const section = mod.attachmentsSection(
      snapshotWith([
        captureRef({
          format: "application/pdf",
          parts: [{ name: "file", role: "file", mime: "application/pdf", byteLen: 2048 }],
        }),
      ]),
    ) as HTMLElement;
    expect(section.querySelector(".attachment-image")).toBeNull();
    expect(section.querySelector(".attachment-download")?.textContent).toBe("Download");
  });
});
