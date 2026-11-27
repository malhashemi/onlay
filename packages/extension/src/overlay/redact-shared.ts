// Two rules of the one redaction policy that both redactors apply: the markup
// sanitizer (`sanitize.ts`, uploads and outcome copies) and the structured
// capture's walker (`capture/walker.ts`).

/** SVG attributes whose value may be a paint server or clip reference: `url(…)`. */
const PAINT_ATTRS = new Set([
  "fill",
  "stroke",
  "clip-path",
  "mask",
  "filter",
  "marker-start",
  "marker-mid",
  "marker-end",
]);

/** Only a same-document reference survives: `url(#id)`, the id already in the markup. */
const LOCAL_REF = /^\s*url\(\s*(["']?)#[A-Za-z_][\w.:-]*\1\s*\)\s*(?:[a-z-]+\s*)?$/i;

/**
 * An SVG paint or clip attribute whose value names a URL other than a
 * same-document `#id`: it can carry another document's address, its query or
 * its fragment, so it never leaves the browser (dropped, not rewritten).
 */
export function paintUrlDropped(name: string, value: string): boolean {
  if (!PAINT_ATTRS.has(name.toLowerCase())) return false;
  if (!/url\(/i.test(value)) return false;
  return !LOCAL_REF.test(value);
}

/** The element's shadow root, open or closed (an extension's content script may read a closed one). */
function shadowRootOf(el: Element): ShadowRoot | null {
  if (el.shadowRoot) return el.shadowRoot;
  try {
    const dom = (
      globalThis as unknown as {
        chrome?: { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } };
      }
    ).chrome?.dom;
    return dom?.openOrClosedShadowRoot?.(el) ?? null;
  } catch {
    return null;
  }
}

/**
 * For a shadow host, the light-DOM children it draws: the ones its slots are
 * assigned. A light child no slot takes is never drawn, so it never travels.
 * Null when `el` hosts no shadow root (every light child counts).
 */
export function projectedLightChildren(el: Element): Set<Node> | null {
  const root = shadowRootOf(el);
  if (!root) return null;
  const drawn = new Set<Node>();
  for (const slot of Array.from(root.querySelectorAll("slot"))) {
    const assigned =
      typeof (slot as HTMLSlotElement).assignedNodes === "function"
        ? (slot as HTMLSlotElement).assignedNodes()
        : [];
    for (const n of assigned) drawn.add(n);
  }
  return drawn;
}
