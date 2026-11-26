// The anchoring ladder (ADR-0005): element → selection → page. Builds an
// Anchor from a page element or the current text selection, resolves an
// Anchor back to a live element (degrading gracefully), and produces the
// human-readable label the rail/popover/pin tooltip show. Anchor loss never
// drops an interaction — it demotes to page-level; re-anchor is one pick.
import { type Anchor, LIMITS, ONLAY_PROVENANCE_ATTR, ONLAY_SOURCE_ATTR } from "@onlay/protocol";
import { framePathFor, resolveFramePath } from "./frame-path";
import { renderedText } from "./rendered";

const SOURCE_SELECTOR = `[${ONLAY_SOURCE_ATTR}]`;

function cssEscape(s: string): string {
  const g = globalThis as { CSS?: { escape?: (v: string) => string } };
  if (g.CSS?.escape) return g.CSS.escape(s);
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

export function isUnique(selector: string, doc: Document = document): boolean {
  try {
    return doc.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

/* ── generated names: hashed or atomic, never stable across builds ── */

const GENERATED_PREFIX = /^(css|sc|jsx|svelte|emotion|styled|astro|tw|chakra|mui|makeStyles)-/i;

/** Letters and at least two digits in one token: `x1tgivj0`, `a1b2c3`, `_3xYz9`. */
function hashLikeToken(token: string): boolean {
  if (token.length < 5) return false;
  const digits = token.replace(/[^0-9]/g, "").length;
  const letters = token.replace(/[^a-zA-Z]/g, "").length;
  return digits >= 2 && letters >= 1;
}

/** A short token whose case flips like a hash: `kHJgfD`, `AbCdE`. */
function caseNoiseToken(token: string): boolean {
  if (token.length < 5 || token.length > 10 || !/^[a-zA-Z]+$/.test(token)) return false;
  let flips = 0;
  for (let i = 1; i < token.length; i += 1) {
    const a = token.charAt(i - 1);
    const b = token.charAt(i);
    if ((a === a.toUpperCase()) !== (b === b.toUpperCase())) flips += 1;
  }
  return flips >= 3;
}

/**
 * A class name a build tool generated (hashed or atomic) — it will not match
 * after the next deploy, so selectors skip it: CSS-in-JS (`css-1a2b3c`,
 * `sc-AbCdE`), atomic CSS (`x1tgivj0`), CSS-module hashes
 * (`Button_root__a1b2c`), utility variants (`md:flex`, `w-[32px]`).
 */
export function isGeneratedClass(name: string): boolean {
  if (!/^[A-Za-z_-][A-Za-z0-9_-]*$/.test(name)) return true;
  if (GENERATED_PREFIX.test(name)) return true;
  if (/__[A-Za-z0-9]{4,}$/.test(name) && /[0-9]/.test(name)) return true;
  return name.split(/[-_]+/).some((t) => hashLikeToken(t) || caseNoiseToken(t));
}

/** An id a framework generated (`:r1:`, `radix-:r2:`, `ember123`, `react-select-3-input`). */
export function isGeneratedId(id: string): boolean {
  if (id.includes(":")) return true;
  if (/\d{3,}/.test(id)) return true;
  return isGeneratedClass(id);
}

/** Attributes authors put on purpose, stable across builds, in preference order. */
const STABLE_ATTRS = ["data-testid", "data-test", "data-qa", "data-cy", "name", "aria-label"];

function stableAttr(node: Element): string | null {
  for (const attr of STABLE_ATTRS) {
    const v = node.getAttribute(attr);
    if (v && v.length <= 80 && !isGeneratedId(v.replace(/\s+/g, "-"))) {
      return `[${attr}="${v.replace(/["\\]/g, "\\$&")}"]`;
    }
  }
  return null;
}

/**
 * One selector segment for `node`, uniqueness-verified by the caller: a stable
 * id, else a stable attribute, else up to two non-generated classes, plus the
 * position among same-tag siblings when it has any.
 */
export function segmentFor(node: Element): string {
  if (node.id && !isGeneratedId(node.id)) return `${node.localName}#${cssEscape(node.id)}`;
  let part = node.localName;
  const attr = stableAttr(node);
  if (attr) return `${part}${attr}`;
  part += [...node.classList]
    .filter((c) => !isGeneratedClass(c))
    .slice(0, 2)
    .map((c) => `.${cssEscape(c)}`)
    .join("");
  const parent = node.parentElement;
  if (parent) {
    const same = [...parent.children].filter((c) => c.localName === node.localName);
    if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
  }
  return part;
}

/**
 * Climb until the path is document-unique (echoed selectors must not be
 * ambiguous). Every selector ends in a tag-qualified segment (`p#intro`, not
 * `#intro`): the tag is what the verifier searches when the id or the path
 * stops matching.
 */
export function cssPath(target: Element): string {
  // Unique in the block's own document (a frame's, for a block inside one).
  const doc = target.ownerDocument;
  if (target.id && !isGeneratedId(target.id)) {
    const idSel = `${target.localName}#${cssEscape(target.id)}`;
    if (isUnique(idSel, doc)) return idSel;
  }
  const parts: string[] = [];
  let node: Element | null = target;
  while (node && node.nodeType === 1 && parts.length < 8 && node !== doc.body) {
    parts.unshift(segmentFor(node));
    if (isUnique(parts.join(" > "), doc)) break;
    node = node.parentElement;
  }
  return parts.join(" > ");
}

export function readSourcePointer(el: Element): string | null {
  const stamped = el.closest(SOURCE_SELECTOR);
  const value = stamped?.getAttribute(ONLAY_SOURCE_ATTR)?.trim();
  return value ? value : null;
}

/**
 * The document-level provenance stamp (ADR-0017 §3), joined to a source
 * pointer so a repo-relative `file:line:col` becomes portable
 * (`origin@sha;branch;dirty`). Read from the nearest ancestor carrying it
 * (the stamp plugins put it on <html>/root), else the document element.
 */
function readProvenance(el: Element): string | null {
  const host = el.closest(`[${ONLAY_PROVENANCE_ATTR}]`) ?? el.ownerDocument.documentElement;
  const value = host?.getAttribute(ONLAY_PROVENANCE_ATTR)?.trim();
  return value ? value.slice(0, LIMITS.MAX_PROVENANCE) : null;
}

/** The provenance stamp the document carries, when it does (a page edit's source, spec §8). */
export function documentProvenance(doc: Document = document): string | undefined {
  const v = doc.documentElement?.getAttribute(ONLAY_PROVENANCE_ATTR)?.trim();
  return v ? v.slice(0, LIMITS.MAX_PROVENANCE) : undefined;
}

/**
 * Resolve to the closest anchored block: a `data-onlay-block` region wins
 * (block-level vocabulary), else the element itself. Carries the block id + a
 * snippet for the anchor.
 */
export function blockFor(target: Element): {
  el: Element;
  blockId?: string;
  snippet?: string;
} {
  const block = target.closest("[data-onlay-block]");
  const host = block ?? target;
  const blockId = block?.getAttribute("data-onlay-block") ?? undefined;
  // Only rendered text: a hidden panel's contents never become a snippet.
  const snippet = renderedText(host, LIMITS.MAX_SNIPPET * 4)
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, LIMITS.MAX_SNIPPET);
  return {
    el: host,
    ...(blockId !== undefined && blockId.length > 0 ? { blockId } : {}),
    ...(snippet ? { snippet } : {}),
  };
}

/**
 * The frame path from `owner` down to `doc` (A-3): [] when `doc` is the owner
 * itself, null when it is not part of the owner at all.
 */
export function framePathTo(doc: Document, owner: Document = document): string[] | null {
  return framePathFor(doc, owner, (el) => cssPath(el).slice(0, LIMITS.MAX_SELECTOR));
}

/**
 * Pin a picked block to where it is now (2-A2): its document and, for a block
 * inside a frame of the page, each frame element on the way up to `owner`,
 * the document behind each, and the frame path that leads from the owner to
 * it. The returned check is true only while all of them are the same objects
 * in the same places; once a block is moved into another document, or a frame
 * moved, replaced or pointed elsewhere, it is false for good.
 */
export function pinBlock(el: Element, owner: Document = document): () => boolean {
  const doc = el.ownerDocument;
  const path = framePathTo(doc, owner);
  if (path === null) return () => false;
  const hops: Array<{ frame: Element; parent: Document; child: Document }> = [];
  for (let d = doc; d !== owner; ) {
    const frame = d.defaultView?.frameElement;
    if (!frame) return () => false;
    hops.push({ frame, parent: frame.ownerDocument, child: d });
    d = frame.ownerDocument;
  }
  let held = true;
  return () => {
    if (!held) return false;
    try {
      held =
        el.isConnected &&
        el.ownerDocument === doc &&
        hops.every(
          (h) =>
            h.frame.isConnected &&
            h.frame.ownerDocument === h.parent &&
            (h.frame as HTMLIFrameElement).contentDocument === h.child,
        ) &&
        (path.length === 0 || resolveFramePath(owner, path) === doc);
    } catch {
      held = false;
    }
    return held;
  };
}

/** The optional `framePath` field (A-3): only a non-empty path is carried. */
function framed(framePath: readonly string[] | undefined): { framePath?: string[] } {
  return framePath && framePath.length > 0 ? { framePath: [...framePath] } : {};
}

/**
 * Build an element-level Anchor from a clicked page element. `framePath`
 * names the frames between the owning document and the element's (A-3).
 */
export function anchorForElement(target: Element, framePath?: readonly string[]): Anchor {
  const { blockId, snippet } = blockFor(target);
  const sourcePointer = readSourcePointer(target)?.slice(0, LIMITS.MAX_SOURCE_POINTER);
  // Provenance rides only with a source pointer — it's the pointer's portable
  // half (ADR-0017 §3); alone it would anchor nothing.
  const provenance = sourcePointer ? readProvenance(target) : null;
  return {
    level: "element",
    selector: cssPath(target).slice(0, LIMITS.MAX_SELECTOR),
    ...framed(framePath),
    ...(blockId !== undefined ? { blockId } : {}),
    ...(sourcePointer ? { sourcePointer } : {}),
    ...(provenance ? { provenance } : {}),
    ...(snippet ? { snippet } : {}),
  };
}

/** Build a selection-level Anchor from the current text selection of `win`, if any. */
export function anchorForSelection(
  win: Window = window,
  framePath?: readonly string[],
): Anchor | null {
  const sel = win.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const text = sel.toString().trim().replace(/\s+/g, " ").slice(0, LIMITS.MAX_SNIPPET);
  if (!text) return null;
  const node = sel.getRangeAt(0).commonAncestorContainer;
  const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
  if (!el) return null;
  return {
    level: "selection",
    selector: cssPath(el).slice(0, LIMITS.MAX_SELECTOR),
    ...framed(framePath),
    text,
  };
}

/* ── anchor verification (spec §10) ── */

/** Collapse whitespace and case: the form stored text and live text compare in. */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

const HEAD_CHARS = 60;
const OVERLAP_MIN = 0.6;
/** Live text read past this is never compared (a huge container stays cheap). */
const LIVE_TEXT_CAP = 20_000;

function tokens(text: string): Set<string> {
  return new Set(text.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0));
}

/** Dice overlap of two texts' word sets, 0..1. */
function overlap(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return (2 * shared) / (ta.size + tb.size);
}

/**
 * How well a block's live text matches the snippet stored at pick time, 0..1;
 * 0 means it is not the same block. Tolerates small edits: whitespace and case
 * never count; a live text that contains the snippet's first 60 characters (or
 * is contained by the snippet, when it is at least half that long) scores 1; otherwise
 * the score is the word overlap, accepted from 0.6. No stored snippet: any
 * block is consistent.
 */
function textMatchScore(stored: string | undefined, live: string): number {
  const s = normalizeText(stored ?? "");
  if (!s) return 1;
  const l = normalizeText(live.slice(0, LIVE_TEXT_CAP));
  if (!l) return 0;
  if (leadMatch(s, l)) return 1;
  return overlapScore(s, l);
}

/** The normalized live text contains the snippet's lead (or is the snippet's start). */
function leadMatch(s: string, l: string): boolean {
  if (l.includes(s.slice(0, HEAD_CHARS))) return true;
  const lHead = l.slice(0, HEAD_CHARS);
  return lHead.length >= Math.min(s.length, HEAD_CHARS) / 2 && s.includes(lHead);
}

/** The token-overlap rule alone: 0 below the threshold. */
function overlapScore(s: string, l: string): number {
  // Compare like with like: the snippet is the start of the block's text.
  const score = overlap(s, l.slice(0, s.length + HEAD_CHARS));
  return score >= OVERLAP_MIN ? score : 0;
}

/** Is a block's live text consistent with the snippet stored for it? */
export function textConsistent(stored: string | undefined, live: string): boolean {
  return textMatchScore(stored, live) > 0;
}

/**
 * At most `max` characters of an element's text, read node by node: a huge
 * container never materializes its whole `textContent` to be compared.
 */
export function boundedText(el: Element, max: number): string {
  const doc = el.ownerDocument;
  let out = "";
  const walker = doc.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    out += n.nodeValue ?? "";
    if (out.length >= max) return out.slice(0, max);
  }
  return out;
}

