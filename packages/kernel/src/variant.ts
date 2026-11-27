/**
 * Variant-set state machine + journal codec — pure (no I/O, no timers). A
 * variant set is created from a picked element + command, moves generating →
 * previewing → implementing → verifying → resolved, and is resolved exactly
 * once (first pick / discard wins).
 *
 * Sets are independent: several may be live on one page at once, and nothing
 * here looks across sets (spec §8). A set's root is one block or the whole
 * page; a picked set behind a kept Edit may reopen for new variants.
 *
 * Kernel state is plain strings — branding (`UntrustedText`) is a protocol/
 * edge concern; the server re-brands page strings when emitting agent events.
 * Replay births state ONLY from `variant-set-create` (intent-first, the
 * husk-session lesson).
 */
import {
  type ElementContext,
  LIMITS,
  type MutationProgram,
  type RefusedStep,
  type VariantIntent,
  type VariantRoot,
} from "@onlay/protocol";

export type VariantSetStatus =
  | "generating"
  | "previewing"
  | "implementing"
  | "verifying"
  | "resolved";
export type VariantOutcome = "picked" | "discarded" | "stale";

export interface Variant {
  variantId: string;
  label: string;
  program: MutationProgram;
  version: number;
  /** Posted by an agent through MCP. */
  agent?: boolean;
  /** Who wrote this version: the person (for an agent's variant, the person it acts as). */
  by?: string;
}

/**
 * One revision a client named (round 3, 2-S1, 3-S1): this person's
 * `clientId` produced this version of this variant, at this index, with a
 * program of this many ops. A repeat finds it, answers with it and changes
 * nothing. Kept for as long as the set is (it goes with the set at retention).
 */
export interface VariantRevision {
  by: string;
  clientId: string;
  variantId: string;
  version: number;
  index: number;
  ops: number;
}

/**
 * How one version of a variant applied in the Edit author's own browser
 * (`variant-outcome`): integers and the closed reason set only. The first
 * report for a version stands; a newer version's report replaces it.
 */
export interface ApplyReport {
  version: number;
  steps: number;
  applied: number;
  refused: RefusedStep[];
  /** The set's root block was not on the page. */
  rootMissing?: true;
  /** Computed against a copy of the block reduced to fit the markup limit. */
  reducedCopy?: true;
  at: number;
}

export interface VariantSetState {
  setId: string;
  /** Frames must originate from a URL starting with this — the anti-spoof gate. */
  expectUrlPrefix: string;
  command: string;
  count: number;
  /** Picked-element context captured at create — the preview engine's resolution root + the agent's durable pointer. Absent on sets journaled before root capture. */
  element?: ElementContext;
  /** The set's root (spec §8). Absent = a block root at `element` (legacy sets). */
  root?: VariantRoot;
  /** The human's intent lane ("change" | "insert-after"); absent = "change". */
  intent?: VariantIntent;
  /** The Change interaction this set is the method of (ADR-0004). */
  changeInteractionId?: string;
  status: VariantSetStatus;
  outcome?: VariantOutcome;
  variants: Variant[];
  activeIndex?: number;
  pickedVariantId?: string;
  /**
   * What the person picked, pinned at pick time (spec §8): the kept program is
   * served from here, so an agent revising or appending after the pick never
   * changes what stays applied until a person picks again.
   */
  pickedVersion?: number;
  pickedProgram?: MutationProgram;
  pickedLabel?: string;
  createdAt: number;
  resolvedAt?: number;
  /** Every revision sent with a client id, oldest first (never sent to clients). */
  revisions?: VariantRevision[];
  /** Per variant id, how its current (or an earlier) version applied for the author (never in frames). */
  applyReports?: Record<string, ApplyReport>;
}

export interface VariantCreateInput {
  setId: string;
  expectUrlPrefix: string;
  command: string;
  count: number;
  element?: ElementContext;
  root?: VariantRoot;
  intent?: VariantIntent;
  changeInteractionId?: string;
}

/** The set's root: `root`, else a block at the legacy `element`, else null (pre-root-capture). */
export function variantSetRoot(s: VariantSetState): VariantRoot | null {
  if (s.root) return s.root;
  if (s.element) return { kind: "block", element: s.element };
  return null;
}

export function createVariantSet(input: VariantCreateInput, now: number): VariantSetState {
  return {
    ...input,
    status: "generating",
    variants: [],
    createdAt: now,
  };
}

export type SubmitVariantsResult =
  | { state: VariantSetState; ok: true }
  | {
      state: VariantSetState;
      ok: false;
      reason: "resolved" | "wrong-status" | "count" | "duplicate-id";
    };
