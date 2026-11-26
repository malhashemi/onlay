// Kind + state + stakes chips (ADR-0008, design-language §5). Accessibility law:
// never color-only — every chip carries label/glyph copy, not just a hue.
import type { InteractionKind, Stakes } from "@onlay/protocol";
import type { Chip } from "@onlay/render/interaction-view";
import { CHIP_LABEL } from "@onlay/render/interaction-view";
import { add, el } from "../dom";
import { kindGlyph } from "./glyphs";

/** The interaction kind, as glyph + label. `data-kind` drives the hue from the
 *  kind-chip CSS (the same treatment the extension's chips get). */
export function kindChip(kind: InteractionKind, label: string): HTMLElement {
  const chip = el("span", "kind-chip");
  chip.setAttribute("data-kind", kind === "change" ? "edit" : kind);
  return add(chip, kindGlyph(kind, 13), el("span", "kind-chip-label", label));
}

/** The shared state vocabulary: needs you (amber-hot) · waiting (muted) ·
 *  resolved (emerald-soft). */
export function stateChip(state: Chip): HTMLElement {
  const chip = el("span", "state-chip", CHIP_LABEL[state]);
  chip.setAttribute("data-state", state);
  return chip;
}

/** Stakes tick — routine is visually silent by design (interaction.css
 *  precedent); only careful/dangerous render a dot + label. */
export function stakesDot(stakes: Stakes | undefined): HTMLElement | null {
  if (!stakes || stakes === "routine") return null;
  const chip = el("span", "stakes-dot", stakes);
  chip.setAttribute("data-stakes", stakes);
  return chip;
}
