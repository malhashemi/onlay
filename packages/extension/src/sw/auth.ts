// Extension sign-in (spec §4): a PKCE-style verifier/challenge, a tab at
// `/auth/extension`, and a one-time code delivered back through
// `chrome.runtime.onMessageExternal`. Everything chrome-specific is a port so
// the message checks — wrong sender, wrong state, replayed code — are tested
// without a browser. A code is accepted only from the top-level hand-off page
// (`/auth/extension`) in the very tab this extension opened, on the server
// origin configured now; an opaque sender origin is refused outright.
import type { ExtensionTokenResponse } from "@onlay/protocol";

/** A sign-in tab left open longer than this no longer counts. */
export const SIGN_IN_TTL_MS = 10 * 60_000;

export interface PendingSignIn {
  state: string;
  verifier: string;
  /** The origin the tab was opened on; the code must come back from it. */
  origin: string;
  createdAt: number;
  /** The tab the extension opened; the code must come back from it. */
  tabId?: number;
}

/** The hand-off page's path on the server. */
const HANDOFF_PATH = "/auth/extension";

/** What Chrome tells us about an external message's sender. */
export interface ExternalSender {
  origin?: string | undefined;
  url?: string | undefined;
  frameId?: number | undefined;
  tab?: { id?: number | undefined } | undefined;
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function base64url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64URL[(n >> 18) & 63];
    out += B64URL[(n >> 12) & 63];
    if (b !== undefined) out += B64URL[(n >> 6) & 63];
    if (c !== undefined) out += B64URL[n & 63];
  }
  return out;
}

/** 32 random bytes as the verifier; base64url(SHA-256(verifier)) as the challenge. */
export async function makePkce(
  randomBytes: (n: number) => Uint8Array,
): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(randomBytes(32));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

function signInUrl(origin: string, extensionId: string, challenge: string, state: string): string {
  const q = new URLSearchParams({ ext: extensionId, challenge, state });
  return `${origin}/auth/extension?${q.toString()}`;
}

export type SignInRefusal =
  | "sender" // not the hand-off page, in the tab we opened, on the configured origin
  | "shape" // not an onlay-auth message
  | "no-pending" // no sign-in in progress (or the code was already used)
  | "state" // the state does not match the pending sign-in
  | "expired"
  | "redeem"; // the server refused the code

export type SignInResult = { ok: true } | { ok: false; reason: SignInRefusal };

/**
 * Where the sender says it is: Chrome sets `origin` for web pages, else read
 * it off `url`. An origin Chrome reports as opaque ("null") is refused, never
 * replaced by the URL's.
 */
export function externalSenderOrigin(sender: ExternalSender): string | null {
  if (typeof sender.origin === "string") return sender.origin === "null" ? null : sender.origin;
  if (typeof sender.url === "string") {
    try {
      return new URL(sender.url).origin;
    } catch {
      return null;
    }
  }
  return null;
}

/** The sender is the top-level hand-off page: Chrome says frame 0, never leaves it out. */
function fromHandoffPage(sender: ExternalSender): boolean {
  if (sender.frameId !== 0) return false;
  try {
    return new URL(sender.url ?? "").pathname === HANDOFF_PATH;
  } catch {
    return false;
  }
}

export interface SignInPorts {
  load(): Promise<PendingSignIn | null>;
  save(pending: PendingSignIn | null): Promise<void>;
  randomBytes(n: number): Uint8Array;
  now(): number;
  origin(): Promise<string>;
  extensionId: string;
  /** Open the sign-in tab; its id, when Chrome gives one. */
  openTab(url: string): Promise<number | undefined>;
  /** POST /auth/extension/token — null when the server refuses. */
  redeem(origin: string, code: string, verifier: string): Promise<ExtensionTokenResponse | null>;
  signedIn(origin: string, result: ExtensionTokenResponse): Promise<void>;
}

export interface SignInFlow {
  start(): Promise<void>;
  receive(msg: unknown, sender: ExternalSender): Promise<SignInResult>;
  /** The configured server origin changed: no sign-in in progress counts any more. */
  invalidate(): Promise<void>;
}

export function createSignInFlow(ports: SignInPorts): SignInFlow {
  // Messages are handled one at a time: two deliveries of the same code must
  // not both read the pending sign-in before either clears it.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };

  return {
    start: () =>
      serial(async () => {
        const origin = await ports.origin();
        const { verifier, challenge } = await makePkce(ports.randomBytes);
        const state = base64url(ports.randomBytes(16));
        await ports.save({ state, verifier, origin, createdAt: ports.now() });
        const tabId = await ports.openTab(signInUrl(origin, ports.extensionId, challenge, state));
        if (tabId !== undefined)
          await ports.save({ state, verifier, origin, createdAt: ports.now(), tabId });
      }),

    invalidate: () => serial(() => ports.save(null)),

    receive: (msg, sender) =>
      serial(async (): Promise<SignInResult> => {
        const m = msg as { type?: unknown; code?: unknown; state?: unknown } | null;
        if (
          m?.type !== "onlay-auth" ||
          typeof m.code !== "string" ||
          typeof m.state !== "string" ||
          m.code.length === 0 ||
          m.code.length > 256
        ) {
          return { ok: false, reason: "shape" };
        }
        const pending = await ports.load();
        const configured = await ports.origin();
        // A sign-in begun on another origin no longer counts.
        if (pending && pending.origin !== configured) await ports.save(null);
        // A sign-in with no recorded tab (the worker died before openTab
        // returned) is invalid: discarded, never accepted without the tab check.
        if (pending && pending.tabId === undefined) await ports.save(null);
        const live =
          pending && pending.origin === configured && pending.tabId !== undefined ? pending : null;
        const from = externalSenderOrigin(sender);
        if (from === null || from !== configured || !fromHandoffPage(sender))
          return { ok: false, reason: "sender" };
        if (live && sender.tab?.id !== live.tabId) return { ok: false, reason: "sender" };
        if (!live) return { ok: false, reason: "no-pending" };
        // A wrong state leaves the real sign-in waiting: it is someone else's message.
        if (m.state !== live.state) return { ok: false, reason: "state" };
        // Consumed before the network call, so a replay finds nothing to redeem.
        await ports.save(null);
        if (ports.now() - live.createdAt > SIGN_IN_TTL_MS) return { ok: false, reason: "expired" };
        const result = await ports.redeem(live.origin, m.code, live.verifier);
        if (!result) return { ok: false, reason: "redeem" };
        await ports.signedIn(live.origin, result);
        return { ok: true };
      }),
  };
}
