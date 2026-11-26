// What a person can actually see, for everything that leaves the browser as
// text (R2-C5): an element is not rendered when it carries `hidden`, computes
// to `display: none`, or its text computes to `visibility: hidden|collapse`
// (a child may make itself visible again). Snippets, markup uploads and the
// structured capture all read text through these, so a block's hidden
// contents (a collapsed "secret" panel, a templated value) never travel.

function styleOf(el: Element): CSSStyleDeclaration | null {
  try {
    const view = el.ownerDocument?.defaultView;
    return view ? view.getComputedStyle(el) : null;
  } catch {
    return null;
  }
}

/** The element and its whole subtree are not drawn at all. */
export function isRemoved(el: Element): boolean {
  if (el.hasAttribute("hidden")) return true;
  return styleOf(el)?.getPropertyValue("display") === "none";
}

/** The element's own text is not drawn (its children may still be). */
export function isInvisible(el: Element): boolean {
  const v = styleOf(el)?.getPropertyValue("visibility");
  return v === "hidden" || v === "collapse";
}

/**
 * At most `max` characters of the text a person sees in `el`, read node by
 * node: removed subtrees are skipped whole, invisible text is left out.
 */
export function renderedText(el: Element, max: number): string {
  const doc = el.ownerDocument;
  const removed = new WeakMap<Element, boolean>();
  const cutOff = (node: Node): boolean => {
    for (let p = node.parentElement; p; p = p.parentElement) {
      let r = removed.get(p);
      if (r === undefined) {
        r = isRemoved(p);
        removed.set(p, r);
      }
      if (r) return true;
      if (p === el) break;
    }
    return false;
  };
  let out = "";
  const walker = doc.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (!parent || cutOff(n) || isInvisible(parent)) continue;
    out += n.nodeValue ?? "";
    if (out.length >= max) return out.slice(0, max);
  }
  return out;
}
