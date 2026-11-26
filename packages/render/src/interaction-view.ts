// Pure view-model helpers for the full-page interaction view (ui-spec §4).
// No DOM, no chrome APIs — the render code in interaction.ts imports these and
// interaction-model.test.ts exercises them. Everything here maps a
// RawInteractionSnapshot (server truth over `GET /agent/interaction/:id`) into
// the small facts the page draws: actors, ages, chips, the anchor label, and
// the ask's answer state.
import {
  type ActorKind,
  type ActorSummary,
  type Anchor,
  type CaptureRef,
  type CaptureRefResidue,
  flattenFences,
  type RawInteractionSnapshot,
} from "@onlay/protocol";
import type { RenderResidue } from "./portable-renderer";

export type Snapshot = RawInteractionSnapshot;

/** Individual tints (mirrors the overlay/popup fallback ramp). */
const TINT = [
  "#0ea5e9",
  "#8b5cf6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#ec4899",
  "#14b8a6",
  "#6366f1",
];

function hashTint(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return TINT[Math.abs(h) % TINT.length] as string;
}

/** Mirrors the kernel's `initialsOf` — first letters of up to two words. */
export function initialsOf(name: string): string {
  const words = name
    .split(/[\s\-_]+/)
    .filter(Boolean)
    .slice(0, 2);
  return words.map((w) => (w[0] ?? "").toUpperCase()).join("") || "?";
}

/** An actor the directory doesn't know — species guessed from the id shape. */
export function fallbackActor(id: string): ActorSummary {
  const kind: ActorKind = id === "agent" || id.endsWith("-agent") ? "agent" : "human";
  return { id, name: id, kind, tint: hashTint(id), initials: initialsOf(id) };
}

export function resolveActor(directory: Map<string, ActorSummary>, id: string): ActorSummary {
  return directory.get(id) ?? fallbackActor(id);
}

/** Coarse relative age: now / Nm / Nh / Nd. */
export function age(ts: number, now: number = Date.now()): string {
  const d = now - ts;
  if (d < 60_000) return "now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
  return `${Math.floor(d / 86_400_000)}d`;
}

/** Host of the origin URL for the context line, or null when page-less. */
export function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 60);
  }
}

/** The anchor's human label (local copy of overlay/anchors `anchorLabel`). */
export function anchorLabel(anchor: Anchor): string {
  if (anchor.level === "unanchored") return "unanchored";
  if (anchor.level === "page") return "page-level";
  if (anchor.level === "selection") {
    const t = anchor.text.trim();
    return t ? `“${t.slice(0, 40)}”` : "selection";
  }
  if (anchor.blockId) return `§${anchor.blockId}`;
  if (anchor.snippet) return anchor.snippet.slice(0, 40);
  const sel = anchor.selector;
  const tail = sel.split(">").pop()?.trim() ?? sel;
  return tail.slice(0, 40) || "block";
}

/**
 * The page to show and open for a thread (F-3): the page the person shares
 * (`hostUrl`) when the block is inside a frame of it, else the page it is
 * bound to. The binding itself always stays `url`.
 */
export function shownUrl(x: {
  url?: string | undefined;
  hostUrl?: string | undefined;
}): string | undefined {
  return x.hostUrl ?? x.url;
}

/** Short page label for a cross-page row ("/docs/adr-0019", or the host). */
export function pathLabel(url: string | undefined): string {
  if (!url) return "unanchored";
  try {
    const u = new URL(url);
    return u.pathname === "/" ? u.hostname : u.pathname;
  } catch {
    return url.slice(0, 40);
  }
}

/* ── the ONE search matcher (F25) ─────────────────────────────────────
 * The extension command bar and the PWA search bar match the SAME fields
 * with the SAME semantics — parity by construction, not by mirroring. Each
 * surface adapts its rows into this shape; drift is a type error. */

export interface SearchableRow {
  /** One-line summary: ask question / edit intent / first thread words. */
  text: string;
  actorId: string;
  actorName: string;
  /** Anchor label / attention context line. */
  context: string;
  state: string;
  /** Page place: path or host; "unanchored" when loose (pathLabel). */
  place: string;
  /** The FULL anchored URL (F26 follow-up): `place` alone is the pathname on
   *  non-root pages, so "forum" would miss a thread on forum.example.com/r/… —
   *  searching by site is how people actually remember where things live. */
  url?: string;
}

