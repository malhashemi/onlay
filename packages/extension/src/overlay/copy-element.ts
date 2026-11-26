// Copy element (F-041): the Select grounding path, replaced. Clicking an
// element in copy mode puts its full outerHTML on the clipboard — a purely
// local act: NO interaction is created, NOTHING reaches the SW or server.

export interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

/**
 * Copy the element's outerHTML. `clipboard.writeText` is invoked
 * SYNCHRONOUSLY — callers must run this inside the click handler itself so
 * the write still carries the user gesture (an `await` before it would
 * forfeit the transient activation).
 */
export function copyElement(
  target: Element,
  clipboard: ClipboardLike,
  toast: (text: string) => void,
): void {
  const html = target.outerHTML;
  clipboard.writeText(html).then(
    () => toast(`block HTML copied (${html.length} chars)`),
    () => toast("copy failed — clipboard unavailable"),
  );
}
