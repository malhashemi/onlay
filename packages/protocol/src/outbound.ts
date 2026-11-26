/**
 * Outbound frames: server → extension.
 *
 * Control frames are unsequenced. Work frames carry a per-session monotonic
 * `seq` and MUST be acked by the extension — the MV3 service-worker socket
 * churns constantly (Prototype 0: ~33 reconnects/5min), so agent→browser
 * pushes queue server-side and flush on reconnect from the hello's
 * `lastAckSeq`.
 */
import * as z from "zod/mini";
import { ActorSchema } from "./actor";
import {
  AgentWorkStatusSchema,
  InteractionKindSchema,
  InteractionSnapshotSchema,
  StakesSchema,
} from "./interaction";
import { LIMITS } from "./limits";
import { bounded, count } from "./schema-helpers";
import { PersonSummarySchema, SpaceSummarySchema } from "./space";
import { KeptEditSchema, PageMutationProgramSchema, VARIANT_ROOT_KINDS } from "./variant";

export const PongSchema = z.object({
  v: z.literal(1),
  type: z.literal("pong"),
  t: z.number(),
});
export type Pong = z.infer<typeof PongSchema>;

export const WelcomeSchema = z.object({
  v: z.literal(1),
  type: z.literal("welcome"),
  sessionId: z.uuid(),
  /** The ack watermark the server resumed this connection from. */
  resumedFromSeq: count(),
  serverTime: z.number(),
  /** The Actor this socket's token pairs to (absent on legacy tokens). */
  actor: z.optional(ActorSchema),
  /** Interactions waiting on this socket's Actor — badge truth on (re)connect. */
  needsYouCount: z.optional(count()),
  /** The signed-in person this socket speaks for (hosted, spec §7.1). */
  person: z.optional(PersonSummarySchema),
  /** The space this socket belongs to, with the caller's role there (hosted, spec §7.1). */
  space: z.optional(SpaceSummarySchema),
});
export type Welcome = z.infer<typeof WelcomeSchema>;

/**
 * Identity changed server-side (e.g. an actor was renamed). Unsequenced nudge
 * telling every connected client to re-pull the actor directory so names /
 * initials refresh in-place (interactions-state renders reference actor ids).
 */
export const DirectoryUpdatedSchema = z.object({
  v: z.literal(1),
  type: z.literal("directory-updated"),
});
export type DirectoryUpdated = z.infer<typeof DirectoryUpdatedSchema>;

export const HighlightSchema = z.object({
  v: z.literal(1),
  type: z.literal("highlight"),
  seq: count(),
  selector: bounded(LIMITS.MAX_SELECTOR),
  color: bounded(LIMITS.MAX_COLOR),
  tabId: z.optional(z.number()),
});
export type Highlight = z.infer<typeof HighlightSchema>;

export const CommandSchema = z.object({
  v: z.literal(1),
  type: z.literal("command"),
  seq: count(),
  text: bounded(LIMITS.MAX_COMMAND_TEXT),
});
export type Command = z.infer<typeof CommandSchema>;

// ---- interactions (comment · ask · change) ----

/**
 * Receipt for an inbound interaction mutation — answers and resolutions are
 * consequential; a silently-rejected one is unacceptable UX for a gate.
 * Connection-scoped and unsequenced (like pong/welcome): NOT journaled, NOT
 * acked. If the socket drops before it lands, the overlay stays pending and
 * the human retries — idempotent reducers make retry safe.
 */
export const InteractionReceiptSchema = z.object({
  v: z.literal(1),
  type: z.literal("interaction-receipt"),
  /** Echoes `interaction-create.nonce` (creation has no id yet). */
  nonce: z.optional(bounded(LIMITS.MAX_VARIANT_SET_ID)),
  /** Echoes the frame's `clientId` (replies): only the tab that sent it settles on it. */
  clientId: z.optional(bounded(LIMITS.MAX_VARIANT_SET_ID)),
  interactionId: z.optional(z.uuid()),
  kind: z.enum([
    "create",
    "reply",
    "edit",
    "delete",
    "react",
    "resolve",
    "reopen",
    "answer",
    "anchor",
    "reanchor",
    "batch",
  ]),
  ok: z.boolean(),
  reason: z.optional(bounded(LIMITS.MAX_TAG)),
  message: z.optional(bounded(LIMITS.MAX_TITLE)),
});
export type InteractionReceipt = z.infer<typeof InteractionReceiptSchema>;

/**
 * Full interaction snapshot set for one page URL — the overlay's ONLY state
 * source (state-sync model: pushed on every change and in answer to
 * `interaction-sync`; the overlay never accumulates, it re-renders).
 * Broadcast to all sockets; overlays filter by prefix-match against their
 * frame URL. Unsequenced: a lost frame heals on the next sync.
 */