/** Case-insensitive substring match across every searchable field.
 *  An empty/whitespace query matches everything. */
export function matchesQuery(r: SearchableRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    r.text.toLowerCase().includes(q) ||
    r.actorId.toLowerCase().includes(q) ||
    r.actorName.toLowerCase().includes(q) ||
    r.context.toLowerCase().includes(q) ||
    r.state.toLowerCase().includes(q) ||
    r.place.toLowerCase().includes(q) ||
    (r.url?.toLowerCase().includes(q) ?? false)
  );
}

/** One-line summary of a snapshot: ask question / edit intent / first live
 *  thread words (the same digest the command bar's rows lead with). */
export function snapshotSummary(s: Snapshot): string {
  // A preview: each fenced block reduced to its code (agents read the text as written).
  if (s.kind === "ask" && s.ask) return flattenFences(s.ask.question);
  if (s.kind === "change" && s.change) return flattenFences(s.change.intent);
  const first = s.thread.find((m) => !m.system && !m.deleted);
  return flattenFences(first?.body.text ?? "");
}

/** Last-activity timestamp of a snapshot (newest thread message, else birth). */
export function snapshotTs(s: Snapshot): number {
  const last = s.thread[s.thread.length - 1];
  return last?.ts ?? s.createdAt;
}

/** An open Ask still wants an answer (the control shows). */
export function askIsOpen(s: Snapshot): boolean {
  return s.kind === "ask" && s.state === "open";
}

/**
 * Whether a Full client can actually re-capture this anchor — element/selection
 * only. Page-level and unanchored places have NO in-overlay snapshot path, so a
 * "Request a fresh look" affordance offered on them would light a duty no capture
 * surface can ever discharge (a permanent "Capture due"). The ONE rule every
 * client mirrors: the extension duty surface (`overlay/resnap-model`), the PWA
 * fresh-look button, and — enforced server-side — the kernel's `requestResnap`
 * (which inlines the same level test, being unable to import render). */
/**
 * The Inbox row's reason, in words both clients show beside the row; null for
 * no reason or one this build does not know (the row shows nothing extra).
 */
export function becauseLabel(because: unknown): string | null {
  return because === "shared" ? "Shared with you" : null;
}

export function anchorIsCapturable(anchor: Anchor): boolean {
  return anchor.level === "element" || anchor.level === "selection";
}

/** Live states still count / accept a Resolve; terminal ones don't. */
const LIVE = new Set(["open", "answered", "working", "implemented", "verifying"]);
export function isLive(state: string): boolean {
  return LIVE.has(state);
}

/** The thread outlives the resolution (the panel's rule): follow-up replies
 *  and own-message edit/delete stay open until dropped/superseded — only
 *  Resolve itself keys on `isLive`. Mirrors overlay/kinds.ts. */
export function canFollowThrough(state: string): boolean {
  return state !== "dropped" && state !== "superseded";
}

/** The paired actor is being waited on — this interaction needs them. */
export function waitsOnSelf(s: Snapshot, selfId: string | null): boolean {
  return selfId != null && s.waitingOn.includes(selfId);
}

export type Chip = "needs-you" | "waiting" | "resolved";

/** The state chip vocabulary shared with the overlay (kinds `chipFor`). */
export function chipState(state: string, waitsSelf: boolean): Chip {
  if (state === "resolved" || state === "dropped" || state === "superseded") return "resolved";
  if (waitsSelf) return "needs-you";
  return "waiting";
}

export const CHIP_LABEL: Record<Chip, string> = {
  "needs-you": "needs you",
  waiting: "waiting",
  resolved: "resolved",
};

/** Option ids the ask has been answered with (union across answers). */
export function selectedOptionIds(s: Snapshot): string[] {
  const ids = new Set<string>();
  for (const a of s.ask?.answers ?? []) for (const o of a.optionIds) ids.add(o);
  return [...ids];
}

