import {
  type AttentionRef,
  canSeeInteraction,
  computeAttention,
  effectiveAgentWork,
  type InteractionState,
  isLive,
  keptProgramOf,
  type VariantSetState,
} from "@onlay/kernel";
import {
  type ActorSummary,
  type Anchor,
  type AttentionFrame,
  type AttentionRow,
  type Caller,
  type CallerAccess,
  type CaptureManifest,
  type CaptureMeta,
  type CaptureRef,
  type Control,
  flattenFences,
  type InteractionsStateFrame,
  type KeptEdit,
  LIMITS,
  MIN_CLIENT_PROTOCOL,
  type Notify,
  type PersonSummary,
  type PictureType,
  type RawInteractionSnapshot,
  type SpaceKind,
  type SpaceSummary,
  type VariantStateFrame,
} from "@onlay/protocol";
import { type CaptureStore, captureRefsFor, makeCaptureStore } from "./capture-store";
import { type ContentStore, makeContentStore } from "./content-store";
import { type InteractionStore, makeInteractionStore } from "./interaction-store";
import { makePeopleStore, type PeopleStore } from "./people-store";
import type { Clock, Db, Socket, Sockets, SqlRow, Statement } from "./ports";
import { makePushStore, type PushStore } from "./push-store";
import { ensureSchema, type Journal, makeJournal } from "./schema";
import { makeSessionStore, type SessionStore } from "./session-store";
import { makeVariantStore, type VariantStore } from "./variant-store";
import type { Fetcher, VapidKeys } from "./webpush";

/**
 * The space runtime's state and fan-out (spec §7): today's broker scoped to
 * one space. Durable truth lives in SQLite and is hydrated on construction,
 * so a Durable Object evicted between requests wakes into the same state.
 * What lives only in memory — pending uploads and in-flight waits — fails
 * closed when lost.
 *
 * Visibility is enforced here, at the one place frames leave: every
 * broadcast is built per socket from what that socket's caller may see, and
 * nothing is sent to a socket that may not see the interaction it concerns.
 */

/** What a socket carries across hibernation: who it speaks for and its session. */
export interface SocketAttachment {
  caller: Caller;
  /** Set by `hello`; frames other than `hello`/`ping` wait for it. */
  sessionId?: string;
  /** When the edge authorized the upgrade; never renewed (a re-scope changes scope, not lifetime). */
  authorizedAt?: number;
  /** The first `welcome` this socket was sent, answered again to a repeated `hello`. */
  welcome?: string;
  /**
   * When the directory last vouched for this socket's credential and scope:
   * the upgrade (the edge had just decided), then each re-validation (R3-S2).
   */
  validatedAt?: number;
  /** Closed by the space: frames still queued for it are dropped. */
  closedAt?: number;
}

/**
 * How long a socket's stored caller stays good without the edge saying so
 * again (security audit, findings 5 and 6): an older one is closed with a
 * normal close so the client reconnects through the edge and is
 * re-authorized.
 */
export const SOCKET_AUTHORIZATION_MS = 86_400_000;
/** The close code and reason for that: a normal close; the client simply reconnects. */
const CLOSE_REAUTHORIZE = 1000;

/**
 * True (and the socket closed) when the upgrade that authorized it is older
 * than `SOCKET_AUTHORIZATION_MS`, or it carries no upgrade time at all.
 */
export function expiredSocket(rt: Runtime, socket: SpaceSocket, a: SocketAttachment): boolean {
  // Set only at the upgrade and never renewed; a socket without it is closed.
  if (a.authorizedAt !== undefined && rt.clock.now() - a.authorizedAt <= SOCKET_AUTHORIZATION_MS)
    return false;
  socket.close(CLOSE_REAUTHORIZE, "re-authorize");
  return true;
}

export type SpaceSocket = Socket<SocketAttachment>;

export type LogFn = (event: string, data?: Record<string, unknown>) => void;

