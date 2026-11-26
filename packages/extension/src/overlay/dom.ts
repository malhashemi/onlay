// DOM primitives + the ONE constructed stylesheet (ADR-0008 §4).
//
// Invariants held here: no innerHTML/insertAdjacentHTML anywhere; overlay
// styles live ONLY in this constructed CSSStyleSheet (adoptedStyleSheets);
// dynamic geometry is written via style *properties*, never <style> or the
// style attribute (CSP style-src safe, Trusted-Types safe). The palette is a
// single `:host` custom-property block; every component references tokens.
//
// The values are the onlay design system (src/ui/tokens.ts, the extension's
// design tokens): teal/cyan primary, brand-tinted cool
// neutrals, and the interaction grammar Comment teal · Ask amber · Edit
// green. The overlay is dark-committed and wears the brand FALLBACK font
// stacks (@font-face cannot reach a shadow adopted sheet; rem is unsafe
// against arbitrary host pages, so type is px).

import { LIMITS } from "@onlay/protocol";
import { CODE_BLOCK_CSS } from "@onlay/render/code-block";
import { SPACE_SELECT_CSS } from "@onlay/render/space-select";
import { paintPicture } from "../picture-face";
import { type Theme, UI_ZOOM_DEFAULT } from "../prefs";
import { OVERLAY_LIGHT_ALIAS_BLOCK, OVERLAY_TOKEN_BLOCK } from "../ui/tokens";
import { rectInOwner } from "./frame-path";
import type { Glyph } from "./kinds";
import type { PersonView } from "./people";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Programmatic element factory — the only DOM-construction path (no innerHTML). */
export function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** Build an SVG glyph via createElementNS — never innerHTML. */
export function icon(glyph: Glyph, cls = "icon"): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("class", cls);
  for (const d of glyph.paths) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
  }
  return svg;
}

/**
 * THE mark, built programmatically for the overlay —
 * the shadow DOM never sees innerHTML. One drawing at every size: the
 * boundary ring broken where an agent waits, the loose signal holding the
 * break, the anchored point reaching toward it. Exact ramp colors ride the
 * geometry (primary-600 boundary, primary-500 core), matching the asset.
 */
export function markSvg(cls = "orb-mark"): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 512 512");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  const shape = (tag: "path" | "circle", attrs: Record<string, string>): SVGElement => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.appendChild(node);
    return node;
  };
  shape("path", {
    d: "M 357.3 100 A 186 186 0 1 0 431.9 195.4",
    fill: "none",
    stroke: "#007886",
    "stroke-width": "34",
    "stroke-linecap": "round",
  });
  shape("circle", { cx: "403", cy: "141", r: "32", fill: "#007886" });
  shape("circle", {
    cx: "256",
    cy: "256",
    r: "118",
    fill: "none",
    stroke: "#00C4D7",
    "stroke-width": "30",
  });
  shape("path", {
    d: "M 229 277 L 325 202",
    fill: "none",
    stroke: "#00C4D7",
    "stroke-width": "20",
    "stroke-linecap": "round",
  });
  shape("circle", { cx: "229", cy: "277", r: "36", fill: "#00C4D7" });
  return svg;
}

/** Uppercase mono micro-label for metadata (the calm grammar's connective tissue). */
export function microLabel(text: string): HTMLElement {
  return el("span", "micro", text);
}

/**
 * A person's avatar: round, in the person's tint, wearing their initials — or
 * their picture once the service worker hands it over (`picture-face.ts`:
 * drawn on a canvas, so the page's own policy can't block it and the page
 * learns nothing). Named by the person's name. Agents have no avatar of their
 * own (spec §2).
 */
export function avatar(person: PersonView, size: "sm" | "md" = "md"): HTMLElement {
  const node = el("span", `avatar avatar-${size} avatar-round`);
  node.style.background = person.tint || "#425a62";
  node.title = person.name;
  node.setAttribute("role", "img");
  node.setAttribute("aria-label", person.name);
  node.textContent = person.initials || person.name.slice(0, 2).toUpperCase();
  paintPicture(node, person.avatarUrl);
  return node;
}

/** The small tag beside the name of someone whose agent wrote this. */
export function agentTag(): HTMLElement {
  const tag = el("span", "chip chip-waiting agent-tag", "agent");
  tag.title = "Written by an agent";
  return tag;
}

/** A small toast controller bound to a shared toast element. */
export function makeToast(host: HTMLElement): (text: string, ms?: number) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (text: string, ms = 4000): void => {
    host.textContent = text.slice(0, 400);
    host.style.display = "block";
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      host.style.display = "none";
    }, ms);
  };
}

export function frameUrl(): string {
  return location.href.slice(0, LIMITS.MAX_URL);
}

/**
 * The overlay design system — the onlay brand riding a shadow root. One dark,
 * calm, small-footprint sheet: instrument-panel type (system stacks), tinted
 * cool-neutral surfaces, hairline borders, and the kind grammar as the only
 * loud color. Legacy component variable names (--surface, --k-*, --amber, …)
 * are DERIVED from the design tokens below so every component speaks brand
 * values through its existing vocabulary. Geometry is written by JS onto
 * style properties, never here.
 */
/* ── the launcher orb (ADR-0019 §1, ADR-0020) ──
   The only persistent chrome — and it IS the mark, in product-control dress:
   the drawing centered on a quiet tinted surface, a status dot, and the
   needs-you badge. Nothing else may join it. Click opens the Inbox;
   hold-drag moves it; double-click resets to this default corner.
   Kept OUTSIDE the zoomed sheet: the orb is page chrome and holds its 1×
   size at any overlay zoom — the zoom scales reading surfaces, not the
   button that summons them. */
