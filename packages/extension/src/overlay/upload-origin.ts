// What every upload tells the service worker about where it came from (R3-C4):
// the page URL at the moment of sending and the account generation this page
// last heard from the service worker. The service worker compares both with
// what it knows itself (the sender's tab and document, its own generation)
// before any byte leaves.

let generation: number | null = null;

/** Adopt the generation the service worker's status reported. */
export function noteAccountGeneration(g: unknown): void {
  generation = typeof g === "number" && Number.isInteger(g) ? g : null;
}

/** The account generation this page last heard, or null. */
export function accountGeneration(): number | null {
  return generation;
}

/** The fields an upload message carries so the service worker can check its sender. */
export function uploadOrigin(): { pageUrl: string; generation: number | null } {
  return { pageUrl: typeof location === "undefined" ? "" : location.href, generation };
}
