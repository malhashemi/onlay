// Mention text, one convention for every client (spec §10): tokens route,
// text is what people and agents read. A person mention's text is `@` plus
// the person's display name (`@Ada Lovelace`), `@agent` hands the thread to
// an agent, and an anchor reads as `#<label>`. The token carries the person
// id, so a message written in the extension reads right in the web app, in a
// plain-text rendering and to an agent, with no directory-dependent handle.
import {
  parseFences,
  personSpellings,
  type RawRichText,
  runStandsAlone,
  type Token,
} from "@onlay/protocol";

/** The text the `@agent` token occupies. */
export const AGENT_MENTION_TEXT = "@agent";

/** The text a person mention occupies: `@<display name>`. */
export function personMentionText(name: string): string {
  return `@${name}`;
}

/** The text a token occupies in a message, given each person's current name. */
export function mentionTextOf(tok: Token, nameOf: (personId: string) => string): string {
  if (tok.t === "agent") return AGENT_MENTION_TEXT;
  if (tok.t === "anchor") return `#${tok.label}`;
  return personMentionText(nameOf(tok.actorId));
}

// Where a pill's text stands is the one rule of `@onlay/protocol`
// (`mention-rule.ts`), which the space's span check and the agent rendering
// use too: not glued to a word on its left, not running on into one on its right.

/** `at` falls between the two halves of a surrogate pair. */
function splitsPair(text: string, at: number): boolean {
  if (at <= 0 || at >= text.length) return false;
  const before = text.charCodeAt(at - 1);
  const after = text.charCodeAt(at);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/**
 * The texts a token's pill may stand on: `@agent`; an anchor's `#<label>`;
 * for a person, `@` and their name or their id, and `@` and their alias when
 * the reader knows it (a member: a message written while the person was
 * shown by their alias keeps its pill after they take a name). A person the
 * reader cannot resolve yet (`nameOf` gives undefined) has none: their words
 * stay text.
 */
export function mentionSpellings(
  tok: Token,
  nameOf: (personId: string) => string | undefined,
  aliasOf: (personId: string) => string | undefined = () => undefined,
): string[] {
  if (tok.t === "agent") return [AGENT_MENTION_TEXT];
  if (tok.t === "anchor") return [`#${tok.label}`];
  const name = nameOf(tok.actorId);
  if (name === undefined) return [];
  return personSpellings(tok.actorId, name, aliasOf(tok.actorId));
}

/**
 * A stored span really holds the token: both ends on character boundaries,
 * the text under it exactly one of the token's spellings, and the run whole
 * (`@Ann` inside `@Anna` is not `@Ann`).
 */
export function spanHolds(
  text: string,
  start: number,
  length: number,
  spellings: readonly string[],
): boolean {
  const end = start + length;
  if (!Number.isInteger(start) || !Number.isInteger(length)) return false;
  if (start < 0 || length < 1 || end > text.length) return false;
  if (splitsPair(text, start) || splitsPair(text, end)) return false;
  return spellings.includes(text.slice(start, end)) && runStandsAlone(text, start, end);
}

/**
 * The earliest whole-run occurrence of any of `spellings` at or after
 * `from` that `free` accepts: a blocked occurrence never hides a later
 * eligible one, of the same spelling or another.
 */
export function findSpelling(
  text: string,
  spellings: readonly string[],
  from: number,
  free: (start: number, end: number) => boolean = () => true,
): { index: number; length: number } | null {
  let best: { index: number; length: number } | null = null;
  for (const wire of spellings) {
    if (!wire) continue;
    for (let at = text.indexOf(wire, from); at >= 0; at = text.indexOf(wire, at + 1)) {
      if (best && at >= best.index) break;
      const end = at + wire.length;
      if (!runStandsAlone(text, at, end) || !free(at, end)) continue;
      best = { index: at, length: wire.length };
      break;
    }
  }
  return best;
}

/**
 * Where a token's text sits in `text`, searching from `from` and matching
 * whole words only (`@agents` is not `@agent`): the earliest of its current
 * form and, for a person, the bare `@<person id>` (what survives when no name
 * was known at writing time).
 */
export function findMention(
  text: string,
  tok: Token,
  nameOf: (personId: string) => string,
  from: number,
  aliasOf?: (personId: string) => string | undefined,
): { index: number; length: number } | null {
  return findSpelling(text, mentionSpellings(tok, nameOf, aliasOf), from);
}

/**
 * `body` with `prefix` written before its text, cut at `cap`: every pill span
 * moves with the text (M-4), a token whose explicit spans the cut all
 * reached is dropped (its pill is gone; it must not attach elsewhere), so the
 * spans still point at the pills a reader sees. The prefix is one line; a
 * body that opens with a fenced block gets it on a line of its own, so the
 * fence still starts its line.
 */
export function withPrefix(body: RawRichText, prefix: string, cap: number): RawRichText {
  const line = prefix.replace(/[\r\n]+/g, " ");
  const opensWithBlock = parseFences(body.text)[0]?.start === 0;
  const lead = opensWithBlock ? `${line.trimEnd()}\n` : line;
  const text = `${lead}${body.text}`.slice(0, cap);
  if (!body.tokens) return { text };
  const tokens: Token[] = [];
  for (const tok of body.tokens) {
    if (tok.spans === undefined) {
      tokens.push(tok);
      continue;
    }
    const { spans: all, ...rest } = tok;
    const spans = all
      .map((sp) => ({ start: sp.start + lead.length, length: sp.length }))
      .filter((sp) => sp.start + sp.length <= text.length);
    if (spans.length > 0) tokens.push({ ...rest, spans } as Token);
  }
  return tokens.length > 0 ? { text, tokens } : { text };
}

/**
 * The text and mentions a composer holds now are still the revision that was
 * sent: only then may the send's answer clear it. Anything typed after the
 * send stays (M-1). Spans follow the text, so they are not compared.
 */
export function sameRevision(now: RawRichText, sent: RawRichText): boolean {
  if (now.text !== sent.text) return false;
  const pills = (v: RawRichText) =>
    JSON.stringify((v.tokens ?? []).map(({ spans: _spans, ...tok }) => tok));
  return pills(now) === pills(sent);
}