/**
 * Submit variants incrementally (streaming): the first submission moves
 * `generating` → `previewing`; further submissions APPEND while previewing
 * (up to MAX_VARIANTS_PER_SET total), so the human can start cycling the
 * moment variant one exists instead of waiting for the full set. Appending
 * never moves the active index — the human's current preview is not yanked.
 */
export function submitVariants(
  s: VariantSetState,
  variants: Variant[],
  now: number,
): SubmitVariantsResult {
  void now;
  if (s.status === "resolved") return { state: s, ok: false, reason: "resolved" };
  if (s.status !== "generating" && s.status !== "previewing") {
    return { state: s, ok: false, reason: "wrong-status" };
  }
  if (variants.length < 1 || s.variants.length + variants.length > LIMITS.MAX_VARIANTS_PER_SET) {
    return { state: s, ok: false, reason: "count" };
  }
  // variantId is an IDENTITY (F30: witness lineages, capture guards, and the
  // PWA's stop map all key on it) — a duplicate inside the set would collapse
  // two distinct stops into one witness. New submissions carrying a duplicate
  // (against the set OR within the batch) are REFUSED; replay stays tolerant
  // by deduping keep-first below, so an old journal never fails to load.
  const seen = new Set(s.variants.map((v) => v.variantId));
  const fresh: Variant[] = [];
  for (const v of variants) {
    if (seen.has(v.variantId)) return { state: s, ok: false, reason: "duplicate-id" };
    seen.add(v.variantId);
    fresh.push(v);
  }
  return {
    state: {
      ...s,
      status: "previewing",
      variants: [...s.variants, ...fresh],
      activeIndex: s.activeIndex ?? 0,
    },
    ok: true,
  };
}

/** Replay-tolerant submission: an OLD journal may carry duplicate variantIds
 *  (pre-F30); keep-first preserves what those clients actually saw. */
export function replaySubmitVariants(
  s: VariantSetState,
  variants: Variant[],
  now: number,
): VariantSetState {
  const seen = new Set(s.variants.map((v) => v.variantId));
  const deduped = variants.filter((v) => {
    if (seen.has(v.variantId)) return false;
    seen.add(v.variantId);
    return true;
  });
  if (deduped.length === 0) return s;
  return submitVariants(s, deduped, now).state;
}

export function setActive(s: VariantSetState, index: number): VariantSetState {
  if (s.status !== "previewing") return s;
  if (!Number.isInteger(index) || index < 0 || index >= s.variants.length) return s;
  return { ...s, activeIndex: index };
}
export type TuneResult = { state: VariantSetState; ok: boolean };
/**
 * A new version of one variant. `agent` marks the revision as an agent's (it
 * stays marked even when the variant started as a person's manual edit). With
 * `by` and `clientId`, the set remembers that this person's id made this
 * version (`revisionByClientId`).
 */
export function tuneVariant(
  s: VariantSetState,
  index: number,
  program: MutationProgram,
  now: number,
  agent?: boolean,
  by?: string,
  clientId?: string,
): TuneResult {
  void now;
  if (s.status !== "previewing") return { state: s, ok: false };
  if (!Number.isInteger(index) || index < 0 || index >= s.variants.length) {
    return { state: s, ok: false };
  }
  const prev = s.variants[index];
  if (!prev) return { state: s, ok: false };
  const variants = [...s.variants];
  variants[index] = {
    ...prev,
    program,
    version: prev.version + 1,
    ...(agent ? { agent: true } : {}),
    ...(by !== undefined ? { by } : {}),
  };
  const tuned = variants[index] as Variant;
  const revisions =
    by !== undefined && clientId !== undefined
      ? [
          ...(s.revisions ?? []),
          {
            by,
            clientId,
            variantId: tuned.variantId,
            version: tuned.version,
            index,
            ops: program.length,
          },
        ]
      : s.revisions;
  return {
    state: {
      ...s,
      variants,
      activeIndex: index,
      ...(revisions !== undefined ? { revisions } : {}),
    },
    ok: true,
  };
}

/**
 * Keep a variant's apply report: only for a variant in the set at that
 * version, only the first for a version (a later version's replaces an older
 * one). `changed` is false when the report adds nothing.
 */
export function recordApplyReport(
  s: VariantSetState,
  variantId: string,
  report: ApplyReport,
): { state: VariantSetState; changed: boolean } {
  const variant = s.variants.find((v) => v.variantId === variantId);
  if (!variant || variant.version !== report.version) return { state: s, changed: false };
  const prev = s.applyReports?.[variantId];
  if (prev && prev.version >= report.version) return { state: s, changed: false };
  return {
    state: { ...s, applyReports: { ...(s.applyReports ?? {}), [variantId]: report } },
    changed: true,
  };
}