/** The text an element anchor's snippet was read from: its block's, like `blockFor`. */
function anchorTextOf(el: Element, max = LIVE_TEXT_CAP): string {
  // Rendered text, as the snippet was read (rendered.ts).
  return renderedText(el.closest("[data-onlay-block]") ?? el, max);
}

/** Same-tag candidates searched for a snippet before an anchor counts as lost. */
const SEARCH_CAP = 3_000;
/** Characters a whole search may read across its candidates. */
const SEARCH_TEXT_BUDGET = 2_000_000;
/** Where a legacy id-only anchor's block may be (it stored no tag). */
const BLOCK_TAGS = [
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "dt",
  "dd",
  "blockquote",
  "pre",
  "figure",
  "figcaption",
  "td",
  "th",
  "section",
  "article",
  "aside",
  "header",
  "footer",
  "nav",
  "main",
  "div",
  "button",
  "a",
  "label",
  "span",
];

/** How much of a candidate's text the snippet needs: its own length, with room to have moved. */
function neededChars(stored: string): number {
  return Math.min(LIVE_TEXT_CAP, 4 * (normalizeText(stored).length + HEAD_CHARS));
}

/** Elements of `tags` under `root`, in document order, at most `cap` of them. */
function candidates(root: ParentNode, tags: ReadonlySet<string>, cap: number): Element[] {
  const start = (root as Document).documentElement ?? (root as Element);
  const doc = (start as Element).ownerDocument ?? (root as Document);
  const out: Element[] = [];
  const walker = doc.createTreeWalker(start as Node, 1 /* NodeFilter.SHOW_ELEMENT */);
  for (
    let n = walker.currentNode as Element | null;
    n !== null;
    n = walker.nextNode() as Element | null
  ) {
    if (!tags.has(n.localName)) continue;
    out.push(n);
    if (out.length >= cap) break;
  }
  return out;
}

