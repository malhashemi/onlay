// Frames of one tab working as one page (round 3, F-1 … F-4). The top frame
// holds the command bar, the composers and the thread; a child frame owns the
// blocks in its own document and everything bound to its own URL. They talk
// only through here, and every message names the frames involved by what the
// browser reports for its sender (tab, frame and document ids, the frame's
// URL), never by ids the message claims: a page cannot reach
// `chrome.runtime`, and a content script can only reach frames of its own tab.
//
// Content → service worker:
//   from the top frame:  framePickAll, frameCall
//   from a child frame:  framePicked, framePlaced, frameOpen, frameReport, frameGone,
//                        frameCommand
//   from any child frame, one that owns no blocks included: framePickHint
//   from either:         framePickEnd
// Service worker → content: pick-start, pick-end (every frame of the tab;
//   `cancel` when a frame ended the pick rather than completed it),
//   pick-hint (the top frame; it carries nothing but the pick's id),
//   frame-picked, frame-placed, frame-open, frame-report, frame-gone, frame-command (the top
//   frame, each stamped with `frame: {documentId, url}`), frame-call (one
//   child document, addressed by the document id the service worker stamped).
import { AnchorSchema, LIMITS } from "@onlay/protocol";
import { isWebAddress } from "../overlay/frame-owner";
import { redactUrl } from "../overlay/redact-url";

/** A child document the service worker has heard from, under its tab. */
export interface FrameEntry {
  frameId: number;
  url: string;
}
/** tabId → documentId → entry. */
export type FrameRegistry = Record<string, Record<string, FrameEntry>>;

/** What the relay is told about the sender, exactly as the browser reports it. */
export interface FrameSender {
  tab?: { id?: number | undefined; url?: string | undefined } | undefined;
  frameId?: number | undefined;
  documentId?: string | undefined;
  documentLifecycle?: string | undefined;
  url?: string | undefined;
  /** The sender document's origin; "null" when it is opaque. */
  origin?: string | undefined;
}

export interface FramePorts {
  send(
    tabId: number,
    msg: Record<string, unknown>,
    to?: { frameId?: number; documentId?: string },
  ): Promise<unknown>;
  load(): Promise<FrameRegistry>;
  save(next: FrameRegistry): Promise<void>;
  /** The account generation the service worker holds now (2-F5). */
  generation?(): number;
}

/**
 * What a block pick feeds: a composer's Comment or Edit, a copy, or a token
 * editor's anchor; or Edit page mode, which every frame of the tab enters (E-3).
 */
export const PICK_KINDS = new Set(["comment", "edit", "copy", "token", "batch"]);
/** A child frame's report of its Edits (E-1 … E-3): at most this many of each. */
const REPORT_BOUNDS = { sets: 12, kept: 64, ops: LIMITS.MAX_MUTATION_OPS } as const;
/** Commands a child frame's keyboard may relay to the top frame. */
const COMMAND_RE = /^[a-zA-Z]{1,32}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function liveSender(s: FrameSender): { tabId: number; frameId: number } | null {
  const tabId = s.tab?.id;
  if (tabId === undefined || tabId < 0 || s.frameId === undefined) return null;
  if (s.documentLifecycle !== undefined && s.documentLifecycle !== "active") return null;
  return { tabId, frameId: s.frameId };
}

/**
 * A child frame that owns blocks, its document known: what the top frame is
 * told it is. Only an http(s) page with an origin of its own (2-F4).
 */
function childOf(
  s: FrameSender,
): { tabId: number; documentId: string; url: string; host: string } | null {
  const live = liveSender(s);
  if (!live || live.frameId === 0 || !s.documentId || !s.url) return null;
  if (!isWebAddress(s.url, s.origin)) return null;
  return {
    tabId: live.tabId,
    documentId: s.documentId,
    url: s.url.slice(0, LIMITS.MAX_URL),
    host: new URL(s.url).hostname,
  };
}

/**
 * A page sync from a child frame comes from a document with an address of
 * its own (2-A3): the browser-reported origin must be there, not opaque, and
 * the one its URL names, and the page it asks for must be of that origin.
 * The top frame syncs its own address as before.
 */
