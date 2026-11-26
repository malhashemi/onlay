/**
 * Interaction state machines — Comment · Ask · Change (ADR-0001/0003/0004).
 *
 * Pure reducers over one envelope; the server shell owns I/O, ids, and
 * clocks. Kernel state stores PLAIN strings (the server re-brands at the
 * agent boundary — same posture as variant state before the recut).
 *
 * State law (the membrane's business, never an artifact's status):
 *   comment  open → resolved
 *   ask      open → answered → resolved   (+ superseded · dropped)
 *   change   open → working → implemented → verifying → resolved  (+ dropped)
 *            open/working → kept (a pick or hand-made batch on a page whose
 *            source is unknown: the program stays applied as a preview);
 *            kept → working → … when an agent picks the Edit back up
 *
 * Agent work (spec §7) rides any kind: a member asks for an agent, an agent
 * takes it under a lease, and an agent write answers it.
 *
 * Threads ride every interaction; the control answers an ask, never the
 * thread. Resolution sheds the pin; anchor loss DEMOTES, never drops.
 */
import {
  type ActorKind,
  type AgentWork,
  type Anchor,
  type AnchoredAnchor,
  type AskAnswer,
  type AskPayload,
  type ChangePayload,
  type ClientClass,
  type InteractionKind,
  LIMITS,
  type MutationProgram,
  type RawRichText,
  type RawThreadMsg,
} from "@onlay/protocol";

export interface AskState extends AskPayload {
  answers: AskAnswer[];
}

export interface ChangeState extends ChangePayload {
  variantSetId?: string;
  batches: MutationProgram[];
  /** Who kept the current program (the picker, or the batch's author) and when (spec §8). */
  keptBy?: string;
  keptAt?: number;
}

export interface InteractionState {
  id: string;
  kind: InteractionKind;
  /** The page this interaction is bound to (anti-spoof: frames must match). */
  url: string;
  expectUrlPrefix: string;
  /**
   * The page the person shares, when the block is inside a frame of it (the
   * tab's top URL, redacted): shown and opened, never matched against.
   */
  hostUrl?: string;
  anchor: Anchor;
  anchorLost?: boolean;
  authorId: string;
  participants: string[];
  waitingOn: string[];
  state: string;
  thread: RawThreadMsg[];
  msgSeq: number;
  ask?: AskState;
  change?: ChangeState;
  createdAt: number;
  resolvedAt?: number;
  /**
   * A pending "Capture due" duty (ADR-0022 §7). Flat, single-slot, live-only:
   * an involved participant asked the place be looked at again. Absent = no
   * duty. Cleared by a fulfilling snapshot commit and by any closing transition
   * (a closed place can never discharge a "look again" obligation).
   */
  resnapRequestedBy?: string;
  resnapRequestedAt?: number;
  /** The "for agent" state (spec §7). Read it through `effectiveAgentWork`: leases expire. */
  agentWork?: AgentWork;
  /** People this interaction is shared with now (their current share grants). */
  sharedWith?: string[];
  /**
   * Of those, the ones who have not opened, replied to or reacted on it yet:
   * a "shared with you" debt, so the guest finds it in their Inbox. Its own
   * record: it does not depend on whether they already took part.
   */
  shareUnseen?: string[];
  /** Of those, the ones the share itself made participants (removed with the share). */
  shareJoined?: string[];
  /**
   * Who last anchored or re-anchored it, when that wasn't at creation: their
   * extension supplies the markup of the block it now sits on (round 2, S13).
   * Server-side only; never on the wire.
   */
  anchoredBy?: string;
  /**
   * The creating client's `nonce`, when it sent one: a repeat of that create
   * by the same author answers with this interaction instead of a second one.
   * Server-side only; never on the wire.
   */
  createNonce?: string;
}

/** States that no longer accept thread/answer mutations. */
function isClosed(s: InteractionState): boolean {
  return s.resolvedAt !== undefined || s.state === "dropped" || s.state === "superseded";
}

/**
 * Terminal = the interaction was abandoned or replaced; nothing may follow.
 * Resolved is NOT terminal: the thread outlives the resolution so an answer
 * can be talked about in place (F-047 — live-caught when an answered ask
 * auto-resolved and the human's comment had nowhere to land).
 * Answers/state transitions still gate on isClosed; only thread speech
 * (add/edit/delete, reactions) uses this looser gate.
 */
function isTerminal(s: InteractionState): boolean {
  return s.state === "dropped" || s.state === "superseded";
}

/** Live = counts on the badge, wears a pin. */
export function isLive(s: InteractionState): boolean {
  return !isClosed(s);
}

/** Does this text carry the `@agent` token? */
export function mentionsAgent(body: RawRichText | undefined): boolean {
  return body?.tokens?.some((t) => t.t === "agent") ?? false;
}

function mentionedActorIds(body: RawRichText | undefined): string[] {
  if (!body?.tokens) return [];
  const ids: string[] = [];
  for (const t of body.tokens) if (t.t === "actor") ids.push(t.actorId);
  return ids;
}

function addParticipants(prev: string[], add: Iterable<string>): string[] {
  const set = new Set(prev);
  for (const id of add) set.add(id);
  return [...set];
}

/**
 * The reply-target's author is an IMPLICIT mention (ADR-0018 §1): same law as
 * an explicit `@` — join participants (and, at the server, the same wake).
 * System notes have no real author; they never mint one.
 */
function replyTargetAuthor(
  thread: RawThreadMsg[],
  replyTo: { msgId: string } | undefined,
): string[] {
  if (!replyTo) return [];
  const target = thread.find((m) => m.msgId === replyTo.msgId);
  if (!target || target.system) return [];
  return [target.authorId];
}

/* ── creation ─────────────────────────────────────────────────────── */

export interface InteractionCreateInput {
  id: string;
  kind: InteractionKind;
  url: string;
  expectUrlPrefix: string;
  /** The top page's URL when the block is inside a frame of it (display only). */
  hostUrl?: string;
  anchor: Anchor;
  authorId: string;
  /** Root message (required for comment; optional opening note otherwise). */
  body?: RawRichText;
  ask?: AskPayload;
  change?: ChangePayload;
  /**
   * The author is a member of the space (not a guest). Only a member's
   * `@agent`, Direct or Variants Edit, or batch on an owned page asks for an
   * agent. Server-derived from the caller, never client-claimed.
   */
  member?: boolean;
  /**
   * Overrides whether creation asks for an agent (e.g. false for a manual
   * single-variant set). Absent = derived from the kind, method and body.
   */
  requestAgent?: boolean;
  /**
   * A hand-made batch (method `manual-batch`, spec §8): the Edit's program.
   * Not `ownsSource` → born `kept`; `ownsSource` → `open` with agent work pending.
   */
  batch?: MutationProgram;
  /** The creating client's correlation id (`interaction-create` / `variant-create` `nonce`). */
  nonce?: string;
}

export type CreateInteractionResult =
  | { ok: true; state: InteractionState }
  | { ok: false; reason: "payload-mismatch" };

