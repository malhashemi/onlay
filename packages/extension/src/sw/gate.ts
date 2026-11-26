// The privacy gate (spec §7, §10). A page sync carries the page's URL; a space
// only hears it when the page's origin already has live anchored interactions
// that space lets this person see (`/api/origins`, refreshed by `origins`
// frames). Every other space gets nothing, and the tab gets an empty snapshot
// for it locally, so browsing never tells a space where you are.

/** The frames that carry the page URL and ask a space what it holds there. */
export const PAGE_SYNC_TYPES: ReadonlySet<string> = new Set(["interaction-sync", "variant-sync"]);

export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

export interface GateSplit {
  /** Spaces whose origin set holds the page's origin: the sync goes to them. */
  relay: string[];
  /** Every other space: answered locally with an empty snapshot. */
  local: string[];
}

export function splitPageSync(
  frameUrl: string,
  spaceIds: readonly string[],
  origins: Readonly<Record<string, readonly string[]>>,
): GateSplit {
  const origin = originOf(frameUrl);
  const relay: string[] = [];
  const local: string[] = [];
  for (const id of spaceIds) {
    if (origin !== null && (origins[id] ?? []).includes(origin)) relay.push(id);
    else local.push(id);
  }
  return { relay, local };
}
