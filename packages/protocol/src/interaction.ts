/**
 * Interactions — the membrane's core (ADR-0001).
 *
 * onlay is an interaction anchored to a page element (or the page) by an
 * Actor. There are exactly three anchored interactions: Comment, Ask, Change.
 * A variant set is a method inside a Change; a record is a promotion out of
 * the membrane.
 *
 * Interactions have STATE (the membrane's business — render, count, route,
 * enable); only artifacts have STATUS (their own world's lifecycle).
 *
 * Wire discipline matches the rest of the protocol: zod/mini schemas with
 * LIMITS bounds, `v: 1` inbound frames carrying `frameUrl` for the
 * URL-binding gate, and Raw/Branded duality — page-derived text is
 * `UntrustedText` on the branded views until `declassify`.
 */
import * as z from "zod/mini";
import { CaptureRefSchema } from "./capture";
import { LIMITS } from "./limits";
import { bounded, count } from "./schema-helpers";
import type { UntrustedText } from "./untrusted";
import { MutationProgramSchema } from "./variant";

export const INTERACTION_KINDS = ["comment", "ask", "change"] as const;
export const InteractionKindSchema = z.enum(INTERACTION_KINDS);
export type InteractionKind = (typeof INTERACTION_KINDS)[number];

/* ── the anchoring ladder (ADR-0005) ──────────────────────────────── */

/**
 * Where an anchored interaction lives: element → selection → page. Every rung
 * degrades gracefully to the one below; anchor loss DEMOTES a live
 * interaction to page-level (`anchorLost`), never drops it.
 */
/**
 * A block inside a frame that has no address of its own (`about:blank`,
 * `about:srcdoc`, a same-origin `blob:`) belongs to the nearest ancestor
 * document that has one (A-3). `framePath` is the selectors of the iframe
 * elements from that owner document down to the block's document, outermost
 * first; `selector` is then resolved inside the last one. Absent for a block
 * in the owner document itself. Clients that do not know it ignore it.
 */
const FramePathSchema = z
  .array(
    bounded(LIMITS.MAX_SELECTOR).check(
      z.minLength(1),
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
      z.regex(/^[^\u0000-\u001f\u007f]*$/),
    ),
  )
  .check(z.minLength(1), z.maxLength(LIMITS.MAX_FRAME_PATH));

const ElementAnchorSchema = z.object({
  level: z.literal("element"),
  selector: bounded(LIMITS.MAX_SELECTOR),
  framePath: z.optional(FramePathSchema),
  /** Block vocabulary: the data-onlay-block id, when present. */
  blockId: z.optional(bounded(LIMITS.MAX_ANCHOR_ID)),
  /** View-mode vocabulary: the data-onlay-source stamp, when present. */
  sourcePointer: z.optional(bounded(LIMITS.MAX_SOURCE_POINTER)),
  /**
   * Portable dev-stamp provenance joined from the document at pick time
   * (ADR-0017): one opaque `origin@sha;branch;dirty` string, parsed for
   * display only. Present only when a sourcePointer was captured.
   */
  provenance: z.optional(bounded(LIMITS.MAX_PROVENANCE)),
  snippet: z.optional(bounded(LIMITS.MAX_SNIPPET)),
});
const SelectionAnchorSchema = z.object({
  level: z.literal("selection"),
  selector: bounded(LIMITS.MAX_SELECTOR),
  framePath: z.optional(FramePathSchema),
  text: bounded(LIMITS.MAX_SNIPPET),
  snippet: z.optional(bounded(LIMITS.MAX_SNIPPET)),
});
const PageAnchorSchema = z.object({ level: z.literal("page") });

export const AnchoredAnchorSchema = z.discriminatedUnion("level", [
  ElementAnchorSchema,
  SelectionAnchorSchema,
  PageAnchorSchema,
]);
export type AnchoredAnchor = z.infer<typeof AnchoredAnchorSchema>;

/**
 * The rung above the ladder: no page, no URL, agent-initiated Asks only. A
 * human Anchor action moves it onto the anchored ladder.
 */
export const AnchorSchema = z.discriminatedUnion("level", [
  ElementAnchorSchema,
  SelectionAnchorSchema,
  PageAnchorSchema,
  z.object({ level: z.literal("unanchored") }),
]);
export type Anchor = z.infer<typeof AnchorSchema>;

/* ── universal tokens: @ actors · # anchors (ADR-0007) ────────────── */

