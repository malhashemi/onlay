import {
  type AdmissionCaller,
  addMessage,
  addSystemMessage,
  admitCreate,
  admitMutation,
  agentSetEditState,
  answerAsk,
  createInteraction,
  deleteMessage,
  discardSet,
  editMessage,
  heldByOther,
  type InteractionCreateInput,
  type InteractionJournalEntry,
  type InteractionState,
  isLive,
  type MutationKind,
  markImplemented,
  messageByClientId,
  react,
  releaseAgentWork,
  reopenInteraction,
  requestAgentWork,
  requestResnap,
  resolveInteraction,
  resolveSet,
  sendBatch,
  setChangeState,
  takeAgentWork,
  type VariantJournalEntry,
  type VariantSetState,
} from "@onlay/kernel";
import {
  type Anchor,
  type ApiErrorCode,
  type AskPayload,
  type Caller,
  type ChangePayload,
  LIMITS,
  type MutationProgram,
  personSpellings,
  programBytes,
  type RawRichText,
  runStandsAlone,
  type Token,
} from "@onlay/protocol";
import { pushOnMutation } from "./push";
import { canSee, fanOut, fanOutVariantState, type Runtime, sendNotify } from "./runtime";

/**
 * The shared mutation path. WebSocket frames and HTTP routes both funnel
 * through these operations, so admission, journaling, fan-out and agent work
 * stay identical across ingress paths. Every operation runs the kernel's
 * admission first: out of scope reads as `not_found`, a refused action as
 * `forbidden`, and a kernel refusal as `conflict` with the reducer's reason.
 */

export interface Refusal {
  code: ApiErrorCode;
  /** A short machine tag (the receipt `reason`, the error `reason`). */
  reason: string;
  message: string;
  /** Fields a client acts on, beside `error` (a size refusal's `measured` and `allowed`). */
  extra?: Record<string, unknown>;
}

export type Outcome<T> = ({ ok: true } & T) | ({ ok: false } & Refusal);

export const refuse = (code: ApiErrorCode, reason: string, message: string) =>
  ({ ok: false, code, reason, message }) as const;

export const NOT_FOUND = refuse("not_found", "unknown", "Nothing is here.");

/**
 * The page a block's frame sits in, as the space keeps it (2-F7): origin +
 * path, no credentials, query or fragment (a dropped one marked `?…`, as the
 * extension's redaction does). Null for anything that isn't an http(s) URL.
 */
function redactHostUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const head = `${u.origin}${u.pathname}`;
  return u.search !== "" || u.hash !== "" ? `${head}?…` : head;
}

/**
 * A shared page's address as it is stored and sent: redacted, and left out
 * when too long for a snapshot (3-F6). Null when it isn't a web address.
 */
export function storedHostUrl(raw: string): { hostUrl?: string } | null {
  const parsed = redactHostUrl(raw);
  if (parsed === null) return null;
  return parsed.length <= LIMITS.MAX_URL ? { hostUrl: parsed } : {};
}

const FORBIDDEN_MESSAGES: Record<string, string> = {
  guest: "People a thread is shared with can reply, react and attach, but not do this.",
  agent: "Agents can reply, post variants, move an Edit along, take and release. Not this.",
  "needs-anchor": "Holding the page, place it on a block or the page.",
  "needs-page": "This needs the page. Open it in the onlay extension.",
  "edit-needs-page":
    "An Edit needs a page to place it on. Open the page in the onlay extension to make this Edit.",
  "not-allowed": "That isn't something you can do here.",
  "no-source":
    "This Edit's page has no known source, so an agent can't implement it. Post new variants instead.",
};

export function forbidden(reason: string): Refusal & { ok: false } {
  const message = FORBIDDEN_MESSAGES[reason] ?? "That isn't something you can do here.";
  return refuse("forbidden", reason, message);
}

export function conflict(reason: string, message?: string): Refusal & { ok: false } {
  return refuse("conflict", reason, message ?? `That can't be done right now (${reason}).`);
}

