import {
  anchorInteraction,
  applyHello,
  type InteractionState,
  type MutationKind,
  markAnchorLost,
  matchesUrlPrefix,
  reanchor,
} from "@onlay/kernel";
import {
  type BrandedElementContext,
  CLOSE_UPGRADE_REQUIRED,
  type ElementContext,
  type Hello,
  type InteractionReceipt,
  parseInbound,
  type RawRichText,
  type RichText,
  type UntrustedText,
  unwrapForPage,
  type VariantCreate,
  type VariantReceipt,
  type VariantRoot,
} from "@onlay/protocol";
import {
  actorOf,
  buildAttentionFrame,
  buildInteractionsState,
  buildVariantState,
  expiredSocket,
  fanOutVariantState,
  needsRevalidation,
  needsYouCount,
  originsFor,
  personOf,
  type Runtime,
  type SocketAttachment,
  SpacePurgedError,
  type SpaceSocket,
  sendFrame,
  spaceSummaryFor,
} from "./runtime";
import {
  admit,
  afterMutation,
  answerOp,
  batchOp,
  commit,
  conflict,
  createOp,
  deleteOp,
  editOp,
  type Outcome,
  reactOp,
  reopenOp,
  replyOp,
  resolveOp,
  systemNote,
} from "./service";
import { admitSet, createSetOp, discardOp, outcomeOp, pickOp, steerOp, tuneOp } from "./variants";

/**
 * The space's WebSocket frames (spec §7.1): today's vocabulary minus
 * `selection`, `highlight`, `command` and `ack`. `hello` (with `protocol`)
 * → `welcome` and a resync of attention and origins; every other frame waits
 * for it. Mutation frames come from the extension only (class `full`), carry
 * the frame's real URL for URL binding, and run the same admission and
 * operations as the HTTP routes. A web app socket (class `interaction`)
 * says hello, pings, pulls attention, and otherwise only listens for ticks.
 */

type ReceiptKind = InteractionReceipt["kind"];

function sendReceipt(
  socket: SpaceSocket,
  kind: ReceiptKind,
  ok: boolean,
  extra: {
    nonce?: string;
    clientId?: string;
    interactionId?: string;
    reason?: string;
    message?: string;
  } = {},
): void {
  sendFrame(socket, {
    v: 1,
    type: "interaction-receipt",
    kind,
    ok,
    ...(extra.nonce !== undefined ? { nonce: extra.nonce } : {}),
    ...(extra.clientId !== undefined ? { clientId: extra.clientId } : {}),
    ...(extra.interactionId !== undefined ? { interactionId: extra.interactionId } : {}),
    ...(extra.reason !== undefined ? { reason: extra.reason.slice(0, 64) } : {}),
    ...(extra.message !== undefined ? { message: extra.message.slice(0, 200) } : {}),
  });
}

function receiptOf(
  socket: SpaceSocket,
  kind: ReceiptKind,
  interactionId: string | undefined,
  r: Outcome<object>,
  nonce?: string,
  clientId?: string,
): void {
  sendReceipt(socket, kind, r.ok, {
    ...(interactionId !== undefined ? { interactionId } : {}),
    ...(nonce !== undefined ? { nonce } : {}),
    ...(clientId !== undefined ? { clientId } : {}),
    ...(r.ok ? {} : { reason: r.reason, message: r.message }),
  });
}

function sendVariantReceipt(
  socket: SpaceSocket,
  setId: string,
  kind: VariantReceipt["kind"],
  r: Outcome<object>,
): void {
  sendFrame(socket, {
    v: 1,
    type: "variant-receipt",
    setId,
    kind,
    ok: r.ok,
    ...(r.ok ? {} : { reason: r.reason.slice(0, 64) }),
  });
}

function unwrapBody(body: RichText): RawRichText {
  return { text: unwrapForPage(body.text), ...(body.tokens ? { tokens: body.tokens } : {}) };
}

/**
 * URL binding for a mutation on an existing interaction: the frame's real URL
 * (read by the isolated content script — pages can't forge it) must sit
 * under the interaction's bound prefix. Unanchored interactions have none.
 */