/** The tag a selector's last segment names (`main > p.intro:nth-of-type(2)` → `p`). */
export function tagOfSelector(selector: string): string | null {
  const last =
    selector
      .split(/[\s>+~]+/)
      .filter(Boolean)
      .pop() ?? "";
  const m = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(last);
  return m?.[1] ? m[1].toLowerCase() : null;
}

/**
 * Find the one element of `tag` whose text best matches `stored`. Bounded:
 * stops after SEARCH_CAP candidates. A tie between unrelated elements is
 * ambiguous (null); a tie along one ancestor chain (a wrapper and its only
 * child) takes the innermost.
 */
export function searchBySnippet(
  root: ParentNode,
  tag: string | readonly string[],
  stored: string,
  textOf: (el: Element, max: number) => string,
  opts: { strongOnly?: boolean; max?: number } = {},
): Element | null {
  return bestBySnippet(root, tag, stored, textOf, opts).el;
}

/**
 * The search behind `searchBySnippet`, with the whole tie for callers that need
 * it. Candidates whose text carries the snippet's lead are ranked by the token
 * overlap among themselves: when several share the lead, the lead alone is not
 * enough. A unique best wins; a tie along one ancestor chain takes the
 * innermost; any other tie is ambiguous (null).
 */
function bestBySnippet(
  root: ParentNode,
  tag: string | readonly string[],
  stored: string,
  textOf: (el: Element, max: number) => string,
  opts: { strongOnly?: boolean; max?: number },
): { el: Element | null; tied: Element[] } {
  const s = normalizeText(stored);
  if (!s) return { el: null, tied: [] };
  const max = opts.max ?? neededChars(stored);
  const tags = new Set(typeof tag === "string" ? [tag] : tag);
  const lead: Array<{ el: Element; l: string }> = [];
  let best: Element[] = [];
  let bestScore = 0;
  let budget = SEARCH_TEXT_BUDGET;
  for (const el of candidates(root, tags, SEARCH_CAP)) {
    if (budget <= 0) break;
    const raw = textOf(el, max);
    budget -= raw.length;
    const l = normalizeText(raw);
    if (!l) continue;
    if (leadMatch(s, l)) {
      lead.push({ el, l });
      continue;
    }
    if (opts.strongOnly) continue;
    const score = overlapScore(s, l);
    if (score <= 0) continue;
    if (score > bestScore + 1e-9) {
      bestScore = score;
      best = [el];
    } else if (Math.abs(score - bestScore) <= 1e-9) best.push(el);
  }
  // Lead matches outrank overlap-only ones; among several, overlap decides.
  if (lead.length > 0) {
    const distinct = lead.filter((c) => !lead.some((o) => o !== c && c.el.contains(o.el)));
    if (distinct.length <= 1) {
      best = lead.map((c) => c.el);
    } else {
      best = [];
      bestScore = 0;
      for (const c of lead) {
        const score = overlapScore(s, c.l);
        if (score <= 0) continue;
        if (score > bestScore + 1e-9) {
          bestScore = score;
          best = [c.el];
        } else if (Math.abs(score - bestScore) <= 1e-9) best.push(c.el);
      }
    }
  }
  if (best.length === 0) return { el: null, tied: [] };
  if (best.length === 1) return { el: best[0] ?? null, tied: best };
  const innermost = best.find((el) => best.every((o) => o === el || o.contains(el)));
  return { el: innermost ?? null, tied: best };
}

