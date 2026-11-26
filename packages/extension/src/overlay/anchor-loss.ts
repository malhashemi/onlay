// Anchor-loss detection (ADR-0017 §4). The overlay counts, per live
// element-anchored interaction, how many CONSECUTIVE sync passes its anchor
// failed to resolve while the page was otherwise alive. After a threshold
// (3) of misses it reports the loss ONCE; the server demotes to page-level.
// A pass where the anchor resolves resets the counter. Pure over a counter
// map so it is unit-testable without a DOM or a socket.

export const ANCHOR_LOSS_THRESHOLD = 3;

export interface LossStep {
  /** Consecutive-miss counts to carry into the next pass (present ids only). */
  next: Map<string, number>;
  /** Ids that crossed the threshold on THIS pass — send `anchor-lost` once. */
  fire: string[];
}

/**
 * Advance the per-interaction miss counters by one sync pass.
 *
 * @param prev      counts carried from the previous pass
 * @param lost      ids whose anchor failed to resolve this pass
 * @param present   ids that are live + element-anchored + not-yet-lost this pass
 * @param threshold consecutive misses before a loss is reported
 */
export function stepLossCounters(
  prev: Map<string, number>,
  lost: ReadonlySet<string>,
  present: ReadonlySet<string>,
  threshold: number = ANCHOR_LOSS_THRESHOLD,
): LossStep {
  const next = new Map<string, number>();
  const fire: string[] = [];
  for (const id of present) {
    if (!lost.has(id)) {
      next.set(id, 0);
      continue;
    }
    const count = (prev.get(id) ?? 0) + 1;
    next.set(id, count);
    if (count === threshold) fire.push(id);
  }
  return { next, fire };
}
