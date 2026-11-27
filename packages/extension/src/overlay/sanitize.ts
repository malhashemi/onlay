// Anchor-content sanitizer (ADR-0017 §1). At element-anchor time the overlay
// captures the picked element's outerHTML, sanitized for quarantined transport
// to the agent: no scripts, styles, frames, event handlers, inline styles, or
// javascript: URLs survive; only an allowlist of structural/semantic attributes
// remains. Pure over a cloned subtree (never mutates the live page), so it is
// unit-testable with a DOM shim.
//
// Everything that leaves the browser as markup — the block markup sent when
// variants are asked for, the anchor-content upload, a page edit's body — goes
// through `sanitizeElement`, which also redacts what the viewer may never have
// seen: hidden inputs go whole; form values and textarea text go; attributes
// named like credentials go; long data-* values go; and every URL is cut to
// origin + path, a dropped query or fragment left as a literal `?…`.
import { LIMITS } from "@onlay/protocol";
import { overlayHost } from "./host";
import { redactUrl } from "./redact-url";
import { isInvisible, isRemoved } from "./rendered";

/** Elements whose content is code/style/foreign-document — dropped whole. */
const STRIP_ELEMENTS = new Set([
  "script",
  "style",
  "link",
  "iframe",
  "object",
  "embed",
  "noscript",
  "template",
]);

/** Structural + semantic attributes kept verbatim (everything else dropped). */
const ALLOWED_ATTRS = new Set([
  "href",
  "src",
  "alt",
  "title",
  "colspan",
  "rowspan",
  "datetime",
  "scope",
  "headers",
  "start",
  "type",
  "value",
  "lang",
  "dir",
  "name",
  // SVG geometry/paint — inert data (captures are declassified to text for
  // agents, never re-rendered live), and without it a captured logo is an
  // empty skeleton (live-caught: an anchored <svg> arrived as bare paths).
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
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "transform",
]);

/**
 * Presentation attributes kept ONLY in preview mode. The transport sanitizer
 * (agent-bound) drops these — an agent reads text, never re-renders — but the
 * standalone variant stage re-renders the block VISUALLY, so class/style must
 * survive (the look depends on them) and id keeps the agent's descendant
 * selectors resolvable inside the detached clone. All active content still dies.
 */
const PRESENTATION_ATTRS = new Set(["class", "id", "style"]);

/** Attributes carrying URLs — a javascript: value is stripped, never kept. */
const URL_ATTRS = new Set(["href", "src"]);

/** Every attribute whose value is a URL (or, for srcset, a list of them). */
const REDACTED_URL_ATTRS = new Set(["href", "src", "action", "poster", "data", "srcset"]);

/** Controls whose `value` is the person's (an option's value is the page's own choice list). */
const VALUE_CONTROLS = new Set([
  "input",
  "button",
  "select",
  "textarea",
  "output",
  "data",
  "param",
]);

/** Attribute names that smell like credentials, whatever the element. */
const CREDENTIAL_NAME = /token|secret|nonce|csrf|auth|session/i;

/** A data-* value longer than this is more likely state than a label. */
const MAX_DATA_ATTR = 64;

function redactSrcset(value: string, base: string): string {
  return value
    .split(",")
    .map((part) => {
      const [url, ...rest] = part.trim().split(/\s+/);
      const cut = url ? redactUrl(url, base) : null;
      return cut ? [cut, ...rest].join(" ") : "";
    })
    .filter((p) => p.length > 0)
    .join(", ");
}

