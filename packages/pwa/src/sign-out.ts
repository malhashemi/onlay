// How a web app tab's session ends. One rule, with no timing in it: a tab that
// has shown a signed-in person and then hears "not signed in" (a 401 from the
// API, or a socket refused and its refresh answering 401) never navigates by
// itself. It puts a plain signed-out screen in place of the app, whose one
// action starts sign-in. Only a tab that boots with no session at all (its
// first `/api/me` answering 401) goes straight to sign-in.
//
// Signing out revokes the session on the server before its answer returns,
// so the signing-out tab's own sockets and refreshes start answering 401
// while the request is in flight; that tab ignores them (it is leaving anyway)
// and follows the logout address the answer carries. Its other tabs need
// nothing from it: their next 401 shows the signed-out screen. The note it
// posts when done only makes them show it at once.

/** What tabs tell each other (one channel per origin). */
export type SignOutNote = { kind: "signed-out"; personId: string };

export interface NoteChannel {
  post(note: SignOutNote): void;
  listen(fn: (note: SignOutNote) => void): void;
}

/** The browser's channel; a no-op where BroadcastChannel is missing. */
export function browserChannel(name = "onlay-sign-out"): NoteChannel {
  if (typeof BroadcastChannel === "undefined") return { post: () => {}, listen: () => {} };
  const ch = new BroadcastChannel(name);
  return {
    post: (note) => {
      try {
        ch.postMessage(note);
      } catch {
        // a closed channel: nothing to tell
      }
    },
    listen: (fn) => {
      ch.addEventListener("message", (e: MessageEvent) => {
        const note = e.data as SignOutNote | null;
        if (note?.kind === "signed-out" && typeof note.personId === "string") fn(note);
      });
    },
  };
}

/** What a "not signed in" does to this tab. */
export type SignInRequired = "ignore" | "sign-in" | "signed-out";

/**
 * The rule itself: nothing once the tab is leaving, signing out, or already
 * showing the signed-out screen; the signed-out screen once it has shown a
 * signed-in person; sign-in only for a tab that never had one.
 */
export function onSignInRequired(s: {
  leaving: boolean;
  signingOut: boolean;
  signedOut: boolean;
  shown: boolean;
}): SignInRequired {
  if (s.leaving || s.signingOut || s.signedOut) return "ignore";
  return s.shown ? "signed-out" : "sign-in";
}

export interface SessionEnd {
  /** The tab now shows a signed-in person. */
  shown(): void;
  /** A 401 from the API or a socket: acts on it by the rule above. */
  signInRequired(): void;
  /** The tab is navigating away; nothing else happens to it. */
  leave(): void;
  leaving(): boolean;
  /** This tab starts its own sign-out: its 401s are expected from here. */
  begin(): void;
  /** It did not go through: the tab carries on. */
  cancel(): void;
  /** It went through: tell the person's other tabs. */
  done(): void;
}

export function createSessionEnd(opts: {
  personId: () => string;
  channel: NoteChannel;
  /** Navigate to sign-in (a tab that never showed a signed-in person). */
  goSignIn: () => void;
  /** Put the signed-out screen in place of the app. */
  showSignedOut: () => void;
}): SessionEnd {
  const s = { leaving: false, signingOut: false, signedOut: false, shown: false };
  const act = (): void => {
    const what = onSignInRequired(s);
    if (what === "sign-in") {
      s.leaving = true;
      opts.goSignIn();
    } else if (what === "signed-out") {
      s.signedOut = true;
      opts.showSignedOut();
    }
  };
  opts.channel.listen((note) => {
    const who = opts.personId();
    // Only once this tab is that person; a tab still booting finds out from its own `/api/me`.
    if (who && note.personId === who && s.shown) act();
  });
  return {
    shown: () => {
      s.shown = true;
    },
    signInRequired: act,
    leave: () => {
      s.leaving = true;
    },
    leaving: () => s.leaving,
    begin: () => {
      s.signingOut = true;
    },
    cancel: () => {
      s.signingOut = false;
    },
    done: () => {
      opts.channel.post({ kind: "signed-out", personId: opts.personId() });
    },
  };
}

/** How long the push cleanup before a sign-out may take before the sign-out goes on without it. */
const PUSH_CLEANUP_MS = 2_000;
/** How long the sign-out request may take before the tab gives up and carries on. */
const LOGOUT_DEADLINE_MS = 10_000;

const TIMED_OUT: unique symbol = Symbol("timed-out");

/** `p`, or `TIMED_OUT` once `ms` pass first; a rejection counts as settling. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** The sign-out request's answer, as the flow needs it. */
export interface LogoutAnswer {
  ok: boolean;
  status: number;
  /** Where the answer says to go next (`{signOutUrl}`), unchecked. */
  signOutUrl: string | null;
}

/**
 * One sign-out from this tab: mark it, drop push (bounded), pause the sockets,
 * ask (bounded), then clear and leave through `finish`, which is given only
 * AuthKit's own logout address as `/api/me` named it (or null). `false` when
 * the request failed or stalled: the tab is released and resumed, and the
 * caller says the sign-out did not finish. `gone` (the account was deleted)
 * asks nothing and only leaves.
 */
export async function runSignOut(steps: {
  how: "this" | "everywhere" | "gone";
  session: SessionEnd;
  disablePush: () => Promise<unknown>;
  pause: () => void;
  resume: () => void;
  logout: (how: "this" | "everywhere") => Promise<LogoutAnswer>;
  signOutEndpoint: string | undefined;
  finish: (next: string | null) => Promise<void>;
  pushMs?: number;
  logoutMs?: number;
}): Promise<boolean> {
  let next: string | null = null;
  steps.session.begin();
  if (steps.how !== "gone") {
    await withDeadline(
      steps.disablePush().catch(() => undefined),
      steps.pushMs ?? PUSH_CLEANUP_MS,
    );
    // Its sockets would close under the revocation and ask again: stop them first.
    steps.pause();
    const res = await withDeadline(
      steps
        .logout(steps.how)
        .catch((): LogoutAnswer => ({ ok: false, status: 0, signOutUrl: null })),
      steps.logoutMs ?? LOGOUT_DEADLINE_MS,
    );
    // A 401 means the session is already gone: signed out all the same.
    if (res === TIMED_OUT || (!res.ok && res.status !== 401)) {
      steps.session.cancel();
      steps.resume();
      return false;
    }
    // Only AuthKit's own logout endpoint, as /api/me named it, is followed.
    next = followableSignOut(res.signOutUrl, steps.signOutEndpoint);
  }
  steps.session.leave();
  steps.session.done();
  await steps.finish(next);
  return true;
}

/**
 * The address a sign-out's answer may send the browser to: only the WorkOS
 * logout endpoint the server says it uses (same origin and path), with any
 * query; null for anything else, which then goes to the public site.
 */
export function followableSignOut(
  next: string | null,
  endpoint: string | undefined,
): string | null {
  if (next === null || !endpoint) return null;
  try {
    const url = new URL(next);
    const allowed = new URL(endpoint);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.origin !== allowed.origin || url.pathname !== allowed.pathname) return null;
    if (url.username !== "" || url.password !== "") return null;
    return url.toString();
  } catch {
    return null;
  }
}
