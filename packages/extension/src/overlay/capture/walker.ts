// The composed-tree walker (Stage 1 capture spec §1, §2).
//
// Pure over the live DOM (isolated world, no chrome.*). Given the picked block,
// it flattens the composed tree — descending open shadow roots, expanding
// <slot>s to their assigned nodes, reserving boxes for closed roots / replaced
// content — reads each node's curated computed styles (§1.2) with parent-delta
// suppression (§1.2), synthesizes ::before/::after (§1.4), rewrites img /
// background url()s to `{{asset:…}}` part placeholders (§1.3), and serializes
// the ancestor spine + bounded sibling habitat (§1.5) into ONE scriptless HTML
// document whose baseline is a low-specificity `[data-oc="n"]` sheet (D1). Every
// unreproducible thing is metered as residue (§6), never dropped silently.
//
// The document part harvest fills later (the `#oc-fonts` sheet and the separate
// authorsheet are §4's job); the walker leaves `#oc-fonts` empty and hands back
// the assetRefs to fetch. No innerHTML anywhere: the document is built with
// createElement into a detached HTMLDocument and read via outerHTML (which,
// unlike XMLSerializer, preserves the `<style>` raw text — proto gate §9).
import { LIMITS } from "@onlay/protocol";
import { overlayHost } from "../host";
import { renderedText } from "../rendered";
import { CAPTURE_STYLE_PROPS, INHERITED_STYLE_PROPS, URL_BEARING_PROPS } from "./allowlist";
import { cssUrl, hasImageValue, rewriteImageUrls, withoutImages } from "./css-images";
import { fnv8 } from "./hash";
import { CAPTURE_LIMITS, type CaptureLimits } from "./limits";
import { type ResidueEntry, ResidueLog } from "./residue";

/** In-frame meta CSP for the render document (§1.1) — no active content, no egress. */
const CAPTURE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; " +
  "base-uri 'none'; form-action 'none'";

export interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  left: number;
}

export interface CaptureViewport {
  innerWidth: number;
  innerHeight: number;
  dpr: number;
  scrollX: number;
  scrollY: number;
  layoutWidth: number;
}

/** The DOM/layout readers, injectable so the walker is unit-testable under happy-dom. */
export interface WalkEnv {
  styleOf(el: Element, pseudo?: string | null): CSSStyleDeclaration;
  rectOf(el: Element): RectLike;
  viewport(): CaptureViewport;
  baseUrl: string;
}

export interface AssetRef {
  ref: string; // stable 8-hex placeholder id (`{{asset:<ref>}}` ↔ part `asset-<ref>`)
  url: string; // absolute URL to fetch
  origin: string; // for grant-check + declined-grant metering
  kind: "img" | "background";
}

export interface WalkOptions {
  block: Element;
  env?: Partial<WalkEnv>;
  /** Onlay's own overlay host (skipped whole); defaults to the host this script mounted. */
  overlayRoot?: Element | null;
  /** Override the closed-shadow heuristic (§2) — tests pass an explicit predicate. */
  closedShadow?: (el: Element) => boolean;
  /** Partial ceiling overrides (tests shrink MAX_CAPTURE_NODES etc). */
  limits?: Partial<CaptureLimits>;
}

export interface WalkMeta {
  viewport: { innerWidth: number; innerHeight: number; dpr: number; layoutWidth: number };
  blockRect: { x: number; y: number; width: number; height: number };
  habitatRect: { x: number; y: number; width: number; height: number };
}

export interface WalkResult {
  documentHtml: string;
  ocBaseCss: string;
  assetRefs: AssetRef[];
  residue: ResidueEntry[];
  nodeCount: number;
  meta: WalkMeta;
}

/** Elements dropped whole — never serialized, not even as a box (no visual, all code/foreign). */
const DROP_ELEMENTS = new Set([
  "script",
  "style",
  "link",
  "noscript",
  "template",
  "meta",
  "title",
  "base",
  "head",
]);

/** Replaced/plugin elements → reserved box + canvas-video-content residue (§1.1). */
const REPLACED_ELEMENTS = new Set(["canvas", "video", "object", "embed"]);

