/**
 * Variant-set vocabulary — the view-mode vertical's primitives. A variant set
 * is the server-owned unit of view-mode state: a picked element + a free-text
 * command yields up to N variants, each a **mutation program** the overlay
 * cycles as an indicative preview (vision §view-mode; CONTEXT.md "Variant set").
 *
 * Every page-derived string field is re-typed `UntrustedText` on a paired
 * branded interface. The mutation program is the
 * one genuinely new, nested, non-string payload shape view-mode adds — it is
 * validated op-by-op under the `// ---- view mode ----` LIMITS block so a
 * fragment payload fits the outbound cap without loosening the inbound cap.
 */
import * as z from "zod/mini";
import { LIMITS } from "./limits";
import { bounded, count } from "./schema-helpers";
import { StepRefusalReasonSchema } from "./step-refusal";
import type { UntrustedText } from "./untrusted";

// ---- mutation program: the one genuinely new (nested) payload shape ----
export const MUTATION_OPS = [
  "setStyle",
  "setClass",
  "setAttr",
  "setText",
  "insertFragment",
] as const;
export const INSERT_POSITIONS = ["before", "after", "prepend", "append", "replace"] as const;

// A target is a selector resolved relative to the picked element (the set's
// root): ":scope" IS the picked element; any other selector matches the root
// itself or a descendant — plus nodes the program itself inserted (which may
// sit beside the root after a before/after/replace insertFragment). Document-
// wide resolution exists only as the legacy fallback for sets that predate
// root capture. Resolution is single-match (querySelector semantics): one op
// touches ONE element — programs must emit one op per element (unique ids or
// :nth-child()) to style repeated structures.
const target = () => bounded(LIMITS.MAX_SELECTOR);

export const StylePropSchema = z.object({
  prop: bounded(LIMITS.MAX_CSS_PROP),
  value: bounded(LIMITS.MAX_CSS_VALUE),
});
export const SetStyleOpSchema = z.object({
  op: z.literal("setStyle"),
  target: target(),
  props: z.array(StylePropSchema).check(z.maxLength(LIMITS.MAX_STYLE_PROPS)),
});
export const SetClassOpSchema = z.object({
  op: z.literal("setClass"),
  target: target(),
  add: z.array(bounded(LIMITS.MAX_CLASS_LEN)).check(z.maxLength(LIMITS.MAX_CLASSES)),
  remove: z.array(bounded(LIMITS.MAX_CLASS_LEN)).check(z.maxLength(LIMITS.MAX_CLASSES)),
});
export const SetAttrOpSchema = z.object({
  op: z.literal("setAttr"),
  target: target(),
  name: bounded(LIMITS.MAX_TAG),
  value: z.nullable(bounded(LIMITS.MAX_ATTR_VALUE)), // null = remove
});
export const SetTextOpSchema = z.object({
  op: z.literal("setText"),
  target: target(),
  text: bounded(LIMITS.MAX_MUTATION_TEXT),
});
export const InsertFragmentOpSchema = z.object({
  op: z.literal("insertFragment"),
  target: target(),
  position: z.enum(INSERT_POSITIONS),
  html: bounded(LIMITS.MAX_FRAGMENT_CHARS), // sanitized in the engine, never innerHTML'd raw
});
export const MutationOpSchema = z.discriminatedUnion("op", [
  SetStyleOpSchema,
  SetClassOpSchema,
  SetAttrOpSchema,
  SetTextOpSchema,
  InsertFragmentOpSchema,
]);
export const MutationProgramSchema = z
  .array(MutationOpSchema)
  .check(z.maxLength(LIMITS.MAX_MUTATION_OPS));
export type MutationOp = z.infer<typeof MutationOpSchema>;
export type MutationProgram = z.infer<typeof MutationProgramSchema>;

/**
 * A program whose root is the whole page (spec §8): same ops, a larger
 * budget. The engine resolves `:scope` to `document.body` for a page root
 * and refuses `setText` or a `replace` insert aimed at `:scope`.
 */
export const PageMutationProgramSchema = z
  .array(MutationOpSchema)
  .check(z.maxLength(LIMITS.MAX_MUTATION_OPS_PAGE));

/**
 * A program's size as the space measures it against `MAX_PROGRAM_BYTES` and
 * `MAX_SET_PROGRAM_BYTES`: the UTF-8 bytes of its serialized JSON.
 */
export function programBytes(program: MutationProgram): number {
  return utf8Bytes(JSON.stringify(program));
}

/** UTF-8 length of a string, without an encoder (this package runs in every runtime). */
function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

// ---- element context captured at pick (page → server → agent) ----
export const ElementContextSchema = z.object({
  selector: bounded(LIMITS.MAX_SELECTOR),
  tag: bounded(LIMITS.MAX_TAG),
  classes: z.array(bounded(LIMITS.MAX_CLASS_LEN)).check(z.maxLength(LIMITS.MAX_CLASSES)),
  textSnippet: bounded(LIMITS.MAX_TEXT_SNIPPET),
  markup: bounded(LIMITS.MAX_ELEMENT_MARKUP),
  sourcePointer: z.optional(bounded(LIMITS.MAX_SOURCE_POINTER)), // data-onlay-source when stamped
});
type RawElementContext = z.infer<typeof ElementContextSchema>;
/** Plain-string element context (kernel/state shape; branding is an edge concern). */
export type ElementContext = RawElementContext;