function urlBound(
  rt: Runtime,
  interactionId: string,
  frameUrl: UntrustedText,
): Outcome<Record<never, never>> {
  const s = rt.interactions.get(interactionId);
  if (!s || s.anchor.level === "unanchored") return { ok: true };
  if (matchesUrlPrefix(unwrapForPage(frameUrl), s.expectUrlPrefix)) return { ok: true };
  return conflict("url-mismatch", "This page isn't the one the interaction is on.");
}

/** Admission, then URL binding: the interaction this frame may change. */
function admitFrame(
  rt: Runtime,
  socket: SpaceSocket,
  kind: MutationKind,
  receipt: ReceiptKind,
  interactionId: string,
  frameUrl: UntrustedText,
): InteractionState | null {
  const caller = socket.attachment()?.caller;
  if (!caller) return null;
  const g = admit(rt, caller, kind, interactionId);
  const u = g.ok ? urlBound(rt, interactionId, frameUrl) : g;
  if (!g.ok || !u.ok) {
    receiptOf(socket, receipt, interactionId, g.ok ? u : g);
    return null;
  }
  return g.s;
}

/** The admission each receipt's frame needs. */
const MUTATION_OF: Record<
  "reply" | "edit" | "delete" | "react" | "answer" | "resolve" | "reopen" | "batch",
  MutationKind
> = {
  reply: "reply",
  edit: "edit-own",
  delete: "delete-own",
  react: "react",
  answer: "answer",
  resolve: "resolve",
  reopen: "reopen",
  batch: "batch",
};

/**
 * Runs an operation after visibility and capability, then URL binding,
 * answering with a receipt. Admission comes first, so a caller who can't see
 * an interaction gets the same `unknown` whether it exists or not.
 */
function bound(
  rt: Runtime,
  socket: SpaceSocket,
  receipt: keyof typeof MUTATION_OF,
  interactionId: string,
  frameUrl: UntrustedText,
  op: () => Outcome<object>,
  clientId?: string,
): void {
  const caller = socket.attachment()?.caller;
  if (!caller) return;
  const g = admit(rt, caller, MUTATION_OF[receipt], interactionId);
  const u = g.ok ? urlBound(rt, interactionId, frameUrl) : g;
  receiptOf(socket, receipt, interactionId, u.ok ? op() : u, undefined, clientId);
}

/* ── refusing a frame without running it ──────────────────────────── */

type InboundFrame = Extract<ReturnType<typeof parseInbound>, { ok: true }>["msg"];

const INTERACTION_RECEIPTS: Partial<Record<InboundFrame["type"], ReceiptKind>> = {
  "interaction-create": "create",
  "variant-create": "create",
  "interaction-reply": "reply",
  "interaction-edit": "edit",
  "interaction-delete": "delete",
  "interaction-react": "react",
  "ask-answer": "answer",
  "interaction-resolve": "resolve",
  "interaction-reopen": "reopen",
  "change-batch": "batch",
  "interaction-reanchor": "reanchor",
  "interaction-anchor": "anchor",
};

const VARIANT_RECEIPTS: Partial<Record<InboundFrame["type"], VariantReceipt["kind"]>> = {
  "variant-pick": "pick",
  "variant-discard": "discard",
  "variant-steer": "steer",
  "variant-tune": "tune",
  "variant-cycle": "cycle",
};

/**
 * Answers a frame the space will not run (`not-ready` before `hello`,
 * `rate-limited`) with the receipt its sender waits for, when it has one;
 * the socket stays open.
 */
function refuseFrame(rt: Runtime, socket: SpaceSocket, msg: InboundFrame, reason: string): void {
  const message =
    reason === "rate-limited"
      ? "Too many changes in a minute. Wait a moment, then try again."
      : "Still connecting. Try again in a moment.";
  const kind = INTERACTION_RECEIPTS[msg.type];
  if (kind !== undefined) {
    const m = msg as { nonce?: string; clientId?: string; interactionId?: string };
    sendReceipt(socket, kind, false, {
      reason,
      message,
      ...(m.nonce !== undefined ? { nonce: m.nonce } : {}),
      ...(m.clientId !== undefined ? { clientId: m.clientId } : {}),
      ...(m.interactionId !== undefined ? { interactionId: m.interactionId } : {}),
    });
    return;
  }
  const variantKind = VARIANT_RECEIPTS[msg.type];
  if (variantKind !== undefined && "setId" in msg) {
    sendVariantReceipt(socket, msg.setId, variantKind, refuseOutcome(reason, message));
    return;
  }
  rt.log("rejection", { where: "message", reason: `${msg.type}-${reason}` });
}

