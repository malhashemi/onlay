/**
 * An in-process space for `bun test`: the real runtime over `bun:sqlite`, a
 * manual clock and recording sockets, with helpers to call it as the edge
 * would (a caller header per request) and to connect sockets that said hello.
 */
import {
  ACCESS_EPOCH_HEADER,
  CALLER_HEADER,
  type Caller,
  type ClientClass,
  encodeCaller,
  encodeSpaceFacts,
  INTERNAL_HEADER,
  PROTOCOL_VERSION,
  SPACE_HEADER,
} from "@onlay/protocol";
import type { DirectoryPort, SocketAttachment } from "../runtime";
import { createSpace, type Space } from "../space";
import { FakeSockets, ManualClock } from "./fakes";
import { SqliteDb } from "./sqlite-db";
import { TEST_VAPID } from "./test-vapid";

export const SID = "s_aaaaaaaaaaaaaaaaaaaa";
export const ADA = "p_adaadaadaadaadaadaad";
export const BEA = "p_beabeabeabeabeabeabe";
export const GUS = "p_gusgusgusgusgusgusgu";
export const PAGE = "https://example.com/pricing";
/** The generation every test caller's credential was stamped with. */
const CREDENTIAL_GENERATION = 0;

const NAMES: Record<string, string> = { [ADA]: "Ada", [BEA]: "Bea", [GUS]: "Gus" };

export function member(
  personId: string,
  cls: ClientClass = "full",
  role: "admin" | "member" = "member",
): Caller {
  return caller(personId, cls, { kind: "member", role });
}

export function guest(
  personId: string,
  interactionIds: string[],
  cls: ClientClass = "interaction",
): Caller {
  return caller(personId, cls, { kind: "guest", interactionIds });
}

function caller(personId: string, cls: ClientClass, access: Caller["access"]): Caller {
  const name = NAMES[personId] ?? "Someone";
  return {
    personId,
    name,
    initials: name.slice(0, 1),
    tint: "#336699",
    class: cls,
    access,
    credentialId: `cred-${personId}-${cls}`,
    // As the edge always sends them: the epoch it read, and the credential's generation.
    accessEpoch: 0,
    credentialGeneration: CREDENTIAL_GENERATION,
  };
}

/** Parsed JSON bodies and frames, read loosely by tests. */
// biome-ignore lint/suspicious/noExplicitAny: tests read response bodies loosely
export type Json = any;

export type TestSocket = ReturnType<FakeSockets<SocketAttachment>["connect"]>;

export interface Harness {
  space: Space;
  db: SqliteDb;
  clock: ManualClock;
  sockets: FakeSockets<SocketAttachment>;
  /** Calls the space as the edge would. */
  request(
    who: Caller | null,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: Json }>;
  /** A socket admitted for `who` that has said hello; its frames are cleared. */
  connect(who: Caller, opts?: { protocol?: number }): TestSocket;
  /** Sends one frame on a socket; a promise when it waits for a re-validation. */
  send(socket: TestSocket, frame: Record<string, unknown>): Promise<void> | undefined;
  /** An internal control call from the Worker, optionally carrying the space's access epoch. */
  internal(
    method: string,
    path: string,
    body?: unknown,
    epoch?: number,
  ): Promise<{ status: number; body: Json }>;
  /** A fresh runtime over the same database: what a Durable Object eviction looks like. */
  evict(): void;
}

export function makeHarness(
  opts: {
    allowHttpPush?: boolean;
    fetch?: typeof fetch;
    vapid?: false;
    sharesGone?: (ids: string[]) => Promise<void>;
    directory?: DirectoryPort;
  } = {},
): Harness {
  const db = new SqliteDb();
  const clock = new ManualClock();
  const sockets = new FakeSockets<SocketAttachment>();
  const build = () =>
    createSpace({
      db,
      sockets,
      clock,
      spaceId: SID,
      ...(opts.vapid === false ? {} : { vapid: TEST_VAPID }),
      ...(opts.allowHttpPush ? { allowHttpPush: true } : {}),
      ...(opts.sharesGone ? { sharesGone: opts.sharesGone } : {}),
      ...(opts.directory ? { directory: opts.directory } : {}),
      ...(opts.fetch ? { fetch: (url, init) => (opts.fetch as typeof fetch)(url, init) } : {}),
    });
  const h: Harness = {
    space: build(),
    db,
    clock,
    sockets,
    async request(who, method, path, body, headers = {}) {
      const req = new Request(`https://space${path}`, {
        method,
        headers: {
          ...(who ? { [CALLER_HEADER]: encodeCaller(who) } : {}),
          "Onlay-Protocol": String(PROTOCOL_VERSION),
          [SPACE_HEADER]: encodeSpaceFacts({ kind: "workspace", name: "acme" }),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        ...(body !== undefined
          ? { body: body instanceof Uint8Array ? new Uint8Array(body) : JSON.stringify(body) }
          : {}),
      });
      const res = await h.space.fetch(req);
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // a binary or empty body stays text
      }
      return { status: res.status, body: parsed };
    },
    connect(who, o = {}) {
      const socket = sockets.connect();
      const admitted = h.space.admitSocket(
        new Request("https://space/ws", {
          headers: {
            [CALLER_HEADER]: encodeCaller(who),
            [SPACE_HEADER]: encodeSpaceFacts({ kind: "workspace", name: "acme" }),
            Upgrade: "websocket",
            "Sec-WebSocket-Protocol": "onlay.v1",
          },
        }),
      );
      if (!admitted.ok) throw new Error(`socket refused: ${admitted.response.status}`);
      socket.setAttachment(admitted.attachment);
      h.send(socket, {
        v: 1,
        type: "hello",
        sessionId: crypto.randomUUID(),
        bootCount: 1,
        swRestarts: 0,
        connects: 1,
        protocol: o.protocol ?? PROTOCOL_VERSION,
      });
      if (!socket.closed) socket.sent.length = 0;
      return socket;
    },
    send(socket, frame) {
      return h.space.onMessage(socket, JSON.stringify(frame));
    },
    async internal(method, path, body, epoch) {
      const res = await h.space.fetch(
        new Request(`https://space${path}`, {
          method,
          headers: {
            [INTERNAL_HEADER]: "1",
            "Content-Type": "application/json",
            ...(epoch !== undefined ? { [ACCESS_EPOCH_HEADER]: String(epoch) } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }),
      );
      return { status: res.status, body: await res.json() };
    },
    evict() {
      h.space = build();
    },
  };
  return h;
}

/** Frames of one type a socket received. */
export function framesOf<T = Json>(socket: TestSocket, type: string): T[] {
  return socket.frames().filter((f) => (f as { type?: string }).type === type) as T[];
}