/**
 * Typed tokens riding thread text — agents receive data, never prose to
 * parse. `@` mentions an Actor (notifies + adds a participant; a mentioned
 * agent wakes); `#` drops an anchor (element, selection, page, or an
 * existing interaction). Token ids are server-validated references; labels
 * stay untrusted text.
 */
/**
 * Where one pill's text sits in the message body: `start` and `length` in
 * UTF-16 code units. The editors send one per pill (a person mentioned twice
 * has two); the server keeps only spans that lie inside the text and hold the
 * token's `@`/`#` pill, and the agent rendering frames exactly those. A token
 * without spans (older messages) falls back to matching its text.
 */
export const PillSpanSchema = z.object({
  start: z.number().check(z.int(), z.gte(0), z.lte(LIMITS.MAX_COMMENT_TEXT)),
  length: z.number().check(z.int(), z.gte(1), z.lte(LIMITS.MAX_COMMENT_TEXT)),
});
export type PillSpan = z.infer<typeof PillSpanSchema>;

const pillSpans = () =>
  z.optional(z.array(PillSpanSchema).check(z.maxLength(LIMITS.MAX_TOKENS_PER_MSG)));

export const TokenSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("actor"),
    actorId: bounded(LIMITS.MAX_ACTOR_ID),
    spans: pillSpans(),
  }),
  /**
   * `@agent`: hands the interaction to an agent (spec §7). A member's message
   * carrying it makes the interaction's agent work pending; a guest's never does.
   */
  z.object({ t: z.literal("agent"), spans: pillSpans() }),
  z.object({
    t: z.literal("anchor"),
    anchor: AnchorSchema,
    label: bounded(LIMITS.MAX_ANCHOR_LABEL),
    interactionId: z.optional(z.uuid()),
    spans: pillSpans(),
  }),
]);
export type Token = z.infer<typeof TokenSchema>;

export const RichTextSchema = z.object({
  text: bounded(LIMITS.MAX_COMMENT_TEXT),
  tokens: z.optional(z.array(TokenSchema).check(z.maxLength(LIMITS.MAX_TOKENS_PER_MSG))),
});
export type RawRichText = z.infer<typeof RichTextSchema>;
export interface RichText extends Omit<RawRichText, "text"> {
  text: UntrustedText;
}

/* ── the ask payload: a routed choice (ADR-0003) ──────────────────── */

export const STAKES = ["routine", "careful", "dangerous"] as const;
export const StakesSchema = z.enum(STAKES);
export type Stakes = (typeof STAKES)[number];

export const RESOLVES_WHEN = ["any-one", "majority", "everyone"] as const;
export const ResolvesWhenSchema = z.enum(RESOLVES_WHEN);
export type ResolvesWhen = (typeof RESOLVES_WHEN)[number];

export const SUBMIT_MODES = ["immediate", "explicit"] as const;
export const ANSWER_COMMENT_MODES = ["off", "optional", "required"] as const;

export const AskOptionSchema = z.object({
  /** Stable id — what answering emits; button copy is free per ask. */
  id: bounded(LIMITS.MAX_OPTION_ID),
  label: bounded(LIMITS.MAX_OPTION_LABEL),
  description: z.optional(bounded(LIMITS.MAX_OPTION_DESC)),
  /** At most one option wears it; renders as the primary. */
  recommended: z.optional(z.boolean()),
});
export type AskOption = z.infer<typeof AskOptionSchema>;

export const AskSelectionSchema = z.object({
  min: count(),
  max: z.number().check(z.gte(1), z.lte(LIMITS.MAX_ASK_OPTIONS)),
  submit: z.enum(SUBMIT_MODES),
  /** When true, pick order IS the ranking. */
  ordered: z.optional(z.boolean()),
});
export type AskSelection = z.infer<typeof AskSelectionSchema>;

/**
 * The whole ask contract — no `type` field: permission, disambiguation,
 * voting, and ranking are all recipes over this one shape.
 * (Shape kept as a plain object so the snapshot can extend it by spread —
 * the codebase idiom that keeps discriminants first-class own-properties.)
 */