const refuseOutcome = (reason: string, message: string): Outcome<object> => ({
  ok: false,
  code: reason === "rate-limited" ? "rate_limited" : "conflict",
  reason,
  message,
});

/** Frames that change something: these count against the per-person write window. */
const MUTATING = new Set<InboundFrame["type"]>([
  ...(Object.keys(INTERACTION_RECEIPTS) as InboundFrame["type"][]),
  "interaction-anchor-lost",
  "variant-pick",
  "variant-discard",
  "variant-steer",
  "variant-tune",
  "variant-outcome",
]);

/** Mutating frames a person may send in one minute, across their sockets in this space. */
const FRAME_WRITES_PER_MINUTE = 120;
const WINDOW_MS = 60_000;

/**
 * A fixed one-minute window per person, in memory (an eviction resets it):
 * true when this frame fits.
 */
function frameAllowed(rt: Runtime, personId: string): boolean {
  const start = Math.floor(rt.clock.now() / WINDOW_MS) * WINDOW_MS;
  const w = rt.frameWindows.get(personId);
  if (!w || w.start !== start) {
    rt.frameWindows.set(personId, { start, count: 1 });
    return true;
  }
  if (w.count >= FRAME_WRITES_PER_MINUTE) return false;
  w.count += 1;
  return true;
}

/* ── session plumbing ─────────────────────────────────────────────── */

function welcomeFrame(
  rt: Runtime,
  a: SocketAttachment,
  sessionId: string,
  resumedFromSeq: number,
  now: number,
) {
  const space = spaceSummaryFor(rt, a.caller);
  return {
    v: 1,
    type: "welcome",
    sessionId,
    resumedFromSeq,
    serverTime: now,
    actor: actorOf(a.caller),
    needsYouCount: needsYouCount(rt, a.caller),
    person: personOf(a.caller),
    ...(space ? { space } : {}),
  };
}

function onHello(rt: Runtime, socket: SpaceSocket, msg: Hello): void {
  const a = socket.attachment();
  if (!a) return;
  if ((msg.protocol ?? 0) < rt.minClientProtocol) {
    socket.close(CLOSE_UPGRADE_REQUIRED, "upgrade required");
    return;
  }
  const now = rt.clock.now();
  if (a.sessionId !== undefined) {
    // One hello per socket: a repeat hears the first welcome exactly as it was
    // sent, and nothing is journaled, read or computed again.
    if (a.welcome !== undefined) socket.send(a.welcome);
    return;
  }
  const state = applyHello(rt.sessionStore.get(msg.sessionId), msg, now);
  rt.sessionStore.append(
    {
      k: "hello",
      ts: now,
      sessionId: msg.sessionId,
      bootCount: msg.bootCount,
      swRestarts: msg.swRestarts,
      connects: msg.connects,
      lastAckSeq: msg.lastAckSeq ?? 0,
    },
    state,
  );
  const welcome = JSON.stringify(welcomeFrame(rt, a, msg.sessionId, state.lastAckSeq, now));
  socket.setAttachment({ ...a, sessionId: msg.sessionId, welcome });
  socket.send(welcome);
  // The full resync on every connect: attention, and the origins set.
  sendFrame(socket, buildAttentionFrame(rt, a.caller));
  if (a.caller.class === "full") {
    sendFrame(socket, { v: 1, type: "origins", origins: originsFor(rt, a.caller.access) });
  }
}

/* ── frames ───────────────────────────────────────────────────────── */

function unwrapElement(e: BrandedElementContext): ElementContext {
  return {
    selector: unwrapForPage(e.selector),
    tag: unwrapForPage(e.tag),
    classes: e.classes.map(unwrapForPage),
    textSnippet: unwrapForPage(e.textSnippet),
    markup: unwrapForPage(e.markup),
    ...(e.sourcePointer !== undefined ? { sourcePointer: unwrapForPage(e.sourcePointer) } : {}),
  };
}