const ORB_CSS = `
.orb {
  position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
  width: 46px; height: 46px; border-radius: 50%; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  background: radial-gradient(circle at 50% 42%, color-mix(in oklch, var(--primary) 14%, transparent), transparent 62%), var(--surface);
  border: 1px solid color-mix(in oklch, var(--primary) 30%, var(--border));
  box-shadow: var(--shadow-sm);
  cursor: pointer; pointer-events: auto; touch-action: none; user-select: none;
  transition: transform var(--duration-fast) var(--ease), box-shadow var(--duration-fast) var(--ease), border-color var(--duration-fast) var(--ease);
}
.orb:hover { transform: scale(1.05); box-shadow: var(--shadow); border-color: color-mix(in oklch, var(--primary) 55%, var(--border)); }
.orb:active { cursor: grabbing; transform: scale(1); }
.orb:focus-visible { outline: none; box-shadow: var(--ring-focus), var(--shadow-sm); }
.orb.has-needs { box-shadow: var(--shadow-sm), var(--glow-signal); }
.orb-mark { width: 24px; height: 24px; display: block; }
.orb-status {
  position: absolute; right: 0; bottom: 0; width: 12px; height: 12px;
  border-radius: 50%; border: 2px solid var(--surface);
  background: var(--color-neutral-500);
}
.orb-status.connected { background: var(--primary); }
.orb-status.reconnecting { background: var(--amber); animation: orb-pulse 1.4s var(--ease) infinite; }
.orb-status.offline {
  background: transparent; border-color: var(--color-neutral-500);
  border-width: 3px;
}
@keyframes orb-pulse {
  0%, 100% { box-shadow: 0 0 0 0 var(--amber-soft); }
  50% { box-shadow: 0 0 0 4px var(--amber-soft); }
}
.orb-badge {
  display: none; position: absolute; top: -4px; right: -4px;
  min-width: 16px; height: 16px; padding: 0 4px;
  border-radius: var(--radius-full); background: var(--amber); color: var(--color-neutral-950);
  font: var(--weight-bold) 9px/16px var(--font); text-align: center;
  box-shadow: 0 0 0 2px var(--surface);
}
/* The announcement pulse: one anchor-ring breathing out of the orb when a
   new needs-you arrives — appear, settle, never bounce (brand motion law). */
.orb-ping {
  position: absolute; inset: -3px; border-radius: 50%; pointer-events: none;
  border: 2px solid var(--ring); opacity: 0;
}
.orb.ping .orb-ping { animation: orb-ping var(--duration-slow) var(--ease-out); }
/* Quiet markers to the orb's left: kept edits shown, items waiting for an agent. */
.orb-notes {
  position: absolute; right: calc(100% + 6px); top: 50%; transform: translateY(-50%);
  display: none; flex-direction: column; align-items: flex-end; gap: 3px; pointer-events: auto;
}
.orb-note {
  display: none; align-items: center; white-space: nowrap; cursor: pointer;
  padding: 2px 8px; border-radius: var(--radius-full);
  background: var(--surface); color: var(--text-dim);
  border: 1px solid var(--border-soft); box-shadow: var(--shadow-sm);
  font: var(--weight-semibold) 10px/16px var(--font);
}
.orb-note:hover { color: var(--text); border-color: color-mix(in oklch, var(--primary) 45%, var(--border)); }
.orb-note.agent { color: var(--k-change); }
.orb.left-half .orb-notes { right: auto; left: calc(100% + 6px); align-items: flex-start; }
@keyframes orb-ping {
  0% { opacity: .85; transform: scale(.72); }
  100% { opacity: 0; transform: scale(1.55); }
}
`;

/**
 * The light value set (the light theme's aliases + light forms of the derived
 * component vocabulary). Rides `:host(.theme-light)` and, under a light OS,
 * `:host(.theme-system)`; the `:host` base stays dark.
 */
const LIGHT_VOCAB = `
${OVERLAY_LIGHT_ALIAS_BLOCK}
  --surface-2: color-mix(in oklch, var(--color-neutral-200) 46%, var(--color-neutral-100));
  --surface-3: var(--color-neutral-200);
  --border: var(--color-neutral-200);
  --border-soft: color-mix(in oklch, var(--color-neutral-200) 60%, var(--color-neutral-50));
  --ink: var(--color-neutral-900);
  --surface-sunken: color-mix(in oklch, var(--color-neutral-100) 55%, var(--color-neutral-50));
  color-scheme: light;
`;