const asAdmission = (caller: Caller): AdmissionCaller => ({
  class: caller.class,
  access: caller.access,
});

export const isMember = (caller: Caller): boolean => caller.access.kind === "member";

/**
 * Another person's agent holds this item (spec §7): an agent write by anyone
 * else is refused and changes nothing. Human writes are never held.
 */
export function heldRefusal(
  rt: Runtime,
  caller: Caller,
  s: InteractionState,
): (Refusal & { ok: false }) | null {
  if (caller.class !== "agent" || !heldByOther(s, caller.personId, rt.clock.now())) return null;
  return conflict("held", "Another person's agent holds this item right now.");
}

/**
 * The interaction, when the caller may see it and make this mutation;
 * otherwise the refusal (missing and unreadable are the same `not_found`).
 */
export function admit(
  rt: Runtime,
  caller: Caller,
  kind: MutationKind,
  interactionId: string,
): Outcome<{ s: InteractionState }> {
  const s = rt.interactions.get(interactionId);
  if (!s || !canSee(caller.access, interactionId)) return NOT_FOUND;
  const a = admitMutation(asAdmission(caller), kind, interactionId);
  if (!a.ok) return a.code === "not_found" ? NOT_FOUND : forbidden(a.reason);
  return { ok: true, s };
}

/** The interaction, when the caller may see it (reads). */
export function visible(
  rt: Runtime,
  caller: Caller,
  interactionId: string,
): Outcome<{ s: InteractionState }> {
  const s = rt.interactions.get(interactionId);
  if (!s || !canSee(caller.access, interactionId)) return NOT_FOUND;
  return { ok: true, s };
}

/* ── journaling ───────────────────────────────────────────────────── */

/**
 * Applies an in-memory update once storage holds it: at once outside
 * `transact`, after its transaction commits inside one. Memory is never
 * ahead of storage, so a failed write leaves both as they were.
 */
function publish(rt: Runtime, apply: () => void): void {
  if (rt.staged) rt.staged.push(apply);
  else apply();
}

/**
 * Runs `fn` as one storage transaction and publishes its in-memory updates
 * only after it commits: several journal entries (a set and its Edit) land
 * together or not at all. `fn` must not read back what it just committed
 * from the runtime's maps; it uses the states it computed.
 */
export function transact<T>(rt: Runtime, fn: () => T): T {
  if (rt.staged) return fn();
  const staged: Array<() => void> = [];
  rt.staged = staged;
  let out: T;
  try {
    out = rt.db.transaction(fn);
  } finally {
    rt.staged = null;
  }
  for (const apply of staged) apply();
  return out;
}

/** Journal one entry with its resulting state; returns that state. */
export function commit(
  rt: Runtime,
  entry: InteractionJournalEntry,
  next: InteractionState,
): InteractionState {
  rt.interactionStore.append(entry, next);
  publish(rt, () => rt.interactions.set(next.id, next));
  return next;
}

/** Journal one variant-set entry with its resulting state; returns that state. */
export function commitSet(
  rt: Runtime,
  entry: VariantJournalEntry,
  next: VariantSetState,
): VariantSetState {
  rt.variantStore.append(entry, next);
  publish(rt, () => rt.variantSets.set(next.setId, next));
  return next;
}

/** Append a runtime-authored system note (unfakeable) and persist it. */
export function systemNote(rt: Runtime, s: InteractionState, text: string): InteractionState {
  const now = rt.clock.now();
  const r = addSystemMessage(s, text, LIMITS.MAX_THREAD_MSGS, now);
  if (!r.added) return s;
  return commit(rt, { k: "int-msg", ts: now, id: s.id, msg: r.msg }, r.state);
}

/** The one post-mutation choke point: per-socket fan-out, waits, push. */
export function afterMutation(
  rt: Runtime,
  prev: InteractionState | undefined,
  next: InteractionState,
): void {
  fanOut(rt, prev, next);
  pushOnMutation(rt, prev, next);
}

