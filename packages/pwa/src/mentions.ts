// Who can be mentioned in a space: its people (from `/s/<id>/directory`) plus
// `@agent`. Person ids are opaque (`p_…`), so the composer shows a readable
// handle per person, derived from their name, and serialization resolves the
// handle back to the id for the token (tokens route; text is what people
// read). Handles are deterministic for a given directory: people sort by id,
// the first to claim a slug keeps it bare, later ones get `-2`, `-3`, …
// `agent` is never a person's handle.
import type { PersonSummary } from "@onlay/protocol";

/** One row of the mention list. `id` is a person id, or "agent". */
export interface Mentionable {
  handle: string;
  id: string;
  name: string;
  initials: string;
  tint: string;
  avatarUrl?: string | undefined;
  /** Their alias (their email's local part), when the space gives it (to members). */
  alias?: string | undefined;
  agent?: boolean;
}

export const AGENT_HANDLE = "agent";

/** The `@agent` row: hands the thread to an agent. */
export const AGENT_MENTION: Mentionable = {
  handle: AGENT_HANDLE,
  id: AGENT_HANDLE,
  name: "agent",
  initials: "AI",
  tint: "#64748b",
  agent: true,
};

/** A name as a handle: lower-case ASCII letters, digits and hyphens. */
export function slugOf(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "person";
}

/** Handle → mentionable for a space's people, plus `@agent` when allowed. */
export function mentionablesFor(
  people: readonly PersonSummary[],
  opts: { agent: boolean },
): Map<string, Mentionable> {
  const out = new Map<string, Mentionable>();
  if (opts.agent) out.set(AGENT_HANDLE, AGENT_MENTION);
  const taken = new Set<string>([AGENT_HANDLE]);
  for (const p of [...people].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const base = slugOf(p.name);
    let handle = base;
    for (let n = 2; taken.has(handle); n++) handle = `${base}-${n}`;
    taken.add(handle);
    out.set(handle, {
      handle,
      id: p.id,
      name: p.name,
      initials: p.initials,
      tint: p.tint,
      ...(p.avatarUrl ? { avatarUrl: p.avatarUrl } : {}),
      ...(p.alias ? { alias: p.alias } : {}),
    });
  }
  return out;
}