/** SVG geometry/paint attributes preserved verbatim (they render inertly, §1.1). */
const SVG_ATTRS = new Set([
  "viewbox",
  "d",
  "points",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "width",
  "height",
  "fill",
  "fill-rule",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-opacity",
  "opacity",
  "transform",
  "gradientunits",
  "gradienttransform",
  "offset",
  "stop-color",
  "stop-opacity",
  "preserveaspectratio",
  "patternunits",
  "spreadmethod",
  "href",
  "xlink:href",
  "clip-path",
  "clip-rule",
  "text-anchor",
  "dominant-baseline",
  "font-size",
  "font-family",
]);

interface TextRun {
  text: string;
}
interface SerialNode {
  oc: number;
  tag: string;
  realTag: string;
  isCustom: boolean;
  attrs: Array<[string, string]>;
  decls: Array<[string, string]>;
  customDecls: Array<[string, string]>;
  before: Array<[string, string]> | null;
  after: Array<[string, string]> | null;
  children: Array<SerialNode | TextRun>;
  isBlock: boolean;
}

function defaultEnv(): WalkEnv {
  return {
    styleOf: (el, pseudo) =>
      getComputedStyle(el, pseudo ?? undefined) as unknown as CSSStyleDeclaration,
    rectOf: (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, left: r.left };
    },
    viewport: () => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      layoutWidth: document.documentElement.clientWidth || window.innerWidth,
    }),
    baseUrl: typeof document !== "undefined" ? document.baseURI : "http://localhost/",
  };
}

/** Enumerate a computed style's `--*` custom-property names (§1.2 A17). */
function customPropNames(cs: CSSStyleDeclaration): string[] {
  const names: string[] = [];
  try {
    for (const n of cs as unknown as Iterable<string>) {
      if (typeof n === "string" && n.startsWith("--")) names.push(n);
    }
  } catch {
    /* not iterable in this engine */
  }
  if (names.length === 0) {
    const len = (cs as unknown as { length?: number }).length ?? 0;
    for (let i = 0; i < len; i += 1) {
      const n = (cs as unknown as Record<number, string>)[i];
      if (typeof n === "string" && n.startsWith("--")) names.push(n);
    }
  }
  return names;
}

