// Which parts of the page a pick lands on, and how a picked block is named
// and found again. The extension takes the element under the pointer; this
// page does the same with two allowances for a first-time visitor: a pointer
// on a word inside a line picks the line, and the document's shell (html,
// body, main) is not a block.
import type { BlockAnchor } from "../overlay/model";

/** Phrasing inside a line of text: the pick climbs out of these to the line. */
const PHRASING = new Set([
  "span",
  "em",
  "strong",
  "b",
  "i",
  "u",
  "s",
  "kbd",
  "code",
  "mark",
  "small",
  "sub",
  "sup",
  "br",
  "wbr",
  "abbr",
  "cite",
  "q",
  "time",
  "var",
  "samp",
]);

/** Too large to be a block: a pick that reaches these picks nothing. */
const SHELL = new Set(["html", "body", "main"]);

/** The page's own guide (the rail) is not part of the page under discussion. */
const CHROME = "[data-demo-chrome]";

/** How many characters of a block's text label it (the product's snippet length). */
const LABEL_CHARS = 40;

function tagOf(el: Element): string {
  return el.localName.toLowerCase();
}

function isSvgPart(el: Element): boolean {
  return el.namespaceURI === "http://www.w3.org/2000/svg" && tagOf(el) !== "svg";
}

/**
 * The block a pointer over `target` would pick, or null when there is none:
 * the overlay's own nodes, the page's guide, and the document's shell pick
 * nothing.
 */
export function pickTarget(
  target: Element | null,
  isOverlay: (el: Element) => boolean,
): Element | null {
  let el: Element | null = target;
  while (el) {
    if (isOverlay(el)) return null;
    if (el.closest(CHROME)) return null;
    const tag = tagOf(el);
    if (SHELL.has(tag)) return null;
    if (isSvgPart(el) || (PHRASING.has(tag) && el.parentElement !== null)) {
      el = el.parentElement;
      continue;
    }
    return el;
  }
  return null;
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A block's label: its first words, else what names it, else its tag. */
export function blockLabel(el: Element): string {
  const text = squash(el.textContent ?? "");
  if (text) return text.slice(0, LABEL_CHARS);
  const named = el.getAttribute("aria-label") ?? el.getAttribute("alt") ?? el.getAttribute("title");
  if (named) return squash(named).slice(0, LABEL_CHARS);
  return tagOf(el) || "block";
}

/** The selector the variant panel prints: the tag with its id, or its first class. */
export function blockTarget(el: Element): string {
  const tag = tagOf(el);
  if (el.id) return `${tag}#${el.id}`;
  const cls = (el.getAttribute("class") ?? "").split(/\s+/).find(Boolean);
  return cls ? `${tag}.${cls}` : tag;
}

function escapeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

/** A selector that finds exactly this block again: its id, or its path from the body. */
export function selectorFor(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && tagOf(node) !== "body" && tagOf(node) !== "html") {
    if (node.id) {
      parts.unshift(`#${escapeId(node.id)}`);
      return parts.join(" > ");
    }
    const parent: Element | null = node.parentElement;
    const tag = tagOf(node);
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    let nth = 1;
    for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
      if (tagOf(sib) === tag) nth += 1;
    }
    parts.unshift(`${tag}:nth-of-type(${nth})`);
    node = parent;
  }
  return `body > ${parts.join(" > ")}`;
}

/** The anchor a pick makes. `data-variants` names a block the demo agent has Variants for. */
export function describeBlock(el: Element): BlockAnchor {
  const prepared = el.getAttribute("data-variants");
  return {
    selector: selectorFor(el),
    label: blockLabel(el),
    target: blockTarget(el),
    ...(prepared ? { prepared } : {}),
  };
}

export function resolveBlock(doc: Document, anchor: BlockAnchor): Element | null {
  try {
    return doc.querySelector(anchor.selector);
  } catch {
    return null;
  }
}

/** The blocks a keyboard pick steps through, in document order. */
export function keyboardBlocks(doc: Document): Element[] {
  const out: Element[] = [];
  const all = doc.querySelectorAll(
    "main h1, main h2, main h3, main p, main li, main figure, main a.cta, footer p",
  );
  for (const el of all) {
    if (el.closest(CHROME) || el.closest(".ov")) continue;
    out.push(el);
  }
  return out;
}
