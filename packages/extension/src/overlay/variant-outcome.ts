// How a variant applied, told to the space so the agent that wrote it can read
// it (`variant-outcome`), and, separately, said to the person on the panel.
//
// The two are computed apart on purpose. The panel says what happened on the
// LIVE page: that stays in the person's browser. What is reported is computed
// against the REDACTED copy of the block (the same sanitized markup an upload
// of that block carries), parsed apart from the page and run through the
// detached applier: a step's result can depend on nothing an upload of the
// block could not already contain (no form state, no hidden input, no
// stripped attribute, nothing outside the block, no `:hover` or `:checked`).
//
// Like an automatic look: only the Edit's author reports (this tab holds the
// Edit on this exact page, `ownsEditHere`), only for a variant written by them
// or their agent (`by`), once per variant version per account, only while the
// copy is still bound to the document, page and account it was taken for. The
// report is integers and the closed reason set; the service worker checks its
// sender like an upload's, and the space keeps the first.

import { LIMITS, type MutationProgram, type StepRefusalReason } from "@onlay/protocol";
import { type ApplyResult, applyProgramToRoot, type RefusedOp } from "@onlay/render";
import { uploadOrigin } from "./upload-origin";

/** What one apply did: on the live page for the panel, or against the copy for the report. */
export interface AppliedOutcome {
  steps: number;
  applied: number;
  refused: RefusedOp[];
  /** The root block wasn't on the page (the live panel only). */
  rootMissing?: true;
  /** The live apply threw and was taken back (the live panel only). */
  failed?: true;
  /** Computed against a copy of the block reduced to fit the markup limit. */
  reducedCopy?: true;
}

/**
 * The live apply as the panel shows it; null when it tells nothing (a
 * preview held off while a look is taken answers with a zero token).
 */
export function liveOutcomeOf(
  result: ApplyResult | { ok: false; reason: "other-page" },
  steps: number,
): AppliedOutcome | null {
  if (!result.ok) {
    if (result.reason === "target-missing")
      return { steps, applied: 0, refused: [], rootMissing: true };
    if (result.reason === "failed") return { steps, applied: 0, refused: [], failed: true };
    return null;
  }
  if (result.token === 0) return null;
  return {
    steps,
    applied: result.applied,
    refused: (result.refused ?? []).slice(0, LIMITS.MAX_MUTATION_OPS_PAGE),
  };
}

/**
 * The redacted copy a report is computed against: the markup an upload of the
 * block (or, for a page set, the page) carries, and what it is bound to.
 */
export interface RedactedCopy {
  /** The sanitized markup: the block's own element, or the page's body. */
  html: string;
  page: boolean;
  /** It was reduced (or cut) to fit the markup limit. */
  reduced: boolean;
  /** The Edit's page address, to resolve relative addresses as the page would. */
  base: string;
  /** Still the document, page and account (and block) it was taken for. */
  bound: () => boolean;
}

/**
 * How `program` applies to the redacted copy, parsed apart from the page; null
 * when that can't be told for sure (the copy doesn't parse to its root, or
 * applying threw): then nothing is reported.
 */
export function outcomeAgainstCopy(
  copy: RedactedCopy,
  program: MutationProgram,
): AppliedOutcome | null {
  let root: Element | null = null;
  try {
    const parser = new DOMParser();
    if (copy.page) {
      root = parser.parseFromString(copy.html, "text/html").body;
    } else {
      // A template parses any block (a table row, a list item) as itself.
      const holder = parser.parseFromString(`<template>${copy.html}</template>`, "text/html");
      const first = holder.querySelector("template")?.content.firstElementChild ?? null;
      if (first) {
        const doc = parser.parseFromString("<!doctype html><body></body>", "text/html");
        doc.body.append(doc.importNode(first, true));
        root = doc.body.firstElementChild;
      }
    }
  } catch {
    return null;
  }
  if (!root) return null;
  const r = applyProgramToRoot(root, program, { page: copy.page, base: copy.base });
  if (r.failed) return null;
  if (r.applied + r.refused.length !== program.length) return null;
  return {
    steps: program.length,
    applied: r.applied,
    refused: r.refused.slice(0, LIMITS.MAX_MUTATION_OPS_PAGE),
    ...(copy.reduced ? { reducedCopy: true as const } : {}),
  };
}

export interface OutcomeTarget {
  setId: string;
  spaceId: string | undefined;
  changeInteractionId: string | undefined;
  variant: { variantId: string; version: number; by?: string; program: MutationProgram };
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

function reportKey(account: string, t: OutcomeTarget): string {
  return `${account}|${t.setId}|${t.variant.variantId}@${t.variant.version}`;
}

/** Whether this browser should still report this variant version (before any copy is read). */
export function owesReport(deps: OutcomeDeps, t: OutcomeTarget): boolean {
  const account = deps.account();
  const self = deps.selfId();
  if (account === null || self === null || !t.spaceId || !t.changeInteractionId) return false;
  if (t.variant.by !== self) return false;
  if (!deps.ownsEdit(t.changeInteractionId)) return false;
  return !sent.has(reportKey(account, t));
}

/**
 * Report how a variant applies to the redacted copy, when this browser is the
 * one to report it and the copy still holds. Returns whether a report went out.
 */
export function reportVariantOutcome(
  deps: OutcomeDeps,
  t: OutcomeTarget,
  copy: RedactedCopy,
): boolean {
  if (!owesReport(deps, t) || !copy.bound()) return false;
  const account = deps.account() as string;
  const outcome = outcomeAgainstCopy(copy, t.variant.program);
  if (!outcome) return false;
  const key = reportKey(account, t);
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
      ...(outcome.reducedCopy ? { reducedCopy: true } : {}),
      // Checked by the service worker like an upload's, then dropped.
      ...uploadOrigin(),
    })
    .then(
      (r) => {
        if (!r.ok) sent.delete(key); // a later pass may try again
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
  rootMissing: "The block for these variants isn't on this page right now.",
  head: (n: number, total: number) =>
    total === 1 ? "1 step couldn't be applied" : `${n} of ${total} steps couldn't be applied`,
  missing: (n: number) => `${n} didn't match anything on this page`,
  empty: (n: number) => (n === 1 ? "1 adds nothing visible" : `${n} add nothing visible`),
  rules: (n: number) =>
    n === 1 ? "1 isn't allowed on a live page" : `${n} aren't allowed on a live page`,
  budget: (n: number) => (n === 1 ? "1 is past the step limit" : `${n} are past the step limit`),
} as const;

/**
 * One line saying how many steps of the variant on preview couldn't be
 * applied and why, by kind of reason; empty when every step landed.
 */
export function outcomeLine(outcome: AppliedOutcome): string {
  // A missing root or a failed apply is said once, on the status line.
  if (outcome.rootMissing || outcome.failed || outcome.refused.length === 0) return "";
  const counts: Record<Group, number> = { missing: 0, empty: 0, rules: 0, budget: 0 };
  for (const r of outcome.refused) counts[GROUP_OF[r.reason] ?? "rules"] += 1;
  const parts = (["missing", "empty", "rules", "budget"] as const)
    .filter((g) => counts[g] > 0)
    .map((g) => OUTCOME_COPY[g](counts[g]));
  return `${OUTCOME_COPY.head(outcome.refused.length, outcome.steps)}: ${parts.join("; ")}.`;
}
