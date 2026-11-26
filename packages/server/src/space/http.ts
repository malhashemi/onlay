import { API_ERROR_STATUS, type ApiErrorCode, apiError } from "@onlay/protocol";
import * as z from "zod/mini";
import { readJsonCapped } from "./body";
import type { Refusal } from "./service";

/**
 * Response helpers shared by every space route: one error shape,
 * `{error: {code, message, reason?}}`, with the status from the protocol's
 * error table.
 */

export function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, { status, ...(headers ? { headers } : {}) });
}

export function errorResponse(
  code: ApiErrorCode,
  message: string,
  reason?: string,
  extra?: Record<string, unknown>,
): Response {
  return json({ ...apiError(code, message, reason), ...extra }, API_ERROR_STATUS[code]);
}

export function refusal(r: Refusal, extra?: Record<string, unknown>): Response {
  const fields = r.extra || extra ? { ...r.extra, ...extra } : undefined;
  return errorResponse(r.code, r.message, r.reason, fields);
}

export const notFound = () => errorResponse("not_found", "Nothing is here.", "unknown");

export function methodNotAllowed(allow: string[]): Response {
  return json(
    { error: { code: "invalid", message: "That method isn't allowed here.", reason: "method" } },
    405,
    { Allow: allow.join(", ") },
  );
}

/** The parsed body (at most `maxBytes`), or a ready `invalid` response. */
export async function parseBody<S extends z.ZodMiniType>(
  req: Request,
  schema: S,
  maxBytes: number,
): Promise<z.infer<S> | Response> {
  const read = await readJsonCapped(req, maxBytes);
  if (!read.ok) {
    return read.reason === "too-large"
      ? errorResponse("invalid", `The body is larger than ${maxBytes} bytes.`, "too-large")
      : errorResponse("invalid", "The body isn't JSON.", "invalid-json");
  }
  const body = read.data;
  const parsed = z.safeParse(schema, body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path?.join(".") ?? "";
    return errorResponse("invalid", `The body doesn't fit (${path || "root"}).`, "schema-invalid");
  }
  return parsed.data;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  let hex = "";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return hex;
}
