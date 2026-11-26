// Configurable chord shortcuts (F-031). Pure key-sequence machinery — the
// content script owns the guards (editable targets, open panels) via
// `isBlocked` and maps action names onto the EXISTING mode machinery.
//
// Chord grammar (vim-style, server-validated to 1–2 chars of [a-z0-9]):
//   - a two-key chord fires immediately on its second key;
//   - a single-key binding that is also a chord prefix (e.g. `a` under
//     `ca`/`cc`… no — `a` under no prefix) fires immediately; when some
//     chord starts with the same key, the single fires only after the
//     600 ms chord window lapses with no second key;
//   - any modifier, non-character key, or blocked context resets the chord.
//   - a key the page synthesized (`isTrusted` false) is ignored outright.
import { isTrustedEvent } from "./trusted";

/** Default chord window: long enough to type two keys, short enough to feel instant. */
const CHORD_WINDOW_MS = 600;

const CHORD_RE = /^[a-z0-9]{1,2}$/;

export interface ChordDispatcher {
  /** Feed capture-phase keydown events. Consumed keys are preventDefault'd. */
  handleKeydown(e: KeyboardEvent): void;
  /** Replace the action→chord map (e.g. when prefs change). */
  setBindings(bindings: Record<string, string>): void;
  /**
   * Bind the modifier accelerator from a `ctrl+<key>` string (ADR-0019 §3 —
   * prefs.keyboard.commandBar). Invalid/empty disables it.
   */
  setAccel(binding: string | null): void;
  /** Drop any armed chord. */
  reset(): void;
}

export interface ChordDispatcherOpts {
  /** An action's chord completed. */
  fire(action: string): void;
  /** Hard guard: editable target focused, a panel open, etc. */
  isBlocked(e: KeyboardEvent): boolean;
  /** The accelerator (Ctrl+.) completed — toggle the command bar. */
  onAccel?(): void;
  /**
   * The accelerator's own guard (defaults to `isBlocked`). Softer in
   * practice: the bar's OWN input must not block the toggle-to-close.
   */
  isAccelBlocked?(e: KeyboardEvent): boolean;
  windowMs?: number;
}

export function createChordDispatcher(opts: ChordDispatcherOpts): ChordDispatcher {
  const windowMs = opts.windowMs ?? CHORD_WINDOW_MS;
  /** chord → action (inverted from the config's action → chord). */
  let byChord = new Map<string, string>();
  /** The accelerator's key (`.` of "ctrl+."); null = disabled. */
  let accelKey: string | null = null;
  let pending: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function reset(): void {
    pending = null;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function setBindings(bindings: Record<string, string>): void {
    byChord = new Map();
    for (const [action, chord] of Object.entries(bindings)) {
      if (typeof chord === "string" && CHORD_RE.test(chord)) byChord.set(chord, action);
    }
    reset();
  }

  function isPrefix(key: string): boolean {
    for (const chord of byChord.keys()) {
      if (chord.length === 2 && chord[0] === key) return true;
    }
    return false;
  }

  /**
   * Swallow a keydown the dispatcher claims — arming a chord prefix OR
   * completing a binding. Without this the prefix key (`c` of `cc`) leaks to
   * the page and fires ITS shortcut. Tradeoff (same policy as Vimium): a bound
   * prefix shadows the page's plain key while no editable is focused; unbound
   * keys are never touched.
   */
  function swallow(e: KeyboardEvent): void {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function consume(e: KeyboardEvent, action: string): void {
    swallow(e);
    reset();
    opts.fire(action);
  }

  function setAccel(binding: string | null): void {
    const m = binding === null ? null : /^ctrl\+([^\s+])$/i.exec(binding.trim());
    accelKey = m?.[1]?.toLowerCase() ?? null;
  }

  function handleKeydown(e: KeyboardEvent): void {
    // A key the page synthesized never opens the bar or runs a command.
    if (!isTrustedEvent(e)) return;
    // The modifier accelerator (Ctrl+., ADR-0019 §3) — checked BEFORE the
    // modifier reset so ctrl never merely clears state when it IS the chord.
    if (
      accelKey !== null &&
      e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.shiftKey &&
      e.key.toLowerCase() === accelKey
    ) {
      reset();
      if ((opts.isAccelBlocked ?? opts.isBlocked)(e)) return;
      swallow(e);
      opts.onAccel?.();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) {
      reset();
      return;
    }
    const key = e.key;
    if (key.length !== 1 || !/^[a-z0-9]$/.test(key)) {
      reset();
      return;
    }
    if (e.repeat) return;
    if (opts.isBlocked(e)) {
      reset();
      return;
    }
    if (pending !== null) {
      const action = byChord.get(pending + key);
      reset();
      if (action !== undefined) {
        consume(e, action);
        return;
      }
      // an unfinished chord falls through: the second key may bind on its own
    }
    const single = byChord.get(key);
    if (single !== undefined && !isPrefix(key)) {
      consume(e, single);
      return;
    }
    if (isPrefix(key)) {
      // Arming a chord: swallow the prefix key so the page never sees it while
      // we wait for the second key (else `c` of `cc` triggers a page shortcut).
      swallow(e);
      pending = key;
      timer = setTimeout(() => {
        reset();
        // a lone prefix key that is ALSO a single binding fires on lapse
        if (single !== undefined) opts.fire(single);
      }, windowMs);
    }
  }

  return { handleKeydown, setBindings, setAccel, reset };
}
