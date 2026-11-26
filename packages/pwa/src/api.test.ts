// The API layer's contract: same-origin cookie requests that name the
// protocol, the CSRF marker on every write and never on a read, 401 → sign-in,
// 426 → reload prompt, the error table mapped to what screens draw, response
// schemas enforced, and the offline read-cache fallback.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import type { ApiClient } from "./api";
import * as api from "./api";
import { Store } from "./store";

Object.assign(globalThis, { indexedDB, IDBKeyRange });

const PERSON = "p_aaaaaaaaaaaaaaaaaaaa";
const SPACE = "s_bbbbbbbbbbbbbbbbbbbb";
const IID = "11111111-2222-4333-8444-555555555555";

interface Seen {
  url: string;
  init: RequestInit;
}

let store: Store;

beforeEach(async () => {
  store = await Store.open();
});
afterEach(() => {
  store.close();
});

function client(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const calls = { signIn: 0, upgrade: 0 };
  const c: ApiClient = {
    store,
    personId: PERSON,
    onSignInRequired: () => {
      calls.signIn += 1;
    },
    onUpgradeRequired: () => {
      calls.upgrade += 1;
    },
    fetchFn: ((url: string, init: RequestInit) => {
      seen.push({ url, init });
      return Promise.resolve(respond(url, init));
    }) as unknown as typeof fetch,
  };
  return { c, seen, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function headersOf(s: Seen | undefined): Record<string, string> {
  return (s?.init.headers ?? {}) as Record<string, string>;
}

describe("headers", () => {
  test("a read is same-origin, names the protocol, and carries no CSRF marker", async () => {
    const { c, seen } = client(() => json(200, { people: [] }));
    await api.directory(c, SPACE);
    expect(seen[0]?.url).toBe(`/s/${SPACE}/directory`);
    expect(seen[0]?.init.credentials).toBe("same-origin");
    expect(headersOf(seen[0])["Onlay-Protocol"]).toBe("2");
    expect(headersOf(seen[0])["Onlay-CSRF"]).toBeUndefined();
  });

  test("every write carries Onlay-CSRF: 1", async () => {
    const { c, seen } = client(() => json(200, {}));
    await api.reply(c, SPACE, IID, { text: "hi" });
    await api.rename(c, "Ada");
    await api.removeShare(c, SPACE, IID, "a@b.example");
    await api.putAdminSettings(c, { workspaceCreation: "anyone", creators: [] });
    await api.logout(c);
    await api.capturePutPart(c, SPACE, IID, "cap", "file", new Uint8Array([1]), "image/png");
    expect(seen.map((s) => s.init.method)).toEqual([
      "POST",
      "PATCH",
      "DELETE",
      "PUT",
      "POST",
      "PUT",
    ]);
    for (const s of seen) {
      expect(headersOf(s)["Onlay-CSRF"]).toBe("1");
      expect(headersOf(s)["Onlay-Protocol"]).toBe("2");
      expect(s.init.credentials).toBe("same-origin");
    }
  });

  test("a sign-out names AuthKit's logout only when the server sent one", async () => {
    const logout = "https://api.workos.com/user_management/sessions/logout?session_id=session_1";
    const named = client(() => json(200, { signOutUrl: logout }));
    expect(api.signOutUrlOf(await api.logout(named.c))).toBe(logout);
    expect(api.signOutUrlOf(await api.logoutEverywhere(named.c))).toBe(logout);
    // A session that never came from AuthKit: 204, nothing to follow.
    const none = client(() => new Response(null, { status: 204 }));
    expect(api.signOutUrlOf(await api.logout(none.c))).toBeNull();
    // Anything that isn't an http(s) address is never followed.
    for (const odd of ["javascript:alert(1)", "data:text/html,x", "/relative", 7]) {
      const bad = client(() => json(200, { signOutUrl: odd }));
      expect(api.signOutUrlOf(await api.logout(bad.c))).toBeNull();
    }
    const failed = client(() => json(500, { signOutUrl: logout }));
    expect(api.signOutUrlOf(await api.logout(failed.c))).toBeNull();
  });

  test("space routes drop the /agent prefix and encode emails", async () => {
    const { c, seen } = client(() => json(200, {}));
    await api.resolve(c, SPACE, IID);
    await api.cancelInvitation(c, SPACE, "a+b@c.example");
    await api.agentWork(c, SPACE, "https://x.test/a?b=1");
    expect(seen[0]?.url).toBe(`/s/${SPACE}/interaction/${IID}/resolve`);
    expect(seen[1]?.url).toBe(`/api/workspaces/${SPACE}/invitations/a%2Bb%40c.example`);
    expect(seen[2]?.url).toBe(`/s/${SPACE}/agent-work?url=https%3A%2F%2Fx.test%2Fa%3Fb%3D1`);
  });
});

describe("auth exits", () => {
  test("a 401 on a read or a write hands off to sign-in", async () => {
    const { c, calls } = client(() =>
      json(401, { error: { code: "sign_in_required", message: "Sign in." } }),
    );
    const r = await api.inbox(c);
    const w = await api.reply(c, SPACE, IID, { text: "x" });
    expect(calls.signIn).toBe(2);
    expect(r.ok).toBe(false);
    expect(w.ok).toBe(false);
  });

  test("a 426 asks for a reload", async () => {
    const { c, calls } = client(() =>
      json(426, { error: { code: "upgrade_required", message: "Reload." } }),
    );
    await api.me(c);
    expect(calls.upgrade).toBe(1);
    expect(calls.signIn).toBe(0);
  });
});

describe("error table", () => {
  test("each code maps to the verdict screens draw, with the server's sentence", () => {
    const cases: [number, string, api.FetchVerdict][] = [
      [400, "invalid", "refused"],
      [403, "forbidden", "refused"],
      [404, "not_found", "hidden"],
      [409, "conflict", "refused"],
      [409, "last_admin", "refused"],
      [429, "rate_limited", "refused"],
      [500, "nope", "error"],
    ];
    for (const [status, code, verdict] of cases) {
      const f = api.failureOf(status, { error: { code, message: "Because." } });
      expect(f.verdict).toBe(verdict);
      if (code !== "nope") {
        expect(f.code).toBe(code as api.Fail["code"] & string);
        expect(f.message).toBe("Because.");
      }
    }
  });

  test("a body without the error shape falls back to the status's code", () => {
    expect(api.failureOf(404, null)).toEqual({
      ok: false,
      verdict: "hidden",
      status: 404,
      code: "not_found",
    });
    expect(api.failureOf(409, "x").code).toBe("conflict");
    expect(api.failureOf(502, null).verdict).toBe("error");
  });

  test("last_admin reaches the caller with its message", async () => {
    const msg = "You're the last admin of acme. Make another member an admin first.";
    const { c } = client(() => json(409, { error: { code: "last_admin", message: msg } }));
    const res = await api.deleteAccount(c, "ada@x.example");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("last_admin");
      expect(res.message).toBe(msg);
    }
  });
});

describe("responses", () => {
  test("a response that breaks its schema is an error, not data", async () => {
    const { c } = client(() => json(200, { person: { id: "nope" } }));
    const res = await api.me(c);
    expect(res.ok).toBe(false);
  });

  test("offline reads fall back to the person's cache", async () => {
    let online = true;
    const body = { people: [] };
    const { c } = client(() => {
      if (!online) throw new TypeError("offline");
      return json(200, body);
    });
    const live = await api.directory(c, SPACE);
    expect(live.ok && !live.fromCache).toBe(true);
    online = false;
    const cached = await api.directory(c, SPACE);
    expect(cached.ok && cached.fromCache).toBe(true);
    const write = await api.reply(c, SPACE, IID, { text: "x" });
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.verdict).toBe("offline");
  });
});

