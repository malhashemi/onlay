// The web app asks whether this extension is installed (round 4, S-3), and so
// does the public site's landing page, so its built-in demo can stand down: an
// external message `{type: "onlay-ping"}`, answered `{ok: true, version}` and
// nothing else. The manifest's `externally_connectable` already limits who may
// send to the server and site origins; the sender checks of the sign-in
// hand-off hold here too: only a top-level page on one of the origins
// configured now, as Chrome reports the sender (an opaque origin is refused).
// The sign-in hand-off itself (`onlay-auth`, sw/auth.ts) is taken from the
// server origin alone.
import { type ExternalSender, externalSenderOrigin } from "./auth";

const PING_TYPE = "onlay-ping";

export type PingAnswer = { ok: true; version: string } | { ok: false };

export function isPing(msg: unknown): boolean {
  return typeof msg === "object" && msg !== null && (msg as { type?: unknown }).type === PING_TYPE;
}

/** The answer to a ping from `sender`, when the server and site origins are `configured`. */
export function answerPing(
  sender: ExternalSender,
  configured: readonly string[],
  version: string,
): PingAnswer {
  if (sender.frameId !== undefined && sender.frameId !== 0) return { ok: false };
  const from = externalSenderOrigin(sender);
  if (from === null || !configured.includes(from)) return { ok: false };
  return { ok: true, version };
}
