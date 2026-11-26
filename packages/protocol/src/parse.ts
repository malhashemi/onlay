/**
 * Frame parsing: the single entry point for every frame crossing the
 * membrane, in either direction. Size gate BEFORE JSON.parse, schema gate
 * before any handler.
 */
import * as z from "zod/mini";
import { LIMITS } from "./limits";
import { type Inbound, InboundSchema } from "./messages";
import { type Outbound, OutboundSchema } from "./outbound";

export type ParseResult<T> = { ok: true; msg: T } | { ok: false; reason: string };

function parseFrame<T>(raw: unknown, schema: z.ZodMiniType, maxChars: number): ParseResult<T> {
  if (typeof raw !== "string") return { ok: false, reason: "non-string-frame" };
  if (raw.length > maxChars) return { ok: false, reason: "frame-too-large" };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
  const r = z.safeParse(schema, data);
  if (!r.success) {
    const issue = r.error.issues[0];
    const path = issue?.path?.join(".") ?? "";
    return { ok: false, reason: `schema-invalid:${path || issue?.code || "unknown"}` };
  }
  // Page-derived selection fields come out branded as UntrustedText — the
  // runtime values are plain strings; the brand is applied here, at ingest.
  return { ok: true, msg: r.data as unknown as T };
}

/** Parse an extension→server frame (attacker-adjacent: strict budget). */
export function parseInbound(raw: unknown): ParseResult<Inbound> {
  return parseFrame<Inbound>(raw, InboundSchema, LIMITS.MAX_FRAME_CHARS);
}

/**
 * Parse a server→extension frame (the extension validates its inbox too).
 * Larger budget: state snapshots carry thread data and the sender is the
 * gate-authenticated local server.
 */
export function parseOutbound(raw: unknown): ParseResult<Outbound> {
  return parseFrame<Outbound>(raw, OutboundSchema, LIMITS.MAX_OUTBOUND_FRAME_CHARS);
}
