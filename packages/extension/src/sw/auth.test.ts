import { describe, expect, test } from "bun:test";
import type { ExtensionTokenResponse } from "@onlay/protocol";
import {
  base64url,
  createSignInFlow,
  makePkce,
  type PendingSignIn,
  SIGN_IN_TTL_MS,
  type SignInPorts,
} from "./auth";

const ORIGIN = "https://app.onlay.dev";
const PERSON = {
  id: "p_aaaaaaaaaaaaaaaaaaaa",
  email: "ana@example.com",
  name: "Ana",
  initials: "A",
  tint: "#0ea5e9",
};

function rig(overrides: Partial<SignInPorts> = {}, at: { origin: string } = { origin: ORIGIN }) {
  let pending: PendingSignIn | null = null;
  let clock = 1_000;
  let byte = 0;
  const opened: string[] = [];
  const redeemed: Array<{ code: string; verifier: string }> = [];
  const signedIn: ExtensionTokenResponse[] = [];
  const ports: SignInPorts = {
    load: async () => pending,
    save: async (p) => {
      pending = p;
    },
    randomBytes: (n) => Uint8Array.from({ length: n }, () => byte++ & 255),
    now: () => clock,
    origin: async () => at.origin,
    extensionId: "abcdefghijklmnopabcdefghijklmnop",
    openTab: async (url) => {
      opened.push(url);
      return 7;
    },
    redeem: async (_origin, code, verifier) => {
      redeemed.push({ code, verifier });
      return { token: `onl_${"x".repeat(43)}`, person: PERSON };
    },
    signedIn: async (_origin, r) => {
      signedIn.push(r);
    },
    ...overrides,
  };
  const flow = createSignInFlow(ports);
  const stateOf = (): string => new URL(opened[0] ?? "").searchParams.get("state") ?? "";
  return {
    flow,
    opened,
    redeemed,
    signedIn,
    stateOf,
    pending: () => pending,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

const fromServer = {
  origin: ORIGIN,
  url: `${ORIGIN}/auth/extension?x=1`,
  frameId: 0,
  tab: { id: 7 },
};

test("base64url encodes without padding", () => {
  expect(base64url(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
  expect(base64url(new Uint8Array([]))).toBe("");
});

test("the challenge is base64url(SHA-256(verifier)) and the verifier is 43 chars", async () => {
  const { verifier, challenge } = await makePkce((n) => new Uint8Array(n).fill(7));
  expect(verifier).toHaveLength(43);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  expect(challenge).toBe(base64url(new Uint8Array(digest)));
});

test("start opens /auth/extension with ext, challenge and state", async () => {
  const r = rig();
  await r.flow.start();
  const url = new URL(r.opened[0] ?? "");
  expect(url.origin + url.pathname).toBe(`${ORIGIN}/auth/extension`);
  expect(url.searchParams.get("ext")).toBe("abcdefghijklmnopabcdefghijklmnop");
  expect(url.searchParams.get("challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(r.pending()?.state).toBe(r.stateOf());
});

test("a code from the server origin with the right state is redeemed once", async () => {
  const r = rig();
  await r.flow.start();
  const verifier = r.pending()?.verifier;
  const res = await r.flow.receive(
    { type: "onlay-auth", code: "c1", state: r.stateOf() },
    fromServer,
  );
  expect(res).toEqual({ ok: true });
  expect(r.redeemed).toEqual([{ code: "c1", verifier: verifier ?? "" }]);
  expect(r.signedIn).toHaveLength(1);
  expect(r.pending()).toBeNull();
});

test("a replayed code finds no sign-in waiting and is not redeemed again", async () => {
  const r = rig();
  await r.flow.start();
  const msg = { type: "onlay-auth", code: "c1", state: r.stateOf() };
  const [first, second] = await Promise.all([
    r.flow.receive(msg, fromServer),
    r.flow.receive(msg, fromServer),
  ]);
  expect(first).toEqual({ ok: true });
  expect(second).toEqual({ ok: false, reason: "no-pending" });
  expect(r.redeemed).toHaveLength(1);
});

test("a message from another origin is refused and the sign-in keeps waiting", async () => {
  const r = rig();
  await r.flow.start();
  const res = await r.flow.receive(
    { type: "onlay-auth", code: "c1", state: r.stateOf() },
    { origin: "https://evil.example", url: "https://evil.example/x" },
  );
  expect(res).toEqual({ ok: false, reason: "sender" });
  expect(r.redeemed).toHaveLength(0);
  expect(r.pending()).not.toBeNull();
});

test("the public site may ping the extension but never hands it a sign-in", async () => {
  const r = rig();
  await r.flow.start();
  // The site's landing page is in externally_connectable; the hand-off is not its to make,
  // even from the very tab the extension opened and at the hand-off's path.
  const res = await r.flow.receive(
    { type: "onlay-auth", code: "c1", state: r.stateOf() },
    {
      origin: "https://onlay.dev",
      url: "https://onlay.dev/auth/extension?x=1",
      frameId: 0,
      tab: { id: 7 },
    },
  );
  expect(res).toEqual({ ok: false, reason: "sender" });
  expect(r.redeemed).toHaveLength(0);
  expect(r.pending()).not.toBeNull();
});

test("a sender with no origin and no url is refused", async () => {
  const r = rig();
  await r.flow.start();
  const res = await r.flow.receive({ type: "onlay-auth", code: "c1", state: r.stateOf() }, {});
  expect(res).toEqual({ ok: false, reason: "sender" });
});

test("a wrong state is refused without consuming the real sign-in", async () => {
  const r = rig();
  await r.flow.start();
  const wrong = await r.flow.receive(
    { type: "onlay-auth", code: "c1", state: "not-it" },
    fromServer,
  );
  expect(wrong).toEqual({ ok: false, reason: "state" });
  expect(r.redeemed).toHaveLength(0);
  const right = await r.flow.receive(
    { type: "onlay-auth", code: "c2", state: r.stateOf() },
    fromServer,
  );
  expect(right).toEqual({ ok: true });
});

test("malformed messages are refused before anything else", async () => {
  const r = rig();
  await r.flow.start();
  for (const msg of [null, "x", { type: "other" }, { type: "onlay-auth", code: 1, state: "s" }]) {
    expect(await r.flow.receive(msg, fromServer)).toEqual({ ok: false, reason: "shape" });
  }
});

test("a code with no sign-in in progress is refused", async () => {
  const r = rig();
  const res = await r.flow.receive({ type: "onlay-auth", code: "c1", state: "s" }, fromServer);
  expect(res).toEqual({ ok: false, reason: "no-pending" });
});

test("an expired sign-in is cleared and refused", async () => {
  const r = rig();
  await r.flow.start();
  r.tick(SIGN_IN_TTL_MS + 1);
  const res = await r.flow.receive(
    { type: "onlay-auth", code: "c1", state: r.stateOf() },
    fromServer,
  );
  expect(res).toEqual({ ok: false, reason: "expired" });
  expect(r.redeemed).toHaveLength(0);
  expect(r.pending()).toBeNull();
});

test("a refused redemption signs nobody in", async () => {
  const r = rig({ redeem: async () => null });
  await r.flow.start();
  const res = await r.flow.receive(
    { type: "onlay-auth", code: "c1", state: r.stateOf() },
    fromServer,
  );
  expect(res).toEqual({ ok: false, reason: "redeem" });
  expect(r.signedIn).toHaveLength(0);
});

describe("the code comes back only from the hand-off page in the tab we opened", () => {
  const code = (r: ReturnType<typeof rig>) => ({
    type: "onlay-auth",
    code: "c1",
    state: r.stateOf(),
  });

  test("the pending sign-in remembers the tab it opened", async () => {
    const r = rig();
    await r.flow.start();
    expect(r.pending()?.tabId).toBe(7);
  });

  test("another tab on the server origin cannot consume the sign-in", async () => {
    const r = rig();
    await r.flow.start();
    const res = await r.flow.receive(code(r), { ...fromServer, tab: { id: 99 } });
    expect(res).toEqual({ ok: false, reason: "sender" });
    expect(r.pending()).not.toBeNull();
    expect(await r.flow.receive(code(r), fromServer)).toEqual({ ok: true });
  });

  test("a sender that names no frame is refused, even from the right tab and page", async () => {
    const r = rig();
    await r.flow.start();
    const { frameId: _frame, ...noFrame } = fromServer;
    const res = await r.flow.receive(code(r), noFrame);
    expect(res).toEqual({ ok: false, reason: "sender" });
    expect(r.redeemed).toHaveLength(0);
    expect(r.pending()).not.toBeNull();
    expect(await r.flow.receive(code(r), fromServer)).toEqual({ ok: true });
  });

  test("another page on the server origin is refused", async () => {
    const r = rig();
    await r.flow.start();
    const res = await r.flow.receive(code(r), { ...fromServer, url: `${ORIGIN}/app/#/t/x/y` });
    expect(res).toEqual({ ok: false, reason: "sender" });
    expect(r.pending()).not.toBeNull();
  });

  test("a frame inside the hand-off tab is refused", async () => {
    const r = rig();
    await r.flow.start();
    expect(await r.flow.receive(code(r), { ...fromServer, frameId: 3 })).toEqual({
      ok: false,
      reason: "sender",
    });
  });

  test("an opaque origin is refused even when the URL looks right", async () => {
    const r = rig();
    await r.flow.start();
    expect(await r.flow.receive(code(r), { ...fromServer, origin: "null" })).toEqual({
      ok: false,
      reason: "sender",
    });
    expect(r.redeemed).toHaveLength(0);
  });

  test("a sign-in begun before the origin changed no longer counts", async () => {
    const at = { origin: ORIGIN };
    const r = rig({}, at);
    await r.flow.start();
    const msg = code(r);
    at.origin = "http://localhost:8787";
    const res = await r.flow.receive(msg, fromServer);
    expect(res).toEqual({ ok: false, reason: "sender" });
    expect(r.pending()).toBeNull();
    expect(r.redeemed).toHaveLength(0);
  });

  test("invalidate drops a sign-in in progress", async () => {
    const r = rig();
    await r.flow.start();
    await r.flow.invalidate();
    expect(r.pending()).toBeNull();
    expect(await r.flow.receive(code(r), fromServer)).toEqual({ ok: false, reason: "no-pending" });
  });
});

test("a pending sign-in with no recorded tab is invalid and discarded", async () => {
  const r = rig({ openTab: async () => undefined });
  await r.flow.start();
  expect(r.pending()?.tabId).toBeUndefined();
  const res = await r.flow.receive(
    { type: "onlay-auth", code: "c1", state: String(r.pending()?.state) },
    { ...fromServer, tab: { id: 123 } },
  );
  expect(res).toEqual({ ok: false, reason: "no-pending" });
  expect(r.pending()).toBeNull();
  expect(r.redeemed).toHaveLength(0);
});
