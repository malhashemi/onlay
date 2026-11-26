// What the top frame takes from a child frame's report about its Edits
// (round 4, E-1 … E-3): the variant sets its panel mirrors, the kept edits
// the launcher and the Kept edits list count and switch, and the tray edits
// made in that frame's document. Pure, so the rules are pinned by tests.
//
// Each list is the child's own view, relayed by the service worker as it came;
// the top frame keeps only well-formed entries in spaces it knows, from a
// report made under the access revision it knows for that space (3-F5).
import { LIMITS } from "@onlay/protocol";
import type { KeptRow } from "./kept-layer";
import type { RemoteAct, SetMirror } from "./variants";

/** At most this many entries of each list are taken from one report. */
const MAX_REPORTED = { sets: 12, kept: 64, ops: LIMITS.MAX_MUTATION_OPS } as const;
const TEXT = 240;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const STATUSES = new Set(["generating", "previewing", "implementing", "verifying", "resolved"]);
const OUTCOMES = new Set(["picked", "discarded", "stale"]);

const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length <= max ? v : null;
const int = (v: unknown, min: number, max: number): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;

/** The space of an entry may be kept: a space this frame knows, reported as of its newest revision. */
export type SpaceGate = (spaceId: string) => boolean;

/** A space gate for one report: known here, and its revision in the report no older than ours. */
export function spaceGate(
  revs: Readonly<Record<string, unknown>>,
  knownRev: (spaceId: string) => number,
  knownSpace: (spaceId: string) => boolean,
): SpaceGate {
  return (sp) => {
    if (!knownSpace(sp)) return false;
    const rev = revs[sp];
    return typeof rev === "number" && rev >= knownRev(sp);
  };
}

/** The variant sets of a report the top frame's panel may mirror. */
export function acceptSets(raw: unknown, gate: SpaceGate): SetMirror[] {
  if (!Array.isArray(raw)) return [];
  const out: SetMirror[] = [];
  for (const v of raw.slice(0, MAX_REPORTED.sets)) {
    const m = parseSet(v);
    if (m?.spaceId && gate(m.spaceId)) out.push(m);
  }
  return out;
}

function parseSet(v: unknown): SetMirror | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const setId = str(o.setId, LIMITS.MAX_VARIANT_SET_ID);
  const spaceId = typeof o.spaceId === "string" && ID_RE.test(o.spaceId) ? o.spaceId : null;
  const status = typeof o.status === "string" && STATUSES.has(o.status) ? o.status : null;
  if (!setId || !spaceId || !status || !Array.isArray(o.variants)) return null;
  if (o.variants.length > LIMITS.MAX_VARIANTS_PER_SET) return null;
  const variants: SetMirror["variants"] = [];
  for (const x of o.variants) {
    const e = (x ?? {}) as Record<string, unknown>;
    const variantId = str(e.variantId, LIMITS.MAX_VARIANT_SET_ID);
    const label = str(e.label, LIMITS.MAX_VARIANT_LABEL);
    const version = int(e.version, 1, Number.MAX_SAFE_INTEGER);
    if (!variantId || label === null || version === null) return null;
    variants.push({ variantId, label, version });
  }
  const displayIndex = int(o.displayIndex, -1, LIMITS.MAX_VARIANTS_PER_SET);
  const statusText = str(o.statusText, TEXT);
  const lookNote = str(o.lookNote, TEXT);
  if (displayIndex === null || statusText === null || lookNote === null) return null;
  const selector = o.selector === undefined ? undefined : str(o.selector, LIMITS.MAX_SELECTOR);
  const change =
    o.changeInteractionId === undefined
      ? undefined
      : str(o.changeInteractionId, LIMITS.MAX_ACTOR_ID);
  if (selector === null || change === null) return null;
  return {
    setId,
    spaceId,
    status: status as SetMirror["status"],
    ...(typeof o.outcome === "string" && OUTCOMES.has(o.outcome)
      ? { outcome: o.outcome as NonNullable<SetMirror["outcome"]> }
      : {}),
    ...(selector !== undefined ? { selector } : {}),
    ...(o.rootKind === "page" || o.rootKind === "block" ? { rootKind: o.rootKind } : {}),
    ...(change !== undefined ? { changeInteractionId: change } : {}),
    variants,
    displayIndex,
    full: o.full === true,
    nothingApplied: o.nothingApplied === true,
    previewing: o.previewing === true,
    statusText,
    lookNote,
  };
}

/** A child frame's kept edits: its rows and how many are applied in it now. */
export interface ReportedKept {
  rows: KeptRow[];
  shown: number;
}