/* ── creation ─────────────────────────────────────────────────────── */

export interface CreateInput {
  kind: InteractionState["kind"];
  anchor: Anchor;
  /** The page (the frame's real URL); ignored for unanchored interactions. */
  url?: string;
  /** The top page when the block is in a frame of it (display only); ignored when unanchored. */
  hostUrl?: string;
  body?: RawRichText;
  ask?: AskPayload;
  change?: ChangePayload;
  /** The client's correlation id: a repeat of the same create answers with the first. */
  nonce?: string;
}

/**
 * Source ownership (spec §8), derived server-side, never claimed: the anchor
 * carries a `sourcePointer`, or a page edit's page carries a provenance stamp.
 */
export function ownsSourceOf(anchor: Anchor, provenance: string | undefined): boolean {
  if (anchor.level === "element") return anchor.sourcePointer !== undefined;
  if (anchor.level === "page") return provenance !== undefined && provenance.length > 0;
  return false;
}

/** The space already holds `MAX_LIVE_INTERACTIONS` live interactions: no more are created. */
export function spaceFull(rt: Runtime): (Refusal & { ok: false }) | null {
  let live = 0;
  for (const s of rt.interactions.values()) if (isLive(s)) live++;
  if (live < LIMITS.MAX_LIVE_INTERACTIONS) return null;
  return conflict(
    "space-full",
    `This space holds ${LIMITS.MAX_LIVE_INTERACTIONS} open threads. Resolve some before starting more.`,
  );
}

/**
 * The interaction this author already created with this client nonce, if
 * any: a repeat of that create answers with it instead of making another.
 */
export function createdWithNonce(
  rt: Runtime,
  caller: Caller,
  nonce: string | undefined,
): InteractionState | undefined {
  if (nonce === undefined) return undefined;
  for (const s of rt.interactions.values()) {
    if (s.createNonce === nonce && s.authorId === caller.personId) return s;
  }
  return undefined;
}

export function createOp(
  rt: Runtime,
  caller: Caller,
  input: CreateInput,
): Outcome<{ state: InteractionState }> {
  const a = admitCreate(asAdmission(caller), input.kind, input.anchor);
  if (!a.ok) return forbidden(a.reason);
  const repeat = createdWithNonce(rt, caller, input.nonce);
  if (repeat) return canSee(caller.access, repeat.id) ? { ok: true, state: repeat } : NOT_FOUND;
  const full = spaceFull(rt);
  if (full) return full;
  const unanchored = input.anchor.level === "unanchored";
  const url = unanchored ? "" : (input.url ?? "");
  if (!unanchored && url.length === 0)
    return conflict("url-mismatch", "This needs the page's URL.");
  // Display metadata the caller supplies (2-F7): a web address, kept as origin + path.
  const parsedHost =
    unanchored || input.hostUrl === undefined ? undefined : redactHostUrl(input.hostUrl);
  if (parsedHost === null)
    return refuse("invalid", "host-url", "The shared page's address isn't a web address.");
  // Measured as it will be stored and sent (percent-encoded): one too long
  // for a snapshot is left out, and the create goes on without it (3-F6).
  const hostUrl =
    parsedHost !== undefined && parsedHost.length <= LIMITS.MAX_URL ? parsedHost : undefined;
  const now = rt.clock.now();
  const change = input.change
    ? {
        intent: input.change.intent,
        method: input.change.method ?? "direct",
        ownsSource: ownsSourceOf(input.anchor, input.change.provenance),
        ...(input.change.provenance !== undefined ? { provenance: input.change.provenance } : {}),
      }
    : undefined;
  const entry: InteractionCreateInput = {
    id: rt.uuid(),
    kind: input.kind,
    url,
    expectUrlPrefix: url,
    ...(hostUrl !== undefined ? { hostUrl } : {}),
    anchor: input.anchor,
    authorId: caller.personId,
    member: isMember(caller),
    ...(input.nonce !== undefined ? { nonce: input.nonce } : {}),
    ...(input.body ? { body: checkedSpans(rt, caller, input.body) } : {}),
    ...(input.ask ? { ask: input.ask } : {}),
    ...(change ? { change } : {}),
    // A tray Edit asks for an agent when its batch is sent, not before.
    ...(change?.method === "manual-batch" ? { requestAgent: false } : {}),
  };
  const created = createInteraction(entry, now);
  if (!created.ok) return refuse("invalid", created.reason, "The interaction is incomplete.");
  const state = commit(rt, { k: "int-create", ts: now, ...entry }, created.state);
  afterMutation(rt, undefined, state);
  if (state.kind === "ask" && state.ask) {
    sendNotify(rt, state, {
      title: state.ask.question,
      body: state.ask.context,
      personIds: state.waitingOn,
    });
  }
  return { ok: true, state };
}