const askPayloadShape = () => ({
  question: bounded(LIMITS.MAX_QUESTION),
  /** Required markdown — why you're asking; whatever answers well. */
  context: bounded(LIMITS.MAX_ASK_CONTEXT),
  /** One-way dial; recipes force it UP, never self-declared down. */
  stakes: z.optional(StakesSchema),
  waitingOn: z
    .array(bounded(LIMITS.MAX_ACTOR_ID))
    .check(z.minLength(1), z.maxLength(LIMITS.MAX_ATTENTION_ROWS)),
  resolvesWhen: z.optional(ResolvesWhenSchema),
  selection: AskSelectionSchema,
  answerComment: z.optional(z.enum(ANSWER_COMMENT_MODES)),
  options: z.array(AskOptionSchema).check(z.minLength(1), z.maxLength(LIMITS.MAX_ASK_OPTIONS)),
});
export const AskPayloadSchema = z.object(askPayloadShape());
export type AskPayload = z.infer<typeof AskPayloadSchema>;

/** The semantic answer event — journaled; the control freezes into it. */
export const AskAnswerSchema = z.object({
  actorId: bounded(LIMITS.MAX_ACTOR_ID),
  optionIds: z.array(bounded(LIMITS.MAX_OPTION_ID)).check(z.maxLength(LIMITS.MAX_ASK_OPTIONS)),
  comment: z.optional(RichTextSchema),
  ts: z.number(),
});
export type AskAnswer = z.infer<typeof AskAnswerSchema>;

/* ── the change payload: intent owning the implementation loop (ADR-0004) ── */

export const CHANGE_METHODS = ["direct", "variant-set", "manual-batch"] as const;
export const ChangeMethodSchema = z.enum(CHANGE_METHODS);
export type ChangeMethod = (typeof CHANGE_METHODS)[number];

const changePayloadShape = () => ({
  intent: bounded(LIMITS.MAX_COMMAND_INTENT),
  /** Absent = direct; the server may infer variant-set from the gesture. */
  method: z.optional(ChangeMethodSchema),
  /** Absent = the server's default agent actor. */
  routesTo: z.optional(bounded(LIMITS.MAX_ACTOR_ID)),
  /**
   * The page's source is known (spec §8): the anchor carries a
   * `sourcePointer`, or a page edit's page carries a provenance stamp. A
   * picked variant then goes to an agent to implement instead of staying kept.
   */
  ownsSource: z.optional(z.boolean()),
  /** A page edit's document provenance stamp, sent at creation. */
  provenance: z.optional(bounded(LIMITS.MAX_PROVENANCE)),
});
export const ChangePayloadSchema = z.object(changePayloadShape());
export type ChangePayload = z.infer<typeof ChangePayloadSchema>;

/* ── states — the membrane's business, per kind ───────────────────── */

export const COMMENT_STATES = ["open", "resolved"] as const;
export const ASK_STATES = ["open", "answered", "resolved", "superseded", "dropped"] as const;
export const CHANGE_STATES = [
  "open",
  /** Live: the picked (or hand-made) program stays applied as a preview (spec §8). */
  "kept",
  "working",
  "implemented",
  "verifying",
  "resolved",
  "dropped",
] as const;
export type CommentState = (typeof COMMENT_STATES)[number];
export type AskState = (typeof ASK_STATES)[number];
export type ChangeState = (typeof CHANGE_STATES)[number];
export type InteractionStateName = CommentState | AskState | ChangeState;

/** States that still count on the badge and wear pins. */
export const LIVE_STATES = [
  "open",
  "answered",
  "kept",
  "working",
  "implemented",
  "verifying",
] as const;

/** The Edit states an agent may set through MCP (`set_edit_state`). */
export const AGENT_EDIT_STATES = ["working", "implemented"] as const;
export type AgentEditState = (typeof AGENT_EDIT_STATES)[number];

/* ── agent work (spec §7) ─────────────────────────────────────────── */

export const AGENT_WORK_STATUSES = ["pending", "taken", "answered"] as const;
export const AgentWorkStatusSchema = z.enum(AGENT_WORK_STATUSES);
export type AgentWorkStatus = (typeof AGENT_WORK_STATUSES)[number];

/**
 * The "for agent" state an interaction carries. `requestedBy` is the member
 * whose message, Edit, steer, tune, pick or batch asked for an agent. A take
 * holds a lease; an expired lease reads as pending. Ids and clocks are
 * server-trusted, never page-derived.
 */
export const AgentWorkSchema = z.object({
  status: AgentWorkStatusSchema,
  requestedBy: bounded(LIMITS.MAX_ACTOR_ID),
  requestedAt: z.number(),
  takenBy: z.optional(bounded(LIMITS.MAX_ACTOR_ID)),
  takenAt: z.optional(z.number()),
  leaseUntil: z.optional(z.number()),
  answeredAt: z.optional(z.number()),
});
export type AgentWork = z.infer<typeof AgentWorkSchema>;