const SHEET_CSS = `
:host {
  all: initial;
${OVERLAY_TOKEN_BLOCK}
  /* component vocabulary, derived from the design tokens */
  --surface: var(--popover);
  --surface-2: color-mix(in oklch, var(--color-neutral-800) 46%, var(--color-neutral-900));
  --surface-3: var(--color-neutral-800);
  --border: var(--color-neutral-800);
  --border-soft: color-mix(in oklch, var(--color-neutral-800) 60%, var(--color-neutral-900));
  --text: var(--foreground);
  --text-dim: var(--muted-foreground);
  --text-mute: var(--color-neutral-500);
  --k-comment: var(--kind-comment);
  --k-comment-strong: var(--kind-comment-strong);
  --k-comment-soft: var(--kind-comment-soft);
  --k-ask: var(--kind-ask);
  --k-ask-strong: var(--kind-ask-strong);
  --k-ask-soft: var(--kind-ask-soft);
  --k-change: var(--kind-edit);
  --k-change-strong: var(--kind-edit-strong);
  --k-change-soft: var(--kind-edit-soft);
  --amber: var(--attention-careful);
  --amber-soft: color-mix(in oklch, var(--attention-careful) 16%, transparent);
  --green: var(--color-success);
  --green-soft: color-mix(in oklch, var(--color-success) 16%, transparent);
  --danger: var(--attention-dangerous);
  --danger-strong: color-mix(in oklch, var(--attention-dangerous) 80%, var(--color-neutral-950));
  --danger-soft: color-mix(in oklch, var(--attention-dangerous) 18%, transparent);
  /* theme-flipped vocabulary: the readable mix base for tinted text, and the
     recessed strip surface (context bars) */
  --ink: var(--color-neutral-100);
  --surface-sunken: color-mix(in oklch, var(--color-neutral-900) 55%, var(--color-neutral-950));
  color-scheme: dark;
  font: var(--text-sm)/1.5 var(--font);
  color: var(--text);
}

/* ── light mode (prefs.theme, the light theme's values): an explicit light commit, or
   system following the OS. ONE override block rides both selectors — every
   component derives through the aliases above, so nothing else re-declares. ── */
:host(.theme-light) {
${LIGHT_VOCAB}
}
@media (prefers-color-scheme: light) {
  :host(.theme-system) {
${LIGHT_VOCAB}
  }
}
* { box-sizing: border-box; }
button { font: inherit; }

/* ── kind hue helpers ── */
.k-comment { --hue: var(--k-comment); --hue-strong: var(--k-comment-strong); --hue-soft: var(--k-comment-soft); }
.k-ask { --hue: var(--k-ask); --hue-strong: var(--k-ask-strong); --hue-soft: var(--k-ask-soft); }
.k-change { --hue: var(--k-change); --hue-strong: var(--k-change-strong); --hue-soft: var(--k-change-soft); }
.icon { width: 14px; height: 14px; display: block; }
.icon-sm { width: 12px; height: 12px; }

/* ── micro-labels — the system voice: tracked mono caps ── */
.micro {
  font: var(--weight-semibold) 9px/1.3 var(--mono);
  letter-spacing: var(--tracking-caps); text-transform: uppercase; color: var(--text-mute);
}
.mono { font: 10px/1.4 var(--mono); color: var(--text-dim); }
.dim { color: var(--text-dim); }

/* ── avatars ── */
.avatar {
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--color-neutral-50); font: var(--weight-bold) 10px/1 var(--font); flex: none; overflow: hidden;
  text-shadow: 0 1px 1px rgba(0,0,0,.35);
}
.avatar-sm { width: 16px; height: 16px; font-size: 8px; }
.avatar-md { width: 22px; height: 22px; }
.avatar-round { border-radius: 50%; }
.avatar-square { border-radius: var(--radius-xs); }
.avatar-glyph { width: 12px; height: 12px; }
.avatar-img { width: 100%; height: 100%; object-fit: cover; display: block; }
.avatar.has-picture { text-shadow: none; }
.avatar-stack { display: inline-flex; }
.avatar-stack .avatar { margin-left: -5px; box-shadow: 0 0 0 1.5px var(--surface); }
.avatar-stack .avatar:first-child { margin-left: 0; }

/* ── buttons ── */
.btn {
  cursor: pointer; border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--surface-2); color: var(--text); padding: 5px 11px;
  transition: background var(--duration-fast) var(--ease), border-color var(--duration-fast) var(--ease), box-shadow var(--duration-fast) var(--ease);
}
.btn:hover { background: var(--surface-3); }
.btn:focus-visible { outline: none; box-shadow: var(--ring-focus); }
.btn:disabled { opacity: .42; cursor: default; }
.btn.active { background: var(--primary); border-color: var(--primary); color: var(--primary-foreground); }
.btn.primary { background: var(--hue-strong, var(--primary)); border-color: var(--hue-strong, var(--primary)); color: var(--color-neutral-50); }
.btn.primary:hover { filter: brightness(1.1); }
.btn.ghost { background: transparent; border-color: transparent; color: var(--text-dim); }
.btn.ghost:hover { color: var(--text); background: var(--surface-2); }
.btn.danger { background: var(--danger-soft); border-color: var(--danger-strong); color: color-mix(in oklch, var(--danger) 55%, var(--ink)); }
.btn.sm { padding: 3px 8px; font-size: var(--text-xs); }
.btn.tiny { padding: 2px 6px; font-size: 10px; border-radius: var(--radius-xs); }

/* ── inputs ── */
.input, textarea.input {
  width: 100%; background: var(--surface-2); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px 8px;
  font: inherit; resize: vertical;
}
.input:focus { outline: none; border-color: color-mix(in oklch, var(--ring) 55%, var(--border)); box-shadow: var(--ring-hairline); }
textarea.input { min-height: 54px; }
.input::placeholder { color: var(--text-mute); }

/* ── chips ── */
.chip {
  display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px;
  border-radius: var(--radius-full); border: 1px solid transparent;
  font: var(--weight-medium) 10px/1.5 var(--font);
}
.chip .icon { width: 11px; height: 11px; }
.chip-kind { background: var(--hue-soft); color: var(--hue); border-color: color-mix(in oklch, var(--hue) 32%, transparent); }
.chip-needs { background: var(--amber-soft); color: var(--amber); border-color: color-mix(in oklch, var(--amber) 40%, transparent); }
.chip-waiting { background: var(--surface-2); color: var(--text-dim); border-color: var(--border); }
.chip-resolved { background: var(--green-soft); color: var(--green); border-color: color-mix(in oklch, var(--green) 32%, transparent); }
.chip-stakes-careful { background: var(--amber-soft); color: var(--amber); }
.chip-stakes-dangerous { background: var(--danger-soft); color: var(--danger); }
/* The fresh-look duty — a quiet, neutral chip, never amber/red (those are
   reserved for attention/failures, ADR-0006). A duty, not an alarm. */
.chip.capture-due { background: var(--surface-2); color: var(--text-dim); border-color: var(--border); }

@media (prefers-reduced-motion: reduce) {
  .orb { transition: none; }
  .orb-status.reconnecting { animation: none; }
  .orb.ping .orb-ping { animation: none; }
  .react.pop { animation: none; }
}

/* ── the announcement card — a new needs-you introduces itself once ── */
.announce-card {
  position: fixed; top: 54px; right: 12px; z-index: 2147483647;
  display: none; align-items: center; gap: 9px; max-width: 340px;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-md); box-shadow: var(--shadow); padding: 9px 12px;
  cursor: pointer; pointer-events: auto;
  animation: announce-in var(--duration) var(--ease-out);
}
@keyframes announce-in {
  from { opacity: 0; transform: translateY(-6px); }
}
@media (prefers-reduced-motion: reduce) { .announce-card { animation: none; } }
.announce-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.announce-title { font-weight: var(--weight-semibold); font-size: var(--text-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.announce-meta { display: flex; align-items: center; gap: 6px; }
.announce-more { color: var(--text-mute); font: 10px var(--mono); }

/* ── the command bar (ADR-0019 §2, Inbox era) ── */
.bar-backdrop {
  position: fixed; inset: 0; z-index: 2147483647; display: none;
  background: color-mix(in oklch, var(--color-neutral-950) 55%, transparent); pointer-events: auto;
}
.command-bar {
  position: absolute; top: 16vh; left: 50%; transform: translateX(-50%);
  width: 640px; max-width: 92vw; display: flex; flex-direction: column;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-xl); box-shadow: var(--shadow-lg); overflow: hidden;
  animation: bar-in var(--duration-fast) var(--ease-out);
}
@keyframes bar-in {
  from { opacity: 0; transform: translateX(-50%) scale(.98); }
}
@media (prefers-reduced-motion: reduce) { .command-bar { animation: none; } }
.bar-input-row {
  display: flex; align-items: center; gap: 9px; padding: 12px 14px;
  border-bottom: 1px solid var(--border-soft);
}
.bar-search-icon { width: 15px; height: 15px; color: var(--text-mute); flex: none; }
.bar-mode-chip { flex: none; }
.bar-space-chip { flex: none; cursor: pointer; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-mode-chip:not(.k-comment):not(.k-ask):not(.k-change) {
  background: color-mix(in oklch, var(--primary) 14%, transparent);
  color: var(--primary); border-color: color-mix(in oklch, var(--primary) 30%, transparent);
}
.bar-input {
  flex: 1; min-width: 0; background: none; border: 0; outline: none;
  color: var(--text); font: var(--text-base)/1.4 var(--font); padding: 0;
}
.bar-input::placeholder { color: var(--text-mute); }
.bar-hint { margin-left: 0; flex: none; }
.bar-offline {
  padding: 5px 14px; border-bottom: 1px solid var(--border-soft);
  color: var(--amber); font: 10px var(--mono); letter-spacing: var(--tracking-wide);
  background: color-mix(in oklch, var(--amber) 7%, transparent);
}
.bar-list {
  max-height: 46vh; overflow-y: auto; padding: 6px;
  display: flex; flex-direction: column; gap: 2px;
}
.bar-group { padding: 7px 10px 3px; }
.bar-row {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px;
  border: 0; border-radius: var(--radius); background: none; color: var(--text);
  cursor: pointer; text-align: left; width: 100%;
}
.bar-row.on { background: var(--surface-2); box-shadow: inset 2px 0 0 var(--primary); }
.bar-row > .icon { width: 15px; height: 15px; flex: none; color: var(--hue, var(--text-dim)); }
.bar-row .label { font-weight: var(--weight-semibold); flex: none; }
.bar-row .desc {
  color: var(--text-mute); font-size: var(--text-xs); flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.bar-row .kbd { margin-left: auto; }
.bar-empty { padding: 26px 14px; text-align: center; color: var(--text-dim); }
.bar-footer {
  display: flex; gap: 14px; padding: 7px 14px;
  border-top: 1px solid var(--border-soft);
  color: var(--text-mute); font: 10px var(--mono); letter-spacing: var(--tracking-wide);
}
/* inbox rows — two lines: summary + provenance */
.q-row { align-items: flex-start; }
.q-row > .icon { margin-top: 2px; }
.q-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.q-top { display: flex; align-items: center; gap: 7px; }
.q-text {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; font-weight: var(--weight-semibold);
}
.q-age { color: var(--text-mute); font: 9px/1.8 var(--mono); flex: none; }
.q-meta { display: flex; align-items: center; gap: 6px; }
.q-actor { color: var(--text-dim); font-size: var(--text-xs); flex: none; }
.q-context {
  color: var(--text-mute); font: 10px var(--mono); min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.q-away { color: var(--text-mute); font-size: 10px; flex: none; }
/* the quiet Anchor affordance on unanchored/anchor-lost rows */
.q-anchor-act {
  display: none; margin-left: auto; flex: none; align-items: center; gap: 4px;
  border: 1px solid color-mix(in oklch, var(--primary) 30%, transparent);
  border-radius: var(--radius-full); background: transparent; color: var(--primary);
  font: var(--weight-semibold) 9px/1.6 var(--mono); letter-spacing: var(--tracking-caps);
  text-transform: uppercase; padding: 1px 8px; cursor: pointer;
}
.bar-row.on .q-anchor-act, .bar-row:hover .q-anchor-act { display: inline-flex; }
.q-anchor-act:hover { background: color-mix(in oklch, var(--primary) 14%, transparent); }
.q-anchor-act:disabled { opacity: .4; cursor: default; }

/* ── the interaction modal — the Inbox's centered reading surface.
   Same family as the command bar: same width, surface, radius, shadow. ── */
.interaction-modal {
  position: absolute; top: 12vh; left: 50%; transform: translateX(-50%);
  width: 640px; max-width: 92vw; max-height: 76vh;
  display: flex; flex-direction: column;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-xl); box-shadow: var(--shadow-lg); overflow: hidden;
  animation: bar-in var(--duration-fast) var(--ease-out);
}
@media (prefers-reduced-motion: reduce) { .interaction-modal { animation: none; } }
.im-head {
  display: flex; align-items: center; gap: 8px; padding: 12px 14px;
  border-bottom: 1px solid var(--border-soft);
}
.im-who { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1; }
.im-who .name { font-weight: var(--weight-semibold); font-size: var(--text-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.im-who .arrow { color: var(--text-mute); flex: none; }
.im-context {
  display: flex; flex-direction: column; gap: 3px; padding: 8px 14px;
  border-bottom: 1px solid var(--border-soft);
  background: var(--surface-sunken);
}
.im-context .ctx-line {
  display: flex; align-items: center; gap: 6px; color: var(--text-dim);
  font: 10px/1.5 var(--mono); min-width: 0;
}
.im-context .ctx-line .ctx-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.im-context .ctx-link { color: var(--primary); cursor: pointer; text-decoration: none; flex: none; }
.im-context .ctx-link:hover { text-decoration: underline; }
.im-body { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 14px; display: flex; flex-direction: column; gap: 10px; }
/* The body takes focus on open (arrows scroll it) — a ring around the whole
   reading area would be noise; keyboard Tab still shows rings inside. */
.im-body:focus { outline: none; }
.im-max { display: inline-flex; align-items: center; }
.im-actions {
  display: flex; align-items: center; gap: 8px; padding: 10px 14px;
  border-top: 1px solid var(--border-soft);
}
.im-actions .kbd { margin-left: 2px; }

/* ── selection boxes ── */
.box {
  position: fixed; z-index: 2147483644; pointer-events: none;
  border: 2px solid var(--k-comment); border-radius: 3px; display: none;
}
.box.sel { border-color: var(--primary); }
.toast {
  position: fixed; top: 54px; right: 12px; z-index: 2147483647; max-width: 340px;
  background: var(--surface); color: var(--text); border: 1px solid var(--border-soft);
  font: 10px/1.5 var(--mono); padding: 6px 10px; border-radius: var(--radius); display: none;
  box-shadow: var(--shadow-sm); word-break: break-word; pointer-events: none;
}

/* ── pins — outline-only anchors: rings mark context, never fills ── */
.pin-layer { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; }
.pin {
  position: fixed; z-index: 2147483646; display: inline-flex; align-items: center;
  justify-content: center; width: 24px; height: 24px; border-radius: 50%;
  background: var(--surface); color: var(--hue); border: 1.5px solid var(--hue);
  cursor: pointer; pointer-events: auto; box-shadow: var(--shadow-sm);
  transition: transform var(--duration-fast) var(--ease);
}
.pin:hover { transform: scale(1.12); }
.pin.needs { box-shadow: 0 0 0 2px var(--amber-soft), var(--shadow-sm); }
.pin-count {
  position: absolute; top: -6px; right: -6px; min-width: 15px; height: 15px;
  padding: 0 3px; border-radius: var(--radius-full); background: var(--hue-strong); color: var(--color-neutral-50);
  font: var(--weight-bold) 8px/15px var(--font); text-align: center;
}
.ring {
  position: fixed; z-index: 2147483645; pointer-events: none; display: none;
  border-radius: var(--radius-xs); box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--hue, var(--ring));
}

/* ── generic card / panel ── */
.card {
  position: fixed; z-index: 2147483647; display: none; flex-direction: column;
  background: var(--surface); border: 1px solid var(--border-soft);
  border-radius: var(--radius-md); box-shadow: var(--shadow); pointer-events: auto;
  overflow: hidden;
}
.card-head {
  display: flex; align-items: center; gap: 8px; padding: 9px 11px;
  border-bottom: 1px solid var(--border-soft);
}
.card-head .title { font-weight: var(--weight-bold); flex: 1; }
.card-body { padding: 10px 11px; display: flex; flex-direction: column; gap: 10px;
  overflow-y: auto; }
.row { display: flex; align-items: center; gap: 7px; }
.row-wrap { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.spacer { flex: 1; }
.sep { height: 1px; background: var(--border-soft); margin: 2px 0; }

/* Key chip beside a label — the binding IS the documentation (F-054). */
.kbd {
  font: var(--weight-semibold) 9px/1.4 var(--mono); letter-spacing: .04em; color: var(--text-dim);
  background: var(--surface-2); border: 1px solid var(--border);
  border-bottom-width: 2px; border-radius: var(--radius-xs); padding: 0 4px; flex: none;
}
.empty-note { padding: 20px 12px; text-align: center; color: var(--text-dim); }

/* ── composer window (ADR-0019 §2 — the graduated composers) ── */
.composer-glyph { display: inline-flex; color: var(--hue, var(--text-dim)); }
.composer-window .anchor-chip { max-width: 45%; }
/* The header moves the card (drag, or the grip's arrow keys); its buttons stay buttons. */
.composer-window .card-head { cursor: grab; touch-action: none; user-select: none; }
.composer-window .card-head.is-dragging { cursor: grabbing; }
.composer-window .card-head .btn { cursor: pointer; }
.card-grip {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 18px; height: 22px; margin: 0 -4px 0 -5px; padding: 0;
  border: 0; border-radius: var(--radius-xs); background: none; color: var(--text-mute);
  cursor: grab; touch-action: none;
}
.card-grip .icon { stroke-width: 3.4; }
.card-grip:hover { color: var(--text); }
.card-grip:focus-visible { outline: none; color: var(--text); box-shadow: var(--ring-focus); }
.card-head.is-dragging .card-grip { cursor: grabbing; }
.anchor-chip {
  display: inline-block; padding: 4px 8px;
  background: var(--surface-2); border: 1px solid var(--border-soft); border-radius: var(--radius-sm);
  font: 10px/1.3 var(--mono); color: var(--text-dim); max-width: 100%;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* ── composers ── */
.composer { display: flex; flex-direction: column; gap: 8px; }
.field { display: flex; flex-direction: column; gap: 4px; }
.opt-row { display: flex; align-items: center; gap: 6px; }
.opt-row .star { cursor: pointer; color: var(--text-mute); background: none; border: 0; padding: 2px; }
.opt-row .star.on { color: var(--amber); }
.opt-row .del { cursor: pointer; color: var(--text-mute); background: none; border: 0; padding: 2px; }
.opt-row .del:hover { color: var(--danger); }
.stepper { display: inline-flex; align-items: center; gap: 3px; border: 1px solid var(--border);
  border-radius: var(--radius-full); padding: 1px 3px; }
.stepper button { width: 18px; height: 18px; border: 0; background: none; color: var(--text-dim);
  cursor: pointer; border-radius: 50%; font: 12px/1 var(--mono); }
.stepper button:hover { background: var(--surface-3); color: var(--text); }
.stepper .val { width: 16px; text-align: center; font: 11px var(--mono); }
.seg { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
.seg button { border: 0; background: var(--surface-2); color: var(--text-dim); padding: 4px 9px;
  cursor: pointer; border-right: 1px solid var(--border); }
.seg button:last-child { border-right: 0; }
.seg button.on { background: var(--hue-strong, var(--primary)); color: var(--color-neutral-50); }
.seg button.on.amber { background: var(--amber); color: var(--color-neutral-950); }
.seg button.on.red { background: var(--danger-strong); color: var(--color-neutral-50); }
.pick-menu { display: flex; flex-direction: column; gap: 4px; max-height: 180px; overflow-y: auto; }
.pick-item { display: flex; align-items: center; gap: 7px; padding: 5px 7px; border-radius: var(--radius-sm);
  cursor: pointer; }
.pick-item:hover, .pick-item.on { background: var(--surface-3); }

/* ── scrollbars — onlay's own, never the platform default (F-052).
   webkit pseudos only: Chrome ignores them if the standard props are also
   set, and the standard props can't round the thumb. ── */
*::-webkit-scrollbar { width: 8px; height: 8px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb {
  background: var(--surface-3); border-radius: 8px;
  border: 2px solid transparent; background-clip: padding-box;
}
*::-webkit-scrollbar-thumb:hover { background: var(--border); }
*::-webkit-scrollbar-corner { background: transparent; }

/* ── thread ── */
.thread-panel {
  top: 54px; right: 12px; width: 344px; max-height: min(88vh, calc(100vh - 66px));
  min-width: 300px; min-height: 260px; max-width: 92vw;
}
/* The header drags the panel: a finger on it moves the panel, never pans the page. */
.thread-panel > .card-head { touch-action: none; user-select: none; }
.thread-panel > .card-head .btn { touch-action: manipulation; }
/* Resize grip on the bottom-LEFT: the panel is right-anchored, so it grows
   toward the page — dragging the free corner, not the pinned one (F-051). */
.panel-grip {
  position: absolute; left: 0; bottom: 0; width: 16px; height: 16px;
  cursor: nesw-resize; touch-action: none; opacity: .55;
}
.panel-grip::before {
  content: ""; position: absolute; left: 4px; bottom: 4px; width: 7px; height: 7px;
  border-left: 2px solid var(--text-mute); border-bottom: 2px solid var(--text-mute);
  border-bottom-left-radius: 3px;
}
.panel-grip:hover { opacity: 1; }
.thread-body { padding: 9px 11px; display: flex; flex-direction: column; gap: 9px; overflow-y: auto; }
/* the edit sidecar's headline: the request itself */
.thread-body .edit-intent { font-weight: var(--weight-semibold); font-size: var(--text-base); line-height: 1.35; }
.msg { display: flex; flex-direction: column; gap: 3px; }
.msg-head { display: flex; align-items: center; gap: 6px; }
.msg-author { font-weight: var(--weight-semibold); font-size: var(--text-xs); }
.msg-body { white-space: pre-wrap; word-break: break-word; font-size: var(--text-sm); }
.msg-acts { display: flex; gap: 8px; margin-top: 2px; }
.msg-act { background: none; border: 0; color: var(--text-mute); cursor: pointer;
  font: 10px var(--font); padding: 0; text-decoration: underline; }
.msg-act:hover { color: var(--text); }
.msg-system { align-self: center; text-align: center; color: var(--text-mute);
  font: 10px var(--mono); display: flex; align-items: center; gap: 8px; width: 100%; }
.msg-system::before, .msg-system::after { content: ""; flex: 1; height: 1px; background: var(--border-soft); }
.reactions { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 2px; }
.react {
  display: inline-flex; align-items: center; gap: 3px; padding: 1px 6px; cursor: pointer;
  border: 1px solid var(--border); border-radius: var(--radius-full); background: var(--surface-2);
  font-size: var(--text-xs); color: var(--text-dim);
}
.react.on { background: color-mix(in oklch, var(--primary) 22%, var(--surface-2)); border-color: var(--primary); color: color-mix(in oklch, var(--primary) 60%, var(--ink)); }
.react.pop { animation: react-pop var(--duration-fast) var(--ease); }
@keyframes react-pop { 0% { transform: scale(1); } 50% { transform: scale(1.3); } 100% { transform: scale(1); } }
.react-bar { display: flex; gap: 3px; }
.react-bar .react { font-size: 15px; padding: 2px 7px; line-height: 1.2; }

/* ── reply-to quote chips (ADR-0018 §1) ── */
.quote-chip {
  display: flex; align-items: center; gap: 6px; padding: 3px 8px; max-width: 100%;
  border-left: 2px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2);
  color: var(--text-dim); font-size: var(--text-xs); cursor: pointer;
}
.quote-chip:hover { background: var(--surface-3); }
.quote-chip .quote-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.quote-chip.missing { cursor: default; font-style: italic; color: var(--text-mute); }
.quote-cancel { background: none; border: 0; color: var(--text-mute); cursor: pointer; padding: 0 2px; font-size: 13px; line-height: 1; }
.quote-cancel:hover { color: var(--text); }
.msg.flash { animation: msg-flash 1.2s var(--ease); border-radius: var(--radius-sm); }
@keyframes msg-flash { 0% { background: var(--k-comment-soft); } 100% { background: transparent; } }
/* ── rich tokens (ADR-0007): pills shared by editors and message bodies ──
   One round pill for a mentioned person (their tint, written as the inline
   custom property --pill) and for @agent (the primary hue). */
.token-pill {
  display: inline-flex; align-items: baseline; gap: 2px; padding: 0 5px; margin: 0 1px;
  border: 1px solid transparent; font-weight: var(--weight-semibold); font-size: var(--text-xs); line-height: 1.4;
  white-space: nowrap; vertical-align: baseline;
}
.token-actor {
  border-radius: var(--radius-full);
  color: color-mix(in oklch, var(--pill, var(--primary)) 72%, var(--ink));
  background: color-mix(in oklch, var(--pill, var(--primary)) 16%, transparent);
  border-color: color-mix(in oklch, var(--pill, var(--primary)) 40%, transparent);
}
.token-anchor { border-radius: var(--radius-xs); font: var(--weight-semibold) 10px/1.6 var(--mono); color: var(--k-comment);
  background: var(--k-comment-soft);
  border-color: color-mix(in oklch, var(--k-comment) 32%, transparent); }
.token-anchor.clickable { cursor: pointer; }
.token-anchor.clickable:hover { filter: brightness(1.2); }

/* ── the token editor (token-input.ts) ── */
.token-editor {
  width: 100%; min-height: 54px; max-height: 180px; background: var(--surface-2);
  color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-sm);
  padding: 6px 8px; font: inherit; cursor: text;
  white-space: pre-wrap; overflow-wrap: anywhere; overflow-y: auto;
}
.token-editor.single { min-height: 0; white-space: nowrap;
  overflow-x: auto; overflow-y: hidden; }
.token-editor:focus { outline: none; border-color: color-mix(in oklch, var(--ring) 55%, var(--border)); box-shadow: var(--ring-hairline); }
.token-editor:empty::before { content: attr(data-placeholder); color: var(--text-mute);
  pointer-events: none; }

.mention-menu { position: absolute; z-index: 2147483647; background: var(--surface);
  border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow);
  min-width: 200px; max-width: 300px; max-height: 220px; overflow-y: auto; padding: 4px; }
.mention-menu .menu-head { padding: 2px 7px 4px; }
.mention-menu .pick-item .hint { margin-left: auto; padding-left: 10px; flex: none;
  color: var(--text-mute); font-size: 9px; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; max-width: 45%; }
.mention-menu .pick-item .mono { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mention-menu .emoji-glyph { font-size: 14px; line-height: 1; flex: none; }
.pick-pointer { color: var(--k-ask); }

/* ── ask composer (ask-composer.ts) ── */
.gloss { color: var(--text-mute); font-size: 10px; line-height: 1.5; }
.field-head { display: flex; align-items: center; gap: 6px; }
.wait-readout { margin-left: auto; font: 10px var(--mono); color: var(--text-dim);
  max-width: 60%; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pick-menu .pick-item.on { box-shadow: inset 0 0 0 1px var(--k-ask); }
.pick-item .hint { margin-left: auto; color: var(--text-mute); font-size: 9px; }
.opt-card { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface);
  padding: 7px 8px; display: flex; flex-direction: column; gap: 5px; }
.opt-card.rec { border-color: var(--k-ask); }
.opt-card.dragging { opacity: .5;
  box-shadow: 0 0 0 2px color-mix(in oklch, var(--k-ask) 60%, transparent); }
.opt-card .head { display: flex; align-items: center; gap: 6px; }
.grip { cursor: grab; color: var(--text-mute); background: none; border: 0; padding: 1px 2px;
  border-radius: var(--radius-xs); flex: none; font: 10px/1.2 var(--mono); letter-spacing: -.12em; }
.grip:hover { color: var(--text); }
.grip:focus { outline: 1px solid var(--k-ask); color: var(--text); }
.grip:active { cursor: grabbing; }
.opt-id { font: 9px var(--mono); color: var(--text-mute); }
.add-opt { border: 1px dashed var(--border); border-radius: var(--radius); background: transparent;
  color: var(--text-dim); padding: 6px 8px; cursor: pointer; text-align: left; }
.add-opt:hover { color: var(--text); background: var(--surface-2); }
.pill-toggle { border: 1px dashed var(--border); border-radius: var(--radius-full); background: transparent;
  color: var(--text-dim); padding: 2px 9px; font: 10px var(--mono); cursor: pointer; }
.pill-toggle.on { border-style: solid; border-color: var(--k-ask); color: var(--k-ask);
  background: var(--k-ask-soft); }
.preview-block { border: 1.5px dashed color-mix(in oklch, var(--k-ask) 55%, transparent);
  border-radius: var(--radius-md); padding: 7px; display: flex; flex-direction: column; gap: 6px; }
.stepper .micro { padding: 0 2px; }

/* ── ask card — the choice control is the star; the thread never answers ── */
.ask-card { border-radius: var(--radius-md); border: 1px solid var(--border-soft); background: var(--surface-2);
  padding: 10px 11px; display: flex; flex-direction: column; gap: 9px; }
.ask-card.careful { border-color: color-mix(in oklch, var(--amber) 55%, transparent); }
.ask-card.dangerous { border-color: var(--danger-strong); }
.ask-q { font-weight: var(--weight-semibold); font-size: var(--text-base); }
.ask-ctx { color: var(--text-dim); font-size: var(--text-xs); white-space: pre-wrap; }
.ask-opts { display: flex; flex-direction: column; gap: 6px; }
.ask-opts.bare { flex-direction: row; flex-wrap: wrap; }
.opt-btn {
  display: flex; align-items: center; gap: 8px; text-align: left; cursor: pointer;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface);
  color: var(--text); padding: 7px 10px;
}
.opt-btn:hover { border-color: color-mix(in oklch, var(--ring) 45%, var(--border)); }
.opt-btn.staged { border-color: var(--primary); background: color-mix(in oklch, var(--primary) 14%, var(--surface)); }
.opt-btn.primary { border-color: var(--k-ask); }
.opt-btn.bare { padding: 5px 12px; border-radius: var(--radius-full); }
.opt-btn:disabled { opacity: .45; cursor: default; }
.opt-label { font-weight: var(--weight-semibold); }
.opt-desc { color: var(--text-dim); font-size: var(--text-xs); }
.opt-rank { width: 18px; height: 18px; border-radius: 50%; background: var(--k-ask);
  color: var(--color-neutral-950); font: var(--weight-bold) 10px/18px var(--font); text-align: center; flex: none; }
.opt-rec { margin-left: auto; }
.ask-frozen { color: var(--green); display: flex; align-items: center; gap: 6px; font-size: var(--text-sm); }

/* ── the decision artifact (frozen ask readback, F-043) ── */
.ask-status { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.chip-rule { background: var(--k-ask-soft); color: var(--k-ask);
  border-color: color-mix(in oklch, var(--k-ask) 32%, transparent); }
.ask-decision { display: flex; flex-direction: column; gap: 6px; }
.opt-frozen { border: 1px solid var(--border); border-radius: var(--radius); padding: 6px 10px;
  display: flex; flex-direction: column; gap: 3px; }
.opt-frozen.picked { border-color: color-mix(in oklch, var(--green) 65%, transparent);
  background: var(--green-soft); }
.opt-frozen.picked .icon-sm { color: var(--green); flex: none; }
.opt-frozen.quiet { border-style: dashed; border-color: var(--border-soft);
  color: var(--text-mute); padding: 3px 10px; font-size: var(--text-xs); }
.ans-row { display: flex; align-items: flex-start; gap: 6px; font-size: var(--text-xs); }
.ans-row .who { font-weight: var(--weight-semibold); }
.ans-row .when { margin-left: auto; color: var(--text-mute); font: 9px/1.8 var(--mono); flex: none; }
.ans-comment { color: var(--text-dim); font-size: var(--text-xs); white-space: pre-wrap;
  word-break: break-word; margin-top: 1px; }
.ask-closing { color: var(--text-dim); font: 10px var(--mono); }

/* ── batch tray ── */
.batch-tray { bottom: 16px; right: 12px; width: 300px; }
.batch-op { display: flex; align-items: center; gap: 7px; font: 10px var(--mono);
  color: var(--text-dim); padding: 4px 0; border-bottom: 1px solid var(--border-soft); }
.batch-op .op-kind { color: var(--k-change); font-weight: var(--weight-bold); }
.batch-op .op-detail { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.op-remove { border: 0; background: transparent; color: var(--text-dim); cursor: pointer; padding: 0 4px; }
.op-remove:hover { color: var(--danger); }

/* ── variant panel (ported) ── */
.variant-panel { top: 54px; right: 12px; width: 356px; max-height: calc(100vh - 66px); }
.variant-inline-mount { display: flex; flex-direction: column; }
.variant-panel.inline {
  position: static; z-index: auto; width: 100%; max-height: none; display: flex;
  box-shadow: none; border-radius: var(--radius-md); background: var(--surface-2);
}
.variant-panel.inline .card-body { padding: 9px 10px; }
.variant-status { font: 11px var(--mono); color: var(--k-change); }
.variant-note { font-size: 12px; color: var(--text-dim); align-self: center; }
.variant-target { font: 10px var(--mono); color: var(--text-dim); word-break: break-all; }
.variant-current { flex: 1; min-width: 0; color: var(--amber); font-weight: var(--weight-bold);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.preview-label {
  position: fixed; bottom: 16px; right: 12px; z-index: 2147483647; max-width: 360px;
  display: none; pointer-events: none; background: var(--amber); color: var(--color-neutral-950);
  padding: 6px 11px; border-radius: var(--radius-full); box-shadow: var(--shadow-sm);
  font: var(--weight-bold) 12px/1.3 var(--font); letter-spacing: .02em;
}

/* ── code blocks in messages (@onlay/render code-block) ── */
${CODE_BLOCK_CSS}

/* ── the space field and its menu (@onlay/render space-select) ── */
${SPACE_SELECT_CSS}
`;