function querySafe(doc: Document, selector: string): Element | null {
  try {
    const found = selector ? doc.querySelector(selector) : null;
    return found?.isConnected ? found : null;
  } catch {
    return null; // invalid selector — treated as missing
  }
}

function verifyAnchor(anchor: Anchor, doc: Document): Element | null {
  if (anchor.level === "unanchored" || anchor.level === "page") return null;
  const stored = anchor.level === "selection" ? anchor.text : anchor.snippet;
  // A selection's text can sit anywhere in its element: read up to the cap.
  const selection = anchor.level === "selection";
  const textOf = selection
    ? (el: Element, max: number) => boundedText(el, max)
    : (el: Element, max: number) => anchorTextOf(el, max);
  const searchMax = selection ? LIVE_TEXT_CAP : undefined;
  if (anchor.level === "element" && anchor.blockId) {
    for (const b of doc.querySelectorAll("[data-onlay-block]")) {
      if (b.getAttribute("data-onlay-block") !== anchor.blockId || !b.isConnected) continue;
      if (textConsistent(stored, textOf(b, LIVE_TEXT_CAP))) return b;
    }
  }
  const found = querySafe(doc, anchor.selector);
  const tag = tagOfSelector(anchor.selector) ?? found?.localName ?? null;
  const s = normalizeText(stored ?? "");
  if (found) {
    if (!s) return found; // nothing stored to check: the selector is the anchor
    const l = normalizeText(textOf(found, LIVE_TEXT_CAP).slice(0, LIVE_TEXT_CAP));
    if (l && leadMatch(s, l)) {
      // The lead alone proves little when other same-tag blocks share it: the
      // token overlap decides among them, and the selector breaks a tie.
      if (!tag) return found;
      const ranked = bestBySnippet(doc, tag, stored ?? "", textOf, {
        ...(searchMax !== undefined ? { max: searchMax } : {}),
      });
      // Tied with an unrelated block (ranked.el is null): indistinguishable by
      // the anchor rule, so the anchor is lost rather than bound to either.
      if (ranked.tied.includes(found)) return ranked.el === null ? null : found;
      if (ranked.tied.length === 0) return overlapScore(s, l) > 0 ? found : null;
      return ranked.el;
    }
    if (l && overlapScore(s, l) > 0) return found;
  }
  if (!s) return null;
  if (tag) {
    return searchBySnippet(doc, tag, stored ?? "", textOf, {
      ...(searchMax !== undefined ? { max: searchMax } : {}),
    });
  }
  // A legacy id-only selector (`#intro`) stored no tag: search block-level
  // tags, bounded, and take only a unique strong (lead) match.
  return searchBySnippet(doc, BLOCK_TAGS, stored ?? "", textOf, {
    strongOnly: true,
    ...(searchMax !== undefined ? { max: searchMax } : {}),
  });
}