/* ── thread messages ──────────────────────────────────────────────── */

/**
 * A reply-target reference (ADR-0018 §1). Only the msgId travels — quoted
 * context is DERIVED from the thread at render time, never duplicated into
 * the message (duplicated quotes bloat frames and rot on edit).
 */
export const ReplyToSchema = z.object({ msgId: bounded(LIMITS.MAX_ANCHOR_ID) });
export type ReplyTo = z.infer<typeof ReplyToSchema>;

export const ThreadMsgSchema = z.object({
  /** Monotonic per-interaction: m1, m2, … */
  msgId: bounded(LIMITS.MAX_ANCHOR_ID),
  authorId: bounded(LIMITS.MAX_ACTOR_ID),
  body: RichTextSchema,
  ts: z.number(),
  editedAt: z.optional(z.number()),
  /** Tombstone: body emptied, structure kept. */
  deleted: z.optional(z.boolean()),
  /** Runtime-authored state-transition note; no Actor can fake one. */
  system: z.optional(z.boolean()),
  /** emoji → actorIds; micro-signals, never state. */
  reactions: z.optional(z.record(bounded(LIMITS.MAX_EMOJI), z.array(bounded(LIMITS.MAX_ACTOR_ID)))),
  /** This message answers another in the same thread (ADR-0018 §1). */
  replyTo: z.optional(ReplyToSchema),
  /** Written by an agent through MCP; the author is still its person (spec §2). */
  agent: z.optional(z.boolean()),
  /**
   * The request id the author's client sent with it (`interaction-reply`
   * `clientId`): a repeat of that send answers with this message instead of
   * adding another. Server-side only; snapshots never carry it.
   */
  clientId: z.optional(bounded(LIMITS.MAX_VARIANT_SET_ID)),
});
export type RawThreadMsg = z.infer<typeof ThreadMsgSchema>;
export interface ThreadMsg extends Omit<RawThreadMsg, "body"> {
  body: RichText;
}

/* ── the snapshot — one envelope for every kind ───────────────────── */

export const InteractionSnapshotSchema = z.object({
  id: z.uuid(),
  kind: InteractionKindSchema,
  url: z.optional(bounded(LIMITS.MAX_URL)),
  /**
   * The page the person shares, when the block is inside a frame of it: the
   * top page's URL at creation, redacted (origin + path). For display and
   * opening only; the binding stays `url`. Page-derived.
   */
  hostUrl: z.optional(bounded(LIMITS.MAX_URL)),
  anchor: AnchorSchema,
  /** Live + anchor lost = demoted to page-level, wearing this flag. */
  anchorLost: z.optional(z.boolean()),
  /**
   * Bounded structure-preserving markdown excerpt of the captured element
   * (ADR-0017 §2). Set on the AGENT digest only — the full content is fetched
   * on demand via `onlay anchor`. Page-derived → declassified before a prompt.
   */
  anchorExcerpt: z.optional(bounded(LIMITS.MAX_ANCHOR_EXCERPT)),
  captures: z.optional(
    z.array(CaptureRefSchema).check(z.maxLength(LIMITS.MAX_CAPTURES_PER_INTERACTION)),
  ),
  /**
   * A pending "Capture due" duty (ADR-0022 §7): an involved participant asked
   * this anchored place be looked at again. Present only while live; a Full
   * client's committed snapshot discharges it. Both fields are server-trusted
   * (actor id + clock) — never page-derived, so no `UntrustedText` brand.
   */
  resnap: z.optional(
    z.object({
      requestedBy: bounded(LIMITS.MAX_ACTOR_ID),
      requestedAt: z.number(),
    }),
  ),
  authorId: bounded(LIMITS.MAX_ACTOR_ID),
  participants: z.array(bounded(LIMITS.MAX_ACTOR_ID)),
  waitingOn: z.array(bounded(LIMITS.MAX_ACTOR_ID)),
  state: bounded(LIMITS.MAX_TAG),
  thread: z.array(ThreadMsgSchema).check(z.maxLength(LIMITS.MAX_THREAD_MSGS)),
  ask: z.optional(
    z.object({
      ...askPayloadShape(),
      answers: z.array(AskAnswerSchema).check(z.maxLength(LIMITS.MAX_ATTENTION_ROWS)),
    }),
  ),
  change: z.optional(
    z.object({
      ...changePayloadShape(),
      variantSetId: z.optional(bounded(LIMITS.MAX_VARIANT_SET_ID)),
    }),
  ),
  agentWork: z.optional(AgentWorkSchema),
  createdAt: z.number(),
  resolvedAt: z.optional(z.number()),
  truncated: z.optional(z.boolean()),
});
export type RawInteractionSnapshot = z.infer<typeof InteractionSnapshotSchema>;