/* ── attachments (evidence, never a render context) ─────────────────── */

/** The interaction's attachment captures. Only the `attachment` role draws an
 *  evidence card — edit-context/snapshot captures are fidelity substrate, never
 *  evidence, and never surface here (strategy §1 role table). */
export function attachmentCaptures(s: Snapshot): CaptureRef[] {
  return (s.captures ?? []).filter((c) => c.kind === "attachment");
}

/** An attachment previews inline only when its bytes are a still image. SVG is
 *  refused server-side, so `image/*` reaching a card is inert raster — safe to
 *  draw from an object URL, never active content. */
export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

/** The newest edit-context capture on the snapshot, or null (render §2.1). Its
 *  presence selects rung 1 of the fidelity ladder — the portable `sandbox=""`
 *  renderer — over the legacy `sanitizeMarkupForPreview` stage. Reads the same
 *  server-derived `s.captures` list the attachment refs ride, so the ref arrives
 *  with the snapshot; there is no extra fetch. Non-edit-context kinds
 *  (attachment/snapshot) are ignored.
 *
 *  Ordered by `capturedAt`, NOT `revision`: `revision` is an ordinal WITHIN one
 *  lineage (`edit:<targetKey>`, or a per-capture fallback when no targetKey), and
 *  a single interaction can carry more than one edit-context lineage (a re-pick
 *  changes `targetKey`; an absent key mints a fresh `captureId` lineage each at
 *  revision 1). Comparing raw revisions across lineages could seat an older
 *  lineage's high revision over a newer recapture's revision 1 — the wrong
 *  original beside current variants. `capturedAt` is the honest total order (it
 *  also rises monotonically within a lineage), with `revision` as the tie-break. */
export function editContextCapture(s: Snapshot): CaptureRef | null {
  let best: CaptureRef | null = null;
  for (const c of s.captures ?? []) {
    if (c.kind !== "edit-context") continue;
    if (
      best === null ||
      c.capturedAt > best.capturedAt ||
      (c.capturedAt === best.capturedAt && c.revision > best.revision)
    ) {
      best = c;
    }
  }
  return best;
}

/* ── F30: per-variant witness rasters (`variant-look` refs) ────────────── */

/** A variant stop's best witness + its honesty verdict. `stale` means the
 *  raster shows an EARLIER revision of the variant's program — display law
 *  demotes it out of the ground-truth rung with explicit copy. */
export interface VariantLook {
  ref: CaptureRef;
  stale: boolean;
}

/**
 * Match `variant-look` refs to their variants. Selection is freshest-VERSION
 * first, then newest revision WITHIN that version — an out-of-order commit of
 * an old capture (slow upload racing a revise) must never demote a stop that
 * already has fresh evidence (sol-8). A ref whose version exceeds the
 * variant's (a fresh witness read against a STALE cached set — sol-14) is
 * excluded entirely: the caller should refetch the set, not mislabel pixels.
 */
export function variantLooks(
  s: Snapshot,
  setId: string,
  variants: readonly { variantId: string; version?: number }[],
): Map<string, VariantLook> {
  const out = new Map<string, VariantLook>();
  for (const v of variants) {
    const current = v.version ?? 1;
    let best: CaptureRef | null = null;
    for (const c of s.captures ?? []) {
      if (c.kind !== "variant-look") continue;
      if (c.variantSetId !== setId || c.variantId !== v.variantId) continue;
      const ver = c.variantVersion ?? 1;
      if (ver > current) continue; // future witness vs cached set — refetch, don't trust
      if (
        best === null ||
        ver > (best.variantVersion ?? 1) ||
        (ver === (best.variantVersion ?? 1) && c.revision > best.revision)
      ) {
        best = c;
      }
    }
    if (best) out.set(v.variantId, { ref: best, stale: (best.variantVersion ?? 1) < current });
  }
  return out;
}

/** The trust rung a variant stop's visible evidence sits on (F30 display law).
 *  Inputs describe the EVIDENCE PAIR (sol-13): what the stop shows and what the
 *  Original beside it shows. Pick prominence follows the verdict — `primary`
 *  only when the human is looking at trustworthy pixels on BOTH sides. */
