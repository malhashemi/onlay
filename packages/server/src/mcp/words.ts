/**
 * Plain words an agent reads for the closed sets onlay reports: why a step of
 * a variant was not applied (`StepRefusalReason`) and what a capture could not
 * keep (`ResidueClass`). The server renders these from codes and integers
 * only, so nothing here is page text and none of it needs framing.
 * (Copy pass pending: keep each easy to replace.)
 */
import type { RefusedStep, ResidueClass, StepRefusalReason } from "@onlay/protocol";
import { plural } from "./result";

export const STEP_WORDS: Record<StepRefusalReason, string> = {
  "target-missing": "target not on the page",
  "target-kind": "the target can't take this step (it isn't an HTML element)",
  "fragment-empty":
    "inserts nothing that shows (a fragment needs text, an image, a line break or a rule; an empty element shows nothing)",
  "fragment-disallowed":
    "inserts only tags onlay never inserts (forms, inputs, frames, scripts, styles and the like)",
  "attr-rejected":
    "an attribute onlay never sets on that element, or an address type it doesn't allow",
  "attr-denied":
    "an attribute no program may set (event handlers, style, srcdoc and the like) or one onlay manages itself",
  "class-name": "a class name that is empty or holds spaces (one name per entry)",
  "url-origin": "loads something from a site the page doesn't already load from",
  "url-scheme": "a link or address type that isn't allowed",
  "style-value": "a style value that isn't allowed (url() from elsewhere, expression(), @import)",
  "style-property": "a style property that isn't allowed (custom properties included)",
  "text-target": "text or markup aimed into a script, style or head element",
  "page-root-text": "would replace the whole page's text",
  "page-root-replace": "would replace the whole page",
  "over-budget": "past the most steps a variant may have",
};

/** At most this many step numbers are listed per reason. */
const MAX_LISTED_STEPS = 12;

/**
 * `step 0: inserts nothing that shows; steps 4, 7: target not on the page`,
 * grouped by reason in the order the reasons first appear.
 */
export function stepList(refused: readonly RefusedStep[]): string {
  const groups = new Map<StepRefusalReason, number[]>();
  for (const r of refused) {
    const list = groups.get(r.reason) ?? [];
    list.push(r.index);
    groups.set(r.reason, list);
  }
  return [...groups]
    .map(([reason, indexes]) => {
      const shown = indexes.slice(0, MAX_LISTED_STEPS).join(", ");
      const more =
        indexes.length > MAX_LISTED_STEPS ? ` and ${indexes.length - MAX_LISTED_STEPS} more` : "";
      return `${indexes.length === 1 ? "step" : "steps"} ${shown}${more}: ${STEP_WORDS[reason] ?? "not allowed"}`;
    })
    .join("; ");
}

/** How one variant version applied in the person's browser, as a sentence's tail. */
export function applyReportText(report: {
  steps: number;
  applied: number;
  refused: readonly RefusedStep[];
  rootMissing?: boolean;
}): string {
  if (report.rootMissing) return "the block wasn't on the page, so nothing was applied.";
  if (report.refused.length === 0) return `all ${plural(report.steps, "step")} applied.`;
  const none = report.applied === 0 ? " Nothing applied, so it can't be picked." : "";
  return `${report.refused.length} of ${plural(report.steps, "step")} could not be applied (${stepList(report.refused)}).${none}`;
}

/** Why a capture holds no screenshot, or what it could not keep, said to an agent. */
export const RESIDUE_WORDS: Record<ResidueClass, string> = {
  "closed-shadow-root": "part of the block is a closed component onlay can't read",
  "shadow-scoped-rules": "a component's internal styles weren't captured",
  "declined-grant": "onlay wasn't allowed to read some of the page's styles",
  "security-error": "the browser refused part of the capture",
  "stripped-url": "some addresses were removed",
  "unfetchable-asset": "an image or font couldn't be fetched",
  "generated-content-lost": "a generated marker or counter couldn't be kept",
  "quiescence-timeout": "the page was still changing when it was captured",
  "oversize-truncation": "the block was too large, so the capture was trimmed",
  "canvas-video-content": "canvas or video pixels can't be reconstructed",
  "cross-origin-frame": "another site's frame inside the block wasn't captured",
  "flat-raster": "the screenshot came back blank",
  "screenshot-covered": "no screenshot: something on the page covered the block",
  "screenshot-see-through": "no screenshot: the block's frame is transparent",
  "screenshot-foreign-frame": "no screenshot: another site's frame was in the way",
  "screenshot-page-changed":
    "no screenshot: the page changed while it was being taken (a very tall block is taken in parts while the page scrolls, and a moving page spoils it)",
  "screenshot-unplaced": "no screenshot: onlay couldn't find the block's frame on the page",
  "screenshot-transformed": "no screenshot: the block's frame is rotated or skewed",
  "screenshot-scaled": "no screenshot: the block's frame is shrunk or stretched",
  "screenshot-inner-frame": "no screenshot: the block is inside a frame with no address of its own",
};
