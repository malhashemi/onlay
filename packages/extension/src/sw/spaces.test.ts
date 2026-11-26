import { expect, test } from "bun:test";
import { CLOSE_ACCESS_REVOKED, CLOSE_UPGRADE_REQUIRED, LIMITS } from "@onlay/protocol";
import {
  authHeaders,
  normalizeOrigin,
  resolveOrigin,
  resolveSiteOrigin,
  spaceSocketUrl,
  storedTokenUsable,
  threadLink,
} from "./server";
import { BACKOFF_START_MS, createSpaceSockets, type SocketLike } from "./spaces";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  closedWith: number | undefined;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closedWith = code;
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function rig(token: string | null = "onl_tok") {
  const sockets: FakeSocket[] = [];
  const frames: Array<[string, unknown]> = [];
  const closed: Array<[string, number, boolean]> = [];
  const revoked: string[] = [];
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  let upgrades = 0;
  const map = createSpaceSockets({
    connect: (url, protocols) => {
      const s = new FakeSocket(url, protocols);
      sockets.push(s);
      return s;
    },
    urlFor: (id) => `wss://app.onlay.dev/s/${id}/ws`,
    token: () => token,
    hello: async (id) => ({ v: 1, type: "hello", space: id }),
    frame: (id, raw) => frames.push([id, raw]),
    opened: () => {},
    closed: (id, code, wasOpen) => closed.push([id, code, wasOpen]),
    upgradeRequired: () => {
      upgrades++;
    },
    accessRevoked: (id) => revoked.push(id),
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { live: boolean }).live = false;
    },
    random: () => 0,
  });
  const byUrl = (id: string): FakeSocket[] => sockets.filter((s) => s.url.includes(id));
  return { map, sockets, frames, closed, revoked, timers, byUrl, upgrades: () => upgrades };
}

const A = "s_aaaaaaaaaaaaaaaaaaaa";
const B = "s_bbbbbbbbbbbbbbbbbbbb";

test("each space gets its own socket with the onlay.v1 and bearer subprotocols", () => {
  const r = rig();
  r.map.sync([A, B]);
  expect(r.sockets.map((s) => s.url)).toEqual([
    `wss://app.onlay.dev/s/${A}/ws`,
    `wss://app.onlay.dev/s/${B}/ws`,
  ]);
  expect(r.sockets[0]?.protocols).toEqual(["onlay.v1", "bearer.onl_tok"]);
});

test("no token, no sockets", () => {
  const r = rig(null);
  r.map.sync([A]);
  expect(r.sockets).toHaveLength(0);
});

test("the map is capped at MAX_SPACES_PER_CLIENT", () => {
  const r = rig();
  const ids = Array.from(
    { length: LIMITS.MAX_SPACES_PER_CLIENT + 3 },
    (_, i) => `s_${"a".repeat(19)}${"abcdefghijklmnopqrstuvwxyz"[i]}`,
  );
  r.map.sync(ids);
  expect(r.map.spaces()).toHaveLength(LIMITS.MAX_SPACES_PER_CLIENT);
  expect(r.sockets).toHaveLength(LIMITS.MAX_SPACES_PER_CLIENT);
});

test("open sends the space's hello; frames come back tagged with their space", async () => {
  const r = rig();
  r.map.sync([A, B]);
  r.sockets[1]?.open();
  await Promise.resolve();
  await Promise.resolve();
  expect(JSON.parse(r.sockets[1]?.sent[0] ?? "{}")).toEqual({ v: 1, type: "hello", space: B });
  r.sockets[1]?.onmessage?.({ data: "frame-b" });
  r.sockets[0]?.onmessage?.({ data: "frame-a" });
  expect(r.frames).toEqual([
    [B, "frame-b"],
    [A, "frame-a"],
  ]);
});

const WELCOME = JSON.stringify({ v: 1, type: "welcome" });

test("a space is connected, and relays application frames, only after welcome", async () => {
  const r = rig();
  r.map.sync([A]);
  r.sockets[0]?.open();
  // Open but the hello has not even gone yet: refused, never a false success.
  expect(r.map.isOpen(A)).toBe(false);
  expect(r.map.send(A, { type: "interaction-create" })).toBe(false);
  await Promise.resolve();
  await Promise.resolve();
  // Hello sent, no welcome yet: still refused.
  expect(r.map.send(A, { type: "interaction-create" })).toBe(false);
  expect(r.map.anyOpen()).toBe(false);
  r.sockets[0]?.onmessage?.({ data: WELCOME });
  expect(r.map.isOpen(A)).toBe(true);
  expect(r.map.send(A, { type: "interaction-create" })).toBe(true);
  // A reconnect starts over: no frames until the new socket is welcomed.
  r.sockets[0]?.serverClose(1006);
  expect(r.map.send(A, { type: "x" })).toBe(false);
});

test("send routes to the named space only, and refuses a closed one", () => {
  const r = rig();
  r.map.sync([A, B]);
  r.sockets[0]?.open();
  r.sockets[0]?.onmessage?.({ data: WELCOME });
  expect(r.map.send(A, { type: "x" })).toBe(true);
  expect(r.map.send(B, { type: "x" })).toBe(false);
  expect(r.map.send("s_unknownunknownunkno", { type: "x" })).toBe(false);
  expect(r.sockets[0]?.sent[r.sockets[0].sent.length - 1]).toBe('{"type":"x"}');
  expect(r.sockets[1]?.sent).toEqual([]);
});