/*
 * A memo: pins resolve on every scroll frame, and a miss may search. A result
 * holds until the document changes (a MutationObserver per document, read
 * synchronously with takeRecords so a change in this same task counts).
 */
const memo = new Map<string, { doc: Document; rev: number; el: Element | null }>();
const revisions = new WeakMap<Document, { rev: number; observer: MutationObserver | null }>();

/** The document's change counter, bumped by any mutation since the last read. */
function revisionOf(doc: Document): number {
  let r = revisions.get(doc);
  if (!r) {
    const entry: { rev: number; observer: MutationObserver | null } = { rev: 0, observer: null };
    try {
      const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
      if (Observer) {
        entry.observer = new Observer(() => {
          entry.rev += 1;
        });
        entry.observer.observe(doc, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
        });
      }
    } catch {
      entry.observer = null;
    }
    revisions.set(doc, entry);
    r = entry;
  }
  if (!r.observer) {
    r.rev += 1; // cannot observe: never reuse
    return r.rev;
  }
  if (r.observer.takeRecords().length > 0) r.rev += 1;
  return r.rev;
}

function memoKey(anchor: Anchor): string {
  if (anchor.level === "element")
    return `e|${anchor.selector}|${anchor.blockId ?? ""}|${anchor.snippet ?? ""}`;
  if (anchor.level === "selection") return `s|${anchor.selector}|${anchor.text}`;
  return anchor.level;
}

