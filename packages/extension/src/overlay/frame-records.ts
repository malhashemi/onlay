// What the top frame takes from a child frame's report, and when it forgets
// a child document (2-F5, 3-F5). Pure, so the rules are pinned by tests.

/** A snapshot as a child frame reports it: it names its space. */
interface Reported {
  id: string;
  spaceId: string;
  url?: string | undefined;
}

/**
 * The snapshots of a report the top frame keeps: well formed, in a space it
 * knows, and taken under an access revision no older than the newest one it
 * has been told of for that space. A space without a revision in the report
 * keeps nothing.
 */
export function acceptReported<T extends Reported>(
  list: readonly unknown[],
  revs: Readonly<Record<string, unknown>>,
  knownRev: (spaceId: string) => number,
  knownSpace: (spaceId: string) => boolean,
): T[] {
  return list.filter((v): v is T => {
    if (!v || typeof v !== "object") return false;
    const s = v as Reported;
    if (typeof s.id !== "string" || typeof s.spaceId !== "string" || typeof s.url !== "string")
      return false;
    if (!knownSpace(s.spaceId)) return false;
    const rev = revs[s.spaceId];
    return typeof rev === "number" && rev >= knownRev(s.spaceId);
  });
}

/** The child documents silent for longer than `ms`: everything held about them goes. */
export function silentDocuments(
  docs: Iterable<string>,
  lastHeard: ReadonlyMap<string, number>,
  now: number,
  ms: number,
): string[] {
  return [...new Set(docs)].filter((d) => now - (lastHeard.get(d) ?? 0) > ms);
}
