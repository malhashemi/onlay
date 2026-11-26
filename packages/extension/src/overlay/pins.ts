// On-page pins (ADR-0005 §2, ADR-0008): kind-tinted markers at each live
// interaction's anchor, with count badges and outline-only rings. Resolved
// interactions shed their pins (the page wears only live state). One pin per
// (element, kind); needs-you gets an amber halo. Clicking opens the thread.

import { anchorLabel, resolveAnchor } from "./anchors";
import type { App, InteractionSnap as Snapshot } from "./app";
import { el, icon, scaled } from "./dom";
import { rectInOwner } from "./frame-path";
import { isLiveState, KINDS } from "./kinds";
import { isTrustedEvent } from "./trusted";

export interface PinLayer {
  layer: HTMLElement;
  ring: HTMLElement;
  render(): void;
  flash(id: string): void;
}

interface Group {
  el: Element;
  kind: Snapshot["kind"];
  ids: string[];
  needs: boolean;
}

export function createPinLayer(app: App, onOpen: (id: string) => void): PinLayer {
  const layer = el("div", "pin-layer");
  const ring = el("div", "ring");

  function groups(): Group[] {
    const map = new Map<string, Group>();
    for (const s of app.interactions()) {
      if (!isLiveState(s.state)) continue;
      if (s.anchorLost || s.anchor.level === "page" || s.anchor.level === "unanchored") continue;
      const target = resolveAnchor(s.anchor);
      if (!target) continue;
      const sel = s.anchor.selector;
      const blk = s.anchor.level === "element" ? (s.anchor.blockId ?? "") : "";
      // Spaces never share a pin: each opens its own space's thread.
      const key = `${s.spaceId}::${s.kind}::${sel}::${blk}`;
      // The server's attention, as the Inbox and the thread's header show it.
      const needs = app.needsYou(s);
      const g = map.get(key);
      if (g) {
        g.ids.push(s.id);
        g.needs = g.needs || needs;
      } else {
        map.set(key, { el: target, kind: s.kind, ids: [s.id], needs });
      }
    }
    return [...map.values()];
  }

  function render(): void {
    while (layer.firstChild) layer.removeChild(layer.firstChild);
    const gs = groups();
    // Stack multiple kinds at the same element so each hue is visible.
    const perEl = new Map<Element, number>();
    for (const g of gs) {
      // A block inside a frame of this page (A-3) is pinned where it shows here.
      const r = rectInOwner(g.el);
      if (!r.inFrames || r.bottom < 0 || r.top > window.innerHeight) continue;
      const spec = KINDS[g.kind];
      const stackIdx = perEl.get(g.el) ?? 0;
      perEl.set(g.el, stackIdx + 1);
      const pin = el("button", `pin ${spec.cls}${g.needs ? " needs" : ""}`);
      pin.appendChild(icon(spec.glyph, "icon-sm"));
      if (g.ids.length > 1) {
        pin.appendChild(el("span", "pin-count", String(g.ids.length)));
      }
      const first = app.byId(g.ids[0] as string);
      const where = first ? anchorLabel(first.anchor) : "";
      const space = first && app.multiSpace() ? ` · ${app.space(first.spaceId)?.name ?? ""}` : "";
      pin.title = `${spec.label} — ${where}${space}`;
      // 30 = pin diameter (24) + edge margin; 28 = diameter + stack gap —
      // both mirror the sheet's .pin size, so they ride the overlay zoom.
      pin.style.left = `${Math.min(r.right + 6, window.innerWidth - scaled(30))}px`;
      pin.style.top = `${Math.max(2, r.top + 2 + stackIdx * scaled(28))}px`;
      pin.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!isTrustedEvent(e)) return;
        onOpen(g.ids[0] as string);
      });
      layer.appendChild(pin);
    }
  }

  function flash(id: string): void {
    const s = app.byId(id);
    if (!s) return;
    const target = resolveAnchor(s.anchor);
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    const r = rectInOwner(target);
    ring.className = `ring ${KINDS[s.kind].cls}`;
    ring.style.display = "block";
    ring.style.left = `${r.left - 3}px`;
    ring.style.top = `${r.top - 3}px`;
    ring.style.width = `${r.width + 6}px`;
    ring.style.height = `${r.height + 6}px`;
    setTimeout(() => {
      ring.style.display = "none";
    }, 1600);
  }

  return { layer, ring, render, flash };
}