/* ── thread ───────────────────────────────────────────────────────── */

/** The text a token's pill puts in the body, as far as the server can tell. */
function pillFits(rt: Runtime, caller: Caller, tok: Token, text: string): boolean {
  if (tok.t === "agent") return text === "@agent";
  if (tok.t === "anchor") return text === `#${tok.label}`;
  if (text.length < 2 || !text.startsWith("@") || text.includes("\n")) return false;
  const known = rt.people.get(tok.actorId);
  // Someone the space hasn't heard of yet: their pill is still an `@` run.
  if (known === undefined) return true;
  // The clients' one rule (`@onlay/protocol` mention-rule): name, id or alias,
  // the alias only where this caller's directory shows it (a member, for a
  // fellow member): a guest's span over a guessed alias is dropped like any
  // other text, so what they read back says nothing about anyone's alias.
  const alias = caller.access.kind === "member" && known.member ? known.alias : undefined;
  return personSpellings(tok.actorId, known.name, alias).includes(text);
}

/**
 * The body with only the pill spans the server can vouch for (M-4): inside
 * the text, holding the token's `@`/`#` pill, not overlapping another. A
 * dropped span leaves its token to the renderer's text matching.
 */
function checkedSpans(rt: Runtime, caller: Caller, body: RawRichText): RawRichText {
  if (!body.tokens?.some((t) => t.spans !== undefined)) return body;
  const taken: Array<[number, number]> = [];
  const overlaps = (a: number, b: number) => taken.some(([x, y]) => a < y && x < b);
  const tokens = body.tokens.map((tok): Token => {
    if (tok.spans === undefined) return tok;
    const { spans: all, ...rest } = tok;
    const spans = all.filter((sp) => {
      const end = sp.start + sp.length;
      if (end > body.text.length || overlaps(sp.start, end)) return false;
      if (!runStandsAlone(body.text, sp.start, end)) return false;
      if (!pillFits(rt, caller, tok, body.text.slice(sp.start, end))) return false;
      taken.push([sp.start, end]);
      return true;
    });
    return (spans.length > 0 ? { ...rest, spans } : rest) as Token;
  });
  return { ...body, tokens };
}

/**
 * A guest may mention only people already taking part in the interaction:
 * any other `@` token is dropped before the message is reduced (the words
 * stay), so a guest can't pull a stranger into a thread, or into the
 * directory they read.
 */
function mentionsFor(caller: Caller, s: InteractionState, body: RawRichText): RawRichText {
  if (caller.access.kind !== "guest" || !body.tokens) return body;
  const known = new Set(s.participants);
  const tokens = body.tokens.filter((t) => t.t !== "actor" || known.has(t.actorId));
  if (tokens.length === body.tokens.length) return body;
  const { tokens: _all, ...rest } = body;
  return tokens.length > 0 ? { ...rest, tokens } : rest;
}