// ---- variant root: one block, or the whole page (spec §8) ----
export const VARIANT_ROOT_KINDS = ["block", "page"] as const;
export type VariantRootKind = (typeof VARIANT_ROOT_KINDS)[number];

export const VariantRootSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("block"), element: ElementContextSchema }),
  z.object({ kind: z.literal("page") }),
]);
export type VariantRoot = z.infer<typeof VariantRootSchema>;

/** The op budget of a program applied at this root. */
export function maxOpsFor(root: VariantRoot | VariantRootKind): number {
  const kind = typeof root === "string" ? root : root.kind;
  return kind === "page" ? LIMITS.MAX_MUTATION_OPS_PAGE : LIMITS.MAX_MUTATION_OPS;
}

/**
 * One kept Edit on a page (spec §8): its program stays applied as a preview,
 * on by default for the person named in `by`. Rides the page snapshot.
 */
export const KeptEditSchema = z.object({
  interactionId: z.uuid(),
  /** The variant set the program was picked from; absent for a hand-made batch. */
  setId: z.optional(bounded(LIMITS.MAX_VARIANT_SET_ID)),
  /** The picked variant (absent for a hand-made batch). */
  variantId: z.optional(bounded(LIMITS.MAX_VARIANT_SET_ID)),
  /**
   * The version of that variant that was picked (absent for a hand-made
   * batch). A viewer's choice to show the edit is keyed to (interactionId,
   * variantId, version), so a later pick resets it.
   */
  version: z.optional(z.number().check(z.int(), z.gte(1))),
  root: VariantRootSchema,
  program: PageMutationProgramSchema,
  /** Who picked it (or sent the batch). */
  by: bounded(LIMITS.MAX_ACTOR_ID),
  /** When it was kept; kept programs apply in `at` order. */
  at: z.number(),
  label: bounded(LIMITS.MAX_VARIANT_LABEL),
});
export type KeptEdit = z.infer<typeof KeptEditSchema>;

// The human's intent lane: "change" mutates the picked element; "insert-after"
// anchors NEW content beside it (variants should be insertFragment at ":scope",
// position "after"). A distinct UI flow, not a command-prefix convention.
export const VARIANT_INTENTS = ["change", "insert-after"] as const;
export type VariantIntent = (typeof VARIANT_INTENTS)[number];

// ---- inbound frames (page → server) ----
// CREATION (structural addition — see structure §Plan 1): server mints setId,
// the client correlates via `nonce` echoed in the first variant-state.
export const VariantCreateSchema = z.object({
  v: z.literal(1),
  type: z.literal("variant-create"),
  nonce: bounded(LIMITS.MAX_VARIANT_SET_ID), // client correlation token
  frameUrl: bounded(LIMITS.MAX_URL),
  /**
   * The page the person shares when the block is inside a frame of it: the
   * tab's top URL, stamped by the service worker (as on `interaction-create`).
   */
  hostUrl: z.optional(bounded(LIMITS.MAX_URL)),
  /**
   * The set's root (spec §8). Required on the wire; the legacy element-only
   * form survives only in stored sets and journals (the kernel decodes it).
   */
  root: VariantRootSchema,
  /** A page edit's document provenance stamp; with it the page owns its source. */
  provenance: z.optional(bounded(LIMITS.MAX_PROVENANCE)),
  command: bounded(LIMITS.MAX_COMMAND_INTENT),
  count: z.number().check(z.gte(1), z.lte(LIMITS.MAX_VARIANTS_PER_SET)),
  intent: z.optional(z.enum(VARIANT_INTENTS)), // absent = "change"
  manual: z.optional(MutationProgramSchema), // present = manual-edit single-variant set (skips generate)
});
type RawVariantCreate = z.infer<typeof VariantCreateSchema>;

// The shared { v, setId, frameUrl } head for every post-creation inbound frame.
// Composed via object-spread (the codebase idiom) rather than z.extend so the
// discriminant `type` stays a first-class own-property of each frame schema.
const setRefShape = () => ({
  v: z.literal(1),
  setId: bounded(LIMITS.MAX_VARIANT_SET_ID),
  frameUrl: bounded(LIMITS.MAX_URL),
});
export const VariantCycleSchema = z.object({
  ...setRefShape(),
  type: z.literal("variant-cycle"),
  index: count(),
});
/**
 * A pick names the variant the person previewed by its id and the version
 * they saw; the space refuses it (`variant-changed`) when either no longer
 * matches. `index` is a hint only and must agree when present.
 */
