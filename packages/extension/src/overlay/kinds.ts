// The membrane's visual grammar (ADR-0008), implemented natively for the
// overlay: one language for every interaction kind at every altitude —
// pins, rail rows, launcher, cards, notifications — recognizable by
// glyph + hue. No Tailwind: hues are CSS custom properties defined once in
// dom.ts and referenced by class here.
import type { AgentWork, AgentWorkStatus, InteractionKind } from "@onlay/protocol";

/** SVG path data (24×24 viewBox) — drawn via createElementNS, never innerHTML. */
export interface Glyph {
  paths: string[];
}

export interface KindSpec {
  kind: InteractionKind;
  label: string;
  /** CSS class stem: `.k-comment`, `.k-ask`, `.k-change` carry the hue vars. */
  cls: string;
  glyph: Glyph;
}

/** Comment — speech bubble, sky. */
const COMMENT_GLYPH: Glyph = {
  paths: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
};
/** Ask — question circle, violet. */
const ASK_GLYPH: Glyph = {
  paths: [
    "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z",
    "M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3",
    "M12 17h.01",
  ],
};
/** Change — pen line, emerald. */
const CHANGE_GLYPH: Glyph = {
  paths: ["M12 20h9", "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"],
};

export const KINDS: Record<InteractionKind, KindSpec> = {
  comment: { kind: "comment", label: "Comment", cls: "k-comment", glyph: COMMENT_GLYPH },
  ask: { kind: "ask", label: "Ask", cls: "k-ask", glyph: ASK_GLYPH },
  // Lexicon (ADR-0019 §5): the wire kind stays `change`; the human reads Edit.
  change: { kind: "change", label: "Edit", cls: "k-change", glyph: CHANGE_GLYPH },
};

export const KIND_LIST: KindSpec[] = [KINDS.comment, KINDS.ask, KINDS.change];

/** State chips share one vocabulary across pins, rail, popover (ADR-0008 §5). */
export type ChipState = "needs-you" | "waiting" | "resolved";

export interface ChipSpec {
  label: string;
  cls: string;
}
export const CHIP_STATES: Record<ChipState, ChipSpec> = {
  "needs-you": { label: "needs you", cls: "chip-needs" },
  waiting: { label: "waiting", cls: "chip-waiting" },
  resolved: { label: "resolved", cls: "chip-resolved" },
};

/**
 * The membrane's live states (still counted / pinned). Mirrors protocol
 * LIVE_STATES; kept local so a snapshot's `state` string maps to a chip
 * without importing the whole enum table.
 */
const LIVE = new Set(["open", "answered", "kept", "working", "implemented", "verifying"]);

export function isLiveState(state: string): boolean {
  return LIVE.has(state);
}

/**
 * The thread outlives the resolution (F-047): resolved interactions still
 * accept replies/edits/reactions so a verdict or answer can be discussed in
 * place. Only dropped/superseded are terminal.
 */
export function canFollowThrough(state: string): boolean {
  return state !== "dropped" && state !== "superseded";
}

/**
 * Map a snapshot to a coarse chip, given whether it waits on the paired actor.
 * needs-you when the actor is in waitingOn and it's live; resolved when done;
 * waiting otherwise.
 */
export function chipFor(state: string, waitsOnSelf: boolean): ChipState {
  if (state === "resolved" || state === "dropped" || state === "superseded") return "resolved";
  if (waitsOnSelf) return "needs-you";
  return "waiting";
}

/**
 * An interaction's agent work as the person reads it (spec §7, §10): plain
 * words on rows and thread headers, never a chip that competes with
 * "needs you".
 */
export const AGENT_WORK_LABEL: Record<AgentWorkStatus, string> = {
  pending: "for agent",
  taken: "taken",
  answered: "answered",
};

/** The effective status: an expired lease reads as pending (spec §7). */
export function agentWorkStatus(
  work: AgentWork | undefined,
  now: number = Date.now(),
): AgentWorkStatus | null {
  if (!work) return null;
  if (work.status === "taken" && work.leaseUntil !== undefined && work.leaseUntil < now)
    return "pending";
  return work.status;
}
