/**
 * Plain words an agent reads for the closed sets onlay reports: why a step of
 * a variant was not applied (`StepRefusalReason`) and what a capture could not
 * keep (`ResidueClass`). The server renders these from codes and integers
 * only, so nothing here is page text and none of it needs framing.
 * (Copy pass pending: keep each easy to replace.)
 */
import type { RefusedStep, ResidueClass, StepRefusalReason } from "@onlay/protocol";
import { plural } from "./result";

const STEP_WORDS: Record<StepRefusalReason, string> = {
  "target-missing": "selector matched nothing in the root",
  "target-kind": "target isn't an HTML node (can't take styles or replace)",
  "fragment-empty":
    "fragment inserts nothing visible (needs text, img, br or hr; empty tags show nothing)",
  "fragment-disallowed":
    "fragment uses only disallowed tags (such as forms, inputs, frames, scripts or styles)",
  "attr-rejected": "attribute not allowed on that tag, or disallowed URL scheme",
  "attr-denied":
    "forbidden attribute (on*, style, srcdoc, etc.) or one onlay manages (button type, link rel/referrerpolicy/ping)",
  "class-name": "empty class name or one with whitespace (pass one class per entry)",
  "url-origin": "resource URL from an origin the page doesn't already load from",
  "url-scheme":
    "disallowed URL scheme (links allow http, https, mailto, tel; resources allow http, https)",
  "style-value":
    "disallowed style value (such as url() from another origin, expression() or @import)",
  "style-property": "disallowed style property (custom properties aren't allowed)",
  "text-target":
    "text or markup aimed into a raw-text, embedding or head tag (such as script, style or head)",
  "page-root-text":
    "can't use setText on :scope for a page-root variant; target something inside the page",
  "page-root-replace":
    "can't replace :scope on a page-root variant; target something inside the page",
  "over-budget": "past the step limit (64 for a block, 256 for a page)",
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

/** How one variant version applied (against the captured copy of its block), as a sentence's tail. */
export function applyReportText(report: {
  steps: number;
  applied: number;
  refused: readonly RefusedStep[];
  rootMissing?: boolean;
}): string {
  if (report.rootMissing) return "the block wasn't on the page, so nothing was applied.";
  if (report.refused.length === 0)
    return report.steps === 1 ? "1 step applied." : `all ${report.steps} steps applied.`;
  const none = report.applied === 0 ? " Nothing applied, so it can't be picked." : "";
  const head =
    report.steps === 1
      ? "1 step couldn't be applied"
      : `${report.refused.length} of ${report.steps} steps couldn't be applied`;
  return `${head} (${stepList(report.refused)}).${none}`;
}

/** Why a capture holds no screenshot, or what it could not keep, said to an agent. */
export const RESIDUE_WORDS: Record<ResidueClass, string> = {
  "closed-shadow-root": "part of the block is a closed component onlay can't read",
  "shadow-scoped-rules": "a component's internal styles weren't captured",
  "declined-grant": "onlay wasn't allowed to read some of the page's styles",
  "security-error": "the browser refused part of the capture",
  "stripped-url": "some URLs were stripped",
  "unfetchable-asset": "an image or font couldn't be fetched",
  "generated-content-lost": "a generated marker or counter couldn't be kept",
  "quiescence-timeout": "the page was still changing when it was captured",
  "oversize-truncation": "the block was too large, so the capture was trimmed",
  "canvas-video-content": "canvas or video pixels can't be reconstructed",
  "cross-origin-frame": "another site's frame inside the block wasn't captured",
  "flat-raster": "the screenshot came back blank",
  "screenshot-covered": "no screenshot because something on the page covered the block",
  "screenshot-see-through": "no screenshot because the block's frame is transparent",
  "screenshot-foreign-frame": "no screenshot because another site's frame was in the way",
  "screenshot-page-changed":
    "no screenshot because the page changed during capture (tall blocks are captured in scrolled parts, so movement spoils it)",
  "screenshot-unplaced": "no screenshot because onlay couldn't find the block's frame on the page",
  "screenshot-transformed": "no screenshot because the block's frame is rotated or skewed",
  "screenshot-scaled": "no screenshot because the block's frame is shrunk or stretched",
  "screenshot-inner-frame":
    "no screenshot because the block is inside a frame with no address of its own",
};
