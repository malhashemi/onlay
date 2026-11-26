// One WebSocket per space (spec §10), each with its own durable session and
// its own reconnect backoff. The socket constructor and timers are ports so
// the map — open, cap, drop, tag, close-code handling — is unit-tested. A
// space counts as connected, and relays application frames, only once the
// server's `welcome` answered our `hello`: the server drops anything sent
// before that, so `send` refuses it instead of reporting a success.
import {
  CLOSE_ACCESS_REVOKED,
  CLOSE_UPGRADE_REQUIRED,
  LIMITS,
  WS_BEARER_PREFIX,
  WS_SUBPROTOCOL,
} from "@onlay/protocol";

export const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const KEEPALIVE_MS = 20_000;

/** The slice of WebSocket the map uses. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

const OPEN = 1;
const CONNECTING = 0;

export interface SpaceSocketPorts {
  connect(url: string, protocols: string[]): SocketLike;
  /** `ws(s)://…/s/<spaceId>/ws` for the current origin. */
  urlFor(spaceId: string): string;
  token(): string | null;
  /** The `hello` for this space's durable session (async: it bumps stored counters). */
  hello(spaceId: string): Promise<Record<string, unknown>>;
  frame(spaceId: string, raw: unknown): void;
  /** The server welcomed this space's hello: it is connected now. */
  opened(spaceId: string): void;
  /** `wasOpen` false: the handshake failed, so the caller probes why. */
  closed(spaceId: string, code: number, wasOpen: boolean): void;
  upgradeRequired(): void;
  accessRevoked(spaceId: string): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  random(): number;
}

interface Link {
  spaceId: string;
  socket: SocketLike | null;
  backoff: number;
  retry: unknown;
  keepalive: unknown;
  /** Set when the space left the map: nothing reconnects it. */
  dropped: boolean;
  /** The current socket's hello was welcomed: application frames may go. */
  welcomed: boolean;
}

/** Is this raw frame the server's `welcome`? */
function isWelcome(raw: unknown): boolean {
  if (typeof raw !== "string" || !raw.includes('"welcome"')) return false;
  try {
    return (JSON.parse(raw) as { type?: unknown }).type === "welcome";
  } catch {
    return false;
  }
}

export interface SpaceSockets {
  /** Hold exactly these spaces (the first MAX_SPACES_PER_CLIENT): open new ones, close gone ones. */
  sync(spaceIds: readonly string[]): void;
  /** Relay an application frame; false unless the space is connected (welcomed). */
  send(spaceId: string, frame: unknown): boolean;
  isOpen(spaceId: string): boolean;
  anyOpen(): boolean;
  spaces(): string[];
  /** Reconnect every socket now (sign-in, origin change). */
  reconnectAll(): void;
  /** Kick sockets that are neither open nor waiting on a retry. */
  ensure(): void;
  closeAll(): void;
}

function connected(link: Link | undefined): boolean {
  return link?.welcomed === true && link.socket?.readyState === OPEN;
}