function onVariantCreate(rt: Runtime, socket: SpaceSocket, msg: VariantCreate): void {
  const caller = socket.attachment()?.caller;
  if (!caller) return;
  const root: VariantRoot =
    msg.root.kind === "page"
      ? { kind: "page" }
      : { kind: "block", element: unwrapElement(msg.root.element) };
  const r = createSetOp(rt, caller, {
    frameUrl: unwrapForPage(msg.frameUrl),
    ...(msg.hostUrl !== undefined ? { hostUrl: unwrapForPage(msg.hostUrl) } : {}),
    root,
    command: unwrapForPage(msg.command),
    count: msg.count,
    ...(msg.intent !== undefined ? { intent: msg.intent } : {}),
    ...(msg.provenance !== undefined ? { provenance: unwrapForPage(msg.provenance) } : {}),
    ...(msg.manual !== undefined ? { manual: msg.manual } : {}),
    nonce: msg.nonce,
  });
  if (!r.ok) {
    receiptOf(socket, "create", undefined, r, msg.nonce);
    return;
  }
  // The first push carries the nonce so the creating page correlates its set.
  fanOutVariantState(rt, r.set, msg.nonce);
}

/** Frames other than these wait for `hello`. */
const OPEN_FRAMES = new Set(["hello", "ping"]);
/** What a web app socket may send besides hello and ping. */
const LISTENER_FRAMES = new Set(["attention-sync"]);

/** Frames that wait for a fresh directory check when the socket's last one is stale (R3-S2). */
const REVALIDATED = new Set<InboundFrame["type"]>([...MUTATING, "variant-cycle"]);

/**
 * One frame from a socket. A mutating frame on a socket the directory last
 * vouched for more than `REVALIDATE_WRITES_MS` ago waits for a fresh check
 * (R3-S2), and every later frame from that socket waits behind it, in order;
 * a socket the check closes runs none of them. The promise, when there is one,
 * settles once the frame has run or been dropped.
 */
export function onMessage(
  rt: Runtime,
  socket: SpaceSocket,
  raw: unknown,
): Promise<void> | undefined {
  const key = socket.key ?? socket;
  const queued = rt.socketChains.get(key);
  if (queued)
    return chainFor(
      rt,
      key,
      queued.then(() => dispatch(rt, socket, raw)),
    );
  const a = socket.attachment();
  if (a && a.closedAt === undefined && needsRevalidation(rt, a)) {
    const parsed = parseInbound(raw);
    if (parsed.ok && REVALIDATED.has(parsed.msg.type) && a.sessionId) {
      return chainFor(
        rt,
        key,
        rt.revalidate([socket]).then(() => dispatch(rt, socket, raw)),
      );
    }
  }
  try {
    dispatch(rt, socket, raw);
  } catch (error) {
    // The space was purged under it: nothing was written (R3-S4).
    if (!(error instanceof SpacePurgedError)) throw error;
  }
  return undefined;
}

function chainFor(rt: Runtime, key: unknown, work: Promise<void>): Promise<void> {
  const done: Promise<void> = work
    .catch((error: unknown) => {
      if (!(error instanceof SpacePurgedError)) rt.log("frame-failed", { error: String(error) });
    })
    .finally(() => {
      if (rt.socketChains.get(key) === done) rt.socketChains.delete(key);
    });
  rt.socketChains.set(key, done);
  return done;
}

