// How a variant applied in the Edit author's own browser, told to the space so
// the agent that wrote it can read it (`variant-outcome`), and said to the
// person in plain words on the panel.
//
// Like an automatic look: only the Edit's author reports (this tab holds the
// Edit on this exact page, `ownsEditHere`), only for a variant written by them
// or their agent (`by`), once per variant version per account, and only while
// the page and account are the ones the variant was applied on. The report is
// integers and the closed reason set, never text from the page; the service
// worker checks its sender like an upload's, and the space keeps the first.

import { LIMITS, type StepRefusalReason } from "@onlay/protocol";
import type { ApplyResult, RefusedOp } from "@onlay/render";
import { uploadOrigin } from "./upload-origin";

/** What one apply did, as the report carries it. */
export interface AppliedOutcome {
  steps: number;
  applied: number;
  refused: RefusedOp[];
  rootMissing?: true;
}

export function outcomeOf(result: ApplyResult, steps: number): AppliedOutcome {
  if (!result.ok) return { steps, applied: 0, refused: [], rootMissing: true };
  return {
    steps,
    applied: result.applied,
    refused: (result.refused ?? []).slice(0, LIMITS.MAX_MUTATION_OPS_PAGE),
  };
}

export interface OutcomeTarget {
  setId: string;
  spaceId: string | undefined;
  changeInteractionId: string | undefined;
  variant: { variantId: string; version: number; by?: string };
}

export interface OutcomeDeps {
  /** The signed-in person. */
  selfId(): string | null;
  /** `<person>|<server origin>`, or null when signed out. */
  account(): string | null;
  /** This tab may speak for the Edit: its author is signed in here and holds it on this page. */
  ownsEdit(changeInteractionId: string): boolean;
  frameUrl(): string;
  send(frame: { type: string; [k: string]: unknown }): Promise<{ ok: boolean }>;
}

/** Reports already sent, per account, set and variant version. */
const sent = new Set<string>();

/**
 * Report one apply of a variant, when this browser is the one to report it.
 * Returns whether a report went out.
 */
export function reportVariantOutcome(
  deps: OutcomeDeps,
  t: OutcomeTarget,
  outcome: AppliedOutcome,
): boolean {
  const account = deps.account();
  const self = deps.selfId();
  if (account === null || self === null || !t.spaceId || !t.changeInteractionId) return false;
  if (t.variant.by !== self) return false;
  if (!deps.ownsEdit(t.changeInteractionId)) return false;
  const key = `${account}|${t.setId}|${t.variant.variantId}@${t.variant.version}`;
  if (sent.has(key)) return false;
  sent.add(key);
  void deps
    .send({
      type: "variant-outcome",
      frameUrl: deps.frameUrl(),
      setId: t.setId,
      spaceId: t.spaceId,
      variantId: t.variant.variantId,
      version: t.variant.version,
      steps: Math.min(outcome.steps, LIMITS.MAX_MUTATION_OPS_PAGE),
      applied: Math.min(outcome.applied, LIMITS.MAX_MUTATION_OPS_PAGE),
      refused: outcome.refused,
      ...(outcome.rootMissing ? { rootMissing: true } : {}),
      // Checked by the service worker like an upload's, then dropped.
      ...uploadOrigin(),
    })
    .then(
      (r) => {
        if (!r.ok) sent.delete(key); // a later apply may try again
      },
      () => sent.delete(key),
    );
  return true;
}

/* ── the person's words ─────────────────────────────────────────────── */

type Group = "missing" | "empty" | "rules" | "budget";

const GROUP_OF: Record<StepRefusalReason, Group> = {
  "target-missing": "missing",
  "fragment-empty": "empty",
  "fragment-disallowed": "empty",
  "over-budget": "budget",
  "page-root-text": "rules",
  "page-root-replace": "rules",
  "url-origin": "rules",
  "url-scheme": "rules",
  "style-value": "rules",
  "style-property": "rules",
  "text-target": "rules",
  "attr-denied": "rules",
  "attr-rejected": "rules",
  "class-name": "rules",
  "target-kind": "rules",
};

/** Plain words for the panel (copy pass pending; keep each easy to replace). */
export const OUTCOME_COPY = {
  rootMissing: "The block these variants change isn't on this page right now.",
  head: (n: number, total: number) =>
    `${n} of ${total} ${total === 1 ? "step" : "steps"} couldn't be applied`,
  missing: (n: number) =>
    n === 1
      ? "1 targets a part of the block that isn't on this page"
      : `${n} target parts of the block that aren't on this page`,
  empty: (n: number) =>
    n === 1 ? "1 inserts nothing that shows" : `${n} insert nothing that shows`,
  rules: (n: number) =>
    n === 1 ? "1 isn't allowed on a live page" : `${n} aren't allowed on a live page`,
  budget: (n: number) =>
    n === 1
      ? "1 is past the most steps a variant may have"
      : `${n} are past the most steps a variant may have`,
} as const;

/**
 * One line saying how many steps of the variant on preview couldn't be
 * applied and why, by kind of reason; empty when every step landed.
 */
export function outcomeLine(outcome: AppliedOutcome): string {
  if (outcome.rootMissing) return OUTCOME_COPY.rootMissing;
  if (outcome.refused.length === 0) return "";
  const counts: Record<Group, number> = { missing: 0, empty: 0, rules: 0, budget: 0 };
  for (const r of outcome.refused) counts[GROUP_OF[r.reason] ?? "rules"] += 1;
  const parts = (["missing", "empty", "rules", "budget"] as const)
    .filter((g) => counts[g] > 0)
    .map((g) => OUTCOME_COPY[g](counts[g]));
  return `${OUTCOME_COPY.head(outcome.refused.length, outcome.steps)}: ${parts.join("; ")}.`;
}