test("a space leaving the list closes its socket and never reconnects", () => {
  const r = rig();
  r.map.sync([A, B]);
  r.sockets[0]?.open();
  r.map.sync([B]);
  expect(r.sockets[0]?.closedWith).toBe(1000);
  expect(r.map.spaces()).toEqual([B]);
  r.sockets[0]?.serverClose(1000); // late close event: ignored
  expect(r.timers.filter((t) => t.live && t.ms >= BACKOFF_START_MS && t.ms < 2_000)).toHaveLength(
    0,
  );
});

test("an ordinary close reconnects that space alone with backoff", () => {
  const r = rig();
  r.map.sync([A, B]);
  r.sockets[0]?.open();
  r.sockets[1]?.open();
  r.sockets[0]?.serverClose(1006);
  expect(r.closed).toEqual([[A, 1006, true]]);
  const retry = r.timers.find((t) => t.live && t.ms === BACKOFF_START_MS);
  expect(retry).toBeDefined();
  retry?.fn();
  expect(r.byUrl(A)).toHaveLength(2);
  expect(r.byUrl(B)).toHaveLength(1);
});

test("CLOSE_ACCESS_REVOKED drops the space and reports it, without a retry", () => {
  const r = rig();
  r.map.sync([A, B]);
  r.sockets[0]?.open();
  r.sockets[0]?.serverClose(CLOSE_ACCESS_REVOKED);
  expect(r.revoked).toEqual([A]);
  expect(r.map.spaces()).toEqual([B]);
  expect(r.closed).toEqual([]);
});

test("CLOSE_UPGRADE_REQUIRED halts every reconnect until reconnectAll", () => {
  const r = rig();
  r.map.sync([A, B]);
  r.sockets[0]?.serverClose(CLOSE_UPGRADE_REQUIRED);
  expect(r.upgrades()).toBe(1);
  r.sockets[1]?.serverClose(1006);
  expect(r.timers.filter((t) => t.live && t.ms === BACKOFF_START_MS)).toHaveLength(0);
  r.map.ensure();
  expect(r.sockets).toHaveLength(2);
  r.map.reconnectAll();
  expect(r.sockets).toHaveLength(4);
});

test("closeAll closes everything and forgets the spaces", () => {
  const r = rig();
  r.map.sync([A, B]);
  r.map.closeAll();
  expect(r.map.spaces()).toEqual([]);
  expect(r.sockets.every((s) => s.closedWith === 1000)).toBe(true);
});

test("server helpers: origin override, space socket URL, thread link, headers", () => {
  expect(normalizeOrigin("http://localhost:8787/ignored")).toBe("http://localhost:8787");
  expect(normalizeOrigin("javascript:alert(1)")).toBeNull();
  expect(resolveOrigin(undefined)).toBe("https://app.onlay.dev");
  expect(resolveOrigin("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
  expect(spaceSocketUrl("http://localhost:8787", A)).toBe(`ws://localhost:8787/s/${A}/ws`);
  expect(spaceSocketUrl("https://app.onlay.dev", A)).toBe(`wss://app.onlay.dev/s/${A}/ws`);
  expect(threadLink("https://app.onlay.dev", A, "i1")).toBe(
    `https://app.onlay.dev/app/#/t/${A}/i1`,
  );
  expect(authHeaders("onl_t", true)).toEqual({
    "Onlay-Protocol": "2",
    authorization: "Bearer onl_t",
    "content-type": "application/json",
  });
});

test("a production build ignores the stored origin override; dev and e2e builds keep it", () => {
  expect(resolveOrigin("http://127.0.0.1:8787", true)).toBe("https://app.onlay.dev");
  expect(resolveOrigin("https://evil.example", true)).toBe("https://app.onlay.dev");
  expect(resolveOrigin("http://127.0.0.1:8787", false)).toBe("http://127.0.0.1:8787");
});

test("the public site: its own origin in production, the one server's under a dev override", () => {
  expect(resolveSiteOrigin(undefined)).toBe("https://onlay.dev");
  expect(resolveSiteOrigin(undefined, true)).toBe("https://onlay.dev");
  expect(resolveSiteOrigin("http://127.0.0.1:8787", true)).toBe("https://onlay.dev");
  expect(resolveSiteOrigin("https://evil.example", true)).toBe("https://onlay.dev");
  // A dev or e2e server serves everything on one origin.
  expect(resolveSiteOrigin("http://127.0.0.1:8787", false)).toBe("http://127.0.0.1:8787");
  expect(resolveSiteOrigin("javascript:alert(1)", false)).toBe("https://onlay.dev");
});

test("a stored token without its issuing origin, or from another origin, is not used", () => {
  expect(storedTokenUsable("onl_x", "https://app.onlay.dev", "https://app.onlay.dev")).toBe(true);
  expect(storedTokenUsable("onl_x", undefined, "https://app.onlay.dev")).toBe(false);
  expect(storedTokenUsable("onl_x", "http://localhost:8787", "https://app.onlay.dev")).toBe(false);
  expect(storedTokenUsable(undefined, "https://app.onlay.dev", "https://app.onlay.dev")).toBe(
    false,
  );
});