describe("one tab, one person", () => {
  test("every request names the person this tab booted as", async () => {
    const { c, seen } = client(() => json(200, { people: [] }));
    await api.directory(c, SPACE);
    await api.reply(c, SPACE, IID, { text: "hi" } as never);
    for (const s of seen) expect(headersOf(s)[api.PERSON_HEADER]).toBe(PERSON);
  });

  test("a person-changed refusal drops the result, never signs in, and refuses later calls", async () => {
    let changed = 0;
    const { c, seen, calls } = client(() =>
      json(401, {
        error: { code: "sign_in_required", message: "Sign in.", reason: "person-changed" },
      }),
    );
    c.onPersonChanged = () => {
      changed += 1;
    };
    const res = await api.directory(c, SPACE);
    expect(res.ok).toBe(false);
    expect(changed).toBe(1);
    expect(calls.signIn).toBe(0);
    const before = seen.length;
    expect((await api.inbox(c)).ok).toBe(false);
    expect(seen.length).toBe(before); // nothing more goes out as the old person
  });

  test("a read that lands after the person changed is not cached under either person", async () => {
    let release: (r: Response) => void = () => {};
    const { c } = client(
      () =>
        new Promise<Response>((ok) => {
          release = ok;
        }),
    );
    const fresh = "s_cccccccccccccccccccc"; // never read before in this file
    const pending = api.directory(c, fresh);
    c.personChanged = true; // the tab learned of the change meanwhile
    release(json(200, { people: [{ id: "p_b", name: "B", initials: "B", tint: "#111111" }] }));
    expect((await pending).ok).toBe(false);
    expect(await store.getRead(PERSON, `/s/${fresh}/directory`)).toBeNull();
  });
});
