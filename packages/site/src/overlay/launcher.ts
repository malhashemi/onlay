// The launcher: the one persistent piece of page chrome, and it is the mark in
// product-control dress: the drawing, a connection dot, the needs-you count,
// and two quiet markers. Built after the extension's (overlay/launcher.ts):
// a click opens the bar; hold and drag moves it (a small move stays a click);
// a double click sends it back to its corner. A real button: Enter and Space
// open it too.
import { el, markSvg } from "./dom";
import { LAUNCHER } from "./strings";

const MARGIN = 8;
const DRAG_THRESHOLD = 4;

/** A top-left position that keeps a w×h box inside the viewport. */
export function clampPos(
  x: number,
  y: number,
  w: number,
  h: number,
  vw: number,
  vh: number,
  margin = MARGIN,
): { x: number; y: number } {
  const maxX = Math.max(margin, vw - w - margin);
  const maxY = Math.max(margin, vh - h - margin);
  return { x: Math.min(Math.max(x, margin), maxX), y: Math.min(Math.max(y, margin), maxY) };
}

export interface LauncherDeps {
  onOpen(): void;
  onKeptNote(): void;
  onAgentNote(): void;
}

export interface Launcher {
  element: HTMLButtonElement;
  setBadge(count: number): void;
  setKeptShown(count: number): void;
  setAgentPending(count: number): void;
  /** One ring breathing out of the orb. */
  ping(): void;
  reclamp(): void;
}

export function createLauncher(deps: LauncherDeps): Launcher {
  const btn = el("button", "orb");
  btn.type = "button";
  btn.setAttribute("aria-label", LAUNCHER.label);
  btn.title = LAUNCHER.title;
  btn.appendChild(markSvg());
  const status = el("span", "orb-status connected");
  const badge = el("span", "orb-badge");
  badge.hidden = true;
  const ring = el("span", "orb-ping");
  const notes = el("span", "orb-notes");
  const keptNote = el("span", "orb-note");
  keptNote.title = LAUNCHER.editsShownTitle;
  const agentNote = el("span", "orb-note agent");
  agentNote.title = LAUNCHER.forAgentTitle;
  keptNote.hidden = true;
  agentNote.hidden = true;
  notes.append(keptNote, agentNote);
  btn.append(status, badge, ring, notes);

  const noteClick = (node: HTMLElement, run: () => void): void => {
    node.addEventListener("pointerdown", (e) => e.stopPropagation());
    node.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      run();
    });
  };
  noteClick(keptNote, deps.onKeptNote);
  noteClick(agentNote, deps.onAgentNote);

  let pos: { x: number; y: number } | null = null;
  const apply = (): void => {
    if (!pos) {
      btn.style.top = "";
      btn.style.left = "";
      btn.style.right = "";
      btn.style.bottom = "";
      btn.classList.remove("left-half");
      return;
    }
    const r = btn.getBoundingClientRect();
    const vw = window.innerWidth;
    const c = clampPos(pos.x, pos.y, r.width, r.height, vw, window.innerHeight);
    // A right-half orb holds to the right edge across resizes, and the other way round.
    const right = c.x + r.width / 2 > vw / 2;
    btn.style.top = `${c.y}px`;
    btn.style.left = right ? "auto" : `${c.x}px`;
    btn.style.right = right ? `${vw - c.x - r.width}px` : "auto";
    btn.style.bottom = "auto";
    btn.classList.toggle("left-half", !right);
  };

  // A drag that crosses the threshold swallows the click that follows it.
  let suppressClick = false;
  btn.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const r = btn.getBoundingClientRect();
    const sx = e.clientX;
    const sy = e.clientY;
    let active = false;
    let last: { x: number; y: number } | null = null;
    try {
      btn.setPointerCapture(e.pointerId);
    } catch {
      /* no pointer capture here */
    }
    const move = (ev: PointerEvent): void => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!active) {
        if (Math.hypot(dx, dy) <= DRAG_THRESHOLD) return;
        active = true;
        suppressClick = true;
      }
      last = clampPos(
        r.left + dx,
        r.top + dy,
        r.width,
        r.height,
        window.innerWidth,
        window.innerHeight,
      );
      btn.style.top = `${last.y}px`;
      btn.style.left = `${last.x}px`;
      btn.style.right = "auto";
      btn.style.bottom = "auto";
    };
    const finish = (): void => {
      btn.removeEventListener("pointermove", move);
      btn.removeEventListener("pointerup", finish);
      btn.removeEventListener("pointercancel", finish);
      if (active && last) {
        pos = last;
        apply();
      }
    };
    btn.addEventListener("pointermove", move);
    btn.addEventListener("pointerup", finish);
    btn.addEventListener("pointercancel", finish);
  });
  btn.addEventListener("click", () => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    deps.onOpen();
  });
  btn.addEventListener("dblclick", () => {
    pos = null;
    apply();
  });

  const setNote = (node: HTMLElement, text: string, count: number): void => {
    node.textContent = text;
    node.hidden = count <= 0;
  };

  return {
    element: btn,
    setBadge(count) {
      badge.textContent = count > 99 ? "99+" : String(count);
      badge.hidden = count <= 0;
      btn.classList.toggle("has-needs", count > 0);
    },
    setKeptShown: (n) => setNote(keptNote, LAUNCHER.editsShown(n), n),
    setAgentPending: (n) => setNote(agentNote, LAUNCHER.forAgent(n), n),
    ping() {
      btn.classList.remove("ping");
      void btn.offsetWidth;
      btn.classList.add("ping");
      ring.addEventListener("animationend", () => btn.classList.remove("ping"), { once: true });
    },
    reclamp: () => {
      if (pos) apply();
    },
  };
}
