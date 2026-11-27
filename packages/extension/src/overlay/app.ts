// The overlay's shared context — the single mutable backbone every module
// consumes. Holds the pure view state (each space's last `interactions-state`
// for this frame's URL, merged), each space's directory (for avatars and the
// mention list), the person's spaces and self identity, the net send path
// (chrome.runtime → sw relay → that space's WS), and a render dispatcher.
// State-sync purity: the overlay never accumulates truth — it re-renders from
// server snapshots, and every snapshot it holds knows its space.
import type { RawInteractionSnapshot, SpaceSummary } from "@onlay/protocol";
import { type AttentionIndex, indexAttention, needsReader } from "@onlay/render/interaction-view";
import { BUILD_SERVER_ORIGIN } from "../sw/server";
import { pinBlock } from "./anchors";
import { captureSnapshot } from "./capture";
import { bindCapture } from "./capture/binding";
import { frameUrl } from "./dom";
import { pageKey } from "./page-url";
import { type PersonView, unknownPerson } from "./people";
import { noteInteractionSpace, noteSetSpace, spaceOfFrame } from "./space-of";
import { uploadOrigin } from "./upload-origin";
import { uuid4 } from "./uuid";

/** A snapshot as the overlay holds it: tagged with the space it lives in. */
export type InteractionSnap = RawInteractionSnapshot & { spaceId: string };
type Snapshot = InteractionSnap;
export interface Sendable {
  type: string;
  [k: string]: unknown;
}
export type SendResult = { ok: boolean; error?: string };
export type CreateResult = { ok: boolean; interactionId?: string; reason?: string };
/** Sanitized captured element awaiting upload once its interaction id is known. */
export interface AnchorCapture {
  html: string;
  truncated: boolean;
  /** What was cut to make it fit (`sanitize.ts`), when it was too large. */
  reduced?: { text: number; repeats: number; depth: number; skeleton?: true };
}

export interface ReceiptMsg {
  spaceId?: string;
  nonce?: string;
  /** The send's request id, echoed: only the waiter that sent it settles. */
  clientId?: string;
  interactionId?: string;
  kind: string;
  ok: boolean;
  reason?: string;
}