export const VariantPickSchema = z.object({
  ...setRefShape(),
  type: z.literal("variant-pick"),
  variantId: bounded(LIMITS.MAX_VARIANT_SET_ID),
  version: z.number().check(z.int(), z.gte(1)),
  index: z.optional(count()),
});
/** `POST /variant-set/:setId/pick`: the same identity as the `variant-pick` frame. */
export const VariantPickRequestSchema = z.object({
  variantId: bounded(LIMITS.MAX_VARIANT_SET_ID),
  version: z.number().check(z.int(), z.gte(1)),
  index: z.optional(count()),
});
export type VariantPickRequest = z.infer<typeof VariantPickRequestSchema>;
export const VariantDiscardSchema = z.object({
  ...setRefShape(),
  type: z.literal("variant-discard"),
});
export const VariantTuneSchema = z.object({
  ...setRefShape(),
  type: z.literal("variant-tune"),
  index: count(),
  instruction: bounded(LIMITS.MAX_COMMAND_INTENT),
});
export const VariantSteerSchema = z.object({
  ...setRefShape(),
  type: z.literal("variant-steer"),
  instruction: bounded(LIMITS.MAX_COMMAND_INTENT),
});
export const VariantSyncSchema = z.object({
  ...setRefShape(),
  type: z.literal("variant-sync"),
});

/** One step the engine left out, by its index in the program and why (closed set). */
export const RefusedStepSchema = z.object({
  index: z.number().check(z.int(), z.gte(0), z.lt(LIMITS.MAX_MUTATION_OPS_PAGE)),
  reason: StepRefusalReasonSchema,
});
export type RefusedStep = z.infer<typeof RefusedStepSchema>;

/**
 * How a variant applied in the Edit author's own browser (fire-and-report):
 * how many of its steps landed and which were left out, by index and reason,
 * or that its root block was not on the page. Integers and the closed reason
 * set only, never text from the page. Sent once per variant version, only for
 * a variant written by the author or their agent; the space keeps the first.
 */
export const VariantOutcomeSchema = z.object({
  ...setRefShape(),
  type: z.literal("variant-outcome"),
  variantId: bounded(LIMITS.MAX_VARIANT_SET_ID),
  version: z.number().check(z.int(), z.gte(1)),
  /** The program's length as the browser applied it. */
  steps: z.number().check(z.int(), z.gte(0), z.lte(LIMITS.MAX_MUTATION_OPS_PAGE)),
  applied: z.number().check(z.int(), z.gte(0), z.lte(LIMITS.MAX_MUTATION_OPS_PAGE)),
  refused: z.array(RefusedStepSchema).check(z.maxLength(LIMITS.MAX_MUTATION_OPS_PAGE)),
  /** The set's root block was not on the page: nothing was tried. */
  rootMissing: z.optional(z.literal(true)),
});

type RawVariantCycle = z.infer<typeof VariantCycleSchema>;
type RawVariantPick = z.infer<typeof VariantPickSchema>;
type RawVariantDiscard = z.infer<typeof VariantDiscardSchema>;
type RawVariantTune = z.infer<typeof VariantTuneSchema>;
type RawVariantSteer = z.infer<typeof VariantSteerSchema>;
type RawVariantSync = z.infer<typeof VariantSyncSchema>;
type RawVariantOutcome = z.infer<typeof VariantOutcomeSchema>;

// ---- branded parsed views (page-derived fields → UntrustedText) ----
export interface BrandedElementContext
  extends Omit<
    RawElementContext,
    "selector" | "tag" | "classes" | "textSnippet" | "markup" | "sourcePointer"
  > {
  selector: UntrustedText;
  tag: UntrustedText;
  classes: UntrustedText[];
  textSnippet: UntrustedText;
  markup: UntrustedText;
  sourcePointer?: UntrustedText;
}
export type BrandedVariantRoot =
  | { kind: "block"; element: BrandedElementContext }
  | { kind: "page" };
export interface VariantCreate
  extends Omit<RawVariantCreate, "frameUrl" | "hostUrl" | "root" | "command" | "provenance"> {
  frameUrl: UntrustedText;
  hostUrl?: UntrustedText;
  root: BrandedVariantRoot;
  provenance?: UntrustedText;
  command: UntrustedText;
}
export interface VariantCycle extends Omit<RawVariantCycle, "frameUrl"> {
  frameUrl: UntrustedText;
}
export interface VariantPick extends Omit<RawVariantPick, "frameUrl"> {
  frameUrl: UntrustedText;
}
export interface VariantDiscard extends Omit<RawVariantDiscard, "frameUrl"> {
  frameUrl: UntrustedText;
}
export interface VariantTune extends Omit<RawVariantTune, "frameUrl" | "instruction"> {
  frameUrl: UntrustedText;
  instruction: UntrustedText;
}
export interface VariantSteer extends Omit<RawVariantSteer, "frameUrl" | "instruction"> {
  frameUrl: UntrustedText;
  instruction: UntrustedText;
}
export interface VariantSync extends Omit<RawVariantSync, "frameUrl"> {
  frameUrl: UntrustedText;
}
export interface VariantOutcome extends Omit<RawVariantOutcome, "frameUrl"> {
  frameUrl: UntrustedText;
}

// ---- outbound frames (server → page): see outbound.ts additions ----
// ---- agent events (server → agent): see agent-events.ts additions ----