/** The report for a variant's current version, if its author's browser sent one. */
export function currentApplyReport(s: VariantSetState, variantId: string): ApplyReport | undefined {
  const report = s.applyReports?.[variantId];
  const variant = s.variants.find((v) => v.variantId === variantId);
  return report && variant && report.version === variant.version ? report : undefined;
}

/** The revision this person's `clientId` made on this set, if it made one. */
export function revisionByClientId(
  s: VariantSetState,
  by: string,
  clientId: string,
): VariantRevision | undefined {
  return s.revisions?.find((r) => r.by === by && r.clientId === clientId);
}

export type PickResult =
  | { state: VariantSetState; ok: true }
  | { state: VariantSetState; ok: false; reason: "wrong-status" | "variant-changed" };

/**
 * The person picks the variant they previewed, named by id and the version
 * they saw: an unknown id or another version is `variant-changed` and changes
 * nothing. The picked program, version and label are pinned on the set.
 */
export function pickVariant(
  s: VariantSetState,
  pick: { variantId: string; version: number },
  now: number,
): PickResult {
  void now;
  if (s.status !== "previewing") return { state: s, ok: false, reason: "wrong-status" };
  const index = s.variants.findIndex((v) => v.variantId === pick.variantId);
  const picked = s.variants[index];
  if (!picked || picked.version !== pick.version) {
    return { state: s, ok: false, reason: "variant-changed" };
  }
  return {
    state: {
      ...s,
      status: "implementing",
      outcome: "picked",
      activeIndex: index,
      pickedVariantId: picked.variantId,
      pickedVersion: picked.version,
      pickedProgram: picked.program,
      pickedLabel: picked.label,
    },
    ok: true,
  };
}

/** The variant at `index` as a pick (journals written before picks named the variant). */
function pickAt(s: VariantSetState, index: number): { variantId: string; version: number } | null {
  const v = Number.isInteger(index) ? s.variants[index] : undefined;
  return v ? { variantId: v.variantId, version: v.version } : null;
}
export function discardSet(
  s: VariantSetState,
  now: number,
): { state: VariantSetState; ok: boolean } {
  if (s.status === "resolved" || s.status === "implementing" || s.status === "verifying") {
    return { state: s, ok: false };
  }
  return {
    state: { ...s, status: "resolved", outcome: "discarded", resolvedAt: now },
    ok: true,
  };
}
export function markImplemented(
  s: VariantSetState,
  now: number,
): { state: VariantSetState; ok: boolean } {
  void now;
  if (s.status !== "implementing") return { state: s, ok: false };
  return { state: { ...s, status: "verifying" }, ok: true };
}
/**
 * A picked set behind a kept Edit takes new variants again (spec §8: the
 * Edit stays kept until an agent posts new variants). Back to previewing;
 * the pick is remembered, so the kept program holds until the next pick.
 */
export function reopenSet(
  s: VariantSetState,
  now: number,
): { state: VariantSetState; ok: boolean } {
  void now;
  if (s.status !== "implementing" || s.outcome !== "picked") return { state: s, ok: false };
  return { state: { ...s, status: "previewing" }, ok: true };
}

/**
 * The Edit behind a picked set was resolved (spec §8): the set resolves with
 * it, keeping its `picked` outcome. Refused for a set never picked or already
 * resolved.
 */
export function resolveSet(
  s: VariantSetState,
  now: number,
): { state: VariantSetState; ok: boolean } {
  if (s.status === "resolved" || s.outcome !== "picked") return { state: s, ok: false };
  return { state: { ...s, status: "resolved", resolvedAt: now }, ok: true };
}

export function markStale(s: VariantSetState, now: number): VariantSetState {
  if (s.status === "resolved") return s;
  return { ...s, status: "resolved", outcome: "stale", resolvedAt: now };
}

// ---- journal codec — only -create births state ----