export interface App {
  readonly shadow: ShadowRoot;
  readonly host: HTMLElement;
  readonly isTopFrame: boolean;
  toast(text: string, ms?: number): void;
  frameUrl(): string;
  /** Every space's snapshots whose URL prefix-matches this frame (the pure view). */
  interactions(): Snapshot[];
  byId(id: string): Snapshot | undefined;
  /** A person from any space's directory, or a neutral stand-in. */
  /**
   * Who a person id is. With `spaceId` (the thread's own space), only from
   * that space's directory (or the signed-in person's own entry, for their own
   * id); a person it does not hold is the neutral stand-in, never another
   * space's name, alias or picture. Without one (surfaces that are not a
   * thread), from any directory this client holds, without an alias.
   */
  person(id: string, spaceId?: string): PersonView;
  /** One space's directory (the mention list), or everyone known when omitted. */
  people(spaceId?: string): PersonView[];
  /** Monotonic revision of directory/self/spaces — presentation state for repaint keys. */
  presentationRev(): number;
  self(): PersonView | null;
  selfId(): string | null;
  /**
   * This thread needs the signed-in person, by the server's attention rule
   * (`needsReader`): the Inbox lists decide where they know the thread, and
   * its waitingOn is the fallback until they do.
   */
  needsYou(s: { id: string; waitingOn: readonly string[] }): boolean;
  /** The spaces the person can see, in `/api/me` order. */
  spaces(): SpaceSummary[];
  space(id: string): SpaceSummary | undefined;
  /** More than one space: names are worth showing. */
  multiSpace(): boolean;
  /** Spaces the person may create in: every space they belong to (guests can't). */
  composeSpaces(): SpaceSummary[];
  /** The space new interactions go to: the last one used, else the first composable. */
  currentSpaceId(): string | null;
  setCurrentSpace(id: string): void;
  /**
   * A composer (`key`) is open and writes to `spaceId` (null: it closed). The
   * service worker keeps those spaces' sockets and connects a held space
   * that is past the socket cap.
   */
  holdSpace?(key: string, spaceId: string | null): void;
  /** A guest in this space may only reply, react and pick. */
  isGuest(spaceId: string): boolean;
  /** The server's origin, where the web app lives. */
  serverOrigin(): string;
  /** `<person>|<server origin>` while signed in, else null: what a capture is bound to. */
  account(): string | null;
  /** The web app's link to a thread: `<origin>/app/#/t/<spaceId>/<interactionId>`. */
  threadLink(spaceId: string, interactionId: string): string;
  /**
   * Send a frame to its space: `frame.spaceId`, else the space of its
   * `interactionId` or `setId`. Syncs carry none and fan out.
   */
  send(frame: Sendable): Promise<SendResult>;
  /**
   * Create an interaction in `spaceId` and resolve when its receipt lands
   * (create is async: the server mints the id and echoes the nonce).
   * Rejects-as-result on timeout so callers never hang.
   */
  createInteraction(
    payload: Record<string, unknown>,
    spaceId: string,
    /** A retry of an unconfirmed create passes its first nonce: the server answers with the first. */
    nonce?: string,
  ): Promise<CreateResult>;
  /**
   * Resolve when the create sent with `nonce` to `spaceId` lands
   * (`settleCreate`), is refused (its receipt), its socket closes, or the
   * timeout passes. For creates whose success is not an `interaction-receipt`
   * (a variant set's first `variant-state`).
   */
  awaitCreate(nonce: string, spaceId: string, timeoutMs?: number): Promise<CreateResult>;
  /** The create sent with `nonce` landed: settle its waiter. */
  settleCreate(nonce: string, r: CreateResult): void;
  /**
   * Resolve on the server's receipt of `kind` for `interactionId` (register
   * BEFORE sending the frame), or `{ok: false, reason: "timeout"}`. With a
   * `clientId`, only the receipt echoing it settles this waiter (M-1): a
   * receipt for another tab's send never does.
   */
  awaitReceipt(
    kind: string,
    interactionId: string,
    timeoutMs?: number,
    clientId?: string,
  ): Promise<SendResult>;
  /**
   * Send a frame and resolve on the server's receipt for it (3b-C10): a
   * composer keeps its draft until then. Fails at once when the connection
   * drops first (`_connectionLost`), or on the timeout. A frame carrying a
   * `clientId` settles only on the receipt that echoes it.
   */
  sendForReceipt(
    frame: Sendable,
    kind: string,
    interactionId: string,
    timeoutMs?: number,
  ): Promise<SendResult>;
  /**
   * Stage the sanitized captured element for the NEXT element-anchored
   * createInteraction (ADR-0017): the upload rides the receipt once the server
   * mints the id. Cleared after one create. `null` clears without staging.
   */
  setCapture(capture: AnchorCapture | null): void;
  /**
   * Stage the LIVE picked element for a `snapshot` look fired once the NEXT
   * Comment/Ask create receipt carries the id (Stage 2 §1.1 hook 1). Consumed
   * once, only for an element/selection-anchored comment/ask; `null` clears it.
   * Distinct from `setCapture` (that stages the sanitized anchor-content HTML;
   * this holds the live node the walker needs).
   */
  /**
   * Stage the picked block for a look on create. `pin` says the block is
   * still where it was picked (2-A2); staged without one, it is pinned now.
   */
  stageSnapshotSource(el: Element | null, pin?: () => boolean): void;
  /** Upload a captured element for a known interaction id (fail-soft). */
  uploadCapture(interactionId: string, capture: AnchorCapture, verify?: () => boolean): void;
  /** Remember the space a variant set lives in (its frames route there). */
  noteSet(setId: string, spaceId: string): void;
  /** Register a render callback; requestRender fires them all. */
  onRender(cb: () => void): void;
  requestRender(): void;
}

export interface AppOptions {
  shadow: ShadowRoot;
  host: HTMLElement;
  isTopFrame: boolean;
  toast(text: string, ms?: number): void;
  /**
   * This document owns blocks (an http(s) page with an origin of its own, or
   * the top frame). One that does not never sends a page sync, on any path
   * (2-A3). Defaults to true.
   */
  ownsBlocks?: boolean;
}

/** The frames that ask a space for a page's threads or sets. */
const PAGE_SYNCS = new Set(["interaction-sync", "variant-sync"]);

/** The chrome.storage.local key holding the last space the person composed in. */
export const LAST_SPACE_KEY = "lastSpaceId";