/** Everything the runtime needs from its host. Only the ports are required. */
export interface SpaceDeps {
  db: Db;
  sockets: Sockets<SocketAttachment>;
  clock: Clock;
  /** This space's id (the Durable Object's name); used in refs and listings. */
  spaceId?: string;
  /** The oldest client protocol served; defaults to `MIN_CLIENT_PROTOCOL`. */
  minClientProtocol?: number;
  /** The deployment's VAPID keys; absent = web push is off. */
  vapid?: VapidKeys;
  /** The VAPID JWT's `sub`, the contact a push service may use (`pushContactOf`). */
  pushContact?: string;
  /** Push delivery's `fetch`; defaults to the global. */
  fetch?: Fetcher;
  /** Keeps a background promise (push delivery) alive past the response. */
  waitUntil?: (p: Promise<unknown>) => void;
  /** Accept `http:` push endpoints (tests only). */
  allowHttpPush?: boolean;
  /**
   * Retention removed these interactions: the host drops their shares in the
   * directory (the Durable Object over D1). Rejects when that failed; the ids
   * are offered again at the next retention pass.
   */
  sharesGone?: (interactionIds: string[]) => Promise<void>;
  /**
   * Checks connected people against the directory (R3-S2): the Durable
   * Object binds it to D1; without it sockets are not re-validated.
   */
  directory?: DirectoryPort;
  /**
   * Reads a person's stored picture by its key (the Durable Object binds it
   * to D1); without it the space answers no picture.
   */
  pictures?: PicturesPort;
  /** A one-shot timer for waits; returns its canceller. Defaults to `setTimeout`. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  randomUUID?: () => string;
  log?: LogFn;
}

/** Where a person's picture bytes are kept: null for a key that names none. */
export interface PicturesPort {
  read(personId: string, key: string): Promise<{ type: PictureType; bytes: Uint8Array } | null>;
}

/** One connected (person, credential) for the directory to vouch for. */
export interface ValidationEntry {
  personId: string;
  credentialId: string;
  credentialClass: "full" | "interaction";
}

/** What the directory says about one entry now. */
export interface ValidationResult {
  personId: string;
  credentialId: string;
  /** The credential exists, is unexpired and unrevoked, and is of the person's current generation. */
  live: boolean;
  /** The person's current credential generation (null: the person is gone). */
  personGeneration: number | null;
  /** The person's whole current scope in this space, or none. */
  access: CallerAccess | null;
  /** The space's access epoch read with it (null: the space is gone from the directory). */
  epoch: number | null;
}

/** The directory, as the space may ask it about the sockets it holds (R3-S2). */
export interface DirectoryPort {
  validate(entries: ValidationEntry[]): Promise<ValidationResult[]>;
}

/** An in-memory upload session — the DB rows are written only at commit. */
export interface PendingCapture {
  captureId: string;
  interactionId: string;
  personId: string;
  credentialId: string;
  /** That credential's generation: a raised minimum drops only older uploads. */
  credentialGeneration?: number;
  capturedFrom: CaptureRef["capturedFrom"];
  kind: CaptureRef["kind"];
  format: string;
  caption?: string;
  meta?: CaptureMeta;
  parts: CaptureManifest["parts"];
  /** Parts hash-verified + staged during THIS init (proof-of-possession, per name). */
  received: Map<string, { sniffedMime: string; width?: number; height?: number }>;
  /** Staged footprint this init contributes (dedup-aware). */
  stagedBytes: number;
  deadline: number;
}

export interface Runtime {
  deps: SpaceDeps;
  db: Db;
  clock: Clock;
  log: LogFn;
  uuid: () => string;
  minClientProtocol: number;
  journal: Journal;
  interactions: Map<string, InteractionState>;
  variantSets: Map<string, VariantSetState>;
  interactionStore: InteractionStore;
  variantStore: VariantStore;
  sessionStore: SessionStore;
  contentStore: ContentStore;
  captureStore: CaptureStore;
  people: PeopleStore;
  pushStore: PushStore;
  /** Memory only: lost on eviction, so an upload in flight fails closed. */
  pendingCaptures: Map<string, PendingCapture>;
  /** Memory only: `/interaction/:id/wait` resolvers, keyed by interaction id. */
  waiters: Map<string, Set<() => void>>;
  /**
   * Memory only: access the edge changed since a request began (a wait in
   * flight must not answer with access its person no longer holds).
   */
  accessUpdates: Map<string, { access: CallerAccess | null; at: number }>;
  /** In-memory updates waiting for the open `transact` to commit (null outside one). */
  staged: Array<() => void> | null;
  /** Memory only: each person's mutating-frame window (an eviction resets it). */
  frameWindows: Map<string, { start: number; count: number }>;
  /** Memory only: parked `wait` requests per person. */
  waitsByPerson: Map<string, number>;
  /** Memory only: frames waiting behind a socket's re-validation, in order (R3-S2). */
  socketChains: Map<unknown, Promise<void>>;
  /** Set only while `/internal/purge` empties the space (the one write a tombstone allows). */
  purging: boolean;
  /** Re-validates sockets against the directory (set by the space; R3-S2). Resolves with those still open. */
  revalidate: (sockets: SpaceSocket[]) => Promise<SpaceSocket[]>;
}

/**
 * How stale a socket's last validation may be before its next mutating
 * frame waits for a fresh one, and how often (at most) the host re-validates
 * every open socket (R3-S2). With every control call failing, a removed
 * member (or a guest who lost a share) can therefore write over a socket for
 * at most `REVALIDATE_WRITES_MS` after the removal (the last validation
 * preceded it by no more than that), and receive broadcasts for at most
 * `REVALIDATE_ALL_MS` after it (the next host pass closes or re-scopes the
 * socket).
 */
export const REVALIDATE_WRITES_MS = 60_000;
export const REVALIDATE_ALL_MS = 300_000;

/** The socket's next mutating frame must wait for the directory first. */
export function needsRevalidation(rt: Runtime, a: SocketAttachment): boolean {
  if (!rt.deps.directory) return false;
  const since = a.validatedAt ?? a.authorizedAt ?? 0;
  return rt.clock.now() - since > REVALIDATE_WRITES_MS;
}

/** A write reached a space that was purged meanwhile (R3-S4); answered as not found. */
export class SpacePurgedError extends Error {
  constructor() {
    super("space purged");
  }
}

/**
 * The space's database with every write checked against the purge tombstone
 * inside the write itself (R3-S4): SQLite here is synchronous, so the check
 * and the write it guards are one step, inside any transaction around them.
 * A request admitted just before a purge therefore cannot write just after.
 */
function tombstoneGuarded(db: Db, purging: () => boolean): Db {
  const check = () => {
    if (purging()) return;
    if (db.get("SELECT 1 AS ok FROM meta WHERE key = 'purged'") !== undefined) {
      throw new SpacePurgedError();
    }
  };
  return {
    prepare<Row extends SqlRow = SqlRow>(sql: string): Statement<Row> {
      const st = db.prepare<Row>(sql);
      return {
        get: (...params) => st.get(...params),
        all: (...params) => st.all(...params),
        run: (...params) => {
          check();
          return st.run(...params);
        },
      };
    },
    get: (sql, ...params) => db.get(sql, ...params),
    all: (sql, ...params) => db.all(sql, ...params),
    run: (sql, ...params) => {
      check();
      return db.run(sql, ...params);
    },
    exec: (sql) => db.exec(sql),
    transaction: (fn) => db.transaction(fn),
  };
}

export function createRuntime(deps: SpaceDeps): Runtime {
  let purging = false;
  const db = tombstoneGuarded(deps.db, () => purging);
  ensureSchema(db);
  const journal = makeJournal(db);
  const interactionStore = makeInteractionStore(db, journal);
  const variantStore = makeVariantStore(db, journal);
  return {
    deps,
    db,
    clock: deps.clock,
    log: deps.log ?? (() => {}),
    uuid: deps.randomUUID ?? (() => crypto.randomUUID()),
    minClientProtocol: deps.minClientProtocol ?? MIN_CLIENT_PROTOCOL,
    journal,
    interactions: interactionStore.loadAll(),
    variantSets: variantStore.loadAll(),
    interactionStore,
    variantStore,
    sessionStore: makeSessionStore(db, journal),
    contentStore: makeContentStore(db),
    captureStore: makeCaptureStore(db),
    people: makePeopleStore(db),
    pushStore: makePushStore(db),
    pendingCaptures: new Map(),
    waiters: new Map(),
    accessUpdates: new Map(),
    staged: null,
    frameWindows: new Map(),
    waitsByPerson: new Map(),
    socketChains: new Map(),
    revalidate: async (sockets) => sockets,
    get purging() {
      return purging;
    },
    set purging(on: boolean) {
      purging = on;
    },
  };
}

/* ── space facts ──────────────────────────────────────────────────── */

export interface SpaceFacts {
  kind: SpaceKind;
  name: string;
}

/** The space's kind and name, when the edge has told us (`X-Onlay-Space`). */
export function spaceFacts(rt: Runtime): SpaceFacts | undefined {
  const row = rt.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'space'");
  if (!row) return undefined;
  try {
    return JSON.parse(row.value) as SpaceFacts;
  } catch {
    return undefined;
  }
}

/** The lowest credential generation this space accepts for the person (0 before any notice). */
export function minGeneration(rt: Runtime, personId: string): number {
  const row = rt.db.get<{ min_generation: number }>(
    "SELECT min_generation FROM credential_generations WHERE person_id = ?",
    personId,
  );
  return row ? Number(row.min_generation) : 0;
}

/**
 * This credential was signed out here (R3-S1): by id, or stamped below its
 * person's minimum generation. One that does not say its generation counts
 * as 0, below any raised minimum.
 */
export function revokedHere(
  rt: Runtime,
  personId: string,
  credentialId: string,
  generation: number | undefined,
): boolean {
  if (
    rt.db.get("SELECT 1 AS ok FROM revoked_credentials WHERE credential_id = ?", credentialId) !==
    undefined
  )
    return true;
  return (generation ?? 0) < minGeneration(rt, personId);
}

/** The caller's credential was signed out here. */
export function credentialRevokedHere(rt: Runtime, caller: Caller): boolean {
  return revokedHere(rt, caller.personId, caller.credentialId, caller.credentialGeneration);
}

/** The scope last applied for a person (by a control, a re-validation or a subscribe), or none. */
export function storedAccess(
  rt: Runtime,
  personId: string,
): { access: CallerAccess | null; epoch: number } | undefined {
  const row = rt.db.get<{ access_json: string | null; epoch: number }>(
    "SELECT access_json, epoch FROM person_access WHERE person_id = ?",
    personId,
  );
  if (!row) return undefined;
  return {
    access: row.access_json ? (JSON.parse(row.access_json) as CallerAccess) : null,
    epoch: Number(row.epoch),
  };
}

/** The newest access epoch the edge has told this space (0 before any). */
export function knownEpoch(rt: Runtime): number {
  const row = rt.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'access_epoch'");
  return row ? Number(row.value) || 0 : 0;
}

/**
 * A control call for `key` told at `epoch`: true (and recorded) when it is at
 * least as new as anything already applied for that key; false when it is a
 * stale delivery to skip. Without an epoch it always applies.
 */
export function controlApplies(rt: Runtime, key: string, epoch: number | null): boolean {
  if (epoch === null) return true;
  const prev = rt.db.get<{ epoch: number }>("SELECT epoch FROM control_epochs WHERE key = ?", key);
  if (prev && Number(prev.epoch) > epoch) return false;
  rt.db.run(
    "INSERT INTO control_epochs (key, epoch) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET epoch = excluded.epoch",
    key,
    epoch,
  );
  raiseEpoch(rt, epoch);
  return true;
}

/** Remembers the newest access epoch the edge has told; older callers are stale from now on. */
export function raiseEpoch(rt: Runtime, epoch: number | null): void {
  if (epoch === null || epoch <= knownEpoch(rt)) return;
  rt.db.run(
    "INSERT INTO meta (key, value) VALUES ('access_epoch', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    String(epoch),
  );
}

export function rememberSpaceFacts(rt: Runtime, facts: SpaceFacts): void {
  const known = spaceFacts(rt);
  if (known?.kind === facts.kind && known.name === facts.name) return;
  const value = JSON.stringify({ kind: facts.kind, name: facts.name });
  rt.db.run(
    "INSERT INTO meta (key, value) VALUES ('space', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    value,
  );
}

/** The caller's view of this space: id, kind, name and their role here. */
export function spaceSummaryFor(rt: Runtime, caller: Caller): SpaceSummary | undefined {
  const facts = spaceFacts(rt);
  const id = rt.deps.spaceId;
  if (!facts || !id) return undefined;
  const role = caller.access.kind === "member" ? caller.access.role : "guest";
  return { id, kind: facts.kind, name: facts.name, role };
}

/* ── people ───────────────────────────────────────────────────────── */

export function personOf(caller: Caller): PersonSummary {
  return {
    id: caller.personId,
    name: caller.name,
    initials: caller.initials,
    tint: caller.tint,
    ...(caller.avatarUrl !== undefined ? { avatarUrl: caller.avatarUrl } : {}),
  };
}

/** The caller as the people cache keeps them: with their alias, which only the directory route gives out. */
export function cachedPersonOf(caller: Caller): PersonSummary {
  return {
    ...personOf(caller),
    ...(caller.alias !== undefined ? { alias: caller.alias } : {}),
  };
}

/**
 * A person's summary from the cache, or a neutral stand-in for someone
 * unknown. Never their alias: only the directory route gives that, to members.
 */
export function personSummary(rt: Runtime, personId: string): PersonSummary {
  const p = rt.people.get(personId);
  if (p) {
    const { member: _member, guest: _guest, alias: _alias, ...summary } = p;
    return summary;
  }
  return { id: personId, name: "Someone", initials: "?", tint: "#8a8a8a" };
}

/** The wire `actor` for frames that still carry one (welcome, attention). */
export function actorOf(caller: Caller): ActorSummary {
  return {
    id: caller.personId,
    name: caller.name,
    kind: "human",
    tint: caller.tint,
    initials: caller.initials,
  };
}

/* ── visibility ───────────────────────────────────────────────────── */

export const canSee = (access: CallerAccess, interactionId: string): boolean =>
  canSeeInteraction(access, interactionId);

export function visibleInteractions(rt: Runtime, access: CallerAccess): InteractionState[] {
  if (access.kind === "member") return [...rt.interactions.values()];
  const out: InteractionState[] = [];
  for (const id of access.interactionIds) {
    const s = rt.interactions.get(id);
    if (s) out.push(s);
  }
  return out;
}

/** A stable key for "sees the same things": every member alike, each guest by their list. */
function accessKey(access: CallerAccess): string {
  return access.kind === "member"
    ? "member"
    : `guest:${[...access.interactionIds].sort().join(",")}`;
}

/** The variant set's owning Edit, when the set has one. */
export function ownerOf(rt: Runtime, set: VariantSetState): InteractionState | undefined {
  return set.changeInteractionId ? rt.interactions.get(set.changeInteractionId) : undefined;
}

/** A set is visible exactly when its owning Edit is. */
function canSeeSet(access: CallerAccess, rt: Runtime, set: VariantSetState): boolean {
  const owner = ownerOf(rt, set);
  return owner !== undefined && canSee(access, owner.id);
}

/* ── sockets ──────────────────────────────────────────────────────── */

/** Open sockets that have said hello, with their attachment. */
function liveSockets(rt: Runtime): Array<{ socket: SpaceSocket; a: SocketAttachment }> {
  const out: Array<{ socket: SpaceSocket; a: SocketAttachment }> = [];
  for (const socket of rt.deps.sockets.all()) {
    const a = socket.attachment();
    if (!a?.sessionId || expiredSocket(rt, socket, a)) continue;
    out.push({ socket, a });
  }
  return out;
}

export function sendFrame(socket: SpaceSocket, frame: Control | Record<string, unknown>): void {
  try {
    socket.send(JSON.stringify(frame));
  } catch {
    // A socket closing under us drops the frame; the next sync heals it.
  }
}

/* ── interaction snapshots ────────────────────────────────────────── */

/** The kernel state → the wire snapshot (server-only fields dropped). */
export function toSnapshot(
  rt: Runtime,
  s: InteractionState,
  refs?: CaptureRef[],
): RawInteractionSnapshot {
  const work = effectiveAgentWork(s, rt.clock.now());
  return {
    id: s.id,
    kind: s.kind,
    ...(s.anchor.level !== "unanchored" ? { url: s.url } : {}),
    ...(s.anchor.level !== "unanchored" && s.hostUrl !== undefined ? { hostUrl: s.hostUrl } : {}),
    anchor: s.anchor,
    ...(s.anchorLost ? { anchorLost: true } : {}),
    ...(refs?.length ? { captures: refs } : {}),
    ...(s.resnapRequestedBy
      ? { resnap: { requestedBy: s.resnapRequestedBy, requestedAt: s.resnapRequestedAt ?? 0 } }
      : {}),
    authorId: s.authorId,
    participants: s.participants,
    waitingOn: s.waitingOn,
    state: s.state,
    thread: s.thread.map(wireMsg),
    ...(s.ask ? { ask: { ...stripAnswers(s.ask), answers: s.ask.answers } } : {}),
    ...(s.change
      ? {
          change: {
            intent: s.change.intent,
            ...(s.change.method !== undefined ? { method: s.change.method } : {}),
            ...(s.change.ownsSource !== undefined ? { ownsSource: s.change.ownsSource } : {}),
            ...(s.change.provenance !== undefined ? { provenance: s.change.provenance } : {}),
            ...(s.change.variantSetId !== undefined ? { variantSetId: s.change.variantSetId } : {}),
          },
        }
      : {}),
    ...(work ? { agentWork: work } : {}),
    createdAt: s.createdAt,
    ...(s.resolvedAt !== undefined ? { resolvedAt: s.resolvedAt } : {}),
  };
}

/** A thread message as it goes out: the author's request id stays in the space. */
function wireMsg(m: InteractionState["thread"][number]): InteractionState["thread"][number] {
  if (m.clientId === undefined) return m;
  const { clientId: _clientId, ...rest } = m;
  return rest;
}

function stripAnswers(ask: NonNullable<InteractionState["ask"]>) {
  const { answers: _answers, ...payload } = ask;
  return payload;
}

/** The Edit's kept entry (spec §8), when it keeps a program. */
export function keptOf(rt: Runtime, s: InteractionState): KeptEdit | null {
  const setId = s.change?.variantSetId;
  return keptProgramOf(s, setId ? rt.variantSets.get(setId) : undefined);
}

/** Leave room for the envelope around the interactions array. */
const STATE_FRAME_BUDGET = LIMITS.MAX_OUTBOUND_FRAME_CHARS - 2_048;

function isRecentResolved(s: InteractionState, now: number): boolean {
  return (
    s.resolvedAt !== undefined &&
    s.state !== "dropped" &&
    now - s.resolvedAt <= LIMITS.RECENT_RESOLVED_MS
  );
}

/**
 * The overlay's snapshot set for one page URL, limited to what `access` may
 * see (live + recently resolved, exact URL), with the page's kept Edits.
 * Both arrays keep to the schema's entry cap. Over budget → kept entries go
 * first, oldest first (a kept program is a preview; the threads are the
 * page's content), then the oldest resolved interactions, then live ones;
 * any drop marks the frame `truncated`. The frame returned always
 * fits `MAX_OUTBOUND_FRAME_CHARS`, so the client's parser accepts it.
 */
export function buildInteractionsState(
  rt: Runtime,
  url: string,
  access: CallerAccess,
): InteractionsStateFrame {
  const now = rt.clock.now();
  const matching = visibleInteractions(rt, access).filter(
    (s) => s.url === url && (s.resolvedAt === undefined || isRecentResolved(s, now)),
  );
  const live = matching
    .filter((s) => s.resolvedAt === undefined)
    .sort((a, b) => a.createdAt - b.createdAt);
  const resolved = matching
    .filter((s) => s.resolvedAt !== undefined)
    .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
  const allKept = live
    .map((s) => keptOf(rt, s))
    .filter((k): k is KeptEdit => k !== null)
    .sort((a, b) => a.at - b.at);
  // The newest entries win the entry cap, for both arrays.
  let kept = allKept.slice(-LIMITS.MAX_INTERACTIONS_PER_STATE);
  let ordered = [...live, ...resolved];
  let truncated = kept.length < allKept.length;
  if (ordered.length > LIMITS.MAX_INTERACTIONS_PER_STATE) {
    const keepLive = live.slice(-LIMITS.MAX_INTERACTIONS_PER_STATE);
    const room = LIMITS.MAX_INTERACTIONS_PER_STATE - keepLive.length;
    ordered = [...keepLive, ...resolved.slice(0, room)];
    truncated = true;
  }

  const capMap = new Map<string, CaptureRef[]>();
  const refsFor = (s: InteractionState): CaptureRef[] => {
    let r = capMap.get(s.id);
    if (!r) {
      r = captureRefsFor(rt.captureStore, s.id);
      capMap.set(s.id, r);
    }
    return r;
  };
  // Kept Edits that did not fit are named, so a client can fetch each by id.
  const omittedIds = (): string[] => {
    const shown = new Set(kept.map((k) => k.interactionId));
    return allKept
      .filter((k) => !shown.has(k.interactionId))
      .map((k) => k.interactionId)
      .slice(-LIMITS.MAX_INTERACTIONS_PER_STATE);
  };
  const build = (): InteractionsStateFrame => {
    const keptOmitted = omittedIds();
    return {
      v: 1,
      type: "interactions-state",
      url,
      interactions: ordered.map((s) => snapshotOf(s)),
      ...(truncated ? { truncated: true } : {}),
      ...(keptOmitted.length > 0 ? { keptOmitted } : {}),
      ...(kept.length > 0 ? { kept } : {}),
    };
  };
  // Each entry is serialized once and measured; dropping subtracts its size
  // (plus its comma) instead of serializing what remains again.
  const snapshots = new Map<string, RawInteractionSnapshot>();
  const snapshotOf = (s: InteractionState): RawInteractionSnapshot => {
    let snap = snapshots.get(s.id);
    if (!snap) {
      snap = toSnapshot(rt, s, refsFor(s));
      snapshots.set(s.id, snap);
    }
    return snap;
  };
  const sizeOf = new Map<object, number>();
  const measure = (o: object): number => {
    let n = sizeOf.get(o);
    if (n === undefined) {
      n = JSON.stringify(o).length + 1;
      sizeOf.set(o, n);
    }
    return n;
  };
  // The envelope with both arrays empty, the truncation flag set and every
  // kept id listed as omitted: the most it can weigh.
  const envelope = JSON.stringify({
    v: 1,
    type: "interactions-state",
    url,
    interactions: [],
    truncated: true,
    keptOmitted: allKept.slice(-LIMITS.MAX_INTERACTIONS_PER_STATE).map((k) => k.interactionId),
    kept: [],
  }).length;
  let total =
    envelope +
    ordered.reduce((n, s) => n + measure(snapshotOf(s)), 0) +
    kept.reduce((n, k) => n + measure(k), 0);
  while (total > STATE_FRAME_BUDGET && kept.length > 0) {
    const [first, ...rest] = kept;
    if (first) total -= measure(first);
    kept = rest;
    truncated = true;
  }
  const droppable = ordered
    .filter((s) => s.resolvedAt !== undefined)
    .reverse()
    .concat(ordered.filter((s) => s.resolvedAt === undefined).reverse());
  const dropped = new Set<InteractionState>();
  for (const drop of droppable) {
    if (total <= STATE_FRAME_BUDGET) break;
    total -= measure(snapshotOf(drop));
    dropped.add(drop);
    truncated = true;
  }
  if (dropped.size > 0) ordered = ordered.filter((s) => !dropped.has(s));
  return build();
}

/* ── attention (ADR-0006) ─────────────────────────────────────────── */

function anchorLabel(anchor: Anchor): string {
  if (anchor.level === "unanchored") return "unanchored";
  if (anchor.level === "page") return "page-level";
  if (anchor.level === "selection") return anchor.text.slice(0, LIMITS.MAX_ANCHOR_LABEL);
  if (anchor.blockId) return `§${anchor.blockId}`;
  if (anchor.snippet) return anchor.snippet.slice(0, LIMITS.MAX_ANCHOR_LABEL);
  return anchor.selector.slice(0, LIMITS.MAX_ANCHOR_LABEL);
}

function firstThreadText(s: InteractionState): string {
  for (const m of s.thread) {
    if (!m.system && !m.deleted) return m.body.text;
  }
  return "";
}

/**
 * One-line summary for a row: ask question / change intent / comment words.
 * A person's clients get it as a preview (each fenced block reduced to its
 * code, before the cut); an agent gets the words exactly as written.
 */
export function rowText(s: InteractionState, forPerson = false): string {
  const raw =
    s.kind === "ask"
      ? (s.ask?.question ?? "")
      : s.kind === "change"
        ? (s.change?.intent ?? "")
        : firstThreadText(s);
  return (forPerson ? flattenFences(raw) : raw).slice(0, LIMITS.MAX_ANCHOR_LABEL);
}

/** A person's client, as opposed to their agent (who reads text as written). */
export function isPersonClient(caller: Caller): boolean {
  return caller.class !== "agent";
}

function toRow(
  rt: Runtime,
  s: InteractionState,
  ts: number,
  forPerson: boolean,
  because?: AttentionRef["because"],
): AttentionRow {
  const work = effectiveAgentWork(s, rt.clock.now());
  return {
    interactionId: s.id,
    kind: s.kind,
    state: s.state,
    ...(s.anchor.level !== "unanchored" ? { url: s.url } : {}),
    ...(s.anchor.level !== "unanchored" && s.hostUrl !== undefined ? { hostUrl: s.hostUrl } : {}),
    ...(s.anchor.level === "unanchored" ? { unanchored: true } : {}),
    ...(s.anchorLost ? { anchorLost: true } : {}),
    ...(s.ask?.stakes !== undefined ? { stakes: s.ask.stakes } : {}),
    anchorLabel: anchorLabel(s.anchor),
    text: rowText(s, forPerson),
    fromActorId: s.authorId,
    waitingOnIds: s.waitingOn,
    ts,
    ...(work ? { agentWork: work.status } : {}),
    ...(because !== undefined ? { because } : {}),
  };
}

const cap = <T>(rows: T[]): T[] => rows.slice(0, LIMITS.MAX_ATTENTION_ROWS);

/** Narrows attention to one page (`url`) or site (`origin`) before any row cap. */
export interface AttentionFilter {
  url?: string;
  origin?: string;
}

function attentionSets(rt: Runtime, caller: Caller, filter: AttentionFilter = {}) {
  const inScope = (s: InteractionState): boolean => {
    if (filter.url === undefined && filter.origin === undefined) return true;
    if (s.anchor.level === "unanchored") return false;
    if (filter.url !== undefined && s.url !== filter.url) return false;
    if (filter.origin !== undefined && originOf(s.url) !== filter.origin) return false;
    return true;
  };
  return computeAttention(
    visibleInteractions(rt, caller.access).filter(inScope),
    caller.personId,
    rt.clock.now(),
    LIMITS.RECENT_RESOLVED_MS,
  );
}

export function buildAttentionFrame(
  rt: Runtime,
  caller: Caller,
  filter: AttentionFilter = {},
): AttentionFrame {
  const sets = attentionSets(rt, caller, filter);
  const forPerson = isPersonClient(caller);
  // Cut each list to the cap first: only the rows sent are built.
  const mapRefs = (refs: AttentionRef[]) =>
    cap(refs).map((r) => toRow(rt, r.interaction, r.interaction.createdAt, forPerson, r.because));
  return {
    v: 1,
    type: "attention",
    person: personOf(caller),
    needsYou: mapRefs(sets.needsYou),
    waiting: mapRefs(sets.waiting),
    recent: cap(sets.recent).map((s) => toRow(rt, s, s.resolvedAt ?? s.createdAt, forPerson)),
    // The rows are capped; the badge reads the full count, as on `welcome`.
    needsYouCount: sets.needsYou.length,
  };
}

export function needsYouCount(rt: Runtime, caller: Caller): number {
  return attentionSets(rt, caller).needsYou.length;
}

/* ── origins ──────────────────────────────────────────────────────── */

function originOf(url: string): string | null {
  try {
    const o = new URL(url).origin;
    return o === "null" ? null : o.slice(0, LIMITS.MAX_RESIDUE_ORIGIN);
  } catch {
    return null;
  }
}

/**
 * Origins with live anchored interactions `access` may see, sorted. `swap`
 * substitutes one interaction's state (the "before" side of a mutation).
 */
export function originsFor(
  rt: Runtime,
  access: CallerAccess,
  swap?: { id: string; state: InteractionState | undefined },
): string[] {
  const set = new Set<string>();
  for (const s0 of visibleInteractions(rt, access)) {
    const s = swap && s0.id === swap.id ? swap.state : s0;
    if (!s || !isLive(s) || s.anchor.level === "unanchored") continue;
    const o = originOf(s.url);
    if (o) set.add(o);
  }
  // An interaction created by this very mutation is absent from the map's
  // "before" view only when swapped out; nothing else to add.
  return [...set].sort().slice(0, LIMITS.MAX_INTERACTIONS_PER_STATE);
}

/* ── fan-out ──────────────────────────────────────────────────────── */

/**
 * After an accepted interaction mutation: the page snapshot to Full sockets
 * that may see it, a tick to web app sockets that may see it, attention to
 * every socket that may see it, origins where the set moved, and waits woken.
 * `prev` is the state before the mutation (undefined on creation).
 */
export function fanOut(rt: Runtime, prev: InteractionState | undefined, next: InteractionState) {
  const states = new Map<string, InteractionsStateFrame>();
  const prevUrl = prev && prev.anchor.level !== "unanchored" ? prev.url : undefined;
  const url = next.anchor.level !== "unanchored" ? next.url : undefined;
  const originsChanged = new Map<string, string[] | null>();
  for (const { socket, a } of liveSockets(rt)) {
    const access = a.caller.access;
    if (!canSee(access, next.id)) continue;
    const key = accessKey(access);
    if (a.caller.class === "full") {
      for (const u of new Set([prevUrl, url])) {
        if (u === undefined) continue;
        const k = `${key}|${u}`;
        let frame = states.get(k);
        if (!frame) {
          frame = buildInteractionsState(rt, u, access);
          states.set(k, frame);
        }
        sendFrame(socket, frame);
      }
      if (!originsChanged.has(key)) {
        const before = originsFor(rt, access, { id: next.id, state: prev });
        const after = originsFor(rt, access);
        originsChanged.set(key, before.join("\n") === after.join("\n") ? null : after);
      }
      const origins = originsChanged.get(key);
      if (origins) sendFrame(socket, { v: 1, type: "origins", origins });
    } else {
      sendFrame(socket, { v: 1, type: "tick" });
    }
    sendFrame(socket, buildAttentionFrame(rt, a.caller));
  }
  wakeWaiters(rt, next.id);
}

/** Every socket that may see the set's owning Edit gets the set (or a tick). */
export function fanOutVariantState(rt: Runtime, set: VariantSetState, nonce?: string): void {
  const frame = buildVariantState(set, nonce);
  for (const { socket, a } of liveSockets(rt)) {
    if (!canSeeSet(a.caller.access, rt, set)) continue;
    if (a.caller.class === "full") sendFrame(socket, frame);
    else sendFrame(socket, { v: 1, type: "tick" });
  }
}

/** The people list changed: every socket re-pulls the directory. */
export function directoryChanged(rt: Runtime): void {
  for (const { socket, a } of liveSockets(rt)) {
    sendFrame(socket, { v: 1, type: "directory-updated" });
    if (a.caller.class !== "full") sendFrame(socket, { v: 1, type: "tick" });
  }
}

/** A notify frame to the named people's Full sockets that may see the interaction. */
export function sendNotify(
  rt: Runtime,
  s: InteractionState,
  input: { title: string; body: string; personIds: Iterable<string> },
): void {
  const targets = new Set(input.personIds);
  if (targets.size === 0) return;
  const frame: Notify = {
    v: 1,
    type: "notify",
    interactionId: s.id,
    kind: s.kind,
    // A person reads these as previews: each fenced block as its code, before the cut.
    title: flattenFences(input.title).slice(0, LIMITS.MAX_TITLE),
    body: flattenFences(input.body).slice(0, LIMITS.MAX_ANCHOR_LABEL),
    ...(s.anchor.level !== "unanchored" ? { url: s.url } : {}),
    ...(s.ask?.stakes !== undefined ? { stakes: s.ask.stakes } : {}),
  };
  for (const { socket, a } of liveSockets(rt)) {
    if (a.caller.class !== "full") continue;
    if (!targets.has(a.caller.personId) || !canSee(a.caller.access, s.id)) continue;
    sendFrame(socket, frame);
  }
}

/* ── waits ────────────────────────────────────────────────────────── */

function wakeWaiters(rt: Runtime, interactionId: string): void {
  const set = rt.waiters.get(interactionId);
  if (!set) return;
  rt.waiters.delete(interactionId);
  for (const wake of [...set]) wake();
}

/* ── variant-set state frames ─────────────────────────────────────── */

function variantStateWith(
  set: VariantSetState,
  variants: VariantSetState["variants"],
  truncated: boolean,
  dropped: number,
  nonce?: string,
): VariantStateFrame {
  const originalActive = set.activeIndex;
  const activeIndex =
    originalActive !== undefined && originalActive >= dropped
      ? originalActive - dropped
      : undefined;
  const rootKind = set.root?.kind ?? (set.element ? "block" : undefined);
  const selector = set.root?.kind === "block" ? set.root.element.selector : set.element?.selector;
  return {
    v: 1,
    type: "variant-state",
    setId: set.setId,
    ...(nonce !== undefined ? { nonce } : {}),
    status: set.status,
    ...(set.outcome !== undefined ? { outcome: set.outcome } : {}),
    ...(rootKind !== "page" && selector !== undefined ? { selector } : {}),
    ...(rootKind === "page" ? { rootKind: "page" as const } : {}),
    variants,
    ...(activeIndex !== undefined ? { activeIndex } : {}),
    ...(set.changeInteractionId !== undefined
      ? { changeInteractionId: set.changeInteractionId }
      : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

export function buildVariantState(set: VariantSetState, nonce?: string): VariantStateFrame {
  const frame = variantStateWith(set, set.variants, false, 0, nonce);
  if (JSON.stringify(frame).length <= STATE_FRAME_BUDGET) return frame;
  for (let dropped = 1; dropped <= set.variants.length; dropped += 1) {
    const variants = set.variants.slice(dropped);
    const candidate = variantStateWith(set, variants, true, dropped, nonce);
    if (JSON.stringify(candidate).length <= STATE_FRAME_BUDGET) return candidate;
  }
  return variantStateWith(set, [], true, set.variants.length, nonce);
}