/* ── overlay zoom (Appearance pref, prefs.uiZoom) ──
   The sheet above is authored at 1×; every px value is multiplied once at
   adopt time — vw/vh caps and unitless line-heights stay untouched, and
   JS-written page-coordinate geometry (placeBox, pin/ring placement) is
   unaffected, so anchors keep tracking page elements at any zoom. JS values
   that MIRROR sheet sizes (pin stacking, menu clamps, composer widths) must
   go through scaled() so the two stay in lockstep. */
let uiZoom = UI_ZOOM_DEFAULT;

/** Scale a 1×-authored px value by the current overlay zoom. */
export function scaled(n: number): number {
  return Math.round(n * uiZoom);
}

/** Multiply every px length in 1×-authored CSS text. Exported for tests. */
export function zoomCss(css: string, zoom: number): string {
  if (zoom === 1) return css;
  return css.replace(/(-?\d+(?:\.\d+)?)px/g, (_, n: string) => `${Number(n) * zoom}px`);
}

/** The full sheet at a zoom: scaled surfaces + the 1×-fixed orb chrome. */
function composeSheet(zoom: number): string {
  return zoomCss(SHEET_CSS, zoom) + ORB_CSS;
}

/** Build and adopt the single overlay stylesheet onto a shadow root. */
export function installSheet(shadow: ShadowRoot): CSSStyleSheet {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(composeSheet(uiZoom));
  shadow.adoptedStyleSheets = [sheet];
  return sheet;
}

/** Apply an overlay zoom: re-scale the adopted sheet and the scaled() base. */
export function applyUiZoom(sheet: CSSStyleSheet, zoom: number): void {
  if (zoom === uiZoom) return;
  uiZoom = zoom;
  sheet.replaceSync(composeSheet(zoom));
}

/**
 * Stamp prefs.theme onto the overlay host: the sheet's `:host(.theme-*)`
 * blocks pick the value set (dark base · light commit · system via the
 * prefers-color-scheme query).
 */
export function stampTheme(host: HTMLElement, theme: Theme): void {
  host.classList.remove("theme-light", "theme-dark", "theme-system");
  host.classList.add(`theme-${theme}`);
}

/** Place a fixed-position overlay box over a page element via style properties. */
export function placeBox(box: HTMLElement, target: Element | null): void {
  if (!target?.isConnected) {
    box.style.display = "none";
    return;
  }
  // A block inside a frame of this page (A-3) is placed where it shows here.
  const r =
    target.ownerDocument === document ? target.getBoundingClientRect() : rectInOwner(target);
  box.style.display = "block";
  box.style.left = `${r.left}px`;
  box.style.top = `${r.top}px`;
  box.style.width = `${r.width}px`;
  box.style.height = `${r.height}px`;
}
