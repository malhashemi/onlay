/**
 * The one rule for where a person's mention stands in a message's text,
 * shared by the clients' pill matching (`@onlay/render` mentions), the
 * space's span check and the agent rendering (MCP), so all three agree on
 * what is a mention and what is the author's own words.
 *
 * - Spellings: `@` and the person's current name, `@` and their id (what
 *   survives when no name was known), and `@` and their alias when the reader
 *   has it (a message written while the person was shown by their alias).
 * - Boundaries: a run stands alone when it is not glued to a word on its left
 *   (`ann@bea.example` holds no `@bea`) and does not run on into one on its
 *   right (`@Ann` inside `@Anna` is not `@Ann`; a hyphen or punctuation ends a
 *   run, so `@Bea-approved` holds `@Bea`).
 */

/** A run keeps going past this character. */
export const MENTION_CONTINUES = /[\p{L}\p{N}_]/u;
/** A run glued to this character on its left is part of a word, not a mention. */
export const MENTION_GLUED_BEFORE = /[\p{L}\p{N}_.+]/u;

/** The texts a person's mention may stand on, longest first (so a longer name wins at a place). */
export function personSpellings(
  personId: string,
  name: string | undefined,
  alias?: string | undefined,
): string[] {
  const out = new Set<string>();
  if (name !== undefined && name !== "") out.add(`@${name}`);
  out.add(`@${personId}`);
  if (alias !== undefined && alias !== "") out.add(`@${alias}`);
  return [...out].sort((a, b) => b.length - a.length);
}

function codePointBefore(text: string, at: number): string {
  if (at <= 0) return "";
  const low = text.charCodeAt(at - 1);
  if (at >= 2 && low >= 0xdc00 && low <= 0xdfff) {
    const high = text.charCodeAt(at - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(at - 2, at);
  }
  return text.charAt(at - 1);
}

function codePointAt(text: string, at: number): string {
  const cp = text.codePointAt(at);
  return cp === undefined ? "" : String.fromCodePoint(cp);
}

/** The run `[start, end)` stands alone: not glued to a word on either side. */
export function runStandsAlone(text: string, start: number, end: number): boolean {
  const before = codePointBefore(text, start);
  if (before !== "" && MENTION_GLUED_BEFORE.test(before)) return false;
  const after = codePointAt(text, end);
  return !(after !== "" && MENTION_CONTINUES.test(after));
}