/** The transport redaction for one element's attributes (after the allowlist). */
function redactAttributes(el: Element): void {
  const tag = el.localName;
  const base = el.ownerDocument?.baseURI ?? "about:blank";
  for (const attr of [...el.attributes]) {
    const name = attr.name.toLowerCase();
    if (CREDENTIAL_NAME.test(name) || name === "autocomplete") {
      el.removeAttribute(attr.name);
      continue;
    }
    if (name === "value" && VALUE_CONTROLS.has(tag)) {
      el.removeAttribute(attr.name);
      continue;
    }
    // onlay's own build stamps (source pointer, provenance, block id) are the
    // developer's, not the viewer's, and point the agent at the source.
    if (
      name.startsWith("data-") &&
      !name.startsWith("data-onlay-") &&
      attr.value.length > MAX_DATA_ATTR
    ) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (REDACTED_URL_ATTRS.has(name)) {
      const cut = name === "srcset" ? redactSrcset(attr.value, base) : redactUrl(attr.value, base);
      if (cut === null || cut === "") el.removeAttribute(attr.name);
      else el.setAttribute(attr.name, cut);
    }
  }
  if (tag === "textarea") el.textContent = "";
}

function isHiddenInput(el: Element): boolean {
  return el.localName === "input" && (el.getAttribute("type") ?? "").toLowerCase() === "hidden";
}

function isJavascriptUrl(value: string): boolean {
  // Strip leading control/whitespace chars (the classic `java\0script:`
  // bypass), then match case-insensitively. Attribute values arrive decoded.
  let i = 0;
  while (i < value.length && value.charCodeAt(i) <= 0x20) i += 1;
  return /^javascript:/i.test(value.slice(i));
}

/** What a sanitize pass keeps beyond the structural allowlist. */
type Keep = "transport" | "selectors" | "presentation";

function scrubAttributes(el: Element, keep: Keep): void {
  for (const attr of [...el.attributes]) {
    const name = attr.name.toLowerCase();
    if (name.startsWith("data-onlay-")) continue; // onlay's own stamps survive
    if (name.startsWith("on")) {
      el.removeAttribute(attr.name);
      continue;
    }
    const allowed =
      ALLOWED_ATTRS.has(name) ||
      (keep === "presentation" && PRESENTATION_ATTRS.has(name)) ||
      (keep === "selectors" && (name === "class" || name === "id"));
    if (!allowed) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (URL_ATTRS.has(name) && isJavascriptUrl(attr.value)) {
      el.removeAttribute(attr.name);
    }
  }
  // Markup that leaves the browser is redacted; the local preview is not sent anywhere.
  if (keep !== "presentation") redactAttributes(el);
}

/** Recursively strip disallowed elements/attributes from a cloned subtree. */
function scrub(node: Element, keep: Keep): void {
  for (const child of [...node.children]) {
    if (STRIP_ELEMENTS.has(child.localName) || (keep !== "presentation" && isHiddenInput(child))) {
      child.remove();
      continue;
    }
    scrubAttributes(child, keep);
    scrub(child, keep);
  }
}

export interface SanitizedAnchor {
  html: string;
  truncated: boolean;
  /** What was cut to make it fit, when it was over the limit (each cut is marked in the markup). */
  reduced?: MarkupReduction;
}

/**
 * How a block's markup was reduced to fit: long texts shortened, repeated
 * siblings and deeply nested elements cut. Each cut leaves an
 * `<!--onlay-cut: …-->` comment where it was.
 */
export interface MarkupReduction {
  /** Text runs shortened. */
  text: number;
  /** Elements cut as repeats of the siblings kept before them. */
  repeats: number;
  /** Elements cut below the depth kept. */
  depth: number;
}

/**
 * Sanitize a picked element's outerHTML for anchor-content upload. Caps at
 * `maxLen` (default MAX_ANCHOR_CONTENT), truncating at a tag boundary so the
 * markup never breaks mid-tag, and flags `truncated`.
 */
/**
 * Drop from `clone` what the person cannot see in its live twin `live` (same
 * shape: `clone` is `live.cloneNode(true)`): removed subtrees, invisible text,
 * comments, and any `skip` element (onlay's own host).
 */