export function replyOp(
  rt: Runtime,
  caller: Caller,
  id: string,
  input: { body: RawRichText; replyTo?: { msgId: string }; clientId?: string },
): Outcome<{ state: InteractionState; msgId: string; repeat?: true }> {
  const g = admit(rt, caller, "reply", id);
  if (!g.ok) return g;
  // A repeat of a send that already landed (its receipt was lost): the first
  // answer again, and nothing new in the thread (M-1).
  const first =
    input.clientId !== undefined
      ? messageByClientId(g.s, caller.personId, input.clientId)
      : undefined;
  if (first) return { ok: true, state: g.s, msgId: first.msgId, repeat: true };
  const held = heldRefusal(rt, caller, g.s);
  if (held) return held;
  const now = rt.clock.now();
  const agent = caller.class === "agent";
  const member = isMember(caller);
  const body = checkedSpans(rt, caller, mentionsFor(caller, g.s, input.body));
  const r = addMessage(
    g.s,
    {
      authorId: caller.personId,
      body,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(agent ? { agent: true } : {}),
      ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
      member,
    },
    LIMITS.MAX_THREAD_MSGS,
    now,
  );
  if (!r.added) return conflict(r.reason);
  const state = commit(
    rt,
    { k: "int-msg", ts: now, id, msg: r.msg, ...(member ? { member: true } : {}) },
    r.state,
  );
  afterMutation(rt, g.s, state);
  return { ok: true, state, msgId: r.msg.msgId };
}

export function editOp(
  rt: Runtime,
  caller: Caller,
  id: string,
  input: { msgId: string; body: RawRichText },
): Outcome<{ state: InteractionState }> {
  const g = admit(rt, caller, "edit-own", id);
  if (!g.ok) return g;
  const now = rt.clock.now();
  const body = checkedSpans(rt, caller, mentionsFor(caller, g.s, input.body));
  // A human member's edit adding @agent asks for an agent; an agent's never does.
  const member = isMember(caller) && caller.class !== "agent";
  const r = editMessage(
    g.s,
    { msgId: input.msgId, actorId: caller.personId, body, ...(member ? { member: true } : {}) },
    now,
  );
  if (!r.edited) return conflict(r.reason);
  const state = commit(
    rt,
    {
      k: "int-msg-edit",
      ts: now,
      id,
      msgId: input.msgId,
      actorId: caller.personId,
      body,
      ...(member ? { member: true } : {}),
    },
    r.state,
  );
  afterMutation(rt, g.s, state);
  return { ok: true, state };
}

export function deleteOp(
  rt: Runtime,
  caller: Caller,
  id: string,
  msgId: string,
): Outcome<{ state: InteractionState }> {
  const g = admit(rt, caller, "delete-own", id);
  if (!g.ok) return g;
  const target = g.s.thread.find((m) => m.msgId === msgId);
  // A re-delete is idempotent: ok without journaling again.
  if (target?.deleted && target.authorId === caller.personId) return { ok: true, state: g.s };
  const now = rt.clock.now();
  const r = deleteMessage(g.s, { msgId, actorId: caller.personId }, now);
  if (!r.deleted) return conflict(r.reason);
  const state = commit(
    rt,
    { k: "int-msg-delete", ts: now, id, msgId, actorId: caller.personId },
    r.state,
  );
  afterMutation(rt, g.s, state);
  return { ok: true, state };
}

export function reactOp(
  rt: Runtime,
  caller: Caller,
  id: string,
  input: { msgId: string; emoji: string; on: boolean },
): Outcome<{ state: InteractionState }> {
  const g = admit(rt, caller, "react", id);
  if (!g.ok) return g;
  // A reaction on a message that never existed (or was deleted) is refused —
  // never journal an `int-react` for a phantom target.
  const target = g.s.thread.find((m) => m.msgId === input.msgId);
  if (!target || target.deleted) return refuse("not_found", "unknown-message", "No such message.");
  const now = rt.clock.now();
  const next = react(g.s, { ...input, actorId: caller.personId });
  const state = commit(
    rt,
    { k: "int-react", ts: now, id, actorId: caller.personId, ...input },
    next,
  );
  afterMutation(rt, g.s, state);
  return { ok: true, state };
}