export function walk(opts: WalkOptions): WalkResult {
  const env: WalkEnv = { ...defaultEnv(), ...opts.env };
  const L = { ...CAPTURE_LIMITS, ...opts.limits };
  const block = opts.block;
  const residue = new ResidueLog();
  const assetMap = new Map<string, AssetRef>();
  const overlayRoot = opts.overlayRoot ?? null;

  let ocCounter = 0;
  let nodeCount = 0;
  let steps = 0;

  function budgetLeft(): boolean {
    steps += 1;
    return nodeCount < L.MAX_CAPTURE_NODES && steps < L.MAX_WALK_STEPS;
  }

  function isOverlay(el: Element): boolean {
    return el === overlayRoot || el === overlayHost();
  }

  function resolveUrl(url: string): string | null {
    try {
      return new URL(url, env.baseUrl).href;
    } catch {
      return null;
    }
  }

  function originOf(url: string): string {
    try {
      return new URL(url).origin;
    } catch {
      return "";
    }
  }

  function assetRef(abs: string, kind: "img" | "background"): string {
    const existing = assetMap.get(abs);
    if (existing) return existing.ref;
    const ref = fnv8(abs);
    assetMap.set(abs, { ref, url: abs, origin: originOf(abs), kind });
    return ref;
  }

  /**
   * Rewrite every image reference in a computed value to `url({{asset:<ref>}})`
   * (every form, C-3, through the one quote-aware scan, 2-C2); gradients pass through.
   */
  function rewriteUrls(value: string): string {
    return rewriteImageUrls(value, (url, whole) => {
      // An empty target names nothing: never resolved to the page's own URL (3-C3).
      if (!url) return "none";
      // A same-document reference (an SVG paint server, clip or filter) is no resource.
      if (url.startsWith("#")) return whole;
      if (url.startsWith("data:")) {
        if (url.length > LIMITS.MAX_CAPTURE_PART_BYTES) {
          residue.add("oversize-truncation");
          return "none";
        }
        return cssUrl(url);
      }
      const abs = resolveUrl(url);
      if (!abs) {
        residue.add("stripped-url");
        return "none";
      }
      return `url({{asset:${assetRef(abs, "background")}}})`;
    });
  }

  function imgPlaceholder(el: Element): string | null {
    const img = el as HTMLImageElement;
    const src = img.currentSrc || el.getAttribute("src") || "";
    if (!src) return null;
    if (src.startsWith("data:")) {
      if (src.length > LIMITS.MAX_CAPTURE_PART_BYTES) {
        residue.add("oversize-truncation");
        return null;
      }
      return src;
    }
    const abs = resolveUrl(src);
    if (!abs) {
      residue.add("stripped-url");
      return null;
    }
    return `{{asset:${assetRef(abs, "img")}}}`;
  }

  function keptAttrs(el: Element, inSvg: boolean): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    const real = el.localName;
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) continue;
      if (name === "style" || name === "srcset" || name === "sizes") continue;
      if (name.startsWith("data-onlay-")) continue;
      // Minted block-identity metadata (§1.1) — never copy a page-supplied
      // `data-oc`/`data-oc-*`, or a page could overwrite node 0's key, plant a
      // decoy `[data-oc-block]`, or mis-key the `[data-oc="n"]` sheet.
      if (name === "data-oc" || name.startsWith("data-oc-")) continue;
      if (name === "class" || name === "id" || name === "lang" || name === "dir") {
        out.push([attr.name, attr.value]);
        continue;
      }
      // No page `data-*` travels (R2-C5): application state rides there.
      if (name.startsWith("data-")) continue;
      // Ordered-list ordinal state (§1.4/D12): the flattened <ol>/<li> render
      // native markers, so preserving `start`/`reversed`/`value` reproduces the
      // real ordinal sequence (honoring list-style-type from the computed sheet)
      // WITHOUT materializing ::marker text — computed style never exposes the
      // marker glyph (proto Q3), so this is the faithful path.
      if (real === "ol" && (name === "start" || name === "reversed")) {
        out.push([attr.name, attr.value]);
        continue;
      }
      if (real === "li" && name === "value") {
        out.push([attr.name, attr.value]);
        continue;
      }
      if (inSvg && SVG_ATTRS.has(name)) {
        // SVG <use>/<image> ref (§1.1): a same-document `#fragment` resolves
        // inside the serialized SVG and is kept; a cross-document URL would be a
        // live external ref (no <symbol> inlining yet) → drop + meter stripped-url.
        if ((name === "href" || name === "xlink:href") && !attr.value.trim().startsWith("#")) {
          residue.add("stripped-url");
          continue;
        }
        out.push([attr.name, attr.value]);
        continue;
      }
      if (name === "width" || name === "height") {
        out.push([attr.name, attr.value]);
      }
      // everything else (src/href/target/rel/role/aria-*/…) is dropped
    }
    return out;
  }

  function isInline(cs: CSSStyleDeclaration): boolean {
    const d = cs.getPropertyValue("display");
    return d.startsWith("inline") || d === "contents";
  }

  function isClosedShadowHost(el: Element): boolean {
    if (opts.closedShadow) return opts.closedShadow(el);
    // Heuristic (§2): a defined custom element with no reachable shadow root and
    // no light children that still occupies layout is hiding content in a closed
    // root. A custom element WITH light children flattens them (D10) instead.
    if (!el.localName.includes("-")) return false;
    if (el.shadowRoot) return false;
    if (el.childElementCount > 0) return false;
    const defined = (globalThis as { customElements?: CustomElementRegistry }).customElements?.get(
      el.localName,
    );
    if (!defined) return false;
    const r = env.rectOf(el);
    return r.width > 0 || r.height > 0;
  }

  function hasVisibleDescendant(el: Element): boolean {
    for (const child of Array.from(el.children)) {
      const cs = env.styleOf(child);
      const v = cs.getPropertyValue("visibility");
      if (v !== "hidden" && v !== "collapse" && cs.getPropertyValue("display") !== "none")
        return true;
      if (hasVisibleDescendant(child)) return true;
    }
    return false;
  }

  /** Visibility pruning (§2). Returns true when the node (and subtree) is skipped. */
  function shouldPrune(el: Element, cs: CSSStyleDeclaration): boolean {
    if (cs.getPropertyValue("display") === "none") return true;
    if (cs.getPropertyValue("content-visibility") === "hidden") return true;
    const vis = cs.getPropertyValue("visibility");
    if ((vis === "hidden" || vis === "collapse") && !hasVisibleDescendant(el)) return true;
    const r = env.rectOf(el);
    if (r.width === 0 && r.height === 0 && el.childElementCount === 0) return true;
    return false;
  }

  /** Curated computed declarations with parent-delta suppression (§1.2). */
  function curate(
    cs: CSSStyleDeclaration,
    parentCs: CSSStyleDeclaration | null,
    isRoot: boolean,
    /** An ancestor outside the block: style context, but no image of its own (3b-C7). */
    ancestor = false,
  ): { decls: Array<[string, string]>; customDecls: Array<[string, string]> } {
    const decls: Array<[string, string]> = [];
    for (const prop of CAPTURE_STYLE_PROPS) {
      if (decls.length >= L.MAX_NODE_DECLS) break;
      const v = cs.getPropertyValue(prop);
      if (!v) continue;
      // `-webkit-text-fill-color` wins over `color` in text paint; emitting it
      // when it just equals `color` (the ubiquitous case) would freeze the base
      // color and shadow every text-color variant. Keep it ONLY when genuinely
      // divergent (text-stroke effects), so `setStyle`/class color variants stay
      // faithful (render §1.4). Ledger deviation from §1.2's flat allowlist.
      if (prop === "-webkit-text-fill-color" && v === cs.getPropertyValue("color")) continue;
      if (INHERITED_STYLE_PROPS.has(prop) && parentCs && parentCs.getPropertyValue(prop) === v) {
        continue; // inherits from the serialized parent for free
      }
      // Any value that can name an image, in any form (C-3): an ancestor's
      // points at none, a block node's goes through the one rewrite.
      if (URL_BEARING_PROPS.has(prop) || hasImageValue(v)) {
        decls.push([prop, ancestor ? withoutImages(v) : rewriteUrls(v)]);
      } else {
        decls.push([prop, v]);
      }
    }
    const customDecls: Array<[string, string]> = [];
    if (!isRoot) {
      for (const name of customPropNames(cs)) {
        let v = cs.getPropertyValue(name).trim();
        const pv = parentCs ? parentCs.getPropertyValue(name).trim() : "";
        if (!v || v === pv) continue;
        if (hasImageValue(v)) {
          // An image in a custom property travels only through the property
          // that uses it (its computed value names it): the property itself
          // points at none, and an ancestor's goes altogether (C-3).
          if (ancestor) continue;
          v = withoutImages(v);
        }
        customDecls.push([name, v]);
      }
    }
    return { decls, customDecls };
  }

  /** Synthesize a ::before/::after rule (§1.4), or null when there is no generated content. */
  function pseudo(el: Element, which: "::before" | "::after"): Array<[string, string]> | null {
    let cs: CSSStyleDeclaration;
    try {
      cs = env.styleOf(el, which);
    } catch {
      return null;
    }
    const content = cs.getPropertyValue("content");
    if (!content || content === "none" || content === "normal") return null;
    const host = env.styleOf(el);
    const decls: Array<[string, string]> = [];
    for (const prop of CAPTURE_STYLE_PROPS) {
      const v = cs.getPropertyValue(prop);
      if (!v) continue;
      if (prop === "-webkit-text-fill-color" && v === cs.getPropertyValue("color")) continue;
      if (INHERITED_STYLE_PROPS.has(prop) && host.getPropertyValue(prop) === v) continue;
      decls.push([prop, URL_BEARING_PROPS.has(prop) || hasImageValue(v) ? rewriteUrls(v) : v]);
    }
    let c = content;
    if (/counters?\(/.test(c)) {
      c = c.replace(/counters?\([^)]*\)/g, "").trim();
      residue.add("generated-content-lost");
    }
    if (hasImageValue(c)) c = rewriteUrls(c);
    decls.push(["content", c || '""']);
    return decls;
  }

  /** Composed children: shadow root children flattened; <slot> → assigned (or default) nodes. */
  function composedChildNodes(el: Element): Node[] {
    const base = el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes;
    const out: Node[] = [];
    for (const n of Array.from(base)) {
      if (n.nodeType === 1 && (n as Element).localName === "slot") {
        const slot = n as HTMLSlotElement;
        const assigned =
          typeof slot.assignedNodes === "function" ? slot.assignedNodes({ flatten: true }) : [];
        if (assigned.length > 0) out.push(...assigned);
        else out.push(...Array.from(slot.childNodes));
      } else {
        out.push(n);
      }
    }
    return out;
  }

  function textRun(node: Node, cap: number): TextRun | null {
    const raw = node.textContent ?? "";
    if (raw.length === 0) return null;
    if (raw.trim().length === 0) return { text: " " }; // collapse layout whitespace
    return { text: cap === Infinity ? raw : raw.slice(0, cap) };
  }

  /** Serialize one element (and, unless bounded/box, its composed subtree). */
  function serialize(
    el: Element,
    parentCs: CSSStyleDeclaration | null,
    depth: number,
    maxDepth: number,
    isBlock: boolean,
    inSvg: boolean,
  ): SerialNode | null {
    if (!budgetLeft()) {
      residue.add("oversize-truncation");
      return null;
    }
    if (isOverlay(el)) return null;
    const real = el.localName;
    if (DROP_ELEMENTS.has(real)) return null;
    const cs = env.styleOf(el);
    if (shouldPrune(el, cs)) return null;

    const nowInSvg = inSvg || real === "svg";
    let tag: string;
    let box = false;
    if (REPLACED_ELEMENTS.has(real)) {
      box = true;
      residue.add("canvas-video-content");
    } else if (real === "iframe") {
      // cross-origin / unreachable → reserved box; same-origin recursion is a
      // real-browser concern (harness), boxed honestly here.
      box = true;
      residue.add("cross-origin-frame");
    } else if (isClosedShadowHost(el)) {
      box = true;
      residue.add("closed-shadow-root");
    }
    if (box) {
      tag = isInline(cs) ? "span" : "div";
    } else {
      tag = real === "html" || real === "body" ? "div" : real;
    }

    const oc = ocCounter;
    ocCounter += 1;
    nodeCount += 1;

    const attrs = keptAttrs(el, nowInSvg);
    if (!box && real === "img") {
      const ph = imgPlaceholder(el);
      if (ph) attrs.push(["src", ph]);
    }
    const { decls, customDecls } = curate(cs, parentCs, false);
    const node: SerialNode = {
      oc,
      tag,
      realTag: real,
      isCustom: real.includes("-"),
      attrs,
      decls,
      customDecls,
      before: box ? null : pseudo(el, "::before"),
      after: box ? null : pseudo(el, "::after"),
      children: [],
      isBlock,
    };

    if (!box) {
      if (depth < maxDepth) {
        const cap = maxDepth === Infinity ? Infinity : L.MAX_SNIPPET;
        for (const child of composedChildNodes(el)) {
          if (nodeCount >= L.MAX_CAPTURE_NODES) {
            residue.add("oversize-truncation");
            break;
          }
          if (child.nodeType === 3) {
            // Text a person cannot see (visibility: hidden) never travels.
            const v = cs.getPropertyValue("visibility");
            if (v === "hidden" || v === "collapse") continue;
            const t = textRun(child, cap);
            if (t) node.children.push(t);
          } else if (child.nodeType === 1) {
            const kid = serialize(child as Element, cs, depth + 1, maxDepth, false, nowInSvg);
            if (kid) node.children.push(kid);
          }
        }
      } else {
        // depth ceiling (habitat): keep only truncated own RENDERED text
        const raw = renderedText(el, L.MAX_SNIPPET * 4).trim();
        if (raw) node.children.push({ text: raw.slice(0, L.MAX_SNIPPET) });
      }
    }
    return node;
  }

  /**
   * A sibling's slot, when layout needs it: an empty box of the same size in
   * the same flow position — no content, no attributes, no pseudo text. The
   * capture shows the chosen block and nothing beside it (R3-C3).
   */
  function emptySlot(el: Element): SerialNode | null {
    if (isOverlay(el) || DROP_ELEMENTS.has(el.localName)) return null;
    const cs = env.styleOf(el);
    if (shouldPrune(el, cs)) return null;
    const r = env.rectOf(el);
    const decls: Array<[string, string]> = [
      ["box-sizing", "border-box"],
      ["display", isInline(cs) ? "inline-block" : cs.getPropertyValue("display") || "block"],
      ["width", `${r.width}px`],
      ["height", `${r.height}px`],
    ];
    for (const prop of SLOT_LAYOUT_PROPS) {
      const v = cs.getPropertyValue(prop);
      if (v) decls.push([prop, v]);
    }
    nodeCount += 1;
    const tag = slotTag(el);
    // A cell keeps how many columns and rows it spans: numbers, no content.
    const attrs: Array<[string, string]> = [];
    if (tag === "td" || tag === "th") {
      for (const name of ["colspan", "rowspan"]) {
        const v = el.getAttribute(name);
        if (v !== null && /^\d{1,4}$/.test(v)) attrs.push([name, v]);
      }
    }
    return {
      oc: ocCounter++,
      tag,
      realTag: tag,
      isCustom: false,
      attrs,
      decls,
      customDecls: [],
      before: null,
      after: null,
      children: [],
      isBlock: false,
    };
  }

  /** Shallow spine ancestor: attrs + curated styles + pseudos, children chained manually. */
  function serializeShallow(el: Element, parentCs: CSSStyleDeclaration | null): SerialNode {
    const real = el.localName;
    const cs = env.styleOf(el);
    const oc = ocCounter;
    ocCounter += 1;
    nodeCount += 1;
    const { decls, customDecls } = curate(cs, parentCs, real === "html", true);
    return {
      oc,
      tag: real === "html" || real === "body" ? "div" : real,
      realTag: real,
      isCustom: real.includes("-"),
      attrs: keptAttrs(el, false),
      decls,
      customDecls,
      // An ancestor gives style context only: its pseudo-element content is
      // outside the chosen block and never travels (R3-C3).
      before: null,
      after: null,
      children: [],
      isBlock: false,
    };
  }

  // ── build the ancestor spine (bottom-up, then top-down) ──
  const spineEls: Element[] = [];
  {
    let p = block.parentElement;
    while (p && p.nodeType === 1) {
      if (!isOverlay(p)) spineEls.push(p);
      if (p.localName === "html") break;
      p = p.parentElement;
    }
  }
  spineEls.reverse(); // now top-down: html … block.parent
  let spine = spineEls;
  if (spine.length > L.MAX_SPINE_ANCESTORS) {
    residue.add("oversize-truncation");
    spine = [...spine.slice(0, 2), ...spine.slice(spine.length - (L.MAX_SPINE_ANCESTORS - 2))];
  }

  // ── habitat: block ± HABITAT_SIBLINGS intersecting siblings ──
  const parentEl = block.parentElement;
  const blockRectDoc = env.rectOf(block);
  const margin = blockRectDoc.height || 0;
  function intersectsBlock(el: Element): boolean {
    const r = env.rectOf(el);
    return !(
      r.left > blockRectDoc.left + blockRectDoc.width + margin ||
      r.left + r.width < blockRectDoc.left - margin ||
      r.top > blockRectDoc.top + blockRectDoc.height + margin ||
      r.top + r.height < blockRectDoc.top - margin
    );
  }
  function collectSiblings(dir: "prev" | "next"): Element[] {
    const out: Element[] = [];
    let sib: Element | null =
      dir === "prev" ? block.previousElementSibling : block.nextElementSibling;
    while (sib && out.length < L.HABITAT_SIBLINGS) {
      if (!isOverlay(sib) && !DROP_ELEMENTS.has(sib.localName) && intersectsBlock(sib)) {
        out.push(sib);
      }
      sib = dir === "prev" ? sib.previousElementSibling : sib.nextElementSibling;
    }
    return out;
  }
  const prevSibs = collectSiblings("prev").reverse(); // DOM order before the block
  const nextSibs = collectSiblings("next");

  // ── assemble: chain the spine, then attach habitat + block at the innermost ──
  const parentCsOf = (el: Element): CSSStyleDeclaration => env.styleOf(el);
  let rootNode: SerialNode | null = null;
  let innermost: SerialNode | null = null;
  let prevEl: Element | null = null;
  for (const anc of spine) {
    const n = serializeShallow(anc, prevEl ? parentCsOf(prevEl) : null);
    if (!rootNode) rootNode = n;
    if (innermost) innermost.children.push(n);
    innermost = n;
    prevEl = anc;
  }
  const parentCsForBlock = parentEl && !isOverlay(parentEl) ? env.styleOf(parentEl) : null;
  const habitatRects: RectLike[] = [blockRectDoc];
  const attach = (target: SerialNode | null, node: SerialNode | null): void => {
    if (!node) return;
    if (target) target.children.push(node);
    else rootNode = node;
  };
  // Siblings keep their slot (an empty box of the same size) and nothing else;
  // the raster is the block's own box (`habitatRects` holds only it).
  for (const s of prevSibs) attach(innermost, emptySlot(s));
  const blockNode = serialize(block, parentCsForBlock, 0, Infinity, true, false);
  if (blockNode) attach(innermost, blockNode);
  else if (!rootNode) {
    // block itself pruned/dropped — nothing to serialize; emit an empty box
    rootNode = {
      oc: ocCounter++,
      tag: "div",
      realTag: block.localName,
      isCustom: false,
      attrs: [],
      decls: [],
      customDecls: [],
      before: null,
      after: null,
      children: [],
      isBlock: true,
    };
  }
  for (const s of nextSibs) attach(innermost, emptySlot(s));
  if (!rootNode) rootNode = blockNode as SerialNode;

  // ── root custom properties (:root once, §1.2) ──
  const rootCustom: Array<[string, string]> = [];
  {
    // The block's own document's root: a block inside a frame (A-3) inherits none of the page's.
    const de =
      block.ownerDocument?.documentElement ??
      (typeof document !== "undefined" ? document.documentElement : (null as Element | null));
    if (de) {
      const cs = env.styleOf(de);
      for (const name of customPropNames(cs)) {
        const v = cs.getPropertyValue(name).trim();
        // A page-wide custom property holding an image, in any form, brings
        // no image along (3b-C7, C-3).
        if (v && !hasImageValue(v)) rootCustom.push([name, v]);
      }
    }
  }

  // ── assemble the oc-base sheet + the document ──
  const declStr = (pairs: Array<[string, string]>): string =>
    pairs.map(([p, v]) => `${p}:${v}`).join(";");
  const cssParts: string[] = ["html,body{margin:0;padding:0;background:transparent}"];
  if (rootCustom.length) cssParts.push(`:root{${declStr(rootCustom)}}`);
  const emitCss = (n: SerialNode): void => {
    const all = [...n.decls, ...n.customDecls];
    if (all.length) cssParts.push(`[data-oc="${n.oc}"]{${declStr(all)}}`);
    if (n.before) cssParts.push(`[data-oc="${n.oc}"]::before{${declStr(n.before)}}`);
    if (n.after) cssParts.push(`[data-oc="${n.oc}"]::after{${declStr(n.after)}}`);
    for (const c of n.children) if ("oc" in c) emitCss(c);
  };
  emitCss(rootNode);
  const ocBaseCss = cssParts.join("\n");

  const lang = spine[0]?.getAttribute("lang") ?? "";
  const dir = spine[0]?.getAttribute("dir") ?? "";
  const documentHtml = buildDocument(rootNode, ocBaseCss, lang, dir);

  // ── meta (document coords, CSS px, §1.6) ──
  const vp = env.viewport();
  const union = unionRect(habitatRects);
  const meta: WalkMeta = {
    viewport: {
      innerWidth: vp.innerWidth,
      innerHeight: vp.innerHeight,
      dpr: vp.dpr,
      layoutWidth: vp.layoutWidth,
    },
    blockRect: {
      x: blockRectDoc.left + vp.scrollX,
      y: blockRectDoc.top + vp.scrollY,
      width: blockRectDoc.width,
      height: blockRectDoc.height,
    },
    habitatRect: {
      x: union.left + vp.scrollX,
      y: union.top + vp.scrollY,
      width: union.width,
      height: union.height,
    },
  };

  return {
    documentHtml,
    ocBaseCss,
    assetRefs: [...assetMap.values()],
    residue: residue.toArray(),
    nodeCount,
    meta,
  };
}