export function createSpaceSockets(ports: SpaceSocketPorts): SpaceSockets {
  const links = new Map<string, Link>();
  let halted = false;

  const stopKeepalive = (link: Link): void => {
    if (link.keepalive !== null) ports.clearTimer(link.keepalive);
    link.keepalive = null;
  };

  const scheduleRetry = (link: Link): void => {
    if (link.dropped || halted || link.retry !== null) return;
    const delay = link.backoff + Math.floor(ports.random() * 250);
    link.retry = ports.setTimer(() => {
      link.retry = null;
      open(link);
    }, delay);
    link.backoff = Math.min(link.backoff * 2, BACKOFF_MAX_MS);
  };

  const keepalive = (link: Link): void => {
    stopKeepalive(link);
    link.keepalive = ports.setTimer(function tick() {
      if (link.socket?.readyState === OPEN)
        link.socket.send(JSON.stringify({ v: 1, type: "ping", t: Date.now() }));
      if (!link.dropped && link.socket?.readyState === OPEN)
        link.keepalive = ports.setTimer(tick, KEEPALIVE_MS);
    }, KEEPALIVE_MS);
  };

  function open(link: Link): void {
    if (link.dropped || halted) return;
    const state = link.socket?.readyState;
    if (state === OPEN || state === CONNECTING) return;
    const token = ports.token();
    if (!token) return;
    let socket: SocketLike;
    try {
      socket = ports.connect(ports.urlFor(link.spaceId), [
        WS_SUBPROTOCOL,
        `${WS_BEARER_PREFIX}${token}`,
      ]);
    } catch {
      scheduleRetry(link);
      return;
    }
    link.socket = socket;
    link.welcomed = false;
    let wasOpen = false;
    socket.onopen = () => {
      wasOpen = true;
      link.backoff = BACKOFF_START_MS;
      void ports.hello(link.spaceId).then((hello) => {
        if (link.socket === socket && socket.readyState === OPEN)
          socket.send(JSON.stringify(hello));
      });
      keepalive(link);
    };
    socket.onmessage = (e) => {
      if (link.socket !== socket) return;
      if (!link.welcomed && isWelcome(e.data)) {
        link.welcomed = true;
        ports.opened(link.spaceId);
      }
      ports.frame(link.spaceId, e.data);
    };
    socket.onclose = (e) => {
      if (link.socket !== socket) return;
      link.socket = null;
      link.welcomed = false;
      stopKeepalive(link);
      if (e.code === CLOSE_UPGRADE_REQUIRED) {
        halted = true;
        ports.upgradeRequired();
        return;
      }
      if (e.code === CLOSE_ACCESS_REVOKED) {
        drop(link.spaceId);
        ports.accessRevoked(link.spaceId);
        return;
      }
      ports.closed(link.spaceId, e.code, wasOpen);
      scheduleRetry(link);
    };
    socket.onerror = () => {
      /* onclose always follows; it owns the retry */
    };
  }

  function drop(spaceId: string): void {
    const link = links.get(spaceId);
    if (!link) return;
    links.delete(spaceId);
    link.dropped = true;
    if (link.retry !== null) ports.clearTimer(link.retry);
    link.retry = null;
    stopKeepalive(link);
    const s = link.socket;
    link.socket = null;
    try {
      s?.close(1000, "space dropped");
    } catch {
      /* already closed */
    }
  }

  const fresh = (spaceId: string): Link => ({
    spaceId,
    socket: null,
    backoff: BACKOFF_START_MS,
    retry: null,
    keepalive: null,
    dropped: false,
    welcomed: false,
  });

  return {
    sync(spaceIds) {
      const wanted = [...new Set(spaceIds)].slice(0, LIMITS.MAX_SPACES_PER_CLIENT);
      for (const id of [...links.keys()]) if (!wanted.includes(id)) drop(id);
      for (const id of wanted) {
        let link = links.get(id);
        if (!link) {
          link = fresh(id);
          links.set(id, link);
        }
        open(link);
      }
    },
    send(spaceId, frame) {
      const link = links.get(spaceId);
      const s = link?.socket;
      if (!link?.welcomed || !s || s.readyState !== OPEN) return false;
      s.send(JSON.stringify(frame));
      return true;
    },
    isOpen: (spaceId) => connected(links.get(spaceId)),
    anyOpen: () => [...links.values()].some(connected),
    spaces: () => [...links.keys()],
    reconnectAll() {
      halted = false;
      for (const link of links.values()) {
        if (link.retry !== null) ports.clearTimer(link.retry);
        link.retry = null;
        stopKeepalive(link);
        const s = link.socket;
        link.socket = null;
        link.welcomed = false;
        try {
          s?.close(1000, "reconnect");
        } catch {
          /* already closed */
        }
        link.backoff = BACKOFF_START_MS;
        open(link);
      }
    },
    ensure() {
      for (const link of links.values()) if (link.retry === null) open(link);
    },
    closeAll() {
      for (const id of [...links.keys()]) drop(id);
      halted = false;
    },
  };
}
