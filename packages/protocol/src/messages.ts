/**
 * Inbound frames: extension → server.
 *
 * Walking-kernel vocabulary, mapped to the primitive protocol (vision §3):
 * `selection` seeds point/select (the grounding primitive); `hello`/`ping`/
 * `ack` are session plumbing; the interaction frames carry the three core
 * interactions (comment · ask · change, ADR-0001). Adding a primitive is new
 * variants here + new journal kinds — no envelope, queue, or gate change.
 */
import * as z from "zod/mini";
import {
  type AskAnswerFrame,
  AskAnswerFrameSchema,
  type AttentionSync,
  AttentionSyncSchema,
  type ChangeBatch,
  ChangeBatchSchema,
  type InteractionAnchor,
  type InteractionAnchorLost,
  InteractionAnchorLostSchema,
  InteractionAnchorSchema,
  type InteractionCreate,
  InteractionCreateSchema,
  type InteractionDelete,
  InteractionDeleteSchema,
  type InteractionEdit,
  InteractionEditSchema,
  type InteractionReact,
  InteractionReactSchema,
  type InteractionReanchor,
  InteractionReanchorSchema,
  type InteractionReopen,
  InteractionReopenSchema,
  type InteractionReply,
  InteractionReplySchema,
  type InteractionResolve,
  InteractionResolveSchema,
  type InteractionSync,
  InteractionSyncSchema,
} from "./interaction";
import { count } from "./schema-helpers";
import {
  type VariantCreate,
  VariantCreateSchema,
  type VariantCycle,
  VariantCycleSchema,
  type VariantDiscard,
  VariantDiscardSchema,
  type VariantPick,
  VariantPickSchema,
  type VariantSteer,
  VariantSteerSchema,
  type VariantSync,
  VariantSyncSchema,
  type VariantTune,
  VariantTuneSchema,
} from "./variant";

export const HelloSchema = z.object({
  v: z.literal(1),
  type: z.literal("hello"),
  sessionId: z.uuid(),
  bootCount: count(),
  swRestarts: count(),
  connects: count(),
  /** Resume anchor: the server flushes queued work frames with seq > this. */
  lastAckSeq: z.optional(count()),
  /** The client's protocol version; below `MIN_CLIENT_PROTOCOL` the socket closes 4426. */
  protocol: z.optional(count()),
});
export type Hello = z.infer<typeof HelloSchema>;

export const PingSchema = z.object({
  v: z.literal(1),
  type: z.literal("ping"),
  t: z.number(),
});
export type Ping = z.infer<typeof PingSchema>;

export const InboundSchema = z.discriminatedUnion("type", [
  HelloSchema,
  PingSchema,
  InteractionCreateSchema,
  InteractionReplySchema,
  InteractionEditSchema,
  InteractionDeleteSchema,
  InteractionReactSchema,
  InteractionResolveSchema,
  InteractionReopenSchema,
  InteractionAnchorSchema,
  InteractionReanchorSchema,
  InteractionAnchorLostSchema,
  AskAnswerFrameSchema,
  ChangeBatchSchema,
  InteractionSyncSchema,
  AttentionSyncSchema,
  VariantCreateSchema,
  VariantCycleSchema,
  VariantPickSchema,
  VariantDiscardSchema,
  VariantTuneSchema,
  VariantSteerSchema,
  VariantSyncSchema,
]);

export type Inbound =
  | Hello
  | Ping
  | InteractionCreate
  | InteractionReply
  | InteractionEdit
  | InteractionDelete
  | InteractionReact
  | InteractionResolve
  | InteractionReopen
  | InteractionAnchor
  | InteractionReanchor
  | InteractionAnchorLost
  | AskAnswerFrame
  | ChangeBatch
  | InteractionSync
  | AttentionSync
  | VariantCreate
  | VariantCycle
  | VariantPick
  | VariantDiscard
  | VariantTune
  | VariantSteer
  | VariantSync;
