// How a tab's session ends: a tab that has shown a signed-in person never
// navigates on a 401, whenever it comes and whatever the other tabs said; it
// shows the signed-out screen. Only a tab that boots with no session goes to
// sign-in. The signing-out tab ignores its own expected 401s, bounds its push
// cleanup and its request, and on a stalled request carries on and says so.
// And only AuthKit's own logout endpoint is followed.
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { signedOutState } from "./chrome";
import {
  createSessionEnd,
  followableSignOut,
  type LogoutAnswer,
  type NoteChannel,
  onSignInRequired,
  runSignOut,
  type SignOutNote,
} from "./sign-out";

/** A channel between tabs whose deliveries wait until `flush` (delayed delivery). */
function bus() {
  const tabs: Array<(note: SignOutNote) => void> = [];
  const queued: Array<() => void> = [];
  const channel = (me: number): NoteChannel => ({
    post: (note) => {
      tabs.forEach((fn, i) => {
        if (i !== me) queued.push(() => fn(note));
      });
    },
    listen: (fn) => {
      tabs[me] = fn;
    },
  });
  return {
    channel,
    flush: () => {
      for (const f of queued.splice(0)) f();
    },
  };
}

function tab(channel: NoteChannel, person = "p_a") {
  const did: string[] = [];
  const session = createSessionEnd({
    personId: () => person,
    channel,
    goSignIn: () => did.push("sign-in"),
    showSignedOut: () => did.push("signed-out"),
  });
  return { session, did };
}

describe("what a 401 does to a tab", () => {
  test("the rule", () => {
    const base = { leaving: false, signingOut: false, signedOut: false, shown: false };
    expect(onSignInRequired(base)).toBe("sign-in");
    expect(onSignInRequired({ ...base, shown: true })).toBe("signed-out");
    expect(onSignInRequired({ ...base, shown: true, signedOut: true })).toBe("ignore");
    expect(onSignInRequired({ ...base, shown: true, signingOut: true })).toBe("ignore");
    expect(onSignInRequired({ ...base, leaving: true })).toBe("ignore");
  });

  test("a tab that booted with no session goes to sign-in", () => {
    const t = tab(bus().channel(0));
    t.session.signInRequired();
    t.session.signInRequired();
    expect(t.did).toEqual(["sign-in"]);
  });

  test("a signed-in tab's 401 shows the signed-out screen, once, and never navigates", () => {
    const t = tab(bus().channel(0));
    t.session.shown();
    t.session.signInRequired();
    t.session.signInRequired();
    expect(t.did).toEqual(["signed-out"]);
  });

  test("another tab's 401 before any note arrives: the signed-out screen, not sign-in", () => {
    const b = bus();
    const a = tab(b.channel(0));
    const other = tab(b.channel(1));
    a.session.shown();
    other.session.shown();
    a.session.begin();
    // The server revoked the session; the other tab hears it first from its own 401.
    other.session.signInRequired();
    expect(other.did).toEqual(["signed-out"]);
    a.session.leave();
    a.session.done();
    b.flush();
    // The late note changes nothing.
    expect(other.did).toEqual(["signed-out"]);
    expect(a.did).toEqual([]);
  });

  test("the note only makes the other tab show the screen sooner; a 401 after it adds nothing", () => {
    const b = bus();
    const a = tab(b.channel(0));
    const other = tab(b.channel(1));
    other.session.shown();
    a.session.done();
    b.flush();
    expect(other.did).toEqual(["signed-out"]);
    other.session.signInRequired();
    expect(other.did).toEqual(["signed-out"]);
  });

  test("a note reaching a tab that is still booting, or is another person, does nothing", () => {
    const b = bus();
    const a = tab(b.channel(0), "p_a");
    const booting = tab(b.channel(1), "p_a");
    const otherPerson = tab(b.channel(2), "p_b");
    otherPerson.session.shown();
    a.session.done();
    b.flush();
    expect(booting.did).toEqual([]);
    expect(otherPerson.did).toEqual([]);
  });

  test("the signing-out tab ignores its own 401s; after a failed sign-out it shows the screen on the next", () => {
    const t = tab(bus().channel(0));
    t.session.shown();
    t.session.begin();
    t.session.signInRequired();
    expect(t.did).toEqual([]);
    t.session.cancel();
    t.session.signInRequired();
    expect(t.did).toEqual(["signed-out"]);
  });
});

describe("the signed-out screen", () => {
  test("says so in the server's words, and its one action starts sign-in", () => {
    const win = new Window();
    const saved = globalThis.document;
    Object.assign(globalThis, { document: win.document });
    try {
      let asked = 0;
      const node = signedOutState(() => asked++);
      expect(node.textContent).toContain("You were signed out.");
      expect(node.textContent).toContain("Sign in again.");
      const buttons = node.querySelectorAll("button");
      expect(buttons.length).toBe(1);
      expect(buttons[0]?.textContent).toBe("Sign in");
      const click = new win.MouseEvent("click", { bubbles: true });
      Object.defineProperty(click, "isTrusted", { value: true });
      buttons[0]?.dispatchEvent(click as unknown as Event);
      expect(asked).toBe(1);
    } finally {
      Object.assign(globalThis, { document: saved });
      void win.happyDOM.close();
    }
  });
});