/* ── inbound frames (extension → server) ──────────────────────────── */

/** A client's opaque id for one send (and its retries): 1–64 characters. */
export const ClientIdSchema = z
  .string()
  .check(z.minLength(1), z.maxLength(LIMITS.MAX_VARIANT_SET_ID));

const frameHead = () => ({
  v: z.literal(1),
  frameUrl: bounded(LIMITS.MAX_URL),
});

export const InteractionCreateSchema = z.object({
  ...frameHead(),
  type: z.literal("interaction-create"),
  /** Client correlation id, echoed on the receipt (create is async). */
  nonce: bounded(LIMITS.MAX_VARIANT_SET_ID),
  kind: InteractionKindSchema,
  anchor: AnchorSchema,
  /**
   * Set by the extension's service worker for a block inside a child frame:
   * the tab's top URL, redacted. Shown and opened in place of `frameUrl`,
   * never used for the binding.
   */
  hostUrl: z.optional(bounded(LIMITS.MAX_URL)),
  /** Comment root message (required for kind=comment); optional note else. */
  body: z.optional(RichTextSchema),
  ask: z.optional(AskPayloadSchema),
  change: z.optional(ChangePayloadSchema),
});
type RawInteractionCreate = z.infer<typeof InteractionCreateSchema>;
export interface InteractionCreate
  extends Omit<RawInteractionCreate, "frameUrl" | "hostUrl" | "body"> {
  frameUrl: UntrustedText;
  hostUrl?: UntrustedText;
  body?: RichText;
}

export const InteractionReplySchema = z.object({
  ...frameHead(),
  type: z.literal("interaction-reply"),
  interactionId: z.uuid(),
  body: RichTextSchema,
  /** Answering a specific message: the target's author is implicitly mentioned. */
  replyTo: z.optional(ReplyToSchema),
  /**
   * The client's id for this send, reused by every retry of it and echoed on
   * the receipt. A repeat by the same person on the same interaction adds no
   * message and answers with the first one.
   */
  clientId: z.optional(ClientIdSchema),
});
type RawInteractionReply = z.infer<typeof InteractionReplySchema>;
export interface InteractionReply extends Omit<RawInteractionReply, "frameUrl" | "body"> {
  frameUrl: UntrustedText;
  body: RichText;
}

export const InteractionEditSchema = z.object({
  ...frameHead(),
  type: z.literal("interaction-edit"),
  interactionId: z.uuid(),
  msgId: bounded(LIMITS.MAX_ANCHOR_ID),
  body: RichTextSchema,
});
type RawInteractionEdit = z.infer<typeof InteractionEditSchema>;
export interface InteractionEdit extends Omit<RawInteractionEdit, "frameUrl" | "body"> {
  frameUrl: UntrustedText;
  body: RichText;
}

export const InteractionDeleteSchema = z.object({
  ...frameHead(),
  type: z.literal("interaction-delete"),
  interactionId: z.uuid(),
  msgId: bounded(LIMITS.MAX_ANCHOR_ID),
});
type RawInteractionDelete = z.infer<typeof InteractionDeleteSchema>;
export interface InteractionDelete extends Omit<RawInteractionDelete, "frameUrl"> {
  frameUrl: UntrustedText;
}

export const InteractionReactSchema = z.object({
  ...frameHead(),
  type: z.literal("interaction-react"),
  interactionId: z.uuid(),
  msgId: bounded(LIMITS.MAX_ANCHOR_ID),
  emoji: bounded(LIMITS.MAX_EMOJI),
  on: z.boolean(),
});
type RawInteractionReact = z.infer<typeof InteractionReactSchema>;
export interface InteractionReact extends Omit<RawInteractionReact, "frameUrl" | "emoji"> {
  frameUrl: UntrustedText;
  emoji: UntrustedText;
}

