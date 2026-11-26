// The per-space live client's laws: one socket per space with the `onlay.v1`
// subprotocol and a hello naming the protocol; ticks coalesce into refresh
// rounds; a lost socket retries with backoff; visibility owns the sockets;
// 4426 and 4403 stop the socket and call out; the space list can change. All
// timings injected; no DOM.
import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "@onlay/protocol";
import {
  createLive,
  type DocLike,
  frameType,
  type Live,
  type LiveOpts,
  liveSocketUrl,
  type WsLike,
} from "./live";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeWs implements WsLike {
  readyState = 0;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  sent: string[] = [];
  closedWith: number | null = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closedWith = code ?? 1000;
    this.readyState = 3;
  }
  /* test drivers */
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  frame(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  die(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function stubDoc(state = "visible"): DocLike & { setVisibility(v: string): void } {
  const listeners = new Set<() => void>();
  return {
    visibilityState: state,
    addEventListener(_t: string, cb: () => void) {
      listeners.add(cb);
    },
    removeEventListener(_t: string, cb: () => void) {
      listeners.delete(cb);
    },
    setVisibility(v: string) {
      (this as { visibilityState: string }).visibilityState = v;
      for (const cb of listeners) cb();
    },
  };
}

function harness(opts?: Partial<LiveOpts>) {
  const sockets: FakeWs[] = [];
  const rounds: number[] = [];
  const calls = { upgrade: 0, access: 0 };
  const doc = stubDoc();
  const live: Live = createLive({
    spaceIds: ["s_one"],
    refresh: () => {
      rounds.push(Date.now());
      return Promise.resolve(true);
    },
    onUpgradeRequired: () => {
      calls.upgrade += 1;
    },
    onAccessChanged: () => {
      calls.access += 1;
    },
    wsFactory: (url, protocols) => {
      const ws = new FakeWs(url, protocols);
      sockets.push(ws);
      return ws;
    },
    wsUrl: (id) => `wss://onlay.test/s/${id}/ws`,
    doc,
    debounceMs: 5,
    maxWaitMs: 20,
    backoffMinMs: 10,
    backoffMaxMs: 40,
    ...opts,
  });
  return { live, sockets, rounds, calls, doc };
}

describe("frameType", () => {
  test("reads the type of a JSON frame and refuses junk", () => {
    expect(frameType('{"v":1,"type":"tick"}')).toBe("tick");
    expect(frameType("not json")).toBeNull();
    expect(frameType(42)).toBeNull();
    expect(frameType(`{"type":"tick","pad":"${"x".repeat(5000)}"}`)).toBeNull();
  });
});

describe("sockets", () => {
  test("one socket per space, onlay.v1, and a hello naming the protocol", () => {
    const h = harness({ spaceIds: ["s_one", "s_two"] });
    expect(h.sockets.map((s) => s.url)).toEqual([
      "wss://onlay.test/s/s_one/ws",
      "wss://onlay.test/s/s_two/ws",
    ]);
    expect(h.sockets[0]?.protocols).toEqual(["onlay.v1"]);
    h.sockets[0]?.open();
    const hello = JSON.parse(h.sockets[0]?.sent[0] ?? "{}");
    expect(hello.type).toBe("hello");
    expect(hello.protocol).toBe(PROTOCOL_VERSION);
    h.live.dispose();
  });

  test("paused (a sign-out in flight): sockets close and nothing asks or reconnects until resumed", async () => {
    const h = harness();
    const ws = h.sockets[0] as FakeWs;
    ws.open();
    await sleep(30);
    const before = h.rounds.length;
    h.live.pause();
    expect(ws.closedWith).not.toBeNull();
    // The server's revocation closing a socket, a tick, a visibility change: no round, no socket.
    ws.die(1006);
    h.live.requestRefresh();
    h.doc.setVisibility("visible");
    await sleep(80);
    expect(h.rounds.length).toBe(before);
    expect(h.sockets).toHaveLength(1);
    h.live.resume();
    expect(h.sockets).toHaveLength(2);
    h.live.dispose();
  });

  test("ticks coalesce into one refresh round", async () => {
    const h = harness();
    const ws = h.sockets[0] as FakeWs;
    ws.open();
    await sleep(30);
    const before = h.rounds.length; // the connect catch-up
    expect(before).toBe(1);
    for (let i = 0; i < 5; i++) ws.frame({ v: 1, type: "tick" });
    await sleep(30);
    expect(h.rounds.length).toBe(before + 1);
    h.live.dispose();
  });

  test("access-changed refreshes like a tick, and the socket stays", async () => {
    const h = harness();
    const ws = h.sockets[0] as FakeWs;
    ws.open();
    await sleep(30);
    const before = h.rounds.length;
    ws.frame({ v: 1, type: "access-changed" });
    await sleep(30);
    expect(h.rounds.length).toBe(before + 1);
    expect(h.sockets.length).toBe(1);
    h.live.dispose();
  });

  test("frames other than tick do not refresh", async () => {
    const h = harness();
    const ws = h.sockets[0] as FakeWs;
    ws.open();
    await sleep(30);
    const before = h.rounds.length;
    ws.frame({ v: 1, type: "origins", origins: [] });
    ws.frame({ v: 1, type: "welcome" });
    await sleep(30);
    expect(h.rounds.length).toBe(before);
    h.live.dispose();
  });

  test("a lost socket reconnects with growing backoff", async () => {
    const h = harness();
    (h.sockets[0] as FakeWs).die();
    expect(h.sockets.length).toBe(1);
    await sleep(15);
    expect(h.sockets.length).toBe(2); // after ~10ms
    (h.sockets[1] as FakeWs).die();
    await sleep(12);
    expect(h.sockets.length).toBe(2); // the second wait is ~20ms
    await sleep(15);
    expect(h.sockets.length).toBe(3);
    h.live.dispose();
  });

  test("a socket refused before opening asks for a refresh round (401 lives on HTTP)", async () => {
    const h = harness();
    (h.sockets[0] as FakeWs).die();
    await sleep(30);
    expect(h.rounds.length).toBeGreaterThanOrEqual(1);
    h.live.dispose();
  });

  test("healthy only while every socket is open", () => {
    const h = harness({ spaceIds: ["s_one", "s_two"] });
    expect(h.live.healthy()).toBe(false);
    h.sockets[0]?.open();
    expect(h.live.healthy()).toBe(false);
    h.sockets[1]?.open();
    expect(h.live.healthy()).toBe(true);
    h.live.dispose();
  });

  test("hidden closes the sockets, visible reconnects at once", () => {
    const h = harness();
    const first = h.sockets[0] as FakeWs;
    first.open();
    h.doc.setVisibility("hidden");
    expect(first.closedWith).toBe(1000);
    expect(h.sockets.length).toBe(1);
    h.doc.setVisibility("visible");
    expect(h.sockets.length).toBe(2);
    h.live.dispose();
  });

  test("4426 stops the socket and asks for a reload", async () => {
    const h = harness();
    (h.sockets[0] as FakeWs).die(4426);
    await sleep(30);
    expect(h.calls.upgrade).toBe(1);
    expect(h.sockets.length).toBe(1);
    h.live.dispose();
  });

  test("4403 stops the socket and reports the access change", async () => {
    const h = harness();
    (h.sockets[0] as FakeWs).die(4403);
    await sleep(30);
    expect(h.calls.access).toBe(1);
    expect(h.sockets.length).toBe(1);
    h.live.dispose();
  });

  test("a revoked space reopens when a later list still names it", async () => {
    const h = harness();
    (h.sockets[0] as FakeWs).die(4403);
    await sleep(5);
    h.live.setSpaces(["s_one"]);
    expect(h.sockets.length).toBe(2);
    h.live.dispose();
  });

  test("setSpaces opens new spaces and closes dropped ones", () => {
    const h = harness();
    const one = h.sockets[0] as FakeWs;
    h.live.setSpaces(["s_two"]);
    expect(one.closedWith).toBe(1000);
    expect(h.sockets[1]?.url).toBe("wss://onlay.test/s/s_two/ws");
    h.live.dispose();
  });

  test("dispose closes everything and stops retries", async () => {
    const h = harness();
    const ws = h.sockets[0] as FakeWs;
    h.live.dispose();
    expect(ws.closedWith).toBe(1000);
    await sleep(30);
    expect(h.sockets.length).toBe(1);
  });
});

test("the socket URL names the person this tab is", () => {
  expect(liveSocketUrl({ protocol: "https:", host: "app.onlay.dev" }, "s_a", "p_x")).toBe(
    "wss://app.onlay.dev/s/s_a/ws?person=p_x",
  );
  expect(liveSocketUrl({ protocol: "http:", host: "localhost:8787" }, "s_a")).toBe(
    "ws://localhost:8787/s/s_a/ws",
  );
});
