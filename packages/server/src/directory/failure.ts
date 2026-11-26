/**
 * A refusal with a code from the one error table (spec §5). Directory and
 * edge code throw it; the edge's router turns it into `{error: {code,
 * message}}` with the table's status.
 */
import { API_ERROR_STATUS, type ApiErrorCode, apiError } from "@onlay/protocol";

export class Failure extends Error {
  readonly code: ApiErrorCode;
  /** A machine tag refining the code, when a client acts on it (e.g. `person-changed`). */
  readonly reason: string | undefined;
  constructor(code: ApiErrorCode, message: string, reason?: string) {
    super(message);
    this.code = code;
    this.reason = reason;
  }
}

export function failureResponse(code: ApiErrorCode, message: string, reason?: string): Response {
  return Response.json(apiError(code, message, reason), { status: API_ERROR_STATUS[code] });
}

export const NOT_FOUND = "Nothing is here, or you can't open it.";
const SIGN_IN = "Sign in to continue.";

export const notFound = (): Failure => new Failure("not_found", NOT_FOUND);
export const signInRequired = (): Failure => new Failure("sign_in_required", SIGN_IN);

/** The batch failed on the named guard row's CHECK (migrations/0001). */
export function isGuard(error: unknown, reason: string): boolean {
  return String(error instanceof Error ? error.message : error).includes(`change_guard_${reason}`);
}

export function isUnique(error: unknown): boolean {
  return String(error instanceof Error ? error.message : error).includes(
    "UNIQUE constraint failed",
  );
}
