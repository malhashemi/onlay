// The render-time external-URL scrub (render spec §1.6). Runs AFTER inlining
// and guarantees zero external references survive into the srcdoc — the egress
// belt to the CSP's suspenders and the `sandbox=""` frame's opaque origin. On a
// well-formed capture it finds nothing (capture already inlined/rewrote), so a
// non-zero count is a capture-side bug the fidelity harness surfaces.
//
// Fragment-only refs (`url(#grad)`, `xlink:href="#sym"`) are same-document with
// zero egress and are KEPT (A19); only scheme-ful / path-ful references are
// stripped and counted.

import { declarationBounds } from "./inline";

/** URL-bearing attributes; a non-(data:|#) value is stripped defense-in-depth. */
const URL_ATTRS = ["src", "href", "xlink:href", "poster", "srcset", "background"];

function isInertUrl(value: string): boolean {
  const v = value.trim();
  return v.startsWith("data:") || v.startsWith("#");
}

/**
 * Parse one `url(...)` token starting at `idx` (the "u" of "url"). Handles
 * quoted values whose payload may itself contain `)` (`url("a)b.png")`) — the
 * old `[^'")]*` class terminated at the first `)` and silently left the external
 * reference behind. Returns the raw URL value + the end index (just past `)`),
 * or null if the token is malformed.
 */
function parseUrlToken(css: string, idx: number): { value: string; end: number } | null {
  let i = idx + 4; // past "url("
  while (i < css.length && /\s/.test(css[i] ?? "")) i += 1;
  const quote = css[i];
  if (quote === '"' || quote === "'") {
    i += 1;
    const start = i;
    while (i < css.length && css[i] !== quote) i += 1;
    if (i >= css.length) return null; // unterminated
    const value = css.slice(start, i);
    i += 1; // past closing quote
    while (i < css.length && /\s/.test(css[i] ?? "")) i += 1;
    if (css[i] !== ")") return null;
    return { value, end: i + 1 };
  }
  const start = i;
  while (i < css.length && css[i] !== ")") i += 1;
  if (i >= css.length) return null;
  return { value: css.slice(start, i).trim(), end: i + 1 };
}

/** Strip `@import`s and scheme/path `url()`s from one CSS text; keep data:/#. */
function scrubCss(css: string): { text: string; count: number } {
  let count = 0;
  let working = css.replace(/@import[^;]*;/gi, () => {
    count += 1;
    return "";
  });

  let cursor = 0;
  for (;;) {
    const rel = working.slice(cursor).search(/url\(/i);
    if (rel < 0) break;
    const idx = cursor + rel;
    const tok = parseUrlToken(working, idx);
    if (!tok) {
      cursor = idx + 4;
      continue;
    }
    if (isInertUrl(tok.value)) {
      cursor = tok.end;
      continue;
    }
    const { from, to } = declarationBounds(working, idx, tok.end);
    working = working.slice(0, from) + working.slice(to);
    count += 1;
    cursor = from;
  }
  return { text: working, count };
}

/**
 * Scrub the parsed doc in place; return the number of external references
 * removed (feeds `RenderResidue.strippedUrls`). Operates on the parsed DOM (not
 * the final string) so serialization stays faithful.
 */
export function scrubExternalUrls(doc: Document): number {
  let count = 0;
  for (const style of doc.querySelectorAll("style")) {
    const text = style.textContent ?? "";
    if (!text.includes("url(") && !/@import/i.test(text)) continue;
    const out = scrubCss(text);
    if (out.count > 0) style.textContent = out.text;
    count += out.count;
  }
  for (const el of doc.querySelectorAll("*")) {
    for (const name of URL_ATTRS) {
      const value = el.getAttribute(name);
      if (value === null) continue;
      // `srcset` is a multi-candidate list; `isInertUrl` only inspects its head,
      // so a `data:`-leading `srcset` with external candidates would survive. The
      // walker resolves imgs to a single part ref and drops `srcset` at capture,
      // so any survivor is residue — strip it unconditionally.
      if (name === "srcset" || !isInertUrl(value)) {
        el.removeAttribute(name);
        count += 1;
      }
    }
  }
  return count;
}