/**
 * The empty slot's element, valid where the sibling stood (3b-C6): the HTML
 * parser moves a `div` out of a table row or section, so a slot there is an
 * empty cell or row; in a list an empty item; in a select an empty option;
 * inside a paragraph an empty span. Anywhere else, an empty `div`.
 */
export function slotTag(sibling: Element): string {
  const own = sibling.localName;
  // Inside an SVG, an HTML `div` would end the SVG on reparse and leave the
  // chosen shape outside it: the slot is an empty group in the same namespace.
  const SVG = "http://www.w3.org/2000/svg";
  if (sibling.namespaceURI === SVG && sibling.parentElement?.namespaceURI === SVG) return "g";
  const parent = sibling.parentElement?.localName ?? "";
  switch (parent) {
    case "tr":
      return own === "th" ? "th" : "td";
    case "thead":
    case "tbody":
    case "tfoot":
      return "tr";
    case "table":
      return ["caption", "colgroup", "thead", "tbody", "tfoot", "tr"].includes(own) ? own : "tbody";
    case "colgroup":
      return "col";
    case "ul":
    case "ol":
    case "menu":
      return "li";
    case "dl":
      return own === "dt" || own === "dd" ? own : "div";
    case "select":
    case "optgroup":
    case "datalist":
      return own === "optgroup" ? "optgroup" : "option";
    case "p":
      return "span";
    default:
      return "div";
  }
}