export interface RungVerdict {
  /** 2 = live variant raster · 3 = trustworthy recon delta · 4 = absolutes only */
  rung: 2 | 3 | 4;
  pick: "primary" | "demoted";
  /** The honest one-liner beside the stage (empty = the rung line alone). */
  caution: string;
}

export function variantRungVerdict(input: {
  /** The stop's witness, when one exists. */
  look?: VariantLook | undefined;
  /** Render residue of the stop's reconstruction frame (rung 3/4 evidence). */
  render?: RenderResidue | null | undefined;
  /** The reconstruction frame is the honest failure page, not a render. */
  renderFailed?: boolean | undefined;
  /** The ORIGINAL side has trustworthy evidence (witness raster or a clean
   *  reconstruction) — a variant raster beside NO original is not a delta. */
  originalTrusted: boolean;
}): RungVerdict {
  const { look, render, renderFailed, originalTrusted } = input;
  if (look && !look.stale) {
    return originalTrusted
      ? { rung: 2, pick: "primary", caution: "" }
      : { rung: 2, pick: "demoted", caution: "no faithful original to compare against" };
  }
  if (renderFailed) {
    return { rung: 4, pick: "demoted", caution: "the preview couldn't be rendered here" };
  }
  const misses = (render?.misses ?? 0) + (render?.rejected ?? 0);
  if (misses > 0) {
    return {
      rung: 3,
      pick: "demoted",
      caution: `${misses} of this variant's edits couldn't be shown here`,
    };
  }
  const dirty =
    (render?.strippedPlaceholders ?? 0) > 0 ||
    (render?.strippedUrls ?? 0) > 0 ||
    render?.authorRulesMissing === true;
  if (look?.stale) {
    return {
      rung: 3,
      pick: "demoted",
      caution: "captured from an earlier revision of this variant",
    };
  }
  if (dirty || !originalTrusted) {
    return {
      rung: 3,
      pick: "demoted",
      caution: "the preview can't fully show this — check on the desk before picking",
    };
  }
  return { rung: 3, pick: "primary", caution: "" };
}

/** F31/F34 — a raster metered `flat-raster` (a degenerate grab that survived
 *  the capture-side retry) anchors NO trust: both compare surfaces treat the
 *  ref as witness-less and fall to the reconstruction rung. */
export function flatRasterRef(ref: Pick<CaptureRef, "residue"> | null | undefined): boolean {
  return ref?.residue?.some((e) => e.class === "flat-raster") ?? false;
}

/* ── the stop trust lines (F30/F34) — the ONE grammar both compare surfaces
   speak: the PWA compare card and the desk full-page stage render these
   verbatim, so a stop never reads more (or less) trustworthy on one screen. ── */

/** The Original stop's rung line. `witnessAt` = the edit-context witness's
 *  capturedAt when a TRUSTED witness shows (absent = reconstruction or no
 *  capture at all). */
export function originalRungLine(input: {
  witnessAt?: number | undefined;
  capExists: boolean;
}): string {
  if (input.witnessAt !== undefined) {
    return `original — captured screenshot · uploaded ${age(input.witnessAt)} ago`;
  }
  return input.capExists ? "original — reconstruction" : "original — no capture yet";
}

/** A variant stop's rung line. `witnessAt` = the fresh variant-look witness's
 *  capturedAt when one shows; `stale` = a witness exists only from an earlier
 *  revision (the stop fell to the reconstruction). */
export function variantRungLine(input: {
  witnessAt?: number | undefined;
  stale?: boolean | undefined;
  capExists: boolean;
}): string {
  if (input.witnessAt !== undefined) {
    return `live capture · uploaded ${age(input.witnessAt)} ago — hold to compare`;
  }
  if (input.stale) return "reconstruction — a capture exists from an earlier revision";
  return input.capExists
    ? "reconstruction — trust what CHANGES, not the absolutes"
    : "no evidence for this variant yet";
}

/** True when the interaction carries a variant-look ref NEWER than the set
 *  copy in hand (sol-14: mixed cache generations) — the set read is stale. */
