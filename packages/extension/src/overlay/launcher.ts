// The launcher (ADR-0019 §1, amended by ADR-0020): the ONE persistent piece
// of page chrome — and it IS the mark, in product-control dress: the drawing,
// a connection dot, and the needs-you count; nothing else may join it. Click
// opens your Inbox; hold-drag moves it; double-click resets to the default
// corner. Keyboard: it is a real button — Enter/Space open the Inbox.
//
// The pure drag/position machinery is inherited from the island (vision A-1):
// movement threshold so clicks never move it, viewport clamping, nearest-edge
// anchoring, offscreen recovery on resize — with persistence repointed at
// prefs.launcherPos (ADR-0019 §4). Timers/DOM are injectable; tests drive the
// controllers by hand.
import { getPrefs, patchPrefs } from "../prefs";
import { el, markSvg } from "./dom";
import { routePointerDrag } from "./drag-router";

/* ── geometry ────────────────────────────────────────────────────────── */

const LAUNCHER_MARGIN = 8;

/** Clamp a top-left position so a w×h box stays fully inside the viewport. */
export function clampPos(
  x: number,
  y: number,
  w: number,
  h: number,
  vw: number,
  vh: number,
  margin = LAUNCHER_MARGIN,
): { x: number; y: number } {
  const maxX = Math.max(margin, vw - w - margin);
  const maxY = Math.max(margin, vh - h - margin);
  return {
    x: Math.min(Math.max(x, margin), maxX),
    y: Math.min(Math.max(y, margin), maxY),
  };
}

/* ── drag controller ─────────────────────────────────────────────────── */

export interface DragControllerDeps {
  /** Launcher rect at pointerdown (origin) and for clamping (size). */
  rect(): { left: number; top: number; width: number; height: number };
  viewport(): { w: number; h: number };
  /** Live position while dragging (already viewport-clamped). */
  apply(pos: { x: number; y: number }): void;
  /** Final position on release — persist + re-anchor. */
  commit(pos: { x: number; y: number }): void;
  onDragChange?(dragging: boolean): void;
  thresholdPx?: number;
}

export interface DragController {
  down(px: number, py: number): void;
  move(px: number, py: number): void;
  up(): void;
  dragging(): boolean;
}

/** How far (CSS px) a press on the orb may travel and still be a click. */
const DRAG_THRESHOLD_PX = 4;

/**
 * Pointer-sample drag with a movement threshold: below ~4px nothing moves
 * (a click stays a click, a double-click stays a reset); beyond it the
 * launcher follows the pointer, clamped to the viewport, and `commit` fires
 * once on release. `up()` without crossing the threshold commits nothing.
 */
export function createDragController(deps: DragControllerDeps): DragController {
  const threshold = deps.thresholdPx ?? DRAG_THRESHOLD_PX;
  let tracking = false;
  let active = false;
  let startX = 0;
  let startY = 0;
  let originX = 0;
  let originY = 0;
  let width = 0;
  let height = 0;
  let last: { x: number; y: number } | null = null;

  return {
    down(px, py) {
      const r = deps.rect();
      tracking = true;
      active = false;
      last = null;
      startX = px;
      startY = py;
      originX = r.left;
      originY = r.top;
      width = r.width;
      height = r.height;
    },
    move(px, py) {
      if (!tracking) return;
      const dx = px - startX;
      const dy = py - startY;
      if (!active) {
        if (Math.hypot(dx, dy) <= threshold) return;
        active = true;
        deps.onDragChange?.(true);
      }
      const v = deps.viewport();
      last = clampPos(originX + dx, originY + dy, width, height, v.w, v.h);
      deps.apply(last);
    },
    up() {
      if (!tracking) return;
      tracking = false;
      if (!active) return;
      active = false;
      if (last) deps.commit(last);
      deps.onDragChange?.(false);
    },
    dragging: () => active,
  };
}

/* ── persistence (prefs.launcherPos — same spot on every page) ───────── */

export interface LauncherPos {
  x: number;
  y: number;
}

export interface PosStore {
  load(): Promise<LauncherPos | null>;
  /** Fire-and-forget; `null` clears the field (reset to the default corner). */
  save(pos: LauncherPos | null): void;
}

/** The real store: prefs.launcherPos via the prefs module (ADR-0019 §4). */
export function createPrefsPosStore(): PosStore {
  return {
    async load() {
      try {
        return (await getPrefs()).launcherPos ?? null;
      } catch {
        return null; // storage unavailable — default corner
      }
    },
    save(pos) {
      void patchPrefs({ launcherPos: pos ?? undefined }).then(undefined, () => {
        /* storage unavailable — position just won't persist */
      });
    },
  };
}

