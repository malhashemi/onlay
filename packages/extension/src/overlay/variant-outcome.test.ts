import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MutationProgram } from "@onlay/protocol";
import { createPreviewEngine } from "@onlay/render";
import { Window } from "happy-dom";
import { sanitizeElement } from "./sanitize";
import {
  liveOutcomeOf,
  type OutcomeDeps,
  outcomeAgainstCopy,
  outcomeLine,
  type RedactedCopy,
  reportVariantOutcome,
} from "./variant-outcome";

let win: Window | null = null;

function installDom(html: string): void {
  win = new Window({ url: "https://shop.example/p/1" });
  const g = globalThis as unknown as Record<string, unknown>;
  for (const k of [
    "DOMParser",
    "Element",
    "HTMLElement",
    "Node",
    "Text",
    "Document",
    "DocumentFragment",
    "MutationObserver",
  ])
    g[k] = (win as unknown as Record<string, unknown>)[k];
  g.window = win;
  g.document = win.document;
  win.document.body.innerHTML = html;
}

beforeEach(() => installDom(""));
afterEach(() => {
  void win?.happyDOM.abort();
  win?.close();
  win = null;
});

/** The redacted copy of `#block`, as a Variants upload carries it. */
function copyOf(id = "block", bound = () => true): RedactedCopy {
  const c = sanitizeElement(document.getElementById(id) as Element, 131_072, {
    keepSelectors: true,
  });
  return {
    html: c.html,
    page: false,
    reduced: c.truncated || c.reduced !== undefined,
    base: "https://shop.example/p/1",
    bound,
  };
}

/** A block holding everything the redaction policy keeps in the browser. */
const PAGE_WITH_SECRETS = `
  <p class="outside">Outside the block</p>
  <section id="block" class="pdp">
    <p class="copy">Copy</p>
    <form><input type="hidden" name="csrf" value="tok-123"></form>
    <input class="opt" type="checkbox" checked value="yes">
    <input class="email" type="text" value="ada@example.com">
    <div class="tracked" data-secret="s3cr3t">Tracked</div>
    <div class="later" hidden><span class="hidden-child">Hidden</span></div>
    <a class="link" href="https://shop.example/cart?session=abc">Cart</a>
  </section>`;

/** Steps whose results, on the live page, would read out what redaction hides. */
const PROBES: MutationProgram = [
  { op: "setText", target: ".copy", text: "Landed" },
  { op: "setStyle", target: "input[type=hidden]", props: [{ prop: "color", value: "red" }] },
  { op: "setStyle", target: "[value='tok-123']", props: [{ prop: "color", value: "red" }] },
  { op: "setStyle", target: "input:checked", props: [{ prop: "color", value: "red" }] },
  { op: "setStyle", target: "[value^='ada']", props: [{ prop: "color", value: "red" }] },
  { op: "setStyle", target: "[data-secret]", props: [{ prop: "color", value: "red" }] },
  { op: "setStyle", target: ".hidden-child", props: [{ prop: "color", value: "red" }] },
  { op: "setStyle", target: "a[href*='session']", props: [{ prop: "color", value: "red" }] },
  { op: "setStyle", target: ":hover", props: [{ prop: "color", value: "red" }] },
  { op: "setStyle", target: ".outside", props: [{ prop: "color", value: "red" }] },
];