/* ── the ask control ──────────────────────────────────────────────── */

export function answerOp(
  rt: Runtime,
  caller: Caller,
  id: string,
  input: { optionIds: string[]; comment?: RawRichText },
): Outcome<{ state: InteractionState }> {
  const g = admit(rt, caller, "answer", id);
  if (!g.ok) return g;
  const now = rt.clock.now();
  // An answer's comment keeps only the pill spans the server can vouch for, as a reply does.
  const answer = input.comment
    ? { ...input, comment: checkedSpans(rt, caller, input.comment) }
    : input;
  const r = answerAsk(g.s, { actorId: caller.personId, ...answer }, [], now);
  if (!r.ok) return conflict(r.reason);
  let state = commit(rt, { k: "int-answer", ts: now, id, answer: r.answer }, r.state);
  if (r.aggregateMet) state = systemNote(rt, state, "Ask answered");
  afterMutation(rt, g.s, state);
  return { ok: true, state };
}

/* ── lifecycle ────────────────────────────────────────────────────── */

/**
 * Close the Edit's variant set with it: a picked set resolves keeping its
 * outcome (spec §8), an unpicked live set is discarded.
 */
function closeSetOf(rt: Runtime, s: InteractionState): void {
  const setId = s.change?.variantSetId;
  const set = setId ? rt.variantSets.get(setId) : undefined;
  if (!set || set.status === "resolved") return;
  const now = rt.clock.now();
  if (set.outcome === "picked") {
    const r = resolveSet(set, now);
    if (!r.ok) return;
    commitSet(rt, { k: "variant-resolved", ts: now, setId: set.setId }, r.state);
    fanOutVariantState(rt, r.state);
    return;
  }
  const r = discardSet(set, now);
  if (!r.ok) return;
  commitSet(rt, { k: "variant-discarded", ts: now, setId: set.setId }, r.state);
  fanOutVariantState(rt, r.state);
}

export function resolveOp(
  rt: Runtime,
  caller: Caller,
  id: string,
): Outcome<{ state: InteractionState; changed: boolean }> {
  const g = admit(rt, caller, "resolve", id);
  if (!g.ok) return g;
  const now = rt.clock.now();
  const r = resolveInteraction(g.s, caller.personId, "human", now);
  if (!r.resolved) return forbidden(r.reason);
  if (!r.changed) return { ok: true, state: g.s, changed: false };
  let state = commit(
    rt,
    { k: "int-resolve", ts: now, id, actorId: caller.personId, actorKind: "human" },
    r.state,
  );
  state = systemNote(rt, state, "Resolved");
  closeSetOf(rt, state);
  afterMutation(rt, g.s, state);
  return { ok: true, state, changed: true };
}

export function reopenOp(
  rt: Runtime,
  caller: Caller,
  id: string,
): Outcome<{ state: InteractionState; changed: boolean }> {
  const g = admit(rt, caller, "reopen", id);
  if (!g.ok) return g;
  const r = reopenInteraction(g.s, caller.personId, "human");
  if (!r.reopened) return conflict(r.reason);
  if (!r.changed) return { ok: true, state: g.s, changed: false };
  // Reopening makes it live again: it counts against the space's live cap.
  const full = spaceFull(rt);
  if (full) return full;
  const now = rt.clock.now();
  let state = commit(
    rt,
    { k: "int-reopen", ts: now, id, actorId: caller.personId, actorKind: "human" },
    r.state,
  );
  state = systemNote(rt, state, "Reopened");
  afterMutation(rt, g.s, state);
  if (state.kind === "ask" && state.ask) {
    sendNotify(rt, state, {
      title: state.ask.question,
      body: state.ask.context,
      personIds: state.waitingOn,
    });
  }
  return { ok: true, state, changed: true };
}

/**
 * `POST /interaction/:id/state`. An agent may set `working` or `implemented`
 * (agent-marked, answering agent work); `implemented` retires the kept
 * program, moves a picked set to verifying, and hands the Edit to its
 * requester to verify, as today. People may drop or resolve.
 */