/* ── position controller (restore / commit / reset / re-clamp) ──────── */

/**
 * The style payload written onto the orb: `null` means the stylesheet's
 * default corner (bottom-right). Exactly one of left/right is set — a
 * right-half orb anchors by its right edge so it hugs that edge across
 * resizes, and vice versa.
 */
export type AppliedPos = { top: number; left: number | null; right: number | null } | null;

export interface LauncherPositionDeps {
  store: PosStore;
  rect(): { width: number; height: number };
  viewport(): { w: number; h: number };
  setPos(pos: AppliedPos): void;
  margin?: number;
}

export interface LauncherPosition {
  /** Pull the persisted position (if any) and apply it, clamped. */
  restore(): Promise<void>;
  /** Persist + re-anchor a dropped position. */
  commit(pos: LauncherPos): void;
  /** Double-click: back to the default corner, prefs field cleared. */
  reset(): void;
  /** Window resized — re-clamp the stored position. */
  reclamp(): void;
  current(): LauncherPos | null;
}

export function createLauncherPosition(deps: LauncherPositionDeps): LauncherPosition {
  const margin = deps.margin ?? LAUNCHER_MARGIN;
  let pos: LauncherPos | null = null;

  const apply = (): void => {
    if (!pos) {
      deps.setPos(null);
      return;
    }
    const r = deps.rect();
    const v = deps.viewport();
    const c = clampPos(pos.x, pos.y, r.width, r.height, v.w, v.h, margin);
    const anchorRight = c.x + r.width / 2 > v.w / 2;
    deps.setPos(
      anchorRight
        ? { top: c.y, left: null, right: v.w - c.x - r.width }
        : { top: c.y, left: c.x, right: null },
    );
  };

  return {
    async restore() {
      pos = await deps.store.load();
      if (pos) apply();
    },
    commit(p) {
      pos = p;
      deps.store.save(p);
      apply();
    },
    reset() {
      pos = null;
      deps.store.save(null);
      deps.setPos(null);
    },
    reclamp() {
      if (pos) apply();
    },
    current: () => pos,
  };
}

/* ── the orb ─────────────────────────────────────────────────────────── */

export type ConnectionState = "connected" | "reconnecting" | "offline";

const CONNECTION_TITLE: Record<ConnectionState, string> = {
  connected: "connected",
  reconnecting: "reconnecting…",
  offline: "signed out",
};

export interface LauncherOrbDeps {
  /** A real click (or Enter on the button) — open the command bar. */
  onOpen(): void;
  store: PosStore;
  /** The "edits shown" marker was clicked: list this page's kept edits. */
  onKeptNote?(): void;
  /** The "for agent" marker was clicked: copy this page's round. */
  onAgentNote?(): void;
}

/** The launcher's two quiet markers (spec §8, §10). */
export const LAUNCHER_COPY = {
  editsShown: (n: number) => (n === 1 ? "1 edit shown" : `${n} edits shown`),
  forAgent: (n: number) => `${n} for agent`,
  editsShownTitle: "Kept edits shown on this page — click to show or hide them",
  forAgentTitle: "Waiting for an agent on this page — click to copy",
} as const;

export interface LauncherOrb {
  element: HTMLElement;
  setConnection(state: ConnectionState): void;
  /** Needs-you count for this page; 0 hides the badge (and the glow). */
  setBadge(count: number): void;
  /** One anchor-ring pulse — a new needs-you announcing itself (ADR-0020). */
  ping(): void;
  /** Kept programs applied on this page; 0 hides the "edits shown" marker. */
  setKeptShown(count: number): void;
  /** This page's items pending for an agent; 0 hides the "for agent" marker. */
  setAgentPending(count: number): void;
  /** Apply the persisted position (clamped) on mount. */
  restore(): Promise<void>;
  /** Re-clamp after a viewport resize. */
  reclamp(): void;
}