export function createApp(opts: AppOptions): App {
  let root = opts.shadow;
  let hostEl = opts.host;
  const bySpace = new Map<string, Snapshot[]>();
  let merged: Snapshot[] = [];
  const directories = new Map<string, PersonView[]>();
  let selfPerson: PersonView | null = null;
  /** The signed-in person's Inbox by thread, once the service worker has one. */
  let attention: AttentionIndex | null = null;
  let spaceList: SpaceSummary[] = [];
  let lastSpace: string | null = null;
  let serverOrigin = BUILD_SERVER_ORIGIN;
  // Bumped whenever directory/self change: names, avatars, and own-message
  // controls render from these, so a skip-repaint key must include it (F8).
  let presentationRev = 0;
  const renderCbs: Array<() => void> = [];
  const pendingCreates = new Map<string, { spaceId: string; done: (r: CreateResult) => void }>();
  // Waiters per `kind:interactionId`, oldest first: two sends for the same
  // thread each get their own receipt, in order, and each times out on its own.
  // A waiter with a `clientId` settles only on the receipt echoing it; the
  // order is the fallback for a server that echoes none.
  const pendingReceipts = new Map<
    string,
    Array<{ done: (r: SendResult) => void; clientId?: string }>
  >();
  const holds = new Map<string, string>();

  /** Tell the service worker, fire-and-forget (a stale context just stays quiet). */
  const tellSw = (msg: Record<string, unknown>): void => {
    try {
      void chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      /* stale context (F-053) */
    }
  };
  const reportHolds = (): void =>
    tellSw({ type: "spacesInUse", spaces: [...new Set(holds.values())] });
  let pendingCapture: AnchorCapture | null = null;
  /** The page key when that markup was staged: submitted elsewhere, it is dropped (3b-C8). */
  let pendingCapturePage: string | null = null;
  // The live element staged for a snapshot look on the next comment/ask create.
  let pendingSnapshotSource: Element | null = null;
  /** Where the staged block was picked: its document and frames, still the same (2-A2). */
  let pendingSnapshotPin: (() => boolean) | null = null;

  // Once per page: the extension was reloaded and this tab still runs the
  // old content script — every runtime message now throws (F-053).
  let staleToasted = false;
  const staleContextToast = (): void => {
    if (staleToasted) return;
    staleToasted = true;
    opts.toast("Onlay was updated — refresh this page to reconnect", 8000);
  };

  /** Fire-and-forget the captured element to the SW; failure only toasts. */
  const uploadCapture = (
    interactionId: string,
    capture: AnchorCapture,
    verify: () => boolean = () => true,
  ): void => {
    // Immediately before the send: still what it was captured for (R3-C4).
    if (!verify()) return;
    try {
      chrome.runtime
        .sendMessage({
          type: "uploadAnchorContent",
          ...uploadOrigin(),
          spaceId: spaceOfFrame({ interactionId }),
          interactionId,
          content: capture.html,
          truncated: capture.truncated,
          ...(capture.reduced ? { reduced: capture.reduced } : {}),
        })
        .then(
          (res: SendResult | undefined) => {
            if (res && !res.ok) opts.toast("captured block not uploaded");
          },
          () => opts.toast("captured block not uploaded"),
        );
    } catch {
      staleContextToast();
    }
  };

  const person = (id: string, spaceId?: string): PersonView => {
    if (spaceId !== undefined) {
      const own = directories.get(spaceId)?.find((p) => p.id === id);
      if (own) return own;
      if (selfPerson && selfPerson.id === id) return selfPerson;
      // Not in this space's directory: another space's entry is not this thread's to use.
      return unknownPerson(id);
    }
    if (selfPerson && selfPerson.id === id) return selfPerson;
    for (const list of directories.values()) {
      const found = list.find((p) => p.id === id);
      if (found) {
        // Learned in another space: its alias is not this thread's to use.
        const { alias: _alias, ...seen } = found;
        return seen;
      }
    }
    return unknownPerson(id);
  };
  const everyone = (): PersonView[] => {
    const seen = new Map<string, PersonView>();
    for (const list of directories.values()) for (const p of list) seen.set(p.id, p);
    return [...seen.values()];
  };
  const composeSpaces = (): SpaceSummary[] => spaceList.filter((s) => s.role !== "guest");
  const currentSpaceId = (): string | null => {
    const composable = composeSpaces();
    if (lastSpace && composable.some((s) => s.id === lastSpace)) return lastSpace;
    return (composable.find((s) => s.kind === "personal") ?? composable[0])?.id ?? null;
  };

  const app: App = {
    // Getters: a host the page moved is replaced (content.ts), and every module
    // that appends to the root follows the fresh one.
    get shadow() {
      return root;
    },
    get host() {
      return hostEl;
    },
    isTopFrame: opts.isTopFrame,
    toast: opts.toast,
    frameUrl,
    interactions: () => merged,
    byId: (id) => merged.find((s) => s.id === id),
    person,
    people: (spaceId) => (spaceId === undefined ? everyone() : (directories.get(spaceId) ?? [])),
    presentationRev: () => presentationRev,
    self: () => selfPerson,
    selfId: () => selfPerson?.id ?? null,
    needsYou: (s) => needsReader(s, selfPerson?.id ?? null, attention),
    spaces: () => spaceList,
    space: (id) => spaceList.find((s) => s.id === id),
    multiSpace: () => spaceList.length > 1,
    composeSpaces,
    currentSpaceId,
    setCurrentSpace(id) {
      // Picking a space brings it into the capped set of sockets.
      tellSw({ type: "useSpace", spaceId: id });
      // An open composer follows the choice its own picker made.
      if (holds.has("composer") && holds.get("composer") !== id) {
        holds.set("composer", id);
        reportHolds();
      }
      if (lastSpace === id) return;
      lastSpace = id;
      presentationRev++;
      try {
        void chrome.storage.local.set({ [LAST_SPACE_KEY]: id }).catch(() => {});
      } catch {
        /* stale context (F-053) */
      }
      app.requestRender();
    },
    holdSpace(key, spaceId) {
      if (spaceId === null) {
        if (!holds.delete(key)) return;
      } else {
        if (holds.get(key) === spaceId) return;
        holds.set(key, spaceId);
        tellSw({ type: "useSpace", spaceId });
      }
      reportHolds();
    },
    isGuest: (spaceId) => spaceList.find((s) => s.id === spaceId)?.role === "guest",
    serverOrigin: () => serverOrigin,
    account: () => (selfPerson ? `${selfPerson.id}|${serverOrigin}` : null),
    threadLink: (spaceId, interactionId) => `${serverOrigin}/app/#/t/${spaceId}/${interactionId}`,
    send(frame) {
      // A document that owns no blocks has no page to sync (2-A3).
      if (opts.ownsBlocks === false && PAGE_SYNCS.has(String(frame.type)))
        return Promise.resolve({ ok: false, error: "not-a-page" });
      const spaceId = spaceOfFrame(frame);
      const head: Record<string, unknown> =
        frame.type === "attention-sync" ? { v: 1 } : { v: 1, frameUrl: frameUrl() };
      const payload: Sendable = {
        ...head,
        ...frame,
        ...(spaceId !== undefined ? { spaceId } : {}),
      };
      // A reloaded extension invalidates this page's old content script:
      // sendMessage then THROWS SYNCHRONOUSLY ("extension context
      // invalidated"), which would kill callers before their timeout/error
      // handling even exists (F-053 — Comment stalled forever). Never throw;
      // say what happened once, loudly.
      try {
        return chrome.runtime.sendMessage(payload).then(
          (res: SendResult | undefined) => res ?? { ok: false, error: "no-response" },
          () => ({ ok: false, error: "sw-unreachable" }),
        );
      } catch {
        staleContextToast();
        return Promise.resolve({ ok: false, error: "membrane-updated" });
      }
    },
    createInteraction(payload, spaceId, retryNonce) {
      const nonce = retryNonce ?? uuid4().slice(0, 32);
      // Consume any staged capture ONCE, only for an element-anchored create.
      const level = (payload.anchor as { level?: string } | undefined)?.level;
      // Markup picked on another page than this submission is dropped, not sent.
      const samePageAsPick =
        pendingCapturePage !== null && pageKey(frameUrl()) === pendingCapturePage;
      const capture = level === "element" && samePageAsPick ? pendingCapture : null;
      pendingCapture = null;
      pendingCapturePage = null;
      // Consume the staged snapshot source ONCE — element/selection anchors, and
      // only Comment/Ask (a Change captures edit-context via the variant engine,
      // S2-D1). The upload gate is otherwise piggyback-proof against setCapture.
      const kind = payload.kind;
      const snapshotEl =
        (kind === "comment" || kind === "ask") && (level === "element" || level === "selection")
          ? pendingSnapshotSource
          : null;
      const pinned = pendingSnapshotPin;
      pendingSnapshotSource = null;
      pendingSnapshotPin = null;
      // The look belongs to this page and this account, and to the block where
      // it was picked: bound now, checked when it runs.
      const bound = snapshotEl
        ? bindCapture(app, () => snapshotEl.isConnected && (pinned?.() ?? false))
        : null;
      const boundUpload = capture ? bindCapture(app) : null;
      return new Promise<CreateResult>((resolve) => {
        let settled = false;
        const done = (r: CreateResult): void => {
          if (settled) return;
          settled = true;
          pendingCreates.delete(nonce);
          // Upload the captured element AFTER the create receipt carries the id.
          if (r.ok && r.interactionId) noteInteractionSpace(r.interactionId, spaceId);
          if (r.ok && r.interactionId && capture && boundUpload)
            uploadCapture(r.interactionId, capture, boundUpload);
          // Fire the snapshot look on the same receipt. Guard staleness: an SPA
          // route tick / virtual-list recycle can detach the stashed node in the
          // receipt window — take the honest miss over a false, detached look
          // (§1.1 advisory 7).
          if (r.ok && r.interactionId && snapshotEl?.isConnected && bound)
            void captureSnapshot(snapshotEl, r.interactionId, bound).catch(() => {});
          resolve(r);
        };
        pendingCreates.set(nonce, { spaceId, done });
        app.send({ type: "interaction-create", nonce, ...payload, spaceId }).then((res) => {
          if (!res.ok) done({ ok: false, ...(res.error ? { reason: res.error } : {}) });
        });
        setTimeout(() => done({ ok: false, reason: "timeout" }), 12_000);
      });
    },
    awaitCreate(nonce, spaceId, timeoutMs = 12_000) {
      return new Promise<CreateResult>((resolve) => {
        let settled = false;
        const done = (r: CreateResult): void => {
          if (settled) return;
          settled = true;
          if (pendingCreates.get(nonce)?.done === done) pendingCreates.delete(nonce);
          resolve(r);
        };
        pendingCreates.set(nonce, { spaceId, done });
        setTimeout(() => done({ ok: false, reason: "timeout" }), timeoutMs);
      });
    },
    settleCreate(nonce, r) {
      pendingCreates.get(nonce)?.done(r);
    },
    awaitReceipt(kind, interactionId, timeoutMs = 12_000, clientId) {
      const key = `${kind}:${interactionId}`;
      return new Promise<SendResult>((resolve) => {
        const done = (r: SendResult): void => {
          const waiters = pendingReceipts.get(key);
          const at = waiters?.findIndex((w) => w.done === done) ?? -1;
          if (!waiters || at < 0) return;
          waiters.splice(at, 1);
          if (waiters.length === 0) pendingReceipts.delete(key);
          resolve(r);
        };
        const waiter = { done, ...(clientId !== undefined ? { clientId } : {}) };
        const waiters = pendingReceipts.get(key);
        if (waiters) waiters.push(waiter);
        else pendingReceipts.set(key, [waiter]);
        setTimeout(() => done({ ok: false, error: "timeout" }), timeoutMs);
      });
    },
    sendForReceipt(frame, kind, interactionId, timeoutMs) {
      const clientId = typeof frame.clientId === "string" ? frame.clientId : undefined;
      const receipt = app.awaitReceipt(kind, interactionId, timeoutMs, clientId);
      return app.send(frame).then((res) => (res.ok ? receipt : res));
    },
    setCapture(capture) {
      pendingCapture = capture;
      pendingCapturePage = capture ? pageKey(frameUrl()) : null;
    },
    stageSnapshotSource(el, pin) {
      pendingSnapshotSource = el;
      pendingSnapshotPin = el ? (pin ?? pinBlock(el)) : null;
    },
    uploadCapture,
    noteSet: (setId, spaceId) => noteSetSpace(setId, spaceId),
    onRender: (cb) => {
      renderCbs.push(cb);
    },
    requestRender: () => {
      for (const cb of renderCbs) cb();
    },
  };

  const remerge = (): void => {
    const known = new Set(spaceList.map((s) => s.id));
    merged = [...bySpace.entries()]
      .filter(([id]) => known.size === 0 || known.has(id))
      .flatMap(([, list]) => list);
  };

  // ── state mutations (called by content.ts from server frames) ──
  return Object.assign(app, {
    _setInteractions(spaceId: string, next: RawInteractionSnapshot[]): void {
      const tagged = next.map((s) => ({ ...s, spaceId }));
      for (const s of tagged) noteInteractionSpace(s.id, spaceId);
      bySpace.set(spaceId, tagged);
      remerge();
      app.requestRender();
    },
    _setSelf(p: PersonView | null): void {
      // Another person's (or nobody's) Inbox is not this one's.
      if (p?.id !== selfPerson?.id) attention = null;
      selfPerson = p;
      presentationRev++;
    },
    _setAttention(lists: Parameters<typeof indexAttention>[0], personId: string | null): void {
      if (personId === null || personId !== (selfPerson?.id ?? null)) return;
      attention = indexAttention(lists);
    },
    _setRoot(next: ShadowRoot, nextHost: HTMLElement): void {
      root = next;
      hostEl = nextHost;
    },
    _setServerOrigin(origin: string): void {
      serverOrigin = origin;
    },
    _setSpaces(next: SpaceSummary[], last: string | null): void {
      spaceList = next;
      if (last !== null) lastSpace = last;
      const known = new Set(next.map((s) => s.id));
      for (const id of [...bySpace.keys()]) if (!known.has(id)) bySpace.delete(id);
      for (const id of [...directories.keys()]) if (!known.has(id)) directories.delete(id);
      remerge();
      presentationRev++;
    },
    _setDirectory(spaceId: string, people: PersonView[]): void {
      directories.set(spaceId, people);
      presentationRev++;
    },
    _connectionLost(spaceIds: ReadonlySet<string>): void {
      // Nothing in flight on those sockets will get its receipt now: say so at once.
      for (const [key, waiters] of [...pendingReceipts]) {
        const id = key.slice(key.indexOf(":") + 1);
        const space = app.byId(id)?.spaceId ?? spaceOfFrame({ interactionId: id });
        if (space !== undefined && !spaceIds.has(space)) continue;
        for (const w of [...waiters]) w.done({ ok: false, error: "closed" });
      }
      // A create sent on a closed socket won't hear back either (M-2).
      for (const p of [...pendingCreates.values()]) {
        if (spaceIds.has(p.spaceId)) p.done({ ok: false, reason: "closed" });
      }
    },
    _onReceipt(msg: ReceiptMsg): void {
      if (msg.ok && msg.interactionId && msg.spaceId)
        noteInteractionSpace(msg.interactionId, msg.spaceId);
      if (msg.kind === "create" && msg.nonce) {
        const resolver = pendingCreates.get(msg.nonce)?.done;
        if (resolver) {
          resolver({
            ok: msg.ok,
            ...(msg.interactionId !== undefined ? { interactionId: msg.interactionId } : {}),
            ...(msg.reason !== undefined ? { reason: msg.reason } : {}),
          });
          return;
        }
      }
      if (msg.interactionId) {
        const waiters = pendingReceipts.get(`${msg.kind}:${msg.interactionId}`);
        const r = { ok: msg.ok, ...(msg.reason !== undefined ? { error: msg.reason } : {}) };
        if (msg.clientId !== undefined) {
          // Receipts reach every tab: one for a send this tab never made (or
          // already settled) is someone else's, and changes nothing here.
          waiters?.find((w) => w.clientId === msg.clientId)?.done(r);
          return;
        }
        const waiter = waiters?.[0];
        if (waiter) {
          waiter.done(r);
          return;
        }
      }
      if (!msg.ok) app.toast(`${msg.kind} not saved: ${msg.reason ?? "unknown"}`);
    },
  }) as App & AppInternals;
}

export interface AppInternals {
  _setRoot(root: ShadowRoot, host: HTMLElement): void;
  _setInteractions(spaceId: string, next: RawInteractionSnapshot[]): void;
  _setSelf(p: PersonView | null): void;
  /**
   * The person's Inbox lists (`/api/inbox`, through the service worker),
   * read for `personId`: taken only while that is still who is signed in.
   * Callers request a render after.
   */
  _setAttention(lists: Parameters<typeof indexAttention>[0], personId: string | null): void;
  _setSpaces(next: SpaceSummary[], last: string | null): void;
  _setServerOrigin(origin: string): void;
  _setDirectory(spaceId: string, people: PersonView[]): void;
  _onReceipt(msg: ReceiptMsg): void;
  /** These spaces' sockets closed: fail their pending receipts now (3b-C10). */
  _connectionLost(spaceIds: ReadonlySet<string>): void;
}