export const InteractionsStateSchema = z.object({
  v: z.literal(1),
  type: z.literal("interactions-state"),
  url: bounded(LIMITS.MAX_URL),
  interactions: z
    .array(InteractionSnapshotSchema)
    .check(z.maxLength(LIMITS.MAX_INTERACTIONS_PER_STATE)),
  /** True when oldest resolved interactions were dropped to fit the budget. */
  truncated: z.optional(z.boolean()),
  /**
   * Kept Edits dropped to fit the frame: fetch each with
   * `GET /interaction/:id` (its `kept` entry).
   */
  keptOmitted: z.optional(z.array(z.uuid()).check(z.maxLength(LIMITS.MAX_INTERACTIONS_PER_STATE))),
  /** The page's kept Edits, each a program the viewer may toggle (spec §8). */
  kept: z.optional(z.array(KeptEditSchema).check(z.maxLength(LIMITS.MAX_INTERACTIONS_PER_STATE))),
});
export type InteractionsStateFrame = z.infer<typeof InteractionsStateSchema>;

/** One row of an Actor's attention debt (ADR-0006). */
/** Why a row is in a person's attention (the kernel's reasons). */
export const ATTENTION_BECAUSE = [
  "waiting-on",
  "mentioned",
  "thread-reply",
  "verify",
  "agent-answered",
  "shared",
  "waiting-on-agent",
] as const;
export type AttentionBecause = (typeof ATTENTION_BECAUSE)[number];

export const AttentionRowSchema = z.object({
  interactionId: z.uuid(),
  kind: InteractionKindSchema,
  state: bounded(LIMITS.MAX_TAG),
  url: z.optional(bounded(LIMITS.MAX_URL)),
  /** The page the person shares, when the block is inside a frame of it (see the snapshot). */
  hostUrl: z.optional(bounded(LIMITS.MAX_URL)),
  unanchored: z.optional(z.boolean()),
  anchorLost: z.optional(z.boolean()),
  stakes: z.optional(StakesSchema),
  /** Human-readable anchor ("§decision-matrix", "hero CTA", "page-level"). */
  anchorLabel: bounded(LIMITS.MAX_ANCHOR_LABEL),
  /** One-line summary (question / intent / first words). */
  text: bounded(LIMITS.MAX_ANCHOR_LABEL),
  fromActorId: bounded(LIMITS.MAX_ACTOR_ID),
  waitingOnIds: z.array(bounded(LIMITS.MAX_ACTOR_ID)),
  ts: z.number(),
  /** The interaction's effective agent work status, when it has any (spec §7). */
  agentWork: z.optional(AgentWorkStatusSchema),
  /**
   * Why the row is in this list (`shared` for a thread just shared with a
   * guest). A plain tag, not a closed set, so a client that does not know a
   * newer reason simply shows none. `ATTENTION_BECAUSE` lists what the
   * server sends.
   */
  because: z.optional(bounded(LIMITS.MAX_TAG)),
});
export type AttentionRow = z.infer<typeof AttentionRowSchema>;

/**
 * The paired Actor's attention debt — server-absolute, personal, across
 * every page and agent. Badge truth = `needsYou.length`. Pushed on every
 * relevant change and in answer to `attention-sync`.
 */
export const AttentionSchema = z.object({
  v: z.literal(1),
  type: z.literal("attention"),
  /** The signed-in person this attention belongs to. */
  person: PersonSummarySchema,
  needsYou: z.array(AttentionRowSchema).check(z.maxLength(LIMITS.MAX_ATTENTION_ROWS)),
  waiting: z.array(AttentionRowSchema).check(z.maxLength(LIMITS.MAX_ATTENTION_ROWS)),
  recent: z.array(AttentionRowSchema).check(z.maxLength(LIMITS.MAX_ATTENTION_ROWS)),
  /** The full needs-you count (the rows are capped), as in `welcome`; the badge reads this. */
  needsYouCount: z.optional(count()),
});
export type AttentionFrame = z.infer<typeof AttentionSchema>;

/**
 * Summon (vision tenet #2 — attention management): an interaction needs the
 * human. The SW raises an OS notification; stakes decide loudness (dangerous
 * always notifies). The badge itself rides `attention`, never this frame.
 */
export const NotifySchema = z.object({
  v: z.literal(1),
  type: z.literal("notify"),
  interactionId: z.uuid(),
  kind: InteractionKindSchema,
  title: bounded(LIMITS.MAX_TITLE),
  body: bounded(LIMITS.MAX_ANCHOR_LABEL),
  url: z.optional(bounded(LIMITS.MAX_URL)),
  stakes: z.optional(StakesSchema),
});
export type Notify = z.infer<typeof NotifySchema>;

// ---- view mode: variant-set outbound frames ----

/** One variant inside a `variant-state` snapshot; `version` tune-bumps in place. */
export const VariantSchema = z.object({
  variantId: bounded(LIMITS.MAX_VARIANT_SET_ID),
  label: bounded(LIMITS.MAX_VARIANT_LABEL),
  /** Up to MAX_MUTATION_OPS_PAGE ops; a block-root set's variants stay within MAX_MUTATION_OPS. */
  program: PageMutationProgramSchema,
  version: count(),
  /** Posted by an agent through MCP. */
  agent: z.optional(z.boolean()),
  /** Who wrote it: the person (for an agent's variant, the person it acts as). */
  by: z.optional(bounded(LIMITS.MAX_ACTOR_ID)),
});
export type VariantWire = z.infer<typeof VariantSchema>;

