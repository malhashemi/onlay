/**
 * One item an agent works on: the ref split into its space and interaction,
 * the interaction as the space serves it, and the names of the people in it.
 */
import { type CaptureRef, parseRef, type RawInteractionSnapshot } from "@onlay/protocol";
import { ToolError } from "./result";
import { type AgentSpaces, type Json, NOT_FOUND_SENTENCE } from "./space";

export interface Item {
  ref: string;
  spaceId: string;
  id: string;
  interaction: RawInteractionSnapshot & { captures?: CaptureRef[] };
  /** The interaction's last journal sequence number when read. */
  seq: number;
  /** The kept entry, while the Edit is kept or being worked on. */
  kept?: Json;
}

export function splitRef(ref: string): { spaceId: string; id: string } {
  const parsed = parseRef(ref);
  if (parsed === null) throw new ToolError(NOT_FOUND_SENTENCE);
  return { spaceId: parsed.spaceId, id: parsed.interactionId };
}

export async function loadItem(spaces: AgentSpaces, ref: string): Promise<Item> {
  const { spaceId, id } = splitRef(ref);
  const body = await spaces.read(spaceId, `/interaction/${id}`);
  return {
    ref,
    spaceId,
    id,
    interaction: body.interaction,
    seq: typeof body.seq === "number" ? body.seq : 0,
    ...(body.kept ? { kept: body.kept } : {}),
  };
}

/**
 * A person's display name in this space (the space's directory), as stored:
 * frame it (`who`) in a sentence; the thread renderer declassifies it.
 */
export async function namesIn(
  spaces: AgentSpaces,
  spaceId: string,
  signal?: AbortSignal,
): Promise<NamesIn> {
  const body = await spaces.read(spaceId, "/directory", signal);
  const names = new Map<string, string>();
  const aliases = new Map<string, string>();
  for (const p of (body.people ?? []) as { id: string; name: string; alias?: string }[]) {
    names.set(p.id, p.name);
    if (typeof p.alias === "string" && p.alias !== "") aliases.set(p.id, p.alias);
  }
  const nameOf = (personId: string) => names.get(personId) ?? "someone";
  // The alias, as the directory gave it to this person (only to a member): a
  // spelling the thread renderer also frames (`@onlay/protocol` mention-rule).
  return Object.assign(nameOf, { aliasOf: (personId: string) => aliases.get(personId) });
}

/** A person's display name in a space, and the alias the reader was given for them. */
export type NamesIn = ((personId: string) => string) & {
  aliasOf: (personId: string) => string | undefined;
};