function dispatch(rt: Runtime, socket: SpaceSocket, raw: unknown): void {
  const a = socket.attachment();
  if (!a || a.closedAt !== undefined || expiredSocket(rt, socket, a)) return;
  const parsed = parseInbound(raw);
  if (!parsed.ok) {
    rt.log("rejection", { where: "message", reason: parsed.reason });
    return;
  }
  const msg = parsed.msg;
  if (!OPEN_FRAMES.has(msg.type) && !a.sessionId) {
    // Nothing runs before `welcome`; the sender hears so instead of silence.
    refuseFrame(rt, socket, msg, "not-ready");
    return;
  }
  if (!OPEN_FRAMES.has(msg.type) && a.caller.class !== "full" && !LISTENER_FRAMES.has(msg.type)) {
    rt.log("rejection", { where: "message", reason: `${msg.type}-needs-full` });
    return;
  }
  if (MUTATING.has(msg.type) && !frameAllowed(rt, a.caller.personId)) {
    refuseFrame(rt, socket, msg, "rate-limited");
    return;
  }
  const caller = a.caller;
  switch (msg.type) {
    case "ping":
      sendFrame(socket, { v: 1, type: "pong", t: msg.t });
      return;
    case "hello":
      onHello(rt, socket, msg);
      return;
    case "interaction-create": {
      const r = createOp(rt, caller, {
        kind: msg.kind,
        anchor: msg.anchor,
        url: unwrapForPage(msg.frameUrl),
        ...(msg.hostUrl !== undefined ? { hostUrl: unwrapForPage(msg.hostUrl) } : {}),
        ...(msg.body ? { body: unwrapBody(msg.body) } : {}),
        ...(msg.ask ? { ask: msg.ask } : {}),
        ...(msg.change ? { change: msg.change } : {}),
        nonce: msg.nonce,
      });
      receiptOf(socket, "create", r.ok ? r.state.id : undefined, r, msg.nonce);
      return;
    }
    case "interaction-reply":
      bound(
        rt,
        socket,
        "reply",
        msg.interactionId,
        msg.frameUrl,
        () =>
          replyOp(rt, caller, msg.interactionId, {
            body: unwrapBody(msg.body),
            ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
            ...(msg.clientId !== undefined ? { clientId: msg.clientId } : {}),
          }),
        msg.clientId,
      );
      return;
    case "interaction-edit":
      bound(rt, socket, "edit", msg.interactionId, msg.frameUrl, () =>
        editOp(rt, caller, msg.interactionId, { msgId: msg.msgId, body: unwrapBody(msg.body) }),
      );
      return;
    case "interaction-delete":
      bound(rt, socket, "delete", msg.interactionId, msg.frameUrl, () =>
        deleteOp(rt, caller, msg.interactionId, msg.msgId),
      );
      return;
    case "interaction-react":
      bound(rt, socket, "react", msg.interactionId, msg.frameUrl, () =>
        reactOp(rt, caller, msg.interactionId, {
          msgId: msg.msgId,
          emoji: unwrapForPage(msg.emoji),
          on: msg.on,
        }),
      );
      return;
    case "ask-answer":
      bound(rt, socket, "answer", msg.interactionId, msg.frameUrl, () =>
        answerOp(rt, caller, msg.interactionId, {
          optionIds: msg.optionIds,
          ...(msg.comment ? { comment: unwrapBody(msg.comment) } : {}),
        }),
      );
      return;
    case "interaction-resolve":
      bound(rt, socket, "resolve", msg.interactionId, msg.frameUrl, () =>
        resolveOp(rt, caller, msg.interactionId),
      );
      return;
    case "interaction-reopen":
      bound(rt, socket, "reopen", msg.interactionId, msg.frameUrl, () =>
        reopenOp(rt, caller, msg.interactionId),
      );
      return;
    case "change-batch":
      bound(rt, socket, "batch", msg.interactionId, msg.frameUrl, () =>
        batchOp(rt, caller, msg.interactionId, msg.ops),
      );
      return;
    case "interaction-reanchor": {
      const s = admitFrame(rt, socket, "reanchor", "reanchor", msg.interactionId, msg.frameUrl);
      if (!s) return;
      // Only the page the thread is on places its anchor again (3-A1): the
      // frame's URL is exactly the interaction's, never a deeper route the URL
      // prefix would admit (the same rule as a loss, 2-A4).
      if (unwrapForPage(msg.frameUrl) !== s.url) {
        sendReceipt(socket, "reanchor", false, { interactionId: s.id, reason: "url-mismatch" });
        return;
      }
      const now = rt.clock.now();
      const state = commit(
        rt,
        // Who re-anchored it, journaled: their extension uploads the block it
        // now sits on, and that upload is theirs to make, even after a restart.
        { k: "int-reanchor", ts: now, id: s.id, anchor: msg.anchor, by: caller.personId },
        reanchor(s, msg.anchor, caller.personId),
      );
      sendReceipt(socket, "reanchor", true, { interactionId: s.id });
      afterMutation(rt, s, state);
      return;
    }
    case "interaction-anchor": {
      // Moves an unanchored interaction onto this page.
      const s = admitFrame(rt, socket, "anchor", "anchor", msg.interactionId, msg.frameUrl);
      if (!s) return;
      const frameUrl = unwrapForPage(msg.frameUrl);
      if (frameUrl.length === 0) {
        sendReceipt(socket, "anchor", false, { interactionId: s.id, reason: "url-mismatch" });
        return;
      }
      const anchored = anchorInteraction(s, {
        url: frameUrl,
        expectUrlPrefix: frameUrl,
        anchor: msg.anchor,
        actorId: caller.personId,
      });
      if (!anchored.ok) {
        sendReceipt(socket, "anchor", false, { interactionId: s.id, reason: anchored.reason });
        return;
      }
      const now = rt.clock.now();
      let state = commit(
        rt,
        {
          k: "int-anchored",
          ts: now,
          id: s.id,
          url: frameUrl,
          expectUrlPrefix: frameUrl,
          anchor: msg.anchor,
          actorId: caller.personId,
        },
        anchored.state,
      );
      state = systemNote(rt, state, `Anchored by ${caller.name}`);
      sendReceipt(socket, "anchor", true, { interactionId: s.id });
      afterMutation(rt, s, state);
      return;
    }
    case "interaction-anchor-lost": {
      // Fire-and-report: the broadcast is the acknowledgement.
      const s = rt.interactions.get(msg.interactionId);
      if (!s) return;
      const g = admit(rt, caller, "anchor-lost", s.id);
      // Only the page the anchor is on says it is lost (2-A4): the reporting
      // frame's URL is exactly the interaction's, never a deeper route that
      // the URL prefix would admit.
      if (!g.ok || s.anchor.level === "unanchored" || unwrapForPage(msg.frameUrl) !== s.url) return;
      // A block inside a frame of the page (A-3) is lost only by a client that
      // looked for it there: one that ignores `framePath` searched the wrong document.
      if ("framePath" in s.anchor && s.anchor.framePath && msg.framed !== true) return;
      const next = markAnchorLost(s);
      if (next === s) return;
      const state = commit(rt, { k: "int-anchor-lost", ts: rt.clock.now(), id: s.id }, next);
      afterMutation(rt, s, state);
      return;
    }
    case "interaction-sync":
      sendFrame(socket, buildInteractionsState(rt, unwrapForPage(msg.frameUrl), caller.access));
      return;
    case "attention-sync":
      sendFrame(socket, buildAttentionFrame(rt, caller));
      return;
    case "variant-create":
      onVariantCreate(rt, socket, msg);
      return;
    case "variant-sync": {
      const g = admitSet(rt, caller, "read", msg.setId, unwrapForPage(msg.frameUrl));
      if (g.ok) sendFrame(socket, buildVariantState(g.set));
      return;
    }
    case "variant-pick":
      sendVariantReceipt(
        socket,
        msg.setId,
        "pick",
        pickOp(
          rt,
          caller,
          msg.setId,
          {
            variantId: msg.variantId,
            version: msg.version,
            ...(msg.index !== undefined ? { index: msg.index } : {}),
          },
          unwrapForPage(msg.frameUrl),
        ),
      );
      return;
    case "variant-discard":
      sendVariantReceipt(
        socket,
        msg.setId,
        "discard",
        discardOp(rt, caller, msg.setId, unwrapForPage(msg.frameUrl)),
      );
      return;
    case "variant-steer":
      sendVariantReceipt(
        socket,
        msg.setId,
        "steer",
        steerOp(rt, caller, msg.setId, unwrapForPage(msg.instruction), unwrapForPage(msg.frameUrl)),
      );
      return;
    case "variant-tune":
      sendVariantReceipt(
        socket,
        msg.setId,
        "tune",
        tuneOp(
          rt,
          caller,
          msg.setId,
          msg.index,
          unwrapForPage(msg.instruction),
          unwrapForPage(msg.frameUrl),
        ),
      );
      return;
    case "variant-cycle":
      // Client-local: the overlay cycles previews itself; nothing to record.
      return;
    case "variant-outcome":
      // Fire-and-report: kept or not, nothing is sent back.
      outcomeOp(rt, caller, msg.setId, {
        frameUrl: unwrapForPage(msg.frameUrl),
        variantId: msg.variantId,
        version: msg.version,
        steps: msg.steps,
        applied: msg.applied,
        refused: msg.refused,
        ...(msg.rootMissing ? { rootMissing: true as const } : {}),
      });
      return;
  }
}

export function onClose(rt: Runtime, socket: SpaceSocket): void {
  const sessionId = socket.attachment()?.sessionId;
  if (sessionId === undefined) return;
  rt.sessionStore.append(
    { k: "disconnect", ts: rt.clock.now(), sessionId },
    rt.sessionStore.get(sessionId),
  );
}