/** The anchor's frames (A-3), when it has any. */
export function framePathOfAnchor(anchor: Anchor): readonly string[] | undefined {
  return anchor.level === "element" || anchor.level === "selection" ? anchor.framePath : undefined;
}

/**
 * Resolve an Anchor to a live element, or null when the anchor is lost. A
 * block-id or selector match counts only when its text is consistent with the
 * snippet stored at pick time (or none was stored); otherwise elements of the
 * same tag are searched for the snippet and a unique best match is taken.
 */
export function resolveAnchor(anchor: Anchor, owner: Document = document): Element | null {
  if (anchor.level === "unanchored" || anchor.level === "page") return null;
  // A block inside frames of the page (A-3) is looked for in the document its
  // frames lead to, from the owning document only; frames that lead nowhere
  // (gone, another origin, an address of their own) mean the block is not here.
  const path = framePathOfAnchor(anchor);
  const doc = path ? resolveFramePath(owner, path) : owner;
  if (!doc) return null;
  const key = `${path ? `${JSON.stringify(path)}|` : ""}${memoKey(anchor)}`;
  const rev = revisionOf(doc);
  const hit = memo.get(key);
  if (hit && hit.doc === doc && hit.rev === rev && (hit.el === null || hit.el.isConnected))
    return hit.el;
  const el = verifyAnchor(anchor, doc);
  if (memo.size > 500) memo.clear();
  memo.set(key, { doc, rev, el });
  return el;
}

/** Forget memoized resolutions (tests, and a page that changed under them). */
export function forgetResolutions(): void {
  memo.clear();
}

/** The human-readable label for an anchor (rail rows, pins, popover). */
export function anchorLabel(anchor: Anchor): string {
  if (anchor.level === "unanchored") return "unanchored";
  if (anchor.level === "page") return "page-level";
  if (anchor.level === "selection") {
    const t = anchor.text.trim();
    return t ? `“${t.slice(0, 40)}”` : "selection";
  }
  if (anchor.blockId) return `§${anchor.blockId}`;
  if (anchor.snippet) return anchor.snippet.slice(0, 40);
  const sel = anchor.selector;
  const tail = sel.split(">").pop()?.trim() ?? sel;
  return tail.slice(0, 40) || "block";
}