export function frameMaySync(s: FrameSender, frameUrl: unknown): boolean {
  if (s.frameId === 0) return true;
  if (!isWebAddress(s.url, s.origin) || typeof frameUrl !== "string") return false;
  try {
    return new URL(frameUrl).origin === s.origin;
  } catch {
    return false;
  }
}

/** A create from a child frame must come from a page that owns blocks (2-F4). */
export function frameMayCreate(s: FrameSender): boolean {
  return s.frameId === 0 || isWebAddress(s.url, s.origin);
}

/**
 * Whether a create may go out now (3-F3): a child frame's create comes from a
 * page that owns blocks and carries the account generation its pick was made
 * under, which must be the one the service worker holds at this moment.
 */
export function frameCreateRefusal(
  s: FrameSender,
  pickGeneration: unknown,
  current: number,
): "not-a-page" | "page-changed" | null {
  if (!frameMayCreate(s)) return "not-a-page";
  if (s.frameId !== 0 && pickGeneration !== current) return "page-changed";
  return null;
}

/**
 * The page the person shares, for display (`hostUrl`): the top frame's URL as
 * the browser reports it for the sender's tab, redacted like any other URL.
 * Absent for the top frame itself.
 */
export function hostUrlFor(s: FrameSender): string | undefined {
  if (s.frameId === undefined || s.frameId === 0) return undefined;
  const tabUrl = s.tab?.url;
  if (!tabUrl) return undefined;
  const cut = redactUrl(tabUrl);
  if (cut === null || !/^https?:/.test(cut)) return undefined;
  return cut.slice(0, LIMITS.MAX_URL);
}

export interface FrameRelay {
  /** The relay's handler for `type`, or undefined when it is not a frame message. */
  handle(
    type: string,
    msg: Record<string, unknown>,
    sender: FrameSender,
  ): Promise<Record<string, unknown>> | undefined;
  /** The tab closed: forget its frames. */
  tabClosed(tabId: number): Promise<void>;
  /** The tab's top page navigated: forget its frames. */
  tabNavigated(tabId: number): Promise<void>;
}

