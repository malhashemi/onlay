// Which documents own blocks (round 3, 2-F4). A frame's thread address is its
// own URL; only a web page has an address that belongs to it alone.
// about:blank, about:srcdoc, blob: and data: documents, and documents with an
// opaque origin (a frame sandboxed without allow-same-origin), share or hide
// theirs, so nothing is bound to them. A same-origin addressless frame is
// part of the page that made it instead (frame-path.ts, A-3).

/** This window's document is an http(s) page with an origin of its own. */
export function isWebDocument(win: Window): boolean {
  try {
    const protocol = win.location.protocol;
    if (protocol !== "http:" && protocol !== "https:") return false;
    // `origin` is the document's; an opaque one reads "null".
    return win.origin !== "null" && win.origin === win.location.origin;
  } catch {
    return false;
  }
}

/**
 * A frame address the service worker reported is an http(s) page with a real
 * origin: the browser-reported origin must be there and be the one the URL
 * names (3-F4); a missing or opaque ("null") origin owns nothing.
 */
export function isWebAddress(url: string | undefined, origin: string | undefined): boolean {
  if (!url || !origin || origin === "null") return false;
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && u.origin === origin;
  } catch {
    return false;
  }
}