function pruneUnseen(live: Element, clone: Element, skip: Element | null): void {
  const liveKids = [...live.childNodes];
  const cloneKids = [...clone.childNodes];
  const ownTextHidden = isInvisible(live);
  for (let i = 0; i < cloneKids.length; i += 1) {
    const c = cloneKids[i] as ChildNode;
    const l = liveKids[i];
    if (c.nodeType === 8) {
      c.remove(); // comments never travel
      continue;
    }
    if (c.nodeType === 3) {
      if (ownTextHidden) c.remove();
      continue;
    }
    if (c.nodeType !== 1) continue;
    const lel = l as Element | undefined;
    if (!lel || lel.nodeType !== 1 || lel === skip || lel === overlayHost() || isRemoved(lel)) {
      c.remove();
      continue;
    }
    pruneUnseen(l as Element, c as Element, skip);
  }
}

export function sanitizeElement(
  el: Element,
  maxLen: number = LIMITS.MAX_ANCHOR_CONTENT,
  opts: { keepSelectors?: boolean; skip?: Element | null } = {},
): SanitizedAnchor {
  if (isRemoved(el)) return { html: "", truncated: false };
  const clone = el.cloneNode(true) as Element;
  if (STRIP_ELEMENTS.has(clone.localName) || isHiddenInput(clone))
    return { html: "", truncated: false };
  // Only what is rendered travels: hidden text and comments go first.
  pruneUnseen(el, clone, opts.skip ?? null);
  // The variant request keeps class and id: the agent's selectors need them.
  const keep: Keep = opts.keepSelectors ? "selectors" : "transport";
  scrubAttributes(clone, keep);
  scrub(clone, keep);
  const html = clone.outerHTML;
  if (html.length <= maxLen) return { html, truncated: false };
  // Too large: a skeleton that keeps the structure (tags, ids and classes),
  // already redacted, with what was cut marked where it was.
  const reduced = reduceToFit(clone, maxLen);
  if (reduced) return { html: reduced.html, truncated: false, reduced: reduced.cuts };
  // Even the skeleton is too large: truncate at the last complete tag
  // boundary (a '>' at or before the cap).
  const slice = html.slice(0, maxLen);
  const boundary = slice.lastIndexOf(">");
  return {
    html: boundary >= 0 ? slice.slice(0, boundary + 1) : slice,
    truncated: true,
  };
}

/* ── reducing a block that is too large ──────────────────────────────── */

/** Text runs are shortened to this many characters, then fewer if it still doesn't fit. */
const TEXT_KEEP = [160, 60, 20];
/** Of a run of siblings that look alike (same tag and classes), this many are kept. */
const REPEATS_KEPT = 3;

const cutMark = (doc: Document, what: string): Comment => doc.createComment(` onlay-cut: ${what} `);

/** Shorten every text run over `keep` characters; returns how many were shortened. */
function shortenText(root: Element, keep: number): number {
  const doc = root.ownerDocument;
  let n = 0;
  const walk = (node: Node): void => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) {
        const text = child.textContent ?? "";
        if (text.length > keep + 20) {
          child.textContent = `${text.slice(0, keep)}…`;
          child.after(cutMark(doc, `${(text.length - keep).toLocaleString("en-US")} characters`));
          n += 1;
        }
      } else if (child.nodeType === 1) walk(child);
    }
  };
  walk(root);
  return n;
}

const signature = (el: Element): string => `${el.localName}.${[...el.classList].sort().join(".")}`;

/** Keep the first few of each run of look-alike siblings; returns how many were cut. */
function cutRepeats(root: Element): number {
  const doc = root.ownerDocument;
  let n = 0;
  const walk = (el: Element): void => {
    const kids = [...el.children];
    let i = 0;
    while (i < kids.length) {
      const sig = signature(kids[i] as Element);
      let j = i + 1;
      while (j < kids.length && signature(kids[j] as Element) === sig) j += 1;
      const run = j - i;
      if (run > REPEATS_KEPT) {
        const cut = kids.slice(i + REPEATS_KEPT, j);
        (cut[0] as Element).before(cutMark(doc, `${cut.length} more like the ones above`));
        for (const c of cut) c.remove();
        n += cut.length;
      }
      i = j;
    }
    for (const k of el.children) walk(k);
  };
  walk(root);
  return n;
}

