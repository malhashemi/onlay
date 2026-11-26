// Page script can dispatch synthetic events at the window and, in an open-root
// test build, at the overlay itself. Nothing the page synthesizes may open a
// surface that shows private data or perform an act: every such dispatch point
// asks this first. `isTrusted` is true only for input the browser itself
// produced from a person's keyboard or pointer.
export function isTrustedEvent(e: Event): boolean {
  return e.isTrusted === true;
}