export const InteractionResolveSchema = z.object({
  ...frameHead(),
  type: z.literal("interaction-resolve"),
  interactionId: z.uuid(),
});
type RawInteractionResolve = z.infer<typeof InteractionResolveSchema>;
export interface InteractionResolve extends Omit<RawInteractionResolve, "frameUrl"> {
  frameUrl: UntrustedText;
}

/** Resolve's counterpart (F26): a resolved interaction returns to life. */
export const InteractionReopenSchema = z.object({
  ...frameHead(),
  type: z.literal("interaction-reopen"),
  interactionId: z.uuid(),
});
type RawInteractionReopen = z.infer<typeof InteractionReopenSchema>;
export interface InteractionReopen extends Omit<RawInteractionReopen, "frameUrl"> {
  frameUrl: UntrustedText;
}

export const InteractionAnchorSchema = z.object({
  ...frameHead(),
  type: z.literal("interaction-anchor"),
  interactionId: z.uuid(),
  anchor: AnchoredAnchorSchema,
});
export type RawInteractionAnchor = z.infer<typeof InteractionAnchorSchema>;
export interface InteractionAnchor extends Omit<RawInteractionAnchor, "frameUrl"> {
  frameUrl: UntrustedText;
}

export const InteractionReanchorSchema = z.object({
  ...frameHead(),
  type: z.literal("interaction-reanchor"),
  interactionId: z.uuid(),
  anchor: AnchoredAnchorSchema,
});
type RawInteractionReanchor = z.infer<typeof InteractionReanchorSchema>;
export interface InteractionReanchor extends Omit<RawInteractionReanchor, "frameUrl"> {
  frameUrl: UntrustedText;
}

/**
 * The overlay reports an interaction whose element anchor failed to resolve
 * for several consecutive sync passes while the page is otherwise alive
 * (ADR-0017 §4). The server demotes it to page-level (`markAnchorLost`),
 * journals `int-anchor-lost`, and broadcasts. Never drops a live interaction.
 */
export const InteractionAnchorLostSchema = z.object({
  ...frameHead(),
  type: z.literal("interaction-anchor-lost"),
  interactionId: z.uuid(),
  /**
   * The reporter resolved the anchor's `framePath` (A-3). A report without it
   * on an anchor that has one comes from a client that ignores `framePath`
   * (it looked in the wrong document), and is not taken.
   */
  framed: z.optional(z.literal(true)),
});
type RawInteractionAnchorLost = z.infer<typeof InteractionAnchorLostSchema>;
export interface InteractionAnchorLost extends Omit<RawInteractionAnchorLost, "frameUrl"> {
  frameUrl: UntrustedText;
}

export const AskAnswerFrameSchema = z.object({
  ...frameHead(),
  type: z.literal("ask-answer"),
  interactionId: z.uuid(),
  optionIds: z.array(bounded(LIMITS.MAX_OPTION_ID)).check(z.maxLength(LIMITS.MAX_ASK_OPTIONS)),
  comment: z.optional(RichTextSchema),
});
type RawAskAnswerFrame = z.infer<typeof AskAnswerFrameSchema>;
export interface AskAnswerFrame extends Omit<RawAskAnswerFrame, "frameUrl" | "comment"> {
  frameUrl: UntrustedText;
  comment?: RichText;
}

export const ChangeBatchSchema = z.object({
  ...frameHead(),
  type: z.literal("change-batch"),
  interactionId: z.uuid(),
  /** Human-authored preview ops (same spec agents' variants use). */
  ops: MutationProgramSchema,
  note: z.optional(RichTextSchema),
});
type RawChangeBatch = z.infer<typeof ChangeBatchSchema>;
export interface ChangeBatch extends Omit<RawChangeBatch, "frameUrl" | "note"> {
  frameUrl: UntrustedText;
  note?: RichText;
}

/** Overlay state-pull for this page's interactions (mount/reconnect). */
export const InteractionSyncSchema = z.object({
  ...frameHead(),
  type: z.literal("interaction-sync"),
});
type RawInteractionSync = z.infer<typeof InteractionSyncSchema>;
export interface InteractionSync extends Omit<RawInteractionSync, "frameUrl"> {
  frameUrl: UntrustedText;
}

/** Pull the socket actor's attention rows (popup/badge refresh). */
export const AttentionSyncSchema = z.object({
  v: z.literal(1),
  type: z.literal("attention-sync"),
});
export type AttentionSync = z.infer<typeof AttentionSyncSchema>;
