// Live freshness: one WebSocket per space the person can see (`/s/<id>/ws`,
// subprotocol `onlay.v1`; the session cookie authenticates the upgrade). The
// server sends payload-less `tick` frames scoped to what this person may see;
// a tick says when, never what, so every tick becomes a coalesced refresh
// round that refetches through the HTTP allowlist.
//
// Lifecycle laws, carried over from the stream this replaced: a hidden tab
// holds no socket open; becoming visible reconnects at once; a lost socket
// retries with exponential backoff (2–30 s); every refresh cause — tick,
// connect catch-up, focus, the fallback interval — funnels through one
// coalescer so a burst repaints once. Each socket owns a generation counter:
// a handler that fires under a stale generation does nothing, so rapid
// hidden→visible flips or a space list change can never double-connect.
import {
  CLOSE_ACCESS_REVOKED,
  CLOSE_UPGRADE_REQUIRED,
  PROTOCOL_VERSION,
  WS_SUBPROTOCOL,
} from "@onlay/protocol";

/** The slice of WebSocket the client uses (stubbed in tests). */
export interface WsLike {
  readonly readyState: number;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: { code: number }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  send(data: string): void;
  close(code?: number): void;
}

export type WsFactory = (url: string, protocols: string[]) => WsLike;

/** The slice of Document the lifecycle needs (stubbed in tests). */
export interface DocLike {
  visibilityState: string;
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
}

export interface LiveOpts {
  spaceIds: readonly string[];
  /** The person this tab is; rides the socket URL as `person` so the server can refuse another. */
  personId?: string;
  /** One refresh round; true = live server truth reached. */
  refresh(): Promise<boolean>;
  /** A socket closed with 4426: this build is too old. */
  onUpgradeRequired(): void;
  /** A socket closed with 4403: the person lost a space; reload `/api/me`. */
  onAccessChanged(): void;
  wsFactory?: WsFactory;
  /** The socket URL for a space; production derives it from `location`. */
  wsUrl?: (spaceId: string) => string;
  doc?: DocLike;
  debounceMs?: number;
  maxWaitMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
}

export interface Live {
  /** Every space's socket is open (the fallback interval stands down). */
  healthy(): boolean;
  /** The last completed refresh round reached live truth. */
  lastRoundOk(): boolean;
  /** Feed any refresh cause through the coalescer. */
  requestRefresh(): void;
  /** The person's spaces changed: open sockets for new ones, close the rest. */
  setSpaces(spaceIds: readonly string[]): void;
  /** Close every socket and ask nothing until `resume` (a sign-out in flight). */
  pause(): void;
  resume(): void;
  dispose(): void;
}

const DEBOUNCE_MS = 250;
const MAX_WAIT_MS = 1_000;
const BACKOFF_MIN_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;
const OPEN = 1;
const MAX_FRAME_CHARS = 4_096;

/** The space's socket, naming the person this tab is (`?person=`). */
export function liveSocketUrl(
  loc: { protocol: string; host: string },
  spaceId: string,
  personId?: string,
): string {
  const scheme = loc.protocol === "https:" ? "wss:" : "ws:";
  const q = personId ? `?person=${encodeURIComponent(personId)}` : "";
  return `${scheme}//${loc.host}/s/${spaceId}/ws${q}`;
}

function newSessionId(): string {
  return crypto.randomUUID();
}

/** The frame type of a server message, or null for anything unreadable. */
export function frameType(data: unknown): string | null {
  if (typeof data !== "string" || data.length > MAX_FRAME_CHARS) return null;
  try {
    const msg = JSON.parse(data) as { type?: unknown };
    return typeof msg.type === "string" ? msg.type : null;
  } catch {
    return null;
  }
}

interface SpaceSocket {
  connect(): void;
  suspend(): void;
  open(): boolean;
  /** Closed 4403; a later space list still naming it opens a fresh socket. */
  revoked(): boolean;
  stop(): void;
}