/** The kept edits of a report the launcher may count and the Kept edits list may show. */
export function acceptKept(raw: unknown, gate: SpaceGate): ReportedKept {
  const none = { rows: [], shown: 0 };
  if (!raw || typeof raw !== "object") return none;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.rows)) return none;
  const rows: KeptRow[] = [];
  for (const v of o.rows.slice(0, MAX_REPORTED.kept)) {
    const r = (v ?? {}) as Record<string, unknown>;
    const interactionId = str(r.interactionId, LIMITS.MAX_ACTOR_ID);
    const spaceId = typeof r.spaceId === "string" && ID_RE.test(r.spaceId) ? r.spaceId : null;
    const label = str(r.label, LIMITS.MAX_VARIANT_LABEL);
    const by = str(r.by, LIMITS.MAX_ACTOR_ID);
    const at = typeof r.at === "number" && Number.isFinite(r.at) ? r.at : null;
    const refused = int(r.refused, 0, LIMITS.MAX_MUTATION_OPS_PAGE);
    if (!interactionId || !spaceId || label === null || !by || at === null || refused === null)
      continue;
    if (!gate(spaceId)) continue;
    rows.push({
      interactionId,
      spaceId,
      label,
      by,
      at,
      on: r.on === true,
      unresolved: r.unresolved === true,
      refused,
    });
  }
  // What it says is applied, never more than the rows it showed and has on.
  const on = rows.filter((r) => r.on && !r.unresolved).length;
  const shown = int(o.shown, 0, MAX_REPORTED.kept) ?? 0;
  return { rows, shown: Math.min(shown, on) };
}

/** One tray edit made in a child frame's document, as the top frame's tray lists it. */
export interface ReportedOp {
  op: string;
  detail: string;
}

/** The tray makes only these (batch.ts). */
const OPS = new Set(["setText", "setStyle"]);

/** The tray edits a child frame reports for its own document. */
export function acceptOps(raw: unknown): ReportedOp[] {
  if (!Array.isArray(raw)) return [];
  const out: ReportedOp[] = [];
  for (const v of raw.slice(0, MAX_REPORTED.ops)) {
    const o = (v ?? {}) as Record<string, unknown>;
    const op = typeof o.op === "string" && OPS.has(o.op) ? o.op : null;
    const detail = str(o.detail, TEXT);
    if (!op || detail === null) return [];
    out.push({ op, detail });
  }
  return out;
}

/** An act the top frame's variant panel asks of this frame, when well formed (E-1). */
export function parseRemoteAct(raw: unknown): RemoteAct | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  switch (o.act) {
    case "open": {
      const changeId = str(o.changeId, LIMITS.MAX_ACTOR_ID);
      return changeId ? { act: "open", changeId } : null;
    }
    case "cycle":
      return o.delta === 1 || o.delta === -1 ? { act: "cycle", delta: o.delta } : null;
    case "pick": {
      const variantId = str(o.variantId, LIMITS.MAX_VARIANT_SET_ID);
      const version = int(o.version, 1, Number.MAX_SAFE_INTEGER);
      return variantId && version !== null ? { act: "pick", variantId, version } : null;
    }
    case "discard":
      return { act: "discard" };
    case "more":
      return { act: "more" };
    default:
      return null;
  }
}

/**
 * The child documents to forget now (3-E4): every one the top frame has heard
 * from (`lastHeard`) or still holds anything of (`held`), silent for longer
 * than `ms`, whatever it reported.
 */
export function documentsToForget(
  lastHeard: ReadonlyMap<string, number>,
  held: Iterable<string>,
  now: number,
  ms: number,
): string[] {
  const docs = new Set([...lastHeard.keys(), ...held]);
  return [...docs].filter((d) => now - (lastHeard.get(d) ?? 0) > ms);
}

/**
 * Where a Kept edits switch acts (3-E5): a row that names a child document
 * acts there while that document is still known, or nowhere; never on another
 * document. A row naming none is this frame's.
 */
export function keptSwitchTarget(
  documentId: string | undefined,
  known: ReadonlyMap<string, unknown>,
): { here: true } | { documentId: string } | null {
  if (documentId === undefined) return { here: true };
  return known.has(documentId) ? { documentId } : null;
}

/**
 * A tray call between frames is made under one account generation (3-E3):
 * the child acts on it only under that same generation, and the top frame
 * takes its answer only when the child answered under it and it is still the
 * one held. Anything else reads as "the page changed".
 */
export function trayAnswer(
  r: Record<string, unknown>,
  sent: number | null,
  now: number | null,
): Record<string, unknown> {
  if (sent === null || r.generation !== sent || now !== sent)
    return { ok: false, error: "page-changed" };
  return r;
}

/** Whether a child frame acts on a tray call (3-E3): made under the generation it holds now. */
export function trayCallAllowed(call: Record<string, unknown>, now: number | null): boolean {
  return now !== null && call.generation === now;
}