const SLOT_LAYOUT_PROPS = [
  "position",
  "float",
  "clear",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  "align-self",
  "order",
  "grid-column-start",
  "grid-column-end",
  "grid-row-start",
  "grid-row-end",
];

function unionRect(rects: RectLike[]): {
  left: number;
  top: number;
  width: number;
  height: number;
} {
  if (rects.length === 0) return { left: 0, top: 0, width: 0, height: 0 };
  let l = Infinity;
  let t = Infinity;
  let r = -Infinity;
  let b = -Infinity;
  for (const rc of rects) {
    l = Math.min(l, rc.left);
    t = Math.min(t, rc.top);
    r = Math.max(r, rc.left + rc.width);
    b = Math.max(b, rc.top + rc.height);
  }
  return { left: l, top: t, width: r - l, height: b - t };
}

/** Build the scriptless document via createElement + outerHTML (never innerHTML). */
function buildDocument(root: SerialNode, ocBaseCss: string, lang: string, dir: string): string {
  const doc = document.implementation.createHTMLDocument("");
  const de = doc.documentElement;
  de.setAttribute("data-oc-root", "");
  if (lang) de.setAttribute("lang", lang);
  if (dir) de.setAttribute("dir", dir);

  const metaCharset = doc.createElement("meta");
  metaCharset.setAttribute("charset", "utf-8");
  const metaCsp = doc.createElement("meta");
  metaCsp.setAttribute("http-equiv", "Content-Security-Policy");
  metaCsp.setAttribute("content", CAPTURE_CSP);
  const fonts = doc.createElement("style");
  fonts.id = "oc-fonts"; // harvest (§4) fills this later
  const base = doc.createElement("style");
  base.id = "oc-base";
  base.textContent = ocBaseCss;
  doc.head.append(metaCharset, metaCsp, fonts, base);

  doc.body.append(buildEl(doc, root));
  return `<!doctype html>\n${de.outerHTML}`;
}

function buildEl(doc: Document, node: SerialNode): Element {
  const el = doc.createElement(node.tag);
  el.setAttribute("data-oc", String(node.oc));
  if (node.tag !== node.realTag || node.isCustom) el.setAttribute("data-oc-tag", node.realTag);
  if (node.isBlock) el.setAttribute("data-oc-block", "");
  for (const [name, value] of node.attrs) {
    try {
      el.setAttribute(name, value);
    } catch {
      /* invalid attribute name on this element — drop it */
    }
  }
  for (const child of node.children) {
    if ("oc" in child) el.append(buildEl(doc, child));
    else el.append(doc.createTextNode(child.text));
  }
  return el;
}
