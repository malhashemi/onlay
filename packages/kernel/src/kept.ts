/**
 * Kept Edits (spec §8): the program a kept Edit keeps applied as a preview on
 * the live page, derived from the Edit and its variant set — never stored
 * twice. The page snapshot carries one entry per kept Edit.
 */
import { type KeptEdit, LIMITS } from "@onlay/protocol";
import type { InteractionState } from "./interaction";
import { type VariantSetState, variantSetRoot } from "./variant";

/**
 * The Edit's kept program, or null. While the Edit is `kept` or `working`:
 * the picked variant's program (root = the set's root), or for a hand-made
 * batch the batch itself (root = the page). From `implemented` on it is no
 * longer applied. `set` is the Edit's variant set, when it has one.
 */
export function keptProgramOf(
  change: InteractionState,
  set: VariantSetState | undefined,
): KeptEdit | null {
  const c = change.change;
  if (change.kind !== "change" || !c) return null;
  if (change.state !== "kept" && change.state !== "working") return null;
  const by = c.keptBy;
  const at = c.keptAt;
  if (by === undefined || at === undefined) return null;

  if (c.method === "manual-batch") {
    const program = c.batches.at(-1);
    if (!program) return null;
    return {
      interactionId: change.id,
      root: { kind: "page" },
      program,
      by,
      at,
      label: c.intent.slice(0, LIMITS.MAX_VARIANT_LABEL),
    };
  }

  if (!set || set.setId !== c.variantSetId || set.pickedVariantId === undefined) return null;
  const root = variantSetRoot(set);
  if (!root) return null;
  // The pick is pinned on the set: what the person picked stays applied, whatever
  // an agent revised or appended since. Sets picked before pinning read the variant.
  const pinned =
    set.pickedProgram !== undefined
      ? { program: set.pickedProgram, label: set.pickedLabel ?? "", version: set.pickedVersion }
      : set.variants.find((v) => v.variantId === set.pickedVariantId);
  if (!pinned) return null;
  return {
    interactionId: change.id,
    setId: set.setId,
    variantId: set.pickedVariantId,
    ...(pinned.version !== undefined ? { version: pinned.version } : {}),
    root,
    program: pinned.program,
    by,
    at,
    label: pinned.label.slice(0, LIMITS.MAX_VARIANT_LABEL) || "Edit",
  };
}