export function createLauncherOrb(deps: LauncherOrbDeps): LauncherOrb {
  const btn = el("button", "orb") as HTMLButtonElement;
  btn.type = "button";
  btn.setAttribute("aria-label", "Onlay — open your Inbox");
  btn.appendChild(markSvg());
  const status = el("span", "orb-status");
  const badge = el("span", "orb-badge");
  const ping = el("span", "orb-ping");
  // The markers sit beside the mark, inside the orb so they move with it.
  const notes = el("span", "orb-notes");
  const keptNote = el("span", "orb-note");
  keptNote.title = LAUNCHER_COPY.editsShownTitle;
  const agentNote = el("span", "orb-note agent");
  agentNote.title = LAUNCHER_COPY.forAgentTitle;
  notes.append(keptNote, agentNote);
  btn.append(status, badge, ping, notes);
  const noteClick = (node: HTMLElement, run: (() => void) | undefined): void => {
    node.addEventListener("pointerdown", (e) => e.stopPropagation());
    node.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (!e.isTrusted) return;
      run?.();
    });
  };
  noteClick(keptNote, deps.onKeptNote);
  noteClick(agentNote, deps.onAgentNote);
  const setNote = (node: HTMLElement, text: string, count: number): void => {
    node.textContent = text;
    node.style.display = count > 0 ? "inline-flex" : "none";
    notes.style.display =
      keptNote.style.display === "none" && agentNote.style.display === "none" ? "none" : "flex";
  };
  setNote(keptNote, "", 0);
  setNote(agentNote, "", 0);

  const applyStyle = (p: AppliedPos): void => {
    // On the left half the markers open rightward, so they stay on screen.
    btn.classList.toggle("left-half", p !== null && p.left !== null);
    if (!p) {
      btn.style.top = "";
      btn.style.left = "";
      btn.style.right = "";
      btn.style.bottom = "";
      return;
    }
    btn.style.top = `${p.top}px`;
    btn.style.left = p.left === null ? "auto" : `${p.left}px`;
    btn.style.right = p.right === null ? "auto" : `${p.right}px`;
    btn.style.bottom = "auto";
  };

  const position = createLauncherPosition({
    store: deps.store,
    rect: () => btn.getBoundingClientRect(),
    viewport: () => ({ w: window.innerWidth, h: window.innerHeight }),
    setPos: applyStyle,
  });

  // A drag that crosses the threshold must swallow the click that follows it
  // (pointerup fires a click on the same target) — moving is never opening.
  let suppressClick = false;
  const drag = createDragController({
    rect: () => btn.getBoundingClientRect(),
    viewport: () => ({ w: window.innerWidth, h: window.innerHeight }),
    apply: (p) => {
      // live drag runs top-left anchored; commit re-anchors to the near edge
      btn.style.top = `${p.y}px`;
      btn.style.left = `${p.x}px`;
      btn.style.right = "auto";
      btn.style.bottom = "auto";
    },
    commit: (p) => position.commit(p),
    onDragChange: (on) => {
      if (on) suppressClick = true;
      // The drag's own click comes in the same task as its release, when it
      // comes at all (the isolation may take it first): after that the flag
      // goes, so the next activation (Enter or Space on the orb) opens.
      else
        setTimeout(() => {
          suppressClick = false;
        }, 0);
    },
  });

  // Only a real gesture moves the orb, and the page sees none of it: the drag
  // is taken at the window before page listeners (drag-router.ts).
  // A marker is a button of its own: a press on it is never the orb's drag.
  // The slop is the drag controller's threshold: a press that travels no
  // further clicks the orb.
  routePointerDrag(btn, {
    accept: (e) => !(e.target as Element | null)?.closest?.(".orb-note"),
    begin: (e) => {
      // A drag's click may never arrive (the isolation takes it): a fresh press starts clean.
      suppressClick = false;
      drag.down(e.clientX, e.clientY);
    },
    move: (e) => drag.move(e.clientX, e.clientY),
    end: () => drag.up(),
    slop: DRAG_THRESHOLD_PX,
  });

  btn.addEventListener("click", (e) => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (!e.isTrusted) return;
    deps.onOpen();
  });

  btn.addEventListener("dblclick", (e) => {
    if (e.isTrusted) position.reset();
  });

  const setConnection = (state: ConnectionState): void => {
    status.className = `orb-status ${state}`;
    btn.title = `Onlay · ${CONNECTION_TITLE[state]} — click for your Inbox · drag to move · double-click resets`;
  };
  setConnection("offline");

  return {
    element: btn,
    setConnection,
    setBadge(count) {
      badge.textContent = count > 99 ? "99+" : String(count);
      badge.style.display = count > 0 ? "inline-block" : "none";
      btn.classList.toggle("has-needs", count > 0);
    },
    ping() {
      // restart cleanly even mid-animation: drop the class, reflow, re-add
      btn.classList.remove("ping");
      void btn.offsetWidth;
      btn.classList.add("ping");
      ping.addEventListener("animationend", () => btn.classList.remove("ping"), { once: true });
    },
    setKeptShown: (n) => setNote(keptNote, LAUNCHER_COPY.editsShown(n), n),
    setAgentPending: (n) => setNote(agentNote, LAUNCHER_COPY.forAgent(n), n),
    restore: () => position.restore(),
    reclamp: () => position.reclamp(),
  };
}