/**
 * The initiation authority of the paired client, derived server-side from its
 * credential (ADR-0023, spec §4). NEVER caller-supplied:
 *   full        — the extension (page-holding surface);
 *   interaction — the web app (judgment-first, pageless);
 *   agent       — an MCP client acting as its person.
 */
export type { ClientClass };

/**
 * Who may open WHAT (ADR-0020/0023). The matrix, read once:
 *   agent (actor OR client class)  → unanchored Ask only (DR-009);
 *   interaction human              → unanchored Ask/Comment; Edit refused
 *                                    (`edit-needs-page`); no page to anchor to;
 *   full human (extension)         → the original ADR-0020 gate (must anchor).
 */
export function validateInitiation(
  actorKind: ActorKind,
  clientClass: ClientClass,
  kind: InteractionKind,
  anchor: Anchor,
):
  | { ok: true }
  | { ok: false; reason: "agent-initiation" | "human-unanchored" | "edit-needs-page" } {
  if (actorKind === "agent" || clientClass === "agent") {
    return kind === "ask" && anchor.level === "unanchored"
      ? { ok: true }
      : { ok: false, reason: "agent-initiation" };
  }
  // human:
  if (clientClass === "interaction") {
    // Edit needs a page to place it on — the pwa holds none (always refused).
    if (kind === "change") return { ok: false, reason: "edit-needs-page" };
    if (anchor.level === "unanchored") {
      return kind === "ask" || kind === "comment"
        ? { ok: true }
        : { ok: false, reason: "human-unanchored" };
    }
    // No page to anchor to on a pageless surface → deferred.
    return { ok: false, reason: "human-unanchored" };
  }
  // full (extension): the original ADR-0020 gate, intact.
  if (anchor.level === "unanchored") return { ok: false, reason: "human-unanchored" };
  return { ok: true };
}

/** Does a member creating this interaction ask for an agent (spec §7, §8)? */
function creationRequestsAgent(input: InteractionCreateInput): boolean {
  if (input.requestAgent !== undefined) return input.requestAgent;
  if (!input.member) return false;
  if (mentionsAgent(input.body)) return true;
  if (input.kind !== "change") return false;
  const method = input.change?.method ?? "direct";
  if (method === "manual-batch") return input.change?.ownsSource === true;
  return true;
}

export function createInteraction(
  input: InteractionCreateInput,
  now: number,
): CreateInteractionResult {
  if (input.kind === "comment" && !input.body) return { ok: false, reason: "payload-mismatch" };
  if (input.kind === "ask" && !input.ask) return { ok: false, reason: "payload-mismatch" };
  if (input.kind === "change" && !input.change) return { ok: false, reason: "payload-mismatch" };
  if (input.batch && (input.kind !== "change" || input.change?.method !== "manual-batch"))
    return { ok: false, reason: "payload-mismatch" };

  const waitingOn =
    input.kind === "ask"
      ? [...(input.ask?.waitingOn ?? [])]
      : input.kind === "change" && input.change?.routesTo
        ? [input.change.routesTo]
        : [];

  const thread: RawThreadMsg[] = [];
  let msgSeq = 0;
  if (input.body) {
    msgSeq = 1;
    thread.push({ msgId: "m1", authorId: input.authorId, body: input.body, ts: now });
  }

  // A hand-made batch on a page whose source is unknown is kept at once.
  const keptBatch = input.batch !== undefined && input.change?.ownsSource !== true;
  const change = input.change
    ? {
        change: {
          ...input.change,
          batches: input.batch ? [input.batch] : [],
          // The batch is the Edit's program; it applies while kept or working.
          ...(input.batch ? { keptBy: input.authorId, keptAt: now } : {}),
        },
      }
    : {};

  const state: InteractionState = {
    id: input.id,
    kind: input.kind,
    url: input.url,
    expectUrlPrefix: input.expectUrlPrefix,
    ...(input.hostUrl !== undefined ? { hostUrl: input.hostUrl } : {}),
    anchor: input.anchor,
    authorId: input.authorId,
    participants: addParticipants(
      [input.authorId],
      [...waitingOn, ...mentionedActorIds(input.body)],
    ),
    waitingOn,
    state: keptBatch ? "kept" : "open",
    thread,
    msgSeq,
    ...(input.ask ? { ask: { ...input.ask, answers: [] } } : {}),
    ...change,
    createdAt: now,
    ...(input.nonce !== undefined ? { createNonce: input.nonce } : {}),
  };
  return {
    ok: true,
    state: creationRequestsAgent(input)
      ? requestAgentWork(state, input.authorId, now).state
      : state,
  };
}

/* ── thread ───────────────────────────────────────────────────────── */

export type AddMessageResult =
  | { state: InteractionState; added: true; msg: RawThreadMsg }
  | { state: InteractionState; added: false; reason: "closed" | "cap" };

/**
 * Append a thread message. An agent-marked message (`agent`) answers the
 * interaction's agent work; otherwise a member's message carrying `@agent`
 * asks for an agent (a guest's never does). `member` is server-derived.
 */
