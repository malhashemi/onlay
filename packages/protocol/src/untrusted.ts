import { LIMITS } from "./limits";

declare const brand: unique symbol;

/**
 * Page-derived text — attacker-controlled prompt input (the membrane's
 * first-class threat). Deliberately NOT a string subtype: an `UntrustedText`
 * value cannot flow into a string-typed sink (prompt text, tool call, shell
 * command) without passing through one of the two named gates below. The
 * runtime representation is a plain string, so JSON round-trips untouched.
 */
export type UntrustedText = { readonly [brand]: "UntrustedText" };

/** Brand a page-derived string at the ingest boundary. */
export function untrusted(s: string): UntrustedText {
  return s as unknown as UntrustedText;
}

/**
 * Every character that ends a line or controls the terminal: C0, DEL, C1
 * (which holds NEL, U+0085), and the Unicode line and paragraph separators.
 * Each becomes a space, so declassified text is always one line.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: replacing control chars is the point
const LINE_AND_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * Invisible characters that reorder or hide text: the bidirectional marks,
 * embeddings, overrides and isolates, zero-width space and the byte-order
 * mark. Removed outright.
 */
const BIDI_AND_INVISIBLE = /[\u061c\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * THE sanctioned path from page text to prompt-safe text. Turns every line
 * break (ASCII or Unicode) and control character into a space, removes
 * bidirectional and invisible formatting characters, and truncates. Call
 * sites are the audit surface — grep `declassify(` to see every place page
 * text may enter an agent prompt.
 */
export function declassify(t: UntrustedText, max: number = LIMITS.MAX_TEXT_SNIPPET): string {
  return (t as unknown as string)
    .replace(LINE_AND_CONTROL, " ")
    .replace(BIDI_AND_INVISIBLE, "")
    .slice(0, max);
}

/**
 * Safe sink: page-derived text returning to the page it came from (e.g. a
 * captured selector echoed back in a highlight command). NOT for prompts —
 * use `declassify` for anything agent-facing.
 */
export function unwrapForPage(t: UntrustedText): string {
  return t as unknown as string;
}