export function hasFutureVariantLook(
  s: Snapshot,
  setId: string,
  variants: readonly { variantId: string; version?: number }[],
): boolean {
  const byId = new Map(variants.map((v) => [v.variantId, v.version ?? 1]));
  for (const c of s.captures ?? []) {
    if (c.kind !== "variant-look" || c.variantSetId !== setId) continue;
    const current = c.variantId !== undefined ? byId.get(c.variantId) : undefined;
    if (current !== undefined && (c.variantVersion ?? 1) > current) return true;
  }
  return false;
}

/* ── the honesty meter: capture-time residue ∪ render-time strips ─────── */

/** One residue class the runtime meter surfaces — the capture-time closed enum
 *  (from `CaptureRef.residue`) or a synthesized render-time strip. `class` is a
 *  string (not `ResidueClass`) so a synthesized entry needs no enum ceremony. */
export interface ResidueMeterEntry {
  class: string;
  origin?: string;
}

/** Severity order for the meter's single headline line — a closed component /
 *  canvas / declined grant outranks truncation or a lost asset (render §2.3).
 *  The ONE ranking both human surfaces read, so the extension stage, the PWA
 *  compare meter, and the PWA look history never disagree on what leads. */
export const RESIDUE_RANK: Record<string, number> = {
  // No screenshot at all leads: other lines point the reader at the screenshot.
  "screenshot-covered": 6,
  "screenshot-see-through": 6,
  "screenshot-foreign-frame": 6,
  "screenshot-page-changed": 6,
  "screenshot-unplaced": 6,
  "screenshot-transformed": 6,
  "screenshot-scaled": 6,
  "screenshot-inner-frame": 6,
  "closed-shadow-root": 5,
  "canvas-video-content": 5,
  "declined-grant": 5,
  // flat-raster leads (codex-4): several classes' copy tells the reader to TRUST
  // the screenshot — a blank screenshot must outrank them, never sit under them.
  "flat-raster": 5,
  "cross-origin-frame": 4,
  "shadow-scoped-rules": 4,
  "generated-content-lost": 3,
  "quiescence-timeout": 3,
  "oversize-truncation": 2,
  "unfetchable-asset": 1,
  "stripped-url": 1,
  "security-error": 1,
};

/** The quiet, second-person meter copy for a residue class (render §2.3 verbatim;
 *  never the word "exact"). The ONE copy both surfaces speak — the extension
 *  stage and both PWA surfaces render from this, so a snapshot captured with
 *  `canvas-video-content` reads identically on the desk and on the phone. */
export function residueCopy(e: ResidueMeterEntry): string {
  switch (e.class) {
    case "declined-grant":
      return `Some styles from ${e.origin ?? "this site"} weren't captured — allow Onlay to read that site, then pick the block again to include them.`;
    case "closed-shadow-root":
      return "Part of this block is a closed component — shown from the captured screenshot.";
    case "shadow-scoped-rules":
      return "This block uses a component whose internal styles weren't captured — class changes to it may not preview.";
    case "canvas-video-content":
      return "Canvas or video here can't be reconstructed — the screenshot shows how it looked.";
    case "cross-origin-frame":
      return "An embedded frame here isn't reconstructed — see the screenshot.";
    case "generated-content-lost":
      return "A generated marker or counter couldn't be reconstructed — see the screenshot.";
    case "quiescence-timeout":
      return "Captured mid-change — the look may have still been settling.";
    case "oversize-truncation":
      return "A large block was trimmed to fit.";
    case "flat-raster":
      return "The screenshot came back blank — it may not show this look.";
    case "screenshot-covered":
      return "No screenshot: something on the page covered this block. Uncover it and ask for a fresh look.";
    case "screenshot-see-through":
      return "No screenshot: this block's frame is transparent, so the page behind it would show.";
    case "screenshot-foreign-frame":
      return "No screenshot: another site's frame was in the way.";
    case "screenshot-page-changed":
      return "No screenshot: the page changed before the look finished. Ask for a fresh look once it settles.";
    case "screenshot-unplaced":
      return "No screenshot: Onlay couldn't find this block's frame on the page. Scroll it into view and ask for a fresh look.";
    case "screenshot-transformed":
      return "No screenshot: this block's frame is rotated or skewed.";
    case "screenshot-scaled":
      return "No screenshot: this block's frame is shrunk or stretched.";
    case "screenshot-inner-frame":
      return "No screenshot: this block is inside a frame that has no address of its own.";
    default:
      return "An image or font couldn't be captured.";
  }
}