describe("the report is computed against the redacted copy, never the live page (audit 1)", () => {
  test("a selector over anything redaction hides is 'not there', whatever the live page holds", () => {
    installDom(PAGE_WITH_SECRETS);
    // The live page would match most of these (the panel's business only).
    const live = createPreviewEngine(document).apply(PROBES, "#block");
    expect(live.ok && live.applied).toBeGreaterThan(4);
    const r = outcomeAgainstCopy(copyOf(), PROBES);
    expect(r).not.toBeNull();
    expect(r?.applied).toBe(1);
    expect(r?.refused.map((x) => x.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(new Set(r?.refused.map((x) => x.reason))).toEqual(new Set(["target-missing"]));
  });

  test("the same copy gives the same result, whatever the live page does next", () => {
    installDom(PAGE_WITH_SECRETS);
    const copy = copyOf();
    const before = outcomeAgainstCopy(copy, PROBES);
    (document.querySelector(".later") as HTMLElement).removeAttribute("hidden");
    document.querySelector(".copy")?.remove();
    expect(outcomeAgainstCopy(copy, PROBES)).toEqual(before);
  });

  test("a copy reduced to fit says so", () => {
    installDom(`<ul id="block" class="list"><li class="cell">1</li></ul>`);
    const r = outcomeAgainstCopy({ ...copyOf(), reduced: true }, [
      { op: "setText", target: ".cell", text: "2" },
    ]);
    expect(r).toEqual({ steps: 1, applied: 1, refused: [], reducedCopy: true });
  });

  test("a copy that doesn't parse to its block reports nothing", () => {
    installDom(PAGE_WITH_SECRETS);
    expect(outcomeAgainstCopy({ ...copyOf(), html: "" }, PROBES)).toBeNull();
  });
});

function deps(over: Partial<OutcomeDeps> = {}): OutcomeDeps & { sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    selfId: () => "p_ada",
    account: () => "p_ada|https://app.onlay.dev",
    ownsEdit: () => true,
    frameUrl: () => "https://shop.example/p/1",
    send: async (frame) => {
      sent.push(frame);
      return { ok: true };
    },
    ...over,
  };
}

const target = (variantId: string, by = "p_ada") => ({
  setId: "set-1",
  spaceId: "s_1",
  changeInteractionId: "edit-1",
  variant: {
    variantId,
    version: 1,
    by,
    program: [
      { op: "setText", target: ".copy", text: "X" },
      { op: "setText", target: ".nope", text: "Y" },
    ] as MutationProgram,
  },
});

describe("who reports, and when", () => {
  test("the author reports their own variant once per version, integers and codes only", () => {
    installDom(PAGE_WITH_SECRETS);
    const d = deps();
    expect(reportVariantOutcome(d, target("v-once"), copyOf())).toBe(true);
    expect(reportVariantOutcome(d, target("v-once"), copyOf())).toBe(false);
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0]).toMatchObject({
      type: "variant-outcome",
      variantId: "v-once",
      version: 1,
      steps: 2,
      applied: 1,
      refused: [{ index: 1, reason: "target-missing" }],
    });
    expect(d.sent[0]?.rootMissing).toBeUndefined();
  });

  test("nobody else's variant, no Edit this tab doesn't hold, no copy that no longer holds", () => {
    installDom(PAGE_WITH_SECRETS);
    expect(reportVariantOutcome(deps(), target("v-other", "p_bea"), copyOf())).toBe(false);
    expect(reportVariantOutcome(deps({ ownsEdit: () => false }), target("v-x"), copyOf())).toBe(
      false,
    );
    expect(reportVariantOutcome(deps({ account: () => null }), target("v-y"), copyOf())).toBe(
      false,
    );
    expect(
      reportVariantOutcome(
        deps(),
        target("v-z"),
        copyOf("block", () => false),
      ),
    ).toBe(false);
  });
});

describe("the panel's live line", () => {
  test("a preview held off while a look is taken tells nothing (audit 3)", () => {
    expect(liveOutcomeOf({ ok: true, token: 0, applied: 0 }, 3)).toBeNull();
  });

  test("says how many steps couldn't be applied, by kind, in plain words", () => {
    expect(
      outcomeLine({
        steps: 12,
        applied: 9,
        refused: [
          { index: 0, reason: "fragment-empty" },
          { index: 4, reason: "target-missing" },
          { index: 7, reason: "target-missing" },
        ],
      }),
    ).toBe(
      "3 of 12 steps couldn't be applied: 2 didn't match anything on this page; 1 adds nothing visible.",
    );
    expect(
      outcomeLine({ steps: 1, applied: 0, refused: [{ index: 0, reason: "url-origin" }] }),
    ).toBe("1 step couldn't be applied: 1 isn't allowed on a live page.");
    expect(outcomeLine({ steps: 2, applied: 2, refused: [] })).toBe("");
    // A missing block is said once, on the status line, not here too.
    expect(outcomeLine({ steps: 2, applied: 0, refused: [], rootMissing: true })).toBe("");
  });
});