export function createFrameRelay(ports: FramePorts): FrameRelay {
  let chain: Promise<unknown> = Promise.resolve();
  /** Registry writes run one at a time: two frames reporting at once never clobber. */
  const update = (fn: (r: FrameRegistry) => FrameRegistry): Promise<void> => {
    const next = chain.then(async () => ports.save(fn(await ports.load())));
    chain = next.catch(() => {});
    return next;
  };
  const remember = (c: { tabId: number; documentId: string; url: string }, frameId: number) =>
    update((r) => {
      const tab = { ...(r[String(c.tabId)] ?? {}) };
      if (tab[c.documentId]?.url === c.url && tab[c.documentId]?.frameId === frameId) return r;
      // Bounded: a page that churns frames keeps the newest 64.
      const ids = Object.keys(tab);
      if (!tab[c.documentId] && ids.length >= 64) delete tab[ids[0] as string];
      tab[c.documentId] = { frameId, url: c.url };
      return { ...r, [String(c.tabId)]: tab };
    });
  const forget = (tabId: number, documentId: string) =>
    update((r) => {
      const tab = r[String(tabId)];
      if (!tab?.[documentId]) return r;
      const { [documentId]: _gone, ...rest } = tab;
      return { ...r, [String(tabId)]: rest };
    });

  const quiet = (p: Promise<unknown>): void => void p.catch(() => {});
  const toAll = (tabId: number, msg: Record<string, unknown>): void =>
    quiet(ports.send(tabId, msg));
  const toTop = (tabId: number, msg: Record<string, unknown>): void =>
    quiet(ports.send(tabId, msg, { frameId: 0 }));

  /** A child's message for the top frame, stamped with who sent it. */
  async function fromChild(
    sender: FrameSender,
    build: (frame: { documentId: string; url: string }) => Record<string, unknown> | null,
  ): Promise<Record<string, unknown>> {
    const c = childOf(sender);
    if (!c) return { ok: false, error: "sender" };
    const body = build({ documentId: c.documentId, url: c.url });
    if (!body) return { ok: false, error: "invalid" };
    await remember(c, sender.frameId as number);
    toTop(c.tabId, {
      ...body,
      frame: { documentId: c.documentId, url: c.url, host: c.host },
    });
    return { ok: true };
  }

  /**
   * The documents this tab's frames spoke from, each asked whether it is still
   * there: one that navigated or was removed is forgotten, and the top frame
   * told (2-F5).
   */
  async function sweep(tabId: number, except: string): Promise<void> {
    const tab = (await ports.load())[String(tabId)] ?? {};
    await Promise.all(
      Object.keys(tab)
        .filter((doc) => doc !== except)
        .map((documentId) =>
          ports.send(tabId, { type: "frame-ping" }, { documentId }).catch(async () => {
            await forget(tabId, documentId);
            toTop(tabId, { type: "frame-gone", frame: { documentId, url: "" } });
          }),
        ),
    );
  }

  const handlers: Record<
    string,
    (m: Record<string, unknown>, s: FrameSender) => Promise<Record<string, unknown>>
  > = {
    // The top frame armed a block pick: every frame of its tab arms it too.
    framePickAll: async (m, s) => {
      const live = liveSender(s);
      const pickId = str(m.pickId);
      const kind = str(m.kind);
      if (live?.frameId !== 0) return { ok: false, error: "sender" };
      if (!ID_RE.test(pickId) || !PICK_KINDS.has(kind)) return { ok: false, error: "invalid" };
      toAll(live.tabId, { type: "pick-start", pickId, kind });
      return { ok: true };
    },
    // Any frame ended (completed or cancelled) the pick: every frame ends it.
    framePickEnd: async (m, s) => {
      const live = liveSender(s);
      const pickId = str(m.pickId);
      if (!live) return { ok: false, error: "sender" };
      if (!ID_RE.test(pickId)) return { ok: false, error: "invalid" };
      // Ended by a frame, not completed by a choice there (framePicked's own
      // pick-end): only this ends the pick in the top frame.
      toAll(live.tabId, { type: "pick-end", pickId, cancel: true });
      return { ok: true };
    },
    // The pointer reached a frame onlay can't anchor in (a sandboxed or
    // another origin's frame without an address of its own, A-3): the top
    // frame's hint line says so. Nothing but the pick's id is relayed, so a
    // frame that owns no blocks may send it.
    framePickHint: async (m, s) => {
      const live = liveSender(s);
      const pickId = str(m.pickId);
      if (!live || live.frameId === 0) return { ok: false, error: "sender" };
      if (!ID_RE.test(pickId)) return { ok: false, error: "invalid" };
      toTop(live.tabId, { type: "pick-hint", pickId });
      return { ok: true };
    },
    // A trusted click in a child chose a block: the top frame takes it on.
    framePicked: async (m, s) => {
      const r = await fromChild(s, () => {
        const pickId = str(m.pickId);
        const kind = str(m.kind);
        const anchor = AnchorSchema.safeParse(m.anchor);
        if (!ID_RE.test(pickId) || !PICK_KINDS.has(kind) || !anchor.success) return null;
        const label = str(m.label).slice(0, LIMITS.MAX_ANCHOR_LABEL);
        return { type: "frame-picked", pickId, kind, anchor: anchor.data, label };
      });
      const live = liveSender(s);
      if (r.ok && live) toAll(live.tabId, { type: "pick-end", pickId: str(m.pickId) });
      return r;
    },
    // Where the click that picked a block for the top frame's composer is in
    // the tab's viewport (the frame's own measure, through the placement
    // locate): only where to draw the card. Without a point, the block could
    // not be placed; `stale`, the pick is no longer good.
    framePlaced: (m, s) =>
      fromChild(s, () => {
        const pickId = str(m.pickId);
        if (!ID_RE.test(pickId)) return null;
        if (m.stale === true) return { type: "frame-placed", pickId, stale: true };
        const at = m.at as Record<string, unknown> | null | undefined;
        const fine = (v: unknown): v is number => typeof v === "number" && Math.abs(v) <= 1e6;
        return at && typeof at === "object" && fine(at.x) && fine(at.y)
          ? { type: "frame-placed", pickId, at: { x: at.x, y: at.y } }
          : { type: "frame-placed", pickId };
      }),
    // A pin in a child: its thread opens in the top frame.
    frameOpen: (m, s) =>
      fromChild(s, () => {
        const interactionId = str(m.interactionId);
        const spaceId = str(m.spaceId);
        if (!ID_RE.test(interactionId) || !ID_RE.test(spaceId)) return null;
        return { type: "frame-open", interactionId, spaceId };
      }),
    // A child's view of its own threads, for the top frame's Inbox and badge.
    frameReport: async (m, s) => {
      const r = await fromChild(s, () => {
        if (!Array.isArray(m.interactions)) return null;
        if (m.interactions.length > LIMITS.MAX_INTERACTIONS_PER_STATE) return null;
        // Made under another account than the one held now: not relayed (2-F5).
        if (typeof m.generation !== "number") return null;
        if (ports.generation && m.generation !== ports.generation()) return null;
        // The access revision each space's snapshots were taken under (3-F5).
        const revs: Record<string, number> = {};
        if (m.revs && typeof m.revs === "object") {
          for (const [k, v] of Object.entries(m.revs as Record<string, unknown>).slice(0, 64))
            if (ID_RE.test(k) && typeof v === "number" && Number.isFinite(v)) revs[k] = v;
        }
        // Its variant sets, kept edits and tray edits (E-1 … E-3), bounded;
        // the top frame checks each entry.
        const edits: Record<string, unknown> = {};
        if (Array.isArray(m.sets) && m.sets.length <= REPORT_BOUNDS.sets) edits.sets = m.sets;
        if (Array.isArray(m.ops) && m.ops.length <= REPORT_BOUNDS.ops) edits.ops = m.ops;
        const kept = m.kept as { rows?: unknown } | undefined;
        if (Array.isArray(kept?.rows) && kept.rows.length <= REPORT_BOUNDS.kept) edits.kept = kept;
        // The page the frame says it is on now (3-A1): what the top frame
        // offers there, never what it binds or sends to.
        const page =
          typeof m.page === "string" && m.page.length <= LIMITS.MAX_URL ? { page: m.page } : {};
        return {
          type: "frame-report",
          interactions: m.interactions,
          generation: m.generation,
          revs,
          ...page,
          ...edits,
        };
      });
      const c = childOf(s);
      if (r.ok && c) void sweep(c.tabId, c.documentId).catch(() => {});
      return r;
    },
    frameGone: async (_m, s) => {
      const c = childOf(s);
      if (!c) return { ok: false, error: "sender" };
      await forget(c.tabId, c.documentId);
      toTop(c.tabId, { type: "frame-gone", frame: { documentId: c.documentId, url: c.url } });
      return { ok: true };
    },
    // A chord typed while focus is in a child: the top frame runs it.
    frameCommand: (m, s) =>
      fromChild(s, () => {
        const command = str(m.command);
        return COMMAND_RE.test(command) ? { type: "frame-command", command } : null;
      }),
    // The top frame asks one of its tab's child documents to act.
    frameCall: async (m, s) => {
      const live = liveSender(s);
      if (live?.frameId !== 0) return { ok: false, error: "sender" };
      const documentId = str(m.documentId);
      const call = m.call;
      if (!documentId || typeof call !== "object" || call === null)
        return { ok: false, error: "invalid" };
      const known = (await ports.load())[String(live.tabId)]?.[documentId];
      if (!known) return { ok: false, error: "no-frame" };
      try {
        const res = await ports.send(live.tabId, { type: "frame-call", call }, { documentId });
        return (res && typeof res === "object" ? res : { ok: false }) as Record<string, unknown>;
      } catch {
        // The document went away (navigated, closed): it is forgotten.
        await forget(live.tabId, documentId);
        return { ok: false, error: "no-frame" };
      }
    },
  };

  return {
    handle(type, msg, sender) {
      const h = handlers[type];
      return h ? h(msg, sender) : undefined;
    },
    /** The tab's top page navigated: its frames are new documents (2-F5). */
    tabNavigated: (tabId: number) =>
      update((r) => {
        if (!r[String(tabId)]) return r;
        const { [String(tabId)]: _gone, ...rest } = r;
        return rest;
      }),
    tabClosed: (tabId) =>
      update((r) => {
        if (!r[String(tabId)]) return r;
        const { [String(tabId)]: _gone, ...rest } = r;
        return rest;
      }),
  };
}
