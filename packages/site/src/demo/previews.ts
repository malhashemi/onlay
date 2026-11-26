// What is on the page for each block: the kept edits that are showing and,
// over them, the one variant on preview. Each block has ONE preview engine
// (@onlay/render's, the one the extension runs), and every change goes
// through it as a whole program, so the engine's snapshot of the block is
// always the page as it was: taking everything off puts the block back
// exactly, whatever happened in between.
//
// Which Edit controls a block when several target it:
//   - kept edits that are switched on apply first, in the order they were kept;
//   - then the one set that is showing a variant (the store lets only one set
//     per block show at a time: the last one the visitor stepped).
// A set showing its original adds nothing: the block shows its kept edits.
import type { MutationProgram } from "@onlay/protocol";
import type { PreviewEngine } from "@onlay/render";
import type { Item, Variant } from "../overlay/model";

/** What the "Indicative preview" pill says: a variant's label, the original, or nothing. */
export type PillState = { kind: "variant"; label: string } | { kind: "original" } | null;

export interface Previews {
  /** Bring the page in line with the interactions; returns what the pill shows. */
  sync(items: readonly Item[]): PillState;
  /** Take everything off the page and let every engine go. */
  clear(): void;
  /** How many blocks have something applied. */
  applied(): number;
}

interface Layer {
  /** Names what is applied, so an unchanged block is left alone. */
  key: string;
  program: MutationProgram;
}

/** A kept Edit's picked variant, when its switch is on. */
function keptVariant(item: Item): Variant | undefined {
  const set = item.variants;
  if (item.state !== "kept" || item.keptOn === false || set?.picked === undefined) return undefined;
  return set.variants[set.picked];
}

/** The variant a set is showing on preview. */
function shownVariant(item: Item): Variant | undefined {
  const set = item.variants;
  if (set?.status !== "previewing" || set.shown === null || set.shown < 0) return undefined;
  return set.variants[set.shown];
}

/** What each block should carry, by the block's selector. */
export function layersFor(items: readonly Item[]): Map<string, Layer> {
  const blocks = new Map<string, { kept: Item[]; showing: Item | undefined }>();
  for (const item of items) {
    const where = item.anchor?.selector;
    if (where === undefined || !item.variants) continue;
    let block = blocks.get(where);
    if (!block) {
      block = { kept: [], showing: undefined };
      blocks.set(where, block);
    }
    if (keptVariant(item)) block.kept.push(item);
    else if (shownVariant(item)) block.showing = item;
  }
  const layers = new Map<string, Layer>();
  for (const [where, block] of blocks) {
    const order = [...block.kept].sort((a, b) => (a.keptAt ?? 0) - (b.keptAt ?? 0));
    const parts: Array<{ id: string; variant: Variant }> = [];
    for (const item of order) {
      const v = keptVariant(item);
      if (v) parts.push({ id: item.id, variant: v });
    }
    const top = block.showing ? shownVariant(block.showing) : undefined;
    if (block.showing && top) parts.push({ id: block.showing.id, variant: top });
    if (parts.length === 0) continue;
    layers.set(where, {
      key: parts.map((p) => `${p.id}:${p.variant.id}`).join("|"),
      program: parts.flatMap((p) => p.variant.program),
    });
  }
  return layers;
}

/** What the pill shows: the set on preview, wherever it is. */
export function pillFor(items: readonly Item[]): PillState {
  let pill: PillState = null;
  for (const item of items) {
    const set = item.variants;
    if (set?.status !== "previewing" || set.shown === null) continue;
    const v = shownVariant(item);
    pill = v ? { kind: "variant", label: v.label } : { kind: "original" };
  }
  return pill;
}

export function createPreviews(createEngine: () => PreviewEngine): Previews {
  const slots = new Map<string, { engine: PreviewEngine; key: string | null }>();

  return {
    sync(items) {
      const want = layersFor(items);
      for (const [where, layer] of want) {
        let slot = slots.get(where);
        if (!slot) {
          slot = { engine: createEngine(), key: null };
          slots.set(where, slot);
        }
        if (slot.key === layer.key) continue;
        // The engine restores before it applies: the new program goes onto the
        // block as it was, never onto what the last one left.
        const result = slot.engine.apply(layer.program, where);
        slot.key = result.ok ? layer.key : null;
      }
      for (const [where, slot] of slots) {
        if (want.has(where)) continue;
        slot.engine.dispose();
        slots.delete(where);
      }
      return pillFor(items);
    },
    clear() {
      for (const slot of slots.values()) slot.engine.dispose();
      slots.clear();
    },
    applied: () => [...slots.values()].filter((s) => s.key !== null).length,
  };
}