export function createLive(opts: LiveOpts): Live {
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  const maxWaitMs = opts.maxWaitMs ?? MAX_WAIT_MS;
  const backoffMin = opts.backoffMinMs ?? BACKOFF_MIN_MS;
  const backoffMax = opts.backoffMaxMs ?? BACKOFF_MAX_MS;
  const factory: WsFactory =
    opts.wsFactory ?? ((url, protocols) => new WebSocket(url, protocols) as unknown as WsLike);
  const wsUrl = opts.wsUrl ?? ((id: string) => liveSocketUrl(location, id, opts.personId));
  const doc = opts.doc ?? (document as DocLike);

  let disposed = false;
  let paused = false;
  const visible = (): boolean => doc.visibilityState === "visible";

  /* ── the coalescer: every refresh cause lands here ─────────────────── */

  let roundOk = true;
  let dirty = false;
  let running = false;
  let debTimer: ReturnType<typeof setTimeout> | undefined;
  let firstDirtyAt = 0;

  function requestRefresh(): void {
    if (disposed || paused) return;
    dirty = true;
    if (running) return; // the running loop drains `dirty` when it finishes
    const now = Date.now();
    if (debTimer === undefined) firstDirtyAt = now;
    else clearTimeout(debTimer);
    // Trailing debounce bounded by max-wait: a burst repaints once, a
    // sustained burst still repaints within maxWaitMs of its first cause.
    const wait = Math.min(debounceMs, Math.max(0, firstDirtyAt + maxWaitMs - now));
    debTimer = setTimeout(() => void run(), wait);
  }

  async function run(): Promise<void> {
    debTimer = undefined;
    running = true;
    while (dirty && !disposed) {
      dirty = false; // a cause landing mid-round re-sets it → one more round
      try {
        roundOk = await opts.refresh();
      } catch {
        roundOk = false;
      }
    }
    running = false;
  }

  /* ── one socket per space ──────────────────────────────────────────── */

  function spaceSocket(spaceId: string): SpaceSocket {
    let gen = 0;
    let ws: WsLike | null = null;
    let attempts = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let accessLost = false;
    const sessionId = newSessionId();
    let connects = 0;

    function clearRetry(): void {
      if (retry !== undefined) clearTimeout(retry);
      retry = undefined;
    }

    function drop(): void {
      gen += 1;
      const old = ws;
      ws = null;
      if (old) {
        old.onopen = old.onmessage = old.onclose = old.onerror = null;
        try {
          old.close(1000);
        } catch {
          // already closed
        }
      }
    }

    function scheduleReconnect(): void {
      if (disposed || stopped || retry !== undefined) return;
      const delay = Math.min(backoffMax, backoffMin * 2 ** attempts);
      attempts += 1;
      retry = setTimeout(() => {
        retry = undefined;
        connect();
      }, delay);
    }

    function connect(): void {
      if (disposed || paused || stopped || ws !== null || !visible()) return;
      clearRetry();
      const g = ++gen;
      let opened = false;
      let sock: WsLike;
      try {
        sock = factory(wsUrl(spaceId), [WS_SUBPROTOCOL]);
      } catch {
        scheduleReconnect();
        return;
      }
      ws = sock;
      sock.onopen = () => {
        if (g !== gen) return;
        opened = true;
        attempts = 0;
        connects += 1;
        sock.send(
          JSON.stringify({
            v: 1,
            type: "hello",
            sessionId,
            bootCount: 0,
            swRestarts: 0,
            connects,
            protocol: PROTOCOL_VERSION,
          }),
        );
        // Catch-up: one round covers whatever moved while this socket was down.
        requestRefresh();
      };
      sock.onmessage = (e) => {
        if (g !== gen) return;
        const type = frameType(e.data);
        // `access-changed`: part of this person's access here went while the
        // socket stays; a refresh round re-reads and drops what is gone.
        if (type === "tick" || type === "directory-updated" || type === "access-changed") {
          requestRefresh();
        }
      };
      sock.onerror = () => {
        // onclose follows; it owns the retry.
      };
      sock.onclose = (e) => {
        if (g !== gen) return;
        ws = null;
        if (e.code === CLOSE_UPGRADE_REQUIRED) {
          stopped = true;
          opts.onUpgradeRequired();
          return;
        }
        if (e.code === CLOSE_ACCESS_REVOKED) {
          stopped = true;
          accessLost = true;
          opts.onAccessChanged();
          return;
        }
        // A socket refused before it opened may be a signed-out session — the
        // upgrade hides the status, so a refresh round asks over HTTP, where
        // a 401 ends the session in this tab (sign-out.ts).
        if (!opened) requestRefresh();
        scheduleReconnect();
      };
    }

    return {
      connect,
      suspend: () => {
        clearRetry();
        drop();
      },
      open: () => ws !== null && ws.readyState === OPEN,
      revoked: () => accessLost,
      stop: () => {
        stopped = true;
        clearRetry();
        drop();
      },
    };
  }

  const sockets = new Map<string, SpaceSocket>();

  function setSpaces(spaceIds: readonly string[]): void {
    if (disposed) return;
    const want = new Set(spaceIds);
    for (const [id, s] of sockets) {
      if (!want.has(id) || s.revoked()) {
        s.stop();
        sockets.delete(id);
      }
    }
    for (const id of want) {
      if (sockets.has(id)) continue;
      const s = spaceSocket(id);
      sockets.set(id, s);
      s.connect();
    }
  }

  /* ── visibility + lifetime ─────────────────────────────────────────── */

  const onVis = (): void => {
    if (disposed || paused) return;
    for (const s of sockets.values()) {
      if (visible())
        s.connect(); // now, not at the tail of a backoff window
      else s.suspend(); // a hidden phone holds no socket open
    }
  };
  doc.addEventListener("visibilitychange", onVis);

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    doc.removeEventListener("visibilitychange", onVis);
    for (const s of sockets.values()) s.stop();
    sockets.clear();
    if (debTimer !== undefined) clearTimeout(debTimer);
    debTimer = undefined;
    dirty = false;
  }

  setSpaces(opts.spaceIds);

  function pause(): void {
    if (disposed) return;
    paused = true;
    for (const s of sockets.values()) s.suspend();
    if (debTimer !== undefined) clearTimeout(debTimer);
    debTimer = undefined;
    dirty = false;
  }

  function resume(): void {
    if (disposed || !paused) return;
    paused = false;
    for (const s of sockets.values()) s.connect();
  }

  return {
    pause,
    resume,
    healthy: () => sockets.size > 0 && [...sockets.values()].every((s) => s.open()),
    lastRoundOk: () => roundOk,
    requestRefresh,
    setSpaces,
    dispose,
  };
}