export function addMessage(
  s: InteractionState,
  input: {
    authorId: string;
    body: RawRichText;
    system?: boolean;
    replyTo?: { msgId: string };
    agent?: boolean;
    member?: boolean;
    /** The sending client's request id (`interaction-reply` `clientId`). */
    clientId?: string;
  },
  maxMsgs: number,
  now: number,
): AddMessageResult {
  if (isTerminal(s) && !input.system) return { state: s, added: false, reason: "closed" };
  if (s.thread.length >= maxMsgs) return { state: s, added: false, reason: "cap" };
  // A reply-target must exist in this thread. Unknown target → store the
  // message WITHOUT replyTo (never reject a reply over a stale reference).
  // A deleted target is still a tombstone in the thread: keep the reference;
  // renderers show "original message removed" (ADR-0018 §1).
  const replyTo =
    input.replyTo && s.thread.some((m) => m.msgId === input.replyTo?.msgId)
      ? { msgId: input.replyTo.msgId }
      : undefined;
  const msg: RawThreadMsg = {
    msgId: `m${s.msgSeq + 1}`,
    authorId: input.authorId,
    body: input.body,
    ts: now,
    ...(input.system ? { system: true } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(input.agent && !input.system ? { agent: true } : {}),
    ...(input.clientId !== undefined && !input.system ? { clientId: input.clientId } : {}),
  };
  const appended: InteractionState = {
    ...s,
    thread: [...s.thread, msg],
    msgSeq: s.msgSeq + 1,
    participants: input.system
      ? s.participants
      : addParticipants(s.participants, [
          input.authorId,
          ...mentionedActorIds(input.body),
          ...replyTargetAuthor(s.thread, replyTo),
        ]),
  };
  const next = agentWorkAfterMessage(appended, msg, input.member === true, now);
  // Only the person's own message pays a share debt; their agent's does not.
  return {
    state: input.system || input.agent ? next : shareSeen(next, input.authorId),
    added: true,
    msg,
  };
}

/** The agent-work consequence of one appended message — shared by enqueue and replay. */
function agentWorkAfterMessage(
  s: InteractionState,
  msg: RawThreadMsg,
  member: boolean,
  now: number,
): InteractionState {
  if (msg.system) return s;
  if (msg.agent) return answerAgentWork(s, msg.authorId, now).state;
  if (member && mentionsAgent(msg.body)) return requestAgentWork(s, msg.authorId, now).state;
  return s;
}

/**
 * The message this author already added with this request id, if any: a
 * repeat of that send must answer with it rather than add another.
 */
export function messageByClientId(
  s: InteractionState,
  authorId: string,
  clientId: string,
): RawThreadMsg | undefined {
  return s.thread.find((m) => !m.system && m.authorId === authorId && m.clientId === clientId);
}

/** Runtime-authored transition note — unfakeable (server-only path). */
export function addSystemMessage(
  s: InteractionState,
  text: string,
  maxMsgs: number,
  now: number,
): AddMessageResult {
  return addMessage(s, { authorId: "system", body: { text }, system: true }, maxMsgs, now);
}

export type EditMessageResult =
  | { state: InteractionState; edited: true }
  | { state: InteractionState; edited: false; reason: "closed" | "unknown-msg" | "not-editable" };

/**
 * Edit-as-revision: the journal keeps every prior body. Author-only. A
 * member's edit that newly carries `@agent` asks for an agent, exactly as a
 * new message would (a guest's never does); `member` is server-derived and
 * journaled, so replay agrees.
 */
export function editMessage(
  s: InteractionState,
  input: { msgId: string; actorId: string; body: RawRichText; member?: boolean },
  now: number,
): EditMessageResult {
  if (isTerminal(s)) return { state: s, edited: false, reason: "closed" };
  const msg = s.thread.find((m) => m.msgId === input.msgId);
  if (!msg) return { state: s, edited: false, reason: "unknown-msg" };
  if (msg.authorId !== input.actorId || msg.deleted || msg.system)
    return { state: s, edited: false, reason: "not-editable" };
  const thread = s.thread.map((m) =>
    m.msgId === input.msgId ? { ...m, body: input.body, editedAt: now } : m,
  );
  const edited: InteractionState = {
    ...s,
    thread,
    participants: addParticipants(s.participants, mentionedActorIds(input.body)),
  };
  const asks =
    input.member === true && !msg.agent && !mentionsAgent(msg.body) && mentionsAgent(input.body);
  return {
    state: asks ? requestAgentWork(edited, input.actorId, now).state : edited,
    edited: true,
  };
}

export type DeleteMessageResult =
  | { state: InteractionState; deleted: true }
  | { state: InteractionState; deleted: false; reason: "closed" | "unknown-msg" | "not-editable" };

/** Tombstone: body emptied, structure kept (replies keep their context). */
export function deleteMessage(
  s: InteractionState,
  input: { msgId: string; actorId: string },
  now: number,
): DeleteMessageResult {
  if (isTerminal(s)) return { state: s, deleted: false, reason: "closed" };
  const msg = s.thread.find((m) => m.msgId === input.msgId);
  if (!msg) return { state: s, deleted: false, reason: "unknown-msg" };
  if (msg.authorId !== input.actorId || msg.system)
    return { state: s, deleted: false, reason: "not-editable" };
  if (msg.deleted) return { state: s, deleted: true }; // idempotent
  const thread = s.thread.map((m) =>
    m.msgId === input.msgId ? { ...m, body: { text: "" }, deleted: true, editedAt: now } : m,
  );
  return { state: { ...s, thread }, deleted: true };
}

/** Idempotent reaction toggle — micro-signals, never state. */
export function react(
  s: InteractionState,
  input: { msgId: string; actorId: string; emoji: string; on: boolean },
): InteractionState {
  const msg = s.thread.find((m) => m.msgId === input.msgId);
  if (!msg || msg.deleted) return s;
  const prev = msg.reactions?.[input.emoji] ?? [];
  const has = prev.includes(input.actorId);
  if (input.on === has) return s;
  const nextIds = input.on ? [...prev, input.actorId] : prev.filter((a) => a !== input.actorId);
  const reactions = { ...(msg.reactions ?? {}) };
  if (nextIds.length) reactions[input.emoji] = nextIds;
  else delete reactions[input.emoji];
  const thread = s.thread.map((m) =>
    m.msgId === input.msgId
      ? { ...m, reactions: Object.keys(reactions).length ? reactions : undefined }
      : m,
  );
  return shareSeen({ ...s, thread }, input.actorId);
}

/* ── shares (spec §6): a guest finds what is shared with them ─────── */

/**
 * The interaction was shared with this person: it records the grant and a
 * "shared with you" debt, whether or not they already took part (a person
 * mentioned before is still owed a look); someone not yet a participant
 * joins, and leaves again with the share. A repeat changes nothing.
 */
export function shareWith(s: InteractionState, personId: string): InteractionState {
  if ((s.sharedWith ?? []).includes(personId)) return s;
  const joins = !s.participants.includes(personId);
  return {
    ...s,
    ...(joins ? { participants: [...s.participants, personId] } : {}),
    sharedWith: [...(s.sharedWith ?? []), personId],
    shareUnseen: [...(s.shareUnseen ?? []), personId],
    ...(joins ? { shareJoined: [...(s.shareJoined ?? []), personId] } : {}),
  };
}

/** The share was removed: the grant and the debt go, and a participant it made leaves. */
export function unshare(s: InteractionState, personId: string): InteractionState {
  if (!(s.sharedWith ?? []).includes(personId)) return s;
  const drop = (ids: string[] | undefined) => (ids ?? []).filter((id) => id !== personId);
  const joined = (s.shareJoined ?? []).includes(personId);
  const { sharedWith: _w, shareUnseen: _u, shareJoined: _j, ...rest } = s;
  const sharedWith = drop(s.sharedWith);
  const shareUnseen = drop(s.shareUnseen);
  const shareJoined = drop(s.shareJoined);
  return {
    ...rest,
    participants: joined ? drop(s.participants) : s.participants,
    ...(sharedWith.length > 0 ? { sharedWith } : {}),
    ...(shareUnseen.length > 0 ? { shareUnseen } : {}),
    ...(shareJoined.length > 0 ? { shareJoined } : {}),
  };
}

/** The guest opened, replied or reacted: the "shared with you" debt is paid. */
export function shareSeen(s: InteractionState, personId: string): InteractionState {
  if (!(s.shareUnseen ?? []).includes(personId)) return s;
  const shareUnseen = (s.shareUnseen ?? []).filter((id) => id !== personId);
  const { shareUnseen: _u, ...rest } = s;
  return shareUnseen.length > 0 ? { ...rest, shareUnseen } : rest;
}

/* ── the ask control ──────────────────────────────────────────────── */

export type AnswerAskResult =
  | { state: InteractionState; ok: true; answer: AskAnswer; aggregateMet: boolean }
  | {
      state: InteractionState;
      ok: false;
      reason:
        | "not-ask"
        | "closed"
        | "not-addressee"
        | "unknown-option"
        | "selection"
        | "comment-required"
        | "blocked";
    };

/**
 * The semantic answer event. Re-answering before resolution replaces the
 * actor's previous answer. `blockedOptionIds` carries runtime-computed
 * recipe links ("open change blocks approve") — the kernel enforces, the
 * server computes.
 */
export function answerAsk(
  s: InteractionState,
  input: { actorId: string; optionIds: string[]; comment?: RawRichText },
  blockedOptionIds: string[],
  now: number,
): AnswerAskResult {
  const ask = s.ask;
  if (s.kind !== "ask" || !ask) return { state: s, ok: false, reason: "not-ask" };
  if (isClosed(s)) return { state: s, ok: false, reason: "closed" };
  if (!ask.waitingOn.includes(input.actorId))
    return { state: s, ok: false, reason: "not-addressee" };

  const valid = new Set(ask.options.map((o) => o.id));
  const picked = [...new Set(input.optionIds)];
  if (picked.length !== input.optionIds.length || picked.some((id) => !valid.has(id)))
    return { state: s, ok: false, reason: "unknown-option" };
  const { min, max } = ask.selection;
  if (picked.length < min || picked.length > max)
    return { state: s, ok: false, reason: "selection" };
  if (ask.answerComment === "required" && !input.comment?.text.trim())
    return { state: s, ok: false, reason: "comment-required" };
  if (picked.some((id) => blockedOptionIds.includes(id)))
    return { state: s, ok: false, reason: "blocked" };

  const answer: AskAnswer = {
    actorId: input.actorId,
    optionIds: input.optionIds,
    ...(input.comment !== undefined ? { comment: input.comment } : {}),
    ts: now,
  };
  const answers = [...ask.answers.filter((a) => a.actorId !== input.actorId), answer];

  const rule = ask.resolvesWhen ?? "any-one";
  let aggregateMet = false;
  if (rule === "any-one") aggregateMet = true;
  else if (rule === "everyone")
    aggregateMet = ask.waitingOn.every((a) => answers.some((x) => x.actorId === a));
  else {
    // majority: the most common exact pick must clear half the addressees
    const tally = new Map<string, number>();
    for (const a of answers) {
      const key = [...a.optionIds].sort().join("|");
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    const top = Math.max(0, ...tally.values());
    aggregateMet = top * 2 > ask.waitingOn.length;
  }

  // State and waitingOn derive from the FULL answers set every time — a
  // re-answer that flips a majority must fall back to open, never linger
  // "answered" with nobody waited on (gpt-5.5 audit finding).
  const answered = new Set(answers.map((a) => a.actorId));
  const next: InteractionState = {
    ...s,
    ask: { ...ask, answers },
    state: aggregateMet ? "answered" : "open",
    participants: addParticipants(s.participants, [input.actorId]),
    // an answered addressee is no longer waited on; the ASKER now owns resolve
    waitingOn: aggregateMet ? [] : ask.waitingOn.filter((a) => !answered.has(a)),
  };
  return { state: next, ok: true, answer, aggregateMet };
}

/* ── resolution & lifecycle ───────────────────────────────────────── */

export type ResolveResult =
  | { state: InteractionState; resolved: true; changed: boolean }
  | { state: InteractionState; resolved: false; reason: "not-allowed" };

/**
 * Vanishing is earned by resolution. Authority (v1): the author always may;
 * any HUMAN participant may (humans are the overseers); an agent may resolve
 * only its own. The shell passes the resolver's kind.
 */
export function resolveInteraction(
  s: InteractionState,
  actorId: string,
  actorKind: "human" | "agent",
  now: number,
): ResolveResult {
  if (isClosed(s)) return { state: s, resolved: true, changed: false }; // idempotent
  const allowed = actorId === s.authorId || actorKind === "human";
  if (!allowed) return { state: s, resolved: false, reason: "not-allowed" };
  return {
    // Closing discharges any pending "Capture due" duty (a resolved place can
    // never fulfill a fresh-look obligation, ADR-0022 §7).
    state: dropResnap(
      withoutAgentWork({ ...s, state: "resolved", resolvedAt: now, waitingOn: [] }),
    ),
    resolved: true,
    changed: true,
  };
}

/**
 * Closing ends any agent work (spec §7): a resolved or dropped interaction
 * is nobody's to take, and reopening never brings an old claim back.
 */
function withoutAgentWork(s: InteractionState): InteractionState {
  if (s.agentWork === undefined) return s;
  const { agentWork: _gone, ...rest } = s;
  return rest;
}

export type ReopenResult =
  | { state: InteractionState; reopened: true; changed: boolean }
  | { state: InteractionState; reopened: false; reason: "not-allowed" | "terminal" };

/**
 * Resolution is not a one-way door (F26): a RESOLVED interaction may be
 * reopened by exactly the authority that could resolve it — the author
 * always; any human; an agent only its own. Terminal states stay terminal:
 * dropped is abandonment and superseded has a successor — decisions, not
 * pauses. Reopening restores the kind's natural waiting: an ask re-waits on
 * its unanswered addressees, a change re-waits on its route, a comment waits
 * on nobody until spoken to. The change lifecycle restarts at `open` — the
 * forward-only ladder is for one pass; a reopened change is a new pass.
 */
export function reopenInteraction(
  s: InteractionState,
  actorId: string,
  actorKind: "human" | "agent",
): ReopenResult {
  if (isTerminal(s)) return { state: s, reopened: false, reason: "terminal" };
  if (!isClosed(s)) return { state: s, reopened: true, changed: false }; // idempotent — already live
  const allowed = actorId === s.authorId || actorKind === "human";
  if (!allowed) return { state: s, reopened: false, reason: "not-allowed" };
  const { resolvedAt: _closed, ...base } = s;
  const answered = new Set((s.ask?.answers ?? []).map((a) => a.actorId));
  const waitingOn =
    s.kind === "ask"
      ? (s.ask?.waitingOn ?? []).filter((a) => !answered.has(a))
      : s.kind === "change" && s.change?.routesTo
        ? [s.change.routesTo]
        : [];
  // A reopened change starts a NEW pass: the spent variant set and its method
  // unlink (a resolved/discarded set refuses submissions and must not steer
  // the next attempt); applied batches stay — they are history, like the
  // thread. Intent and route are the change's identity and survive.
  const change =
    s.kind === "change" && s.change
      ? {
          change: {
            intent: s.change.intent,
            ...(s.change.routesTo !== undefined ? { routesTo: s.change.routesTo } : {}),
            ...(s.change.ownsSource !== undefined ? { ownsSource: s.change.ownsSource } : {}),
            ...(s.change.provenance !== undefined ? { provenance: s.change.provenance } : {}),
            batches: s.change.batches,
          },
        }
      : {};
  return {
    state: { ...base, ...change, state: "open", waitingOn },
    reopened: true,
    changed: true,
  };
}

const CHANGE_ORDER = ["open", "working", "implemented", "verifying", "resolved"] as const;

/** `kept` sits beside `open` on the forward ladder: any later state may follow it. */
function changeRank(state: string): number {
  return state === "kept" ? 0 : CHANGE_ORDER.indexOf(state as (typeof CHANGE_ORDER)[number]);
}

export type SetChangeStateResult =
  | { state: InteractionState; changed: true }
  | { state: InteractionState; changed: false; reason: "not-change" | "closed" | "backward" };

/** Forward-only change lifecycle; `dropped` exits from any live state. */
export function setChangeState(
  s: InteractionState,
  next: (typeof CHANGE_ORDER)[number] | "dropped",
  now: number,
): SetChangeStateResult {
  if (s.kind !== "change") return { state: s, changed: false, reason: "not-change" };
  if (isClosed(s)) return { state: s, changed: false, reason: "closed" };
  if (next === "dropped") {
    return {
      state: dropResnap(
        withoutAgentWork({ ...s, state: "dropped", resolvedAt: now, waitingOn: [] }),
      ),
      changed: true,
    };
  }
  const from = changeRank(s.state);
  const to = CHANGE_ORDER.indexOf(next);
  if (to <= from) return { state: s, changed: false, reason: "backward" };
  const resolved = next === "resolved";
  const advanced: InteractionState = {
    ...s,
    state: next,
    ...(resolved ? { resolvedAt: now } : {}),
    // verifying hands the wait back to the requester (the human's closing act)
    waitingOn: resolved
      ? []
      : next === "verifying"
        ? [s.authorId]
        : s.change?.routesTo
          ? [s.change.routesTo]
          : s.waitingOn,
  };
  // Resolving discharges any pending "Capture due" duty; a mid-flow advance
  // (working/implemented/verifying) stays live and keeps it.
  return {
    state: resolved ? dropResnap(withoutAgentWork(advanced)) : advanced,
    changed: true,
  };
}

export type PickEditResult =
  | { state: InteractionState; changed: true }
  | { state: InteractionState; changed: false; reason: "not-change" | "closed" | "wrong-state" };

/**
 * A variant was picked on this Edit's set (spec §8: pick is keep). On a page
 * whose source is known (`ownsSource`) the Edit goes to `working` with agent
 * work pending, for an agent to implement; otherwise it becomes `kept` and
 * the picked program stays applied. Allowed from open, working and kept (a
 * re-pick after an agent posted new variants). `actorId` is the picker;
 * `requestedBy` is who the agent work is for (the picker, unless a guest
 * picked: then the Edit's author, since a guest never requests agent work).
 */
export function pickEdit(
  s: InteractionState,
  actorId: string,
  now: number,
  requestedBy: string = actorId,
): PickEditResult {
  if (s.kind !== "change" || !s.change) return { state: s, changed: false, reason: "not-change" };
  if (isClosed(s)) return { state: s, changed: false, reason: "closed" };
  if (s.state !== "open" && s.state !== "working" && s.state !== "kept")
    return { state: s, changed: false, reason: "wrong-state" };
  const change = { ...s.change, keptBy: actorId, keptAt: now };
  if (s.change.ownsSource) {
    const working: InteractionState = { ...s, change, state: "working", waitingOn: [] };
    return { state: requestAgentWork(working, requestedBy, now).state, changed: true };
  }
  return { state: { ...s, change, state: "kept", waitingOn: [] }, changed: true };
}

/** An agent changes the Edit's state through MCP: the state moves, and the write answers agent work. */
export function agentSetEditState(
  s: InteractionState,
  next: "working" | "implemented",
  personId: string,
  now: number,
): SetChangeStateResult {
  const r = setChangeState(s, next, now);
  if (!r.changed) return r;
  return { state: answerAgentWork(r.state, personId, now).state, changed: true };
}

/* ── agent work (spec §7) ─────────────────────────────────────────── */

/** The agent work as of `now`: a taken item whose lease ran out reads as pending. */
export function effectiveAgentWork(s: InteractionState, now: number): AgentWork | undefined {
  const w = s.agentWork;
  if (w?.status !== "taken") return w;
  if (w.leaseUntil !== undefined && w.leaseUntil > now) return w;
  return { status: "pending", requestedBy: w.requestedBy, requestedAt: w.requestedAt };
}

/**
 * Another person's agent holds an unexpired lease here: an agent write by
 * `personId` would trample the holder's work and is refused (spec §7).
 */
export function heldByOther(s: InteractionState, personId: string, now: number): boolean {
  const w = effectiveAgentWork(s, now);
  return w?.status === "taken" && w.takenBy !== personId;
}

export type RequestAgentWorkResult =
  | { state: InteractionState; requested: true }
  | { state: InteractionState; requested: false; reason: "closed" };

/**
 * A member asks for an agent: agent work becomes pending with them as the
 * requester, replacing any earlier take or answer. Refused once closed.
 */
export function requestAgentWork(
  s: InteractionState,
  personId: string,
  now: number,
): RequestAgentWorkResult {
  if (isClosed(s)) return { state: s, requested: false, reason: "closed" };
  return {
    state: { ...s, agentWork: { status: "pending", requestedBy: personId, requestedAt: now } },
    requested: true,
  };
}

export type TakeAgentWorkResult =
  | { state: InteractionState; taken: true }
  | {
      state: InteractionState;
      taken: false;
      reason: "closed" | "not-pending" | "not-yours" | "held";
    };

/**
 * An agent of `personId` claims the item. Allowed for the requester's own
 * agent, or for a teammate's when `onBehalf` (set only when their human asked);
 * refused while another person's unexpired lease holds. The holder taking
 * again renews its lease.
 */
export function takeAgentWork(
  s: InteractionState,
  input: { personId: string; onBehalf?: boolean },
  now: number,
): TakeAgentWorkResult {
  if (isClosed(s)) return { state: s, taken: false, reason: "closed" };
  const w = effectiveAgentWork(s, now);
  if (!w || w.status === "answered") return { state: s, taken: false, reason: "not-pending" };
  if (w.requestedBy !== input.personId && !input.onBehalf)
    return { state: s, taken: false, reason: "not-yours" };
  if (w.status === "taken" && w.takenBy !== input.personId)
    return { state: s, taken: false, reason: "held" };
  return {
    state: {
      ...s,
      agentWork: {
        status: "taken",
        requestedBy: w.requestedBy,
        requestedAt: w.requestedAt,
        takenBy: input.personId,
        takenAt: w.status === "taken" && w.takenAt !== undefined ? w.takenAt : now,
        leaseUntil: now + LIMITS.AGENT_LEASE_MS,
      },
    },
    taken: true,
  };
}

export type ReleaseAgentWorkResult =
  | { state: InteractionState; released: true; changed: boolean }
  | { state: InteractionState; released: false; reason: "not-holder" };

/**
 * The holder gives the item back: it returns to pending for the same
 * requester. Read on the effective status: a claim whose lease ran out is
 * already pending, so releasing it succeeds and changes nothing.
 */
export function releaseAgentWork(
  s: InteractionState,
  personId: string,
  now: number,
): ReleaseAgentWorkResult {
  const w = s.agentWork;
  if (w?.status === "taken" && effectiveAgentWork(s, now)?.status === "pending") {
    return { state: s, released: true, changed: false };
  }
  if (w?.status !== "taken" || w.takenBy !== personId)
    return { state: s, released: false, reason: "not-holder" };
  return {
    state: {
      ...s,
      agentWork: { status: "pending", requestedBy: w.requestedBy, requestedAt: w.requestedAt },
    },
    released: true,
    changed: true,
  };
}

/** Every agent write by the lease holder extends the lease. */
export function renewAgentLease(
  s: InteractionState,
  personId: string,
  now: number,
): InteractionState {
  const w = s.agentWork;
  if (!w || w.takenBy !== personId || w.leaseUntil === undefined) return s;
  if (w.status === "taken" && w.leaseUntil <= now) return s; // expired: no longer the holder
  return { ...s, agentWork: { ...w, leaseUntil: now + LIMITS.AGENT_LEASE_MS } };
}

export type AnswerAgentWorkResult =
  | { state: InteractionState; answered: true }
  | { state: InteractionState; answered: false; reason: "none" | "already-answered" | "held" };

/**
 * An agent of `personId` wrote (reply, variants, state): pending or taken
 * agent work becomes answered. Another person's unexpired lease keeps the
 * item theirs: the write stands but answers nothing. The holder's lease renews.
 */
export function answerAgentWork(
  s: InteractionState,
  personId: string,
  now: number,
): AnswerAgentWorkResult {
  const w = effectiveAgentWork(s, now);
  if (!w) return { state: s, answered: false, reason: "none" };
  if (w.status === "answered")
    return {
      state: renewAgentLease(s, personId, now),
      answered: false,
      reason: "already-answered",
    };
  if (w.status === "taken" && w.takenBy !== personId)
    return { state: s, answered: false, reason: "held" };
  const answered: AgentWork = {
    status: "answered",
    requestedBy: w.requestedBy,
    requestedAt: w.requestedAt,
    answeredAt: now,
    ...(w.status === "taken" && w.takenBy !== undefined
      ? { takenBy: w.takenBy, takenAt: w.takenAt ?? now, leaseUntil: now + LIMITS.AGENT_LEASE_MS }
      : {}),
  };
  return { state: { ...s, agentWork: answered }, answered: true };
}

/** An ask superseded by a newer one. */
export function supersedeAsk(s: InteractionState, now: number): InteractionState {
  if (s.kind !== "ask" || isClosed(s)) return s;
  return dropResnap({ ...s, state: "superseded", resolvedAt: now, waitingOn: [] });
}

/* ── resnap: request/fulfill a fresh look (ADR-0022 §7) ───────────────── */

export type RequestResnapResult =
  | { state: InteractionState; requested: true }
  | {
      state: InteractionState;
      requested: false;
      reason: "closed" | "pending" | "not-capturable";
    };

/**
 * Fulfillment is a Full client re-capturing the anchored element/selection
 * (ADR-0022 §7); page-level and unanchored places have NO capture path, so a
 * fresh-look duty lit on them could never be discharged — a permanent "Capture
 * due". `requestResnap` refuses them structurally, the one server-side rule the
 * clients mirror (`@onlay/render` `anchorIsCapturable`; the kernel inlines the
 * same element/selection test, being unable to import render). Keep the two in
 * lockstep — a kernel test pins the levels.
 */
function anchorCapturable(s: InteractionState): boolean {
  return s.anchor.level === "element" || s.anchor.level === "selection";
}

/**
 * Any involved participant asks the place be looked at again. At most one duty
 * outstanding: a second request before fulfillment is idempotent — it neither
 * stacks nor resets the timestamp. A closed place has no duty and refuses one;
 * an un-capturable place (page-level/unanchored) refuses one it could never
 * honour.
 */
export function requestResnap(
  s: InteractionState,
  actorId: string,
  now: number,
): RequestResnapResult {
  if (!isLive(s)) return { state: s, requested: false, reason: "closed" };
  if (!anchorCapturable(s)) return { state: s, requested: false, reason: "not-capturable" };
  if (s.resnapRequestedBy) return { state: s, requested: false, reason: "pending" };
  return {
    state: { ...s, resnapRequestedBy: actorId, resnapRequestedAt: now },
    requested: true,
  };
}

/** A Full client committed a fresh snapshot; the duty is discharged. The
 *  captureId is taken for journal/record symmetry only — the fulfilled capture
 *  is discoverable as the newest snapshot revision on `s.captures`. */
export function fulfillResnap(s: InteractionState, _captureId: string): InteractionState {
  return dropResnap(s);
}

/** Strip both resnap keys (not undefined-valued). No-op when nothing pending. */
function dropResnap(s: InteractionState): InteractionState {
  if (!s.resnapRequestedBy) return s;
  const { resnapRequestedBy: _b, resnapRequestedAt: _a, ...rest } = s;
  return rest;
}

/**
 * Runtime policy hook: point the wait at whoever holds the next decision
 * WITHOUT a state transition — e.g. a variant set entering `previewing`
 * keeps the Change `working` but the PICK is the human's (ADR-0004/0006).
 */
export function setWaitingOn(s: InteractionState, actorIds: string[]): InteractionState {
  if (isClosed(s)) return s;
  const same =
    s.waitingOn.length === actorIds.length && actorIds.every((a, i) => s.waitingOn[i] === a);
  if (same) return s;
  return {
    ...s,
    waitingOn: [...actorIds],
    participants: addParticipants(s.participants, actorIds),
  };
}

/* ── anchors (ADR-0005) ───────────────────────────────────────────── */

export type AnchorInteractionResult =
  | { ok: true; state: InteractionState }
  | { ok: false; reason: "not-unanchored" | "closed" };

/** Move a live unanchored Ask onto the page ladder; note emission is server-owned. */
export function anchorInteraction(
  s: InteractionState,
  input: { url: string; expectUrlPrefix: string; anchor: AnchoredAnchor; actorId: string },
): AnchorInteractionResult {
  if (s.anchor.level !== "unanchored") return { ok: false, reason: "not-unanchored" };
  if (!isLive(s)) return { ok: false, reason: "closed" };
  return {
    ok: true,
    state: {
      ...s,
      url: input.url,
      expectUrlPrefix: input.expectUrlPrefix,
      anchor: input.anchor,
      anchoredBy: input.actorId,
    },
  };
}

/** Page drift orphans the ANCHOR, never the interaction: demote + flag. */
export function markAnchorLost(s: InteractionState): InteractionState {
  if (isClosed(s) || s.anchorLost || s.anchor.level === "unanchored") return s;
  return { ...s, anchorLost: true };
}

/**
 * Where an anchor points: its level, selector and block id (3b-S3), and the
 * frames it sits in (A-3).
 */
function placeOf(
  a: Anchor,
): [string, string | undefined, string | undefined, readonly string[] | undefined] {
  return [
    a.level,
    "selector" in a ? a.selector : undefined,
    "blockId" in a ? a.blockId : undefined,
    "framePath" in a ? a.framePath : undefined,
  ];
}

/**
 * Move the anchor. `by` (who moved it) gets the one-shot permission to upload
 * the new block's markup (R3-S5), bound to this anchor revision: only a REAL
 * move mints it, one that changes the anchor's level, selector, block id
 * (3b-S3) or frame path (A-3). Re-anchoring onto the same block with new descriptive fields
 * (snippet, label, source pointer) grants nothing; the next move replaces the
 * permission, and markup existing voids it.
 */
export function reanchor(s: InteractionState, anchor: Anchor, by?: string): InteractionState {
  if (isClosed(s)) return s;
  const moved = JSON.stringify(placeOf(s.anchor)) !== JSON.stringify(placeOf(anchor));
  return {
    ...s,
    anchor,
    anchorLost: false,
    ...(by !== undefined && moved ? { anchoredBy: by } : {}),
  };
}

/* ── change methods ───────────────────────────────────────────────── */

/** Attach the variant set that became this change's method (ADR-0004). */
export function attachVariantSet(s: InteractionState, setId: string): InteractionState {
  if (s.kind !== "change" || !s.change) return s;
  return { ...s, change: { ...s.change, variantSetId: setId, method: "variant-set" } };
}

export type AddBatchResult =
  | { state: InteractionState; added: true }
  | { state: InteractionState; added: false; reason: "not-change" | "closed" };

/** The human's batched manual ops — one Send, one program. */
export function addBatch(s: InteractionState, ops: MutationProgram): AddBatchResult {
  if (s.kind !== "change" || !s.change) return { state: s, added: false, reason: "not-change" };
  if (isClosed(s)) return { state: s, added: false, reason: "closed" };
  return {
    state: { ...s, change: { ...s.change, batches: [...s.change.batches, ops] } },
    added: true,
  };
}

export type SendBatchResult =
  | { state: InteractionState; sent: true }
  | { state: InteractionState; sent: false; reason: "not-change" | "closed" };

/**
 * A person sends a hand-made batch from the Edit page tray (spec §8). The batch
 * is appended; on a `manual-batch` Edit it becomes the Edit's program (kept by
 * the sender): on a page whose source is unknown the Edit is `kept` at once,
 * on an owned page it stays where it is and a member's batch asks for an
 * agent. On any other Edit a member's batch on an owned page asks for an agent.
 */
export function sendBatch(
  s: InteractionState,
  input: { actorId: string; ops: MutationProgram; member?: boolean },
  now: number,
): SendBatchResult {
  const added = addBatch(s, input.ops);
  if (!added.added) return { state: s, sent: false, reason: added.reason };
  const c = added.state.change;
  if (!c) return { state: s, sent: false, reason: "not-change" };
  const owned = c.ownsSource === true;
  let next = added.state;
  if (c.method === "manual-batch") {
    const change = { ...c, keptBy: input.actorId, keptAt: now };
    const keep = !owned && (next.state === "open" || next.state === "kept");
    next = { ...next, change, ...(keep ? { state: "kept", waitingOn: [] } : {}) };
  }
  if (owned && input.member) next = requestAgentWork(next, input.actorId, now).state;
  return { state: next, sent: true };
}

/** The URL-binding anti-spoof gate. */
export function matchesUrlPrefix(url: string, prefix: string): boolean {
  if (prefix.length === 0 || !url.startsWith(prefix)) return false;
  // Boundary-aware: "…/item" must not admit "…/item-evil" (path smuggling).
  if (prefix.endsWith("/")) return true;
  const next = url.charAt(prefix.length);
  return next === "" || next === "/" || next === "?" || next === "#";
}

/* ── journal codec ────────────────────────────────────────────────── */

export type InteractionJournalEntry =
  | ({ k: "int-create"; ts: number; id: string } & Omit<InteractionCreateInput, "id">)
  /** `member`: the author was a member, so their `@agent` asks for an agent on replay too. */
  | { k: "int-msg"; ts: number; id: string; msg: RawThreadMsg; member?: boolean }
  /** `member`: a member edited, so newly adding `@agent` asks for an agent on replay too. */
  | {
      k: "int-msg-edit";
      ts: number;
      id: string;
      msgId: string;
      actorId: string;
      body: RawRichText;
      member?: boolean;
    }
  | { k: "int-msg-delete"; ts: number; id: string; msgId: string; actorId: string }
  | {
      k: "int-react";
      ts: number;
      id: string;
      msgId: string;
      actorId: string;
      emoji: string;
      on: boolean;
    }
  | { k: "int-answer"; ts: number; id: string; answer: AskAnswer }
  | { k: "int-resolve"; ts: number; id: string; actorId: string; actorKind: "human" | "agent" }
  | { k: "int-reopen"; ts: number; id: string; actorId: string; actorKind: "human" | "agent" }
  /** `agent` + `actorId`: an agent set the state through MCP, which answers agent work. */
  | { k: "int-state"; ts: number; id: string; state: string; agent?: boolean; actorId?: string }
  | { k: "int-supersede"; ts: number; id: string }
  | { k: "int-waiting"; ts: number; id: string; actorIds: string[] }
  | {
      k: "int-anchored";
      ts: number;
      id: string;
      url: string;
      expectUrlPrefix: string;
      anchor: AnchoredAnchor;
      actorId: string;
    }
  | { k: "int-reanchor"; ts: number; id: string; anchor: Anchor; by?: string }
  | { k: "int-anchor-lost"; ts: number; id: string }
  | { k: "int-attach-set"; ts: number; id: string; setId: string }
  | { k: "int-batch"; ts: number; id: string; ops: MutationProgram }
  /** A hand-made batch sent from the Edit page tray (spec §8): see `sendBatch`. */
  | {
      k: "int-send-batch";
      ts: number;
      id: string;
      actorId: string;
      ops: MutationProgram;
      member?: boolean;
    }
  | { k: "int-resnap-request"; ts: number; id: string; actorId: string }
  | { k: "int-resnap-fulfill"; ts: number; id: string; captureId: string }
  /** A share added this guest (`shareWith`), removed it (`unshare`), or the guest opened it (`shareSeen`). */
  | { k: "int-share-add"; ts: number; id: string; personId: string }
  | { k: "int-share-remove"; ts: number; id: string; personId: string }
  | { k: "int-share-seen"; ts: number; id: string; personId: string }
  /** `requestedBy`: who the pick's agent work is for when not the picker (a guest's pick). */
  | { k: "int-pick"; ts: number; id: string; actorId: string; requestedBy?: string }
  /**
   * An agent appended or revised variants of this Edit's set: no state of its
   * own, so `wait` on the Edit wakes on every variant write.
   */
  | { k: "int-variants"; ts: number; id: string; setId: string; actorId: string }
  | { k: "int-agent-request"; ts: number; id: string; actorId: string }
  | { k: "int-agent-take"; ts: number; id: string; actorId: string; onBehalf?: boolean }
  | { k: "int-agent-release"; ts: number; id: string; actorId: string }
  /** An agent write that is not a message or a state (e.g. posting variants) answered agent work. */
  | { k: "int-agent-answer"; ts: number; id: string; actorId: string };

const INT_KINDS = new Set([
  "int-create",
  "int-msg",
  "int-msg-edit",
  "int-msg-delete",
  "int-react",
  "int-answer",
  "int-resolve",
  "int-reopen",
  "int-state",
  "int-supersede",
  "int-waiting",
  "int-anchored",
  "int-reanchor",
  "int-anchor-lost",
  "int-attach-set",
  "int-batch",
  "int-send-batch",
  "int-resnap-request",
  "int-resnap-fulfill",
  "int-pick",
  "int-variants",
  "int-share-add",
  "int-share-remove",
  "int-share-seen",
  "int-agent-request",
  "int-agent-take",
  "int-agent-release",
  "int-agent-answer",
]);

export function encodeInteractionEntry(e: InteractionJournalEntry): string {
  return JSON.stringify(e);
}

export function decodeInteractionEntry(line: string): InteractionJournalEntry | null {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const e = data as { k?: unknown; ts?: unknown; id?: unknown };
  if (typeof e.k !== "string" || !INT_KINDS.has(e.k)) return null;
  if (typeof e.ts !== "number" || typeof e.id !== "string") return null;
  return data as InteractionJournalEntry;
}

/** Replay folds through the live reducers; only int-create births state. */
export function replayInteractions(
  lines: Iterable<string>,
  maxMsgs: number,
): Map<string, InteractionState> {
  const out = new Map<string, InteractionState>();
  for (const line of lines) {
    if (!line.trim()) continue;
    const e = decodeInteractionEntry(line);
    if (!e) continue;
    if (e.k === "int-create") {
      const { k: _k, ts, ...input } = e;
      const r = createInteraction({ ...input }, ts);
      if (r.ok) out.set(e.id, r.state);
      continue;
    }
    const prev = out.get(e.id);
    if (!prev) continue;
    switch (e.k) {
      case "int-msg": {
        // direct re-append preserving the recorded msgId (mirror of enqueue)
        const msgSeq = Math.max(prev.msgSeq, Number.parseInt(e.msg.msgId.slice(1), 10) || 0);
        const participants = e.msg.system
          ? prev.participants
          : addParticipants(prev.participants, [
              e.msg.authorId,
              ...mentionedActorIds(e.msg.body),
              // reply-target author joins on replay exactly as at enqueue time
              ...replyTargetAuthor(prev.thread, e.msg.replyTo),
            ]);
        const appended = { ...prev, thread: [...prev.thread, e.msg], msgSeq, participants };
        out.set(e.id, agentWorkAfterMessage(appended, e.msg, e.member === true, e.ts));
        break;
      }
      case "int-msg-edit":
        out.set(
          e.id,
          editMessage(
            prev,
            {
              msgId: e.msgId,
              actorId: e.actorId,
              body: e.body,
              ...(e.member ? { member: true } : {}),
            },
            e.ts,
          ).state,
        );
        break;
      case "int-msg-delete":
        out.set(e.id, deleteMessage(prev, { msgId: e.msgId, actorId: e.actorId }, e.ts).state);
        break;
      case "int-react":
        out.set(e.id, react(prev, e));
        break;
      case "int-answer":
        out.set(
          e.id,
          answerAsk(
            prev,
            {
              actorId: e.answer.actorId,
              optionIds: e.answer.optionIds,
              ...(e.answer.comment !== undefined ? { comment: e.answer.comment } : {}),
            },
            [],
            e.answer.ts,
          ).state,
        );
        break;
      case "int-resolve":
        out.set(e.id, resolveInteraction(prev, e.actorId, e.actorKind, e.ts).state);
        break;
      case "int-reopen":
        out.set(e.id, reopenInteraction(prev, e.actorId, e.actorKind).state);
        break;
      case "int-state":
        out.set(
          e.id,
          e.agent && e.actorId !== undefined && (e.state === "working" || e.state === "implemented")
            ? agentSetEditState(prev, e.state, e.actorId, e.ts).state
            : setChangeState(prev, e.state as (typeof CHANGE_ORDER)[number] | "dropped", e.ts)
                .state,
        );
        break;
      case "int-waiting":
        out.set(e.id, setWaitingOn(prev, e.actorIds));
        break;
      case "int-anchored": {
        const anchored = anchorInteraction(prev, {
          url: e.url,
          expectUrlPrefix: e.expectUrlPrefix,
          anchor: e.anchor,
          actorId: e.actorId,
        });
        out.set(e.id, anchored.ok ? anchored.state : prev);
        break;
      }
      case "int-supersede":
        out.set(e.id, supersedeAsk(prev, e.ts));
        break;
      case "int-reanchor":
        out.set(e.id, reanchor(prev, e.anchor, e.by));
        break;
      case "int-anchor-lost":
        out.set(e.id, markAnchorLost(prev));
        break;
      case "int-attach-set":
        out.set(e.id, attachVariantSet(prev, e.setId));
        break;
      case "int-batch":
        out.set(e.id, addBatch(prev, e.ops).state);
        break;
      case "int-send-batch":
        out.set(
          e.id,
          sendBatch(prev, { actorId: e.actorId, ops: e.ops, member: e.member === true }, e.ts)
            .state,
        );
        break;
      case "int-resnap-request":
        out.set(e.id, requestResnap(prev, e.actorId, e.ts).state);
        break;
      case "int-resnap-fulfill":
        out.set(e.id, fulfillResnap(prev, e.captureId));
        break;
      case "int-pick":
        out.set(e.id, pickEdit(prev, e.actorId, e.ts, e.requestedBy ?? e.actorId).state);
        break;
      case "int-share-add":
        out.set(e.id, shareWith(prev, e.personId));
        break;
      case "int-share-remove":
        out.set(e.id, unshare(prev, e.personId));
        break;
      case "int-share-seen":
        out.set(e.id, shareSeen(prev, e.personId));
        break;
      case "int-variants":
        // A wake marker: the set's own journal holds the variants.
        break;
      case "int-agent-request":
        out.set(e.id, requestAgentWork(prev, e.actorId, e.ts).state);
        break;
      case "int-agent-take":
        out.set(
          e.id,
          takeAgentWork(prev, { personId: e.actorId, onBehalf: e.onBehalf === true }, e.ts).state,
        );
        break;
      case "int-agent-release":
        out.set(e.id, releaseAgentWork(prev, e.actorId, e.ts).state);
        break;
      case "int-agent-answer":
        out.set(e.id, answerAgentWork(prev, e.actorId, e.ts).state);
        break;
    }
  }
  // silence the unused-var lint for maxMsgs if unused paths change later
  void maxMsgs;
  return out;
}
