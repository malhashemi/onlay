// Which page an Edit belongs to. Kept programs, variant previews and every
// capture run on someone's live page, so they only run on the exact page the
// Edit was made on: the exact URL string the server binds an interaction to
// (the frame URL the overlay sends, capped like it), FRAGMENT INCLUDED. A
// hash-routed app keeps different records at different fragments, and the
// server's snapshot lookup uses the full URL. No prefix matching: an Edit on
// /orders/1 is not an Edit on /orders/1/details, /orders/10 or /orders/1#2.
import { LIMITS } from "@onlay/protocol";

/** The URL as the server binds it, or null for anything that is not an http(s) URL. */
export function pageKey(url: string | undefined): string | null {
  if (typeof url !== "string" || url === "") return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.href.slice(0, LIMITS.MAX_URL);
  } catch {
    return null;
  }
}

/** True when both URLs name the same page, fragment and all. */
export function samePage(a: string | undefined, b: string | undefined): boolean {
  const ka = pageKey(a);
  return ka !== null && ka === pageKey(b);
}