/**
 * Full variant-set snapshot — the overlay's ONLY state source (state-sync
 * model, mirroring `interactions-state`). Broadcast and filtered by setId;
 * oldest variants truncate first under the outbound cap. `nonce` echoes
 * `VariantCreate.nonce` on the first push so a page-created set correlates.
 */
export const VariantStateSchema = z.object({
  v: z.literal(1),
  type: z.literal("variant-state"),
  setId: bounded(LIMITS.MAX_VARIANT_SET_ID),
  nonce: z.optional(bounded(LIMITS.MAX_VARIANT_SET_ID)),
  status: z.enum(["generating", "previewing", "implementing", "verifying", "resolved"]),
  outcome: z.optional(z.enum(["picked", "discarded", "stale"])),
  /** The picked element's selector — the preview engine's resolution root. Absent only on pre-root-capture sets (legacy document-wide resolution). */
  selector: z.optional(bounded(LIMITS.MAX_SELECTOR)),
  /** `page` resolves `:scope` to `document.body`; absent = block. */
  rootKind: z.optional(z.enum(VARIANT_ROOT_KINDS)),
  variants: z.array(VariantSchema).check(z.maxLength(LIMITS.MAX_VARIANTS_PER_SET)),
  activeIndex: z.optional(count()),
  /** The Change interaction this set is the method of (ADR-0004). */
  changeInteractionId: z.optional(z.uuid()),
  truncated: z.optional(z.boolean()),
});
export type VariantStateFrame = z.infer<typeof VariantStateSchema>;

/** Unsequenced receipt for an inbound variant frame (incl. the sanitization-rejection kind). */
export const VariantReceiptSchema = z.object({
  v: z.literal(1),
  type: z.literal("variant-receipt"),
  setId: bounded(LIMITS.MAX_VARIANT_SET_ID),
  kind: z.enum(["create", "cycle", "pick", "discard", "tune", "steer", "manual"]),
  ok: z.boolean(),
  reason: z.optional(bounded(LIMITS.MAX_TAG)), // incl. "sanitization-rejected", "url-mismatch", "stale"
});
export type VariantReceipt = z.infer<typeof VariantReceiptSchema>;

// ---- hosted service ----

/**
 * The origins that have live anchored interactions in this socket's space,
 * pushed whenever the set changes. The service worker relays a page's sync to
 * a space only when the page's origin is in that space's set (spec §7, §10).
 */
export const OriginsSchema = z.object({
  v: z.literal(1),
  type: z.literal("origins"),
  origins: z
    .array(bounded(LIMITS.MAX_RESIDUE_ORIGIN))
    .check(z.maxLength(LIMITS.MAX_INTERACTIONS_PER_STATE)),
});
export type OriginsFrame = z.infer<typeof OriginsSchema>;

/**
 * Something the socket may see changed; the web app refetches. Carries no
 * payload by design: the tick says when, never what.
 */
export const TickSchema = z.object({
  v: z.literal(1),
  type: z.literal("tick"),
});
export type Tick = z.infer<typeof TickSchema>;

/**
 * This socket's access in the space just shrank (a share was removed, a role
 * changed): re-sync everything for the space and drop what the new snapshots
 * no longer carry. Payload-less by design.
 */
export const AccessChangedSchema = z.object({
  v: z.literal(1),
  type: z.literal("access-changed"),
});
export type AccessChangedFrame = z.infer<typeof AccessChangedSchema>;

export const OutboundSchema = z.discriminatedUnion("type", [
  PongSchema,
  WelcomeSchema,
  DirectoryUpdatedSchema,
  InteractionReceiptSchema,
  InteractionsStateSchema,
  AttentionSchema,
  NotifySchema,
  VariantStateSchema,
  VariantReceiptSchema,
  OriginsSchema,
  TickSchema,
  AccessChangedSchema,
]);

/** Unsequenced connection-scoped frames. */
export type Control =
  | Pong
  | Welcome
  | DirectoryUpdated
  | InteractionReceipt
  | InteractionsStateFrame
  | AttentionFrame
  | Notify
  | VariantStateFrame
  | VariantReceipt
  | OriginsFrame
  | Tick
  | AccessChangedFrame;
/**
 * Sequenced work frames: no longer sent (the hosted server has no work queue)
 * and out of `OutboundSchema`; the type stays for decoding stored session
 * journals written before.
 */
export type Work = Highlight | Command;
/** Every frame the hosted server sends. */
export type Outbound = Control;

/** A work frame before the session assigned its `seq` (stored session journals only). */
export type WorkInput = Omit<Highlight, "seq"> | Omit<Command, "seq">;