const never = <T>(): Promise<T> => new Promise<T>(() => {});

function flow(over: Partial<Parameters<typeof runSignOut>[0]> = {}) {
  const log: string[] = [];
  const t = tab(bus().channel(0));
  t.session.shown();
  const steps: Parameters<typeof runSignOut>[0] = {
    how: "this",
    session: t.session,
    disablePush: async () => {
      log.push("push");
    },
    pause: () => log.push("pause"),
    resume: () => log.push("resume"),
    logout: async (): Promise<LogoutAnswer> => {
      log.push("logout");
      return { ok: true, status: 200, signOutUrl: null };
    },
    signOutEndpoint: undefined,
    finish: async (next) => {
      log.push(`finish:${next}`);
    },
    pushMs: 20,
    logoutMs: 20,
    ...over,
  };
  return { log, t, run: () => runSignOut(steps) };
}

describe("signing out from this tab", () => {
  test("in order: push, pause, ask, then leave", async () => {
    const f = flow();
    expect(await f.run()).toBe(true);
    expect(f.log).toEqual(["push", "pause", "logout", "finish:null"]);
    expect(f.t.session.leaving()).toBe(true);
  });

  test("a push cleanup that never settles is given up after its deadline", async () => {
    const f = flow({ disablePush: never, pushMs: 10 });
    const started = Date.now();
    expect(await f.run()).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(f.log).toEqual(["pause", "logout", "finish:null"]);
  });

  test("a failing push cleanup does not stop the sign-out", async () => {
    const f = flow({ disablePush: () => Promise.reject(new Error("no")) });
    expect(await f.run()).toBe(true);
    expect(f.log).toEqual(["pause", "logout", "finish:null"]);
  });

  test("a stalled request: after its deadline the tab is released and resumed, and does not leave", async () => {
    const f = flow({ logout: never, logoutMs: 10 });
    expect(await f.run()).toBe(false);
    expect(f.log).toEqual(["push", "pause", "resume"]);
    expect(f.t.session.leaving()).toBe(false);
    // Released: the next 401 ends the session in this tab, without navigating.
    f.t.session.signInRequired();
    expect(f.t.did).toEqual(["signed-out"]);
  });

  test("a refused request carries on the same way; a 401 counts as signed out", async () => {
    const refused = flow({ logout: async () => ({ ok: false, status: 503, signOutUrl: null }) });
    expect(await refused.run()).toBe(false);
    expect(refused.log).toEqual(["push", "pause", "resume"]);
    const gone = flow({ logout: async () => ({ ok: false, status: 401, signOutUrl: null }) });
    expect(await gone.run()).toBe(true);
    expect(gone.log).toEqual(["push", "pause", "finish:null"]);
  });

  test("only the logout address /api/me named is followed", async () => {
    const endpoint = "https://api.workos.com/user_management/sessions/logout";
    const ok = `${endpoint}?session_id=s_1`;
    const f = flow({
      signOutEndpoint: endpoint,
      logout: async () => ({ ok: true, status: 200, signOutUrl: ok }),
    });
    expect(await f.run()).toBe(true);
    expect(f.log.at(-1)).toBe(`finish:${ok}`);
    const g = flow({
      signOutEndpoint: endpoint,
      logout: async () => ({ ok: true, status: 200, signOutUrl: "https://evil.test/logout" }),
    });
    await g.run();
    expect(g.log.at(-1)).toBe("finish:null");
  });

  test("after an account deletion nothing is asked: it only leaves", async () => {
    const f = flow({ how: "gone" });
    expect(await f.run()).toBe(true);
    expect(f.log).toEqual(["finish:null"]);
  });
});

describe("which logout address is followed", () => {
  const endpoint = "https://api.workos.com/user_management/sessions/logout";
  test("AuthKit's own endpoint, with its query", () => {
    const next = `${endpoint}?session_id=s_1&return_to=https%3A%2F%2Fonlay.dev%2F`;
    expect(followableSignOut(next, endpoint)).toBe(next);
  });
  test("anything else is not followed", () => {
    for (const next of [
      "https://evil.test/user_management/sessions/logout",
      "https://api.workos.com/elsewhere",
      "https://api.workos.com.evil.test/user_management/sessions/logout",
      "http://api.workos.com/user_management/sessions/logout",
      "javascript:alert(1)",
      "https://u:p@api.workos.com/user_management/sessions/logout",
      "not a url",
    ]) {
      expect(followableSignOut(next, endpoint)).toBeNull();
    }
    expect(followableSignOut(`${endpoint}?x=1`, undefined)).toBeNull();
    expect(followableSignOut(null, endpoint)).toBeNull();
  });
});
