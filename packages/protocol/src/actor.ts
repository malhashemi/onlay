/**
 * Actors — the membrane's identities (ADR-0002).
 *
 * An Actor is a product identity: who speaks, resolves, and is waited on.
 * Humans and agents are both Actors; the instant tell in a multiplayer
 * membrane is shape (humans round, agents squared), color is the individual.
 * A Client is a paired device/process holding a bearer token; many clients
 * per Actor. This module carries only the WIRE-SAFE summary — tokens and
 * client records never cross the membrane.
 */
import * as z from "zod/mini";
import { LIMITS } from "./limits";
import { bounded } from "./schema-helpers";

export const ACTOR_KINDS = ["human", "agent"] as const;
export const ActorKindSchema = z.enum(ACTOR_KINDS);
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** Wire-safe actor summary (no secrets): rides welcome/attention/state frames. */
export const ActorSchema = z.object({
  /** Stable slug, [a-z0-9-], server-minted at actor creation. */
  id: bounded(LIMITS.MAX_ACTOR_ID),
  name: bounded(LIMITS.MAX_ACTOR_NAME),
  kind: ActorKindSchema,
  /** Hex color assigned at creation — the individual's tint everywhere. */
  tint: bounded(LIMITS.MAX_COLOR),
  initials: bounded(LIMITS.MAX_INITIALS),
  avatar: z.optional(bounded(LIMITS.MAX_AVATAR_DATA)),
});
export type ActorSummary = z.infer<typeof ActorSchema>;