export type VariantJournalEntry =
  | {
      k: "variant-set-create";
      ts: number;
      setId: string;
      expectUrlPrefix: string;
      command: string;
      count: number;
      element?: ElementContext;
      root?: VariantRoot;
      intent?: VariantIntent;
      changeInteractionId?: string;
    }
  | { k: "variant-generated"; ts: number; setId: string; variants: Variant[] }
  | {
      k: "variant-tuned";
      ts: number;
      setId: string;
      index: number;
      program: MutationProgram;
      agent?: boolean;
      by?: string;
      /** The client's id for this revision (2-S1); absent in older journals. */
      clientId?: string;
    }
  | { k: "variant-steered"; ts: number; setId: string; instruction: string }
  /** Older journals carry only `index`: the variant there at that point is the one picked. */
  | {
      k: "variant-picked";
      ts: number;
      setId: string;
      variantId?: string;
      version?: number;
      index?: number;
    }
  | { k: "variant-discarded"; ts: number; setId: string }
  | { k: "variant-stale"; ts: number; setId: string }
  | { k: "variant-implemented"; ts: number; setId: string }
  | { k: "variant-reopened"; ts: number; setId: string }
  | { k: "variant-resolved"; ts: number; setId: string }
  /** How a variant version applied in the Edit author's browser (`recordApplyReport`). */
  | {
      k: "variant-outcome";
      ts: number;
      setId: string;
      variantId: string;
      version: number;
      steps: number;
      applied: number;
      refused: RefusedStep[];
      rootMissing?: true;
      reducedCopy?: true;
    };

const VARIANT_KINDS = new Set([
  "variant-set-create",
  "variant-generated",
  "variant-tuned",
  "variant-steered",
  "variant-picked",
  "variant-discarded",
  "variant-stale",
  "variant-implemented",
  "variant-reopened",
  "variant-resolved",
  "variant-outcome",
]);

export function encodeVariantEntry(e: VariantJournalEntry): string {
  return JSON.stringify(e);
}
export function decodeVariantEntry(line: string): VariantJournalEntry | null {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const e = data as Record<string, unknown>;
  if (typeof e.k !== "string" || !VARIANT_KINDS.has(e.k)) return null;
  if (typeof e.setId !== "string" || typeof e.ts !== "number") return null;
  return data as VariantJournalEntry;
}
export function replayVariantSets(lines: Iterable<string>): Map<string, VariantSetState> {
  const sets = new Map<string, VariantSetState>();
  for (const line of lines) {
    if (line.trim() === "") continue;
    const e = decodeVariantEntry(line);
    if (e === null) continue;
    const prev = sets.get(e.setId);
    switch (e.k) {
      case "variant-set-create": {
        sets.set(
          e.setId,
          createVariantSet(
            {
              setId: e.setId,
              expectUrlPrefix: e.expectUrlPrefix,
              command: e.command,
              count: e.count,
              ...(e.element !== undefined ? { element: e.element } : {}),
              ...(e.root !== undefined ? { root: e.root } : {}),
              ...(e.intent !== undefined ? { intent: e.intent } : {}),
              ...(e.changeInteractionId !== undefined
                ? { changeInteractionId: e.changeInteractionId }
                : {}),
            },
            e.ts,
          ),
        );
        break;
      }
      case "variant-generated": {
        if (!prev) break;
        sets.set(e.setId, replaySubmitVariants(prev, e.variants, e.ts));
        break;
      }
      case "variant-tuned": {
        if (!prev) break;
        const clientId = typeof e.clientId === "string" ? e.clientId : undefined;
        sets.set(
          e.setId,
          tuneVariant(prev, e.index, e.program, e.ts, e.agent, e.by, clientId).state,
        );
        break;
      }
      case "variant-steered": {
        if (!prev) break;
        sets.set(e.setId, prev);
        break;
      }
      case "variant-picked": {
        if (!prev) break;
        const pick =
          e.variantId !== undefined && e.version !== undefined
            ? { variantId: e.variantId, version: e.version }
            : pickAt(prev, e.index ?? -1);
        if (pick) sets.set(e.setId, pickVariant(prev, pick, e.ts).state);
        break;
      }
      case "variant-discarded": {
        if (!prev) break;
        sets.set(e.setId, discardSet(prev, e.ts).state);
        break;
      }
      case "variant-stale": {
        if (!prev) break;
        sets.set(e.setId, markStale(prev, e.ts));
        break;
      }
      case "variant-implemented": {
        if (!prev) break;
        sets.set(e.setId, markImplemented(prev, e.ts).state);
        break;
      }
      case "variant-reopened": {
        if (!prev) break;
        sets.set(e.setId, reopenSet(prev, e.ts).state);
        break;
      }
      case "variant-resolved": {
        if (!prev) break;
        sets.set(e.setId, resolveSet(prev, e.ts).state);
        break;
      }
      case "variant-outcome": {
        if (!prev || typeof e.variantId !== "string" || !Array.isArray(e.refused)) break;
        sets.set(
          e.setId,
          recordApplyReport(prev, e.variantId, {
            version: e.version,
            steps: e.steps,
            applied: e.applied,
            refused: e.refused,
            ...(e.rootMissing ? { rootMissing: true as const } : {}),
            ...(e.reducedCopy ? { reducedCopy: true as const } : {}),
            at: e.ts,
          }).state,
        );
        break;
      }
    }
  }
  return sets;
}