export function stateOp(
  rt: Runtime,
  caller: Caller,
  id: string,
  next: string,
): Outcome<{ state: InteractionState }> {
  if (caller.class === "agent") {
    const g = admit(rt, caller, "agent-state", id);
    if (!g.ok) return g;
    if (g.s.kind !== "change") return conflict("not-change", "Only an Edit has these states.");
    if (next !== "working" && next !== "implemented") return forbidden("agent");
    // Without a known source there is nothing for an agent to implement; a kept
    // Edit stays kept (new variants are the agent's way in).
    if (g.s.change?.ownsSource !== true) return forbidden("no-source");
    const held = heldRefusal(rt, caller, g.s);
    if (held) return held;
    const now = rt.clock.now();
    const r = agentSetEditState(g.s, next, caller.personId, now);
    if (!r.changed) return conflict(r.reason);
    let state = commit(
      rt,
      { k: "int-state", ts: now, id, state: next, agent: true, actorId: caller.personId },
      r.state,
    );
    if (next === "implemented") state = toVerifying(rt, state);
    afterMutation(rt, g.s, state);
    return { ok: true, state };
  }
  if (next === "resolved") {
    const r = resolveOp(rt, caller, id);
    return r.ok ? { ok: true, state: r.state } : r;
  }
  if (next !== "dropped") return forbidden("not-allowed");
  const g = admit(rt, caller, "set-state", id);
  if (!g.ok) return g;
  const now = rt.clock.now();
  const r = setChangeState(g.s, "dropped", now);
  if (!r.changed) return conflict(r.reason);
  let state = commit(rt, { k: "int-state", ts: now, id, state: "dropped" }, r.state);
  state = systemNote(rt, state, "Edit dropped");
  closeSetOf(rt, state);
  afterMutation(rt, g.s, state);
  return { ok: true, state };
}

/** implemented → verifying: the set follows, and the requester is told. */
function toVerifying(rt: Runtime, s: InteractionState): InteractionState {
  const now = rt.clock.now();
  const setId = s.change?.variantSetId;
  const set = setId ? rt.variantSets.get(setId) : undefined;
  if (set) {
    const m = markImplemented(set, now);
    if (m.ok) {
      commitSet(rt, { k: "variant-implemented", ts: now, setId: set.setId }, m.state);
      fanOutVariantState(rt, m.state);
    }
  }
  const r = setChangeState(s, "verifying", now);
  if (!r.changed) return s;
  let state = commit(rt, { k: "int-state", ts: now, id: s.id, state: "verifying" }, r.state);
  state = systemNote(rt, state, "Edit ready to verify");
  sendNotify(rt, state, {
    title: state.change?.intent ?? "Edit",
    body: "Ready to verify",
    personIds: [state.authorId],
  });
  return state;
}

/* ── agent work (spec §7) ─────────────────────────────────────────── */

export function takeOp(
  rt: Runtime,
  caller: Caller,
  id: string,
  onBehalf: boolean,
): Outcome<{ state: InteractionState }> {
  const g = admit(rt, caller, "take", id);
  if (!g.ok) return g;
  const now = rt.clock.now();
  const r = takeAgentWork(g.s, { personId: caller.personId, onBehalf }, now);
  if (!r.taken) {
    if (r.reason === "not-yours")
      return refuse(
        "forbidden",
        "not-yours",
        "This item was handed to a teammate's agent. Take it only when your person asked, with onBehalf.",
      );
    if (r.reason === "held")
      return conflict("held", "Another person's agent holds this item right now.");
    if (r.reason === "not-pending")
      return conflict("not-pending", "Nothing on this item is waiting for an agent.");
    return conflict(r.reason);
  }
  const state = commit(
    rt,
    {
      k: "int-agent-take",
      ts: now,
      id,
      actorId: caller.personId,
      ...(onBehalf ? { onBehalf: true } : {}),
    },
    r.state,
  );
  afterMutation(rt, g.s, state);
  return { ok: true, state };
}