/** Replace what lies below `depth` with one mark per element; returns how many elements went. */
function cutBelow(root: Element, depth: number): number {
  const doc = root.ownerDocument;
  let n = 0;
  const walk = (el: Element, d: number): void => {
    if (d >= depth) {
      const inside = el.querySelectorAll("*").length;
      if (inside > 0 || (el.textContent ?? "").length > 0) {
        el.replaceChildren(
          cutMark(doc, inside > 0 ? `${inside.toLocaleString("en-US")} elements inside` : "text"),
        );
        n += inside;
      }
      return;
    }
    for (const k of [...el.children]) walk(k, d + 1);
  };
  walk(root, 0);
  return n;
}

function depthOf(el: Element): number {
  let max = 0;
  for (const k of el.children) max = Math.max(max, depthOf(k) + 1);
  return max;
}

/**
 * Cut a scrubbed clone down until its markup fits `maxLen`: shorten long text,
 * then cut look-alike siblings past the first few, then cut below the deepest
 * level that fits. Null when even one level of the block is too large.
 */
function reduceToFit(
  clone: Element,
  maxLen: number,
): { html: string; cuts: MarkupReduction } | null {
  const cuts: MarkupReduction = { text: 0, repeats: 0, depth: 0 };
  for (const keep of TEXT_KEEP) {
    cuts.text += shortenText(clone, keep);
    if (clone.outerHTML.length <= maxLen) return { html: clone.outerHTML, cuts };
  }
  cuts.repeats = cutRepeats(clone);
  let html = clone.outerHTML;
  if (html.length <= maxLen) return { html, cuts };
  // The deepest level that fits, by halving: each try cuts a fresh copy.
  let lo = 1;
  let hi = depthOf(clone) - 1;
  let best: { html: string; depth: number } | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const tryClone = clone.cloneNode(true) as Element;
    const gone = cutBelow(tryClone, mid);
    html = tryClone.outerHTML;
    if (html.length <= maxLen) {
      best = { html, depth: gone };
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (!best) return null;
  cuts.depth = best.depth;
  return { html: best.html, cuts };
}

/**
 * Sanitize the whole page body for a page edit (spec §8): the anchor-content
 * format, capped at MAX_PAGE_CONTENT, keeping class and id (an agent writes
 * page-wide selectors from them), never including onlay's own overlay host.
 */
export function sanitizePage(body: Element, overlayHost: Element | null = null): SanitizedAnchor {
  return sanitizeElement(body, LIMITS.MAX_PAGE_CONTENT, { keepSelectors: true, skip: overlayHost });
}

/**
 * Parse a picked block's captured `markup` (RAW, UNTRUSTED page HTML — may be
 * truncated mid-tag) and return a sanitized, DETACHED root Element ready to
 * mount in the standalone preview stage's shadow root, or `null` when it does
 * not parse to a usable element. Preview mode keeps class/id/inline style so
 * the block reads visually, while STILL stripping every active-content vector:
 * script/style/iframe/object/embed/etc. elements, on* handlers, and
 * javascript: URLs. DOMParser("text/html") tolerates the truncation (it closes
 * dangling tags); we never innerHTML the main document — the caller importNodes
 * this sanitized tree into the shadow root.
 */
export function sanitizeMarkupForPreview(markup: string): Element | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(markup, "text/html");
  } catch {
    return null;
  }
  const first = doc.body.firstElementChild;
  if (!first || STRIP_ELEMENTS.has(first.localName)) return null;
  const clone = first.cloneNode(true) as Element;
  scrubAttributes(clone, "presentation");
  scrub(clone, "presentation");
  return clone;
}
