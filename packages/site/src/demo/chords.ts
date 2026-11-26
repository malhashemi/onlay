// The overlay's key chords, as the extension has them (overlay/shortcuts.ts):
// a command is two keys typed one after the other (`cc`, `ee`, `ii`), each
// within a short window, and only outside anything editable. The first key of
// a chord is held back from the page while the second is awaited.

/** Long enough to type two keys, short enough to feel instant. */
const CHORD_WINDOW_MS = 600;

export interface Chords {
  /** Feed a key. True when the key was the dispatcher's (armed or fired). */
  key(key: string): boolean;
  reset(): void;
}

export interface ChordsDeps {
  /** chord → what it runs. */
  bindings: Readonly<Record<string, () => void>>;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  windowMs?: number;
}

export function createChords(deps: ChordsDeps): Chords {
  const windowMs = deps.windowMs ?? CHORD_WINDOW_MS;
  let pending: string | null = null;
  let timer: unknown = null;

  function reset(): void {
    pending = null;
    if (timer !== null) {
      deps.clearTimeout(timer);
      timer = null;
    }
  }

  function isPrefix(key: string): boolean {
    return Object.keys(deps.bindings).some((chord) => chord.length === 2 && chord[0] === key);
  }

  return {
    reset,
    key(key) {
      if (key.length !== 1 || !/^[a-z0-9]$/.test(key)) {
        reset();
        return false;
      }
      if (pending !== null) {
        const run = deps.bindings[pending + key];
        reset();
        if (run) {
          run();
          return true;
        }
        // An unfinished chord falls through: this key may start one of its own.
      }
      if (!isPrefix(key)) return false;
      pending = key;
      timer = deps.setTimeout(reset, windowMs);
      return true;
    },
  };
}

/** True for a node the visitor types into: its keys are never chords. */
export function isEditable(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const el = node as { localName?: string; isContentEditable?: boolean; type?: string };
  const tag = el.localName;
  if (tag === "textarea" || tag === "select") return true;
  if (tag === "input") return el.type !== "button" && el.type !== "checkbox" && el.type !== "radio";
  return el.isContentEditable === true;
}
