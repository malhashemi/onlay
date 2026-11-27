/**
 * The closed set of reasons a step of a mutation program was not applied,
 * shared by the preview engine, the space's program check, the outcome a
 * person's browser reports and what an agent reads. Never free text.
 */
import * as z from "zod/mini";

export const STEP_REFUSAL_REASONS = [
  /** `setText`, or a `replace` insert, aimed at a page root's body. */
  "page-root-text",
  "page-root-replace",
  /** Past the root's op budget. */
  "over-budget",
  /** A resource URL from an origin the page does not already load from. */
  "url-origin",
  /** A link or resource URL with a scheme the policy does not allow. */
  "url-scheme",
  /** A style value that loads, scripts or imports something the policy refuses. */
  "style-value",
  /** A style property name outside the plain CSS grammar. */
  "style-property",
  /** Text or markup aimed into a raw-text, embedding or head element. */
  "text-target",
  /** An attribute no program may set (event handlers, `style`, `srcdoc`…), or one the engine owns. */
  "attr-denied",
  /** An attribute the engine never sets on that element (outside its allowlist, or an unsafe URL). */
  "attr-rejected",
  /** A class name that is empty or holds whitespace. */
  "class-name",
  /** The step's selector matches nothing in the block (or in what earlier steps inserted). */
  "target-missing",
  /** The target can't take this step (a style or a replace on an element that isn't HTML). */
  "target-kind",
  /** A fragment with nothing in it that shows once sanitized. */
  "fragment-empty",
  /** A fragment made only of tags the engine never inserts. */
  "fragment-disallowed",
] as const;
export type StepRefusalReason = (typeof STEP_REFUSAL_REASONS)[number];
export const StepRefusalReasonSchema = z.enum(STEP_REFUSAL_REASONS);
