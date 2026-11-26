// People, not actors (spec §2, §10). Everyone shown in the overlay is a
// person from a space's directory; an agent has no identity of its own, so
// there is no agent pill or bot avatar — an agent-marked message wears its
// person's avatar plus a small "agent" tag, and `@agent` is a token, not a
// person. Mention text is the shared convention (@onlay/render/mentions):
// `@<display name>`, so the text an agent reads stays legible; the token
// carries the id.
import type { PersonSummary, Token } from "@onlay/protocol";
import { AGENT_MENTION_TEXT, findMention } from "@onlay/render/mentions";

export type PersonView = PersonSummary;

/** The `@agent` token's wire text. */
export const AGENT_WIRE = AGENT_MENTION_TEXT;

const TINT_PALETTE = [
  "#0ea5e9",
  "#8b5cf6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#ec4899",
  "#14b8a6",
  "#6366f1",
];

function hashTint(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return TINT_PALETTE[Math.abs(h) % TINT_PALETTE.length] as string;
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]?.slice(0, 2).toUpperCase() ?? "?";
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
}

/** Someone the directory doesn't (yet) know: a stable tint, a neutral name. */
/** The stand-ins made for people not (yet) in any directory this client holds. */
const STAND_INS = new WeakSet<PersonView>();

export function unknownPerson(id: string): PersonView {
  const name = id === "system" ? "system" : "Someone";
  const p: PersonView = { id, name, tint: hashTint(id), initials: initialsOf(name) };
  STAND_INS.add(p);
  return p;
}

/** A person's name as this client knows it; undefined for a stand-in. */
export function knownName(person: (id: string) => PersonView, id: string): string | undefined {
  const p = person(id);
  return STAND_INS.has(p) ? undefined : p.name;
}

/** A person's alias as this client was given it (only a space's members are); else undefined. */
export function knownAlias(person: (id: string) => PersonView, id: string): string | undefined {
  return person(id).alias || undefined;
}

/** Where a token's wire text sits in `text` from `from` on (the shared helper). */
export function findWire(
  text: string,
  tok: Token,
  person: (id: string) => PersonView,
  from: number,
): { index: number; length: number } | null {
  return findMention(
    text,
    tok,
    (id) => person(id).name,
    from,
    (id) => knownAlias(person, id),
  );
}