export function releaseOp(
  rt: Runtime,
  caller: Caller,
  id: string,
): Outcome<{ state: InteractionState }> {
  const g = admit(rt, caller, "release", id);
  if (!g.ok) return g;
  const now = rt.clock.now();
  const r = releaseAgentWork(g.s, caller.personId, now);
  if (!r.released) return conflict(r.reason, "Only the agent holding this item can release it.");
  // A lease that ran out is already pending: nothing to journal.
  if (!r.changed) return { ok: true, state: g.s };
  const state = commit(
    rt,
    { k: "int-agent-release", ts: now, id, actorId: caller.personId },
    r.state,
  );
  afterMutation(rt, g.s, state);
  return { ok: true, state };
}

/** A member asked for an agent another way (a steer or tune of the Edit's variants). */
export function requestAgentOp(rt: Runtime, caller: Caller, s: InteractionState): InteractionState {
  if (!isMember(caller)) return s;
  const now = rt.clock.now();
  const r = requestAgentWork(s, caller.personId, now);
  if (!r.requested) return s;
  return commit(
    rt,
    { k: "int-agent-request", ts: now, id: s.id, actorId: caller.personId },
    r.state,
  );
}

/* ── fresh look · batches ─────────────────────────────────────────── */

export function resnapOp(
  rt: Runtime,
  caller: Caller,
  id: string,
): Outcome<{ state: InteractionState; pending: boolean }> {
  const g = admit(rt, caller, "fresh-look", id);
  if (!g.ok) return g;
  const now = rt.clock.now();
  const r = requestResnap(g.s, caller.personId, now);
  if (!r.requested) {
    if (r.reason === "pending") return { ok: true, state: g.s, pending: true };
    return conflict(r.reason);
  }
  let state = commit(
    rt,
    { k: "int-resnap-request", ts: now, id, actorId: caller.personId },
    r.state,
  );
  state = systemNote(rt, state, "requested a fresh look");
  afterMutation(rt, g.s, state);
  return { ok: true, state, pending: false };
}

export function batchOp(
  rt: Runtime,
  caller: Caller,
  id: string,
  ops: MutationProgram,
): Outcome<{ state: InteractionState }> {
  const g = admit(rt, caller, "batch", id);
  if (!g.ok) return g;
  const batchBytes = programBytes(ops);
  if (batchBytes > LIMITS.MAX_PROGRAM_BYTES) {
    return {
      ...refuse(
        "invalid",
        "program-too-large",
        `The batch is ${batchBytes} bytes; at most ${LIMITS.MAX_PROGRAM_BYTES} are allowed.`,
      ),
      extra: { measured: batchBytes, allowed: LIMITS.MAX_PROGRAM_BYTES },
    };
  }
  const sent = (g.s.change?.batches ?? []).reduce((n, b) => n + programBytes(b), 0);
  if (sent + batchBytes > LIMITS.MAX_SET_PROGRAM_BYTES) {
    return {
      ...refuse(
        "invalid",
        "set-too-large",
        `This Edit's batches would come to ${sent + batchBytes} bytes; at most ${LIMITS.MAX_SET_PROGRAM_BYTES} are allowed.`,
      ),
      extra: { measured: sent + batchBytes, allowed: LIMITS.MAX_SET_PROGRAM_BYTES },
    };
  }
  const now = rt.clock.now();
  const member = isMember(caller);
  const r = sendBatch(g.s, { actorId: caller.personId, ops, member }, now);
  if (!r.sent) return conflict(r.reason);
  let state = commit(
    rt,
    {
      k: "int-send-batch",
      ts: now,
      id,
      actorId: caller.personId,
      ops,
      ...(member ? { member: true } : {}),
    },
    r.state,
  );
  state = systemNote(rt, state, state.state === "kept" ? "Batch kept" : "Batch sent");
  afterMutation(rt, g.s, state);
  return { ok: true, state };
}