/** The meter model for a shown frame: the capture-time closed enum (`ref.residue`)
 *  deduped per class+origin, UNIONED with a synthesized entry when this frame's
 *  render stripped an asset/url the capture-time enum didn't already name, ranked
 *  most-severe first (render §2.3). `render` is null for the look history (a
 *  displayed witness has no live reconstruction, so no render-time strips). */
export function collectResidue(
  capture: readonly CaptureRefResidue[] | undefined,
  render: RenderResidue | null,
): ResidueMeterEntry[] {
  const out: ResidueMeterEntry[] = [];
  const seen = new Set<string>();
  for (const e of capture ?? []) {
    const key = `${e.class}:${e.origin ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e.origin !== undefined ? { class: e.class, origin: e.origin } : { class: e.class });
  }
  if (
    render &&
    (render.strippedPlaceholders > 0 || render.strippedUrls > 0) &&
    !out.some((e) => e.class === "unfetchable-asset" || e.class === "stripped-url")
  ) {
    out.push({ class: "unfetchable-asset" });
  }
  out.sort((a, b) => (RESIDUE_RANK[b.class] ?? 0) - (RESIDUE_RANK[a.class] ?? 0));
  return out;
}

/** The single most-severe residue line for a capture (its whole `ref.residue`,
 *  no live frame) — the look-history per-look note. Null when the capture is
 *  clean. */
export function captureResidueLine(ref: CaptureRef): string | null {
  const top = collectResidue(ref.residue, null)[0];
  return top ? residueCopy(top) : null;
}

/* ── snapshot look history (evidence of a look, browsed newest-first) ─── */

/** The interaction's snapshot look history, newest revision first (Stage 2 §4,
 *  ADR-0022 §3 ordered series). Snapshots share one lineage per interaction
 *  (`snap:<id>`, §1.3), so `revision` is a clean total order — no lineage
 *  grouping needed in the view. Non-snapshot kinds (attachment/edit-context) are
 *  ignored; empty when the place has no captured look yet. */
export function snapshotLooks(s: Snapshot): CaptureRef[] {
  return (s.captures ?? [])
    .filter((c) => c.kind === "snapshot")
    .sort((a, b) => b.revision - a.revision);
}

/** The part to draw a look's thumbnail from: the dedicated `thumbnail` if the
 *  capture carries one, else the `witness` screenshot (the honest, gone-page-
 *  proof render). Null when a look carries neither (§4 strip degrades in place). */
export function lookThumbPart(ref: CaptureRef): string | null {
  const has = (name: string): boolean => ref.parts.some((p) => p.name === name || p.role === name);
  if (has("thumbnail")) return "thumbnail";
  if (has("witness")) return "witness";
  return null;
}

/** The part to draw a look's FULL-SIZE stage/reveal from: the `witness` screenshot
 *  (the honest, gone-page-proof render, at full resolution) when present, else the
 *  downscaled `thumbnail`, else null. The INVERSE preference of `lookThumbPart` —
 *  the strip wants the small thumbnail, the stage/reveal want the full witness so
 *  the visual truth is shown at its native size, never a 320px raster upscaled to
 *  column width (Stage 2 §4/§4a). */
export function lookStagePart(ref: CaptureRef): string | null {
  const has = (name: string): boolean => ref.parts.some((p) => p.name === name || p.role === name);
  if (has("witness")) return "witness";
  if (has("thumbnail")) return "thumbnail";
  return null;
}

/** Human byte size for the evidence card's meta line. */
export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** Decode attachment bytes the SW hands back as base64 (a chrome.runtime message
 *  is JSON — no transferables, so an ArrayBuffer can't cross it). The page wraps
 *  the result in a Blob to mint the object URL. */
export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
