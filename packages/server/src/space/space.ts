import { shareWith, unshare } from "@onlay/kernel";
import {
  ACCESS_EPOCH_HEADER,
  CALLER_HEADER,
  type Caller,
  type CallerAccess,
  CLOSE_ACCESS_REVOKED,
  decodeCaller,
  decodeSpaceFacts,
  INTERNAL_HEADER,
  InternalAccessChangedRequestSchema,
  InternalCredentialRevokedRequestSchema,
  InternalPersonRequestSchema,
  PROTOCOL_HEADER,
  SPACE_HEADER,
  WS_SUBPROTOCOL,
} from "@onlay/protocol";
import { onClose, onMessage } from "./frames";
import { errorResponse, json, notFound, parseBody } from "./http";
import { purgeAll, type RetentionResult, sweepRetention } from "./retention";
import { routeRequest } from "./routes";
import {
  buildAttentionFrame,
  cachedPersonOf,
  controlApplies,
  createRuntime,
  credentialRevokedHere,
  directoryChanged,
  expiredSocket,
  knownEpoch,
  minGeneration,
  originsFor,
  type Runtime,
  raiseEpoch,
  rememberSpaceFacts,
  type SocketAttachment,
  type SpaceDeps,
  SpacePurgedError,
  type SpaceSocket,
  sendFrame,
  storedAccess,
  type ValidationEntry,
  type ValidationResult,
} from "./runtime";
import { afterMutation, commit } from "./service";

/**
 * One space, as the Durable Object (or a test) hosts it (spec §5.1, §7).
 *
 * The caller comes ONLY from the `X-Onlay-Caller` header the edge sets after
 * its access check; a request without a valid one is refused. Internal
 * control routes are called by the Worker alone, marked `X-Onlay-Internal: 1`
 * and carrying no caller (the edge strips every inbound `X-Onlay-*` header,
 * so neither can be forged from outside).
 */

export interface Space {
  readonly runtime: Runtime;
  /** Every request except the WebSocket upgrade itself. */
  fetch(req: Request): Promise<Response>;
  /**
   * Admits a WebSocket upgrade: the attachment the new socket carries and the
   * subprotocol to echo, or the refusal to answer with. The host makes the socket.
   */
  admitSocket(
    req: Request,
  ):
    | { ok: true; attachment: SocketAttachment; protocol?: string }
    | { ok: false; response: Response };
  /** Runs one frame; a promise when it waits for a re-validation (R3-S2). */
  onMessage(socket: SpaceSocket, raw: unknown): Promise<void> | undefined;
  onClose(socket: SpaceSocket): void;
  /** The daily retention pass. */
  alarm(): RetentionResult;
  /** Closes every socket past its 24 hours (or with no upgrade time); the host calls it hourly. */
  sweepSockets(): void;
  /**
   * Re-validates every open socket against the directory in one call (R3-S2);
   * the host calls it at most `REVALIDATE_ALL_MS` apart while sockets are open.
   */
  validateSockets(): Promise<void>;
  /**
   * Offers the interactions retention removed to the host's `sharesGone`
   * port; what it confirms is forgotten, the rest is offered next time.
   */
  reportRemovedShares(): Promise<void>;
}

/** Below the oldest supported protocol: `upgrade_required`. An absent header passes. */
function protocolRefusal(rt: Runtime, req: Request): Response | null {
  const raw = req.headers.get(PROTOCOL_HEADER);
  if (raw === null) return null;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= rt.minClientProtocol) return null;
  return errorResponse(
    "upgrade_required",
    "This version of onlay is too old for the service. Update it to continue.",
    "protocol",
  );
}

/** The space was deleted: every later request, upgrade and control is `not_found`. */
function purged(rt: Runtime): boolean {
  return rt.db.get("SELECT 1 AS ok FROM meta WHERE key = 'purged'") !== undefined;
}

/** The edge's control bodies are small: one person, one access, one revocation. */
const CONTROL_MAX_BYTES = 65_536;

const signInRequired = () => errorResponse("sign_in_required", "Sign in to continue.", "caller");
const credentialRevoked = () =>
  errorResponse("sign_in_required", "You were signed out. Sign in again.", "credential-revoked");

/**
 * Admission for every forwarded request and upgrade (round 2, S1 and S5): the
 * space exists, the caller header is valid and carries an epoch, the epoch is
 * current, and the credential is not revoked here. Only then is anything
 * derived from the caller written (space facts, the people cache).
 */
function admitCaller(rt: Runtime, req: Request): { caller: Caller } | { refusal: Response } {
  if (purged(rt)) return { refusal: notFound() };
  const caller = decodeCaller(req.headers.get(CALLER_HEADER) ?? "");
  if (!caller || caller.accessEpoch === undefined) return { refusal: signInRequired() };
  if (caller.accessEpoch < knownEpoch(rt)) {
    return {
      refusal: errorResponse(
        "conflict",
        "Your access here just changed. Try again.",
        "stale-access",
      ),
    };
  }
  if (credentialRevokedHere(rt, caller)) return { refusal: credentialRevoked() };
  const facts = decodeSpaceFacts(req.headers.get(SPACE_HEADER));
  if (facts) rememberSpaceFacts(rt, facts);
  if (rt.people.remember(cachedPersonOf(caller), caller.access.kind === "member")) {
    directoryChanged(rt);
  }
  return { caller };
}

/** The epoch a control call reports (`X-Onlay-Access-Epoch`), or null. */
function epochOf(req: Request): number | null {
  const raw = req.headers.get(ACCESS_EPOCH_HEADER);
  if (raw === null || !/^\d{1,15}$/.test(raw)) return null;
  return Number(raw);
}

type Rescoped = { socket: SpaceSocket; caller: Caller; was: CallerAccess; sessionId?: string };

/** Resync what each re-scoped socket shows; called only after every socket is re-scoped. */
function resync(rt: Runtime, rescoped: Rescoped[]): void {
  for (const { socket, caller, sessionId } of rescoped) {
    if (!sessionId) continue;
    sendFrame(socket, buildAttentionFrame(rt, caller));
    if (caller.class === "full") {
      sendFrame(socket, { v: 1, type: "origins", origins: originsFor(rt, caller.access) });
    } else {
      sendFrame(socket, { v: 1, type: "tick" });
    }
  }
}

/**
 * The person's access changed: their sockets' stored callers are replaced
 * (or the sockets closed) and their push rows re-scoped, all BEFORE anything
 * is broadcast; the caller resyncs the returned sockets afterwards.
 */
function personAccessChanged(
  rt: Runtime,
  personId: string,
  access: CallerAccess | null,
  epoch: number | null,
  onlyOlderSockets = false,
): Rescoped[] {
  rt.accessUpdates.set(personId, { access, at: rt.clock.now() });
  const rescoped: Rescoped[] = [];
  for (const socket of rt.deps.sockets.all()) {
    const a = socket.attachment();
    if (!a || a.caller.personId !== personId) continue;
    // A directory answer older than what this socket was admitted or last
    // re-scoped with is ignored for it, never applied (3b-S4).
    if (onlyOlderSockets && epoch !== null && (a.caller.accessEpoch ?? 0) > epoch) continue;
    if (access === null) {
      closeSocket(rt, socket, CLOSE_ACCESS_REVOKED, "access revoked");
      continue;
    }
    const caller: Caller = {
      ...a.caller,
      access,
      ...(epoch !== null ? { accessEpoch: epoch } : {}),
    };
    // A new scope, not a new lifetime: the upgrade's time stays.
    socket.setAttachment({ ...a, caller });
    rescoped.push({
      socket,
      caller,
      was: a.caller.access,
      ...(a.sessionId ? { sessionId: a.sessionId } : {}),
    });
  }
  if (access === null) {
    rt.pushStore.removeByPerson(personId);
    for (const [id, p] of rt.pendingCaptures)
      if (p.personId === personId) rt.pendingCaptures.delete(id);
  } else {
    rt.pushStore.setAccess(personId, access);
  }
  return rescoped;
}

/** The guest interaction ids of a scope (none for a member or no access). */
const guestIds = (access: CallerAccess | null): string[] =>
  access?.kind === "guest" ? access.interactionIds : [];

/** True when `next` lets the person see less than `prev` did. */
function shrinks(prev: CallerAccess | null, next: CallerAccess | null): boolean {
  if (prev === null) return false;
  if (next === null) return true;
  if (prev.kind === "member") return next.kind !== "member";
  if (next.kind === "member") return false;
  const kept = new Set(next.interactionIds);
  return prev.interactionIds.some((id) => !kept.has(id));
}

/**
 * One access control (round 2, S2): the person's whole scope as the edge read
 * it at delivery, applied only when its epoch is at or above the last applied
 * for them. Sockets are re-scoped (or closed) first; the interactions shared
 * with them follow (a new share owes a look, a removed one leaves); then the
 * sockets resync, and a socket whose scope shrank hears `access-changed`.
 */
function applyAccess(
  rt: Runtime,
  personId: string,
  access: CallerAccess | null,
  epoch: number | null,
  fromValidation = false,
): void {
  const prev = storedAccess(rt, personId)?.access ?? null;
  const rescoped = personAccessChanged(rt, personId, access, epoch, fromValidation);
  rt.db.run(
    "INSERT INTO person_access (person_id, access_json, epoch) VALUES (?, ?, ?) " +
      "ON CONFLICT(person_id) DO UPDATE SET access_json = excluded.access_json, epoch = excluded.epoch",
    personId,
    access ? JSON.stringify(access) : null,
    epoch ?? 0,
  );
  // The interactions themselves say whom they are shared with: a new share
  // owes a look, a removed one leaves, whatever was last recorded for them.
  const after = new Set(guestIds(access));
  for (const id of after) {
    const shared = rt.interactions.get(id)?.sharedWith ?? [];
    if (!shared.includes(personId)) shareChanged(rt, id, personId, true);
  }
  for (const s of [...rt.interactions.values()]) {
    if ((s.sharedWith ?? []).includes(personId) && !after.has(s.id)) {
      shareChanged(rt, s.id, personId, false);
    }
  }
  resync(rt, rescoped);
  // Each socket that now sees less than it did hears so (whatever was on record).
  for (const { socket, sessionId, was } of rescoped) {
    if (sessionId && (shrinks(prev, access) || shrinks(was, access))) {
      sendFrame(socket, { v: 1, type: "access-changed" });
    }
  }
  wakeAllWaiters(rt);
}

/** One interaction learns a share was added for (or removed from) this person. */
function shareChanged(rt: Runtime, interactionId: string, personId: string, added: boolean): void {
  const prev = rt.interactions.get(interactionId);
  if (!prev) return;
  const next = added ? shareWith(prev, personId) : unshare(prev, personId);
  if (next === prev) return;
  const state = commit(
    rt,
    {
      k: added ? "int-share-add" : "int-share-remove",
      ts: rt.clock.now(),
      id: interactionId,
      personId,
    },
    next,
  );
  afterMutation(rt, prev, state);
}

/** Every parked wait re-checks its caller (revoked, or no longer allowed to see it). */
function wakeAllWaiters(rt: Runtime): void {
  for (const set of [...rt.waiters.values()]) for (const wake of [...set]) wake();
}

/** Closes a socket and marks it, so frames still queued behind it are dropped. */
function closeSocket(rt: Runtime, socket: SpaceSocket, code: number, reason: string): void {
  const a = socket.attachment();
  if (a) socket.setAttachment({ ...a, closedAt: rt.clock.now() });
  socket.close(code, reason);
}

/**
 * Credentials signed out (R3-S1): recorded first, so admission refuses them
 * however late a request arrives; then their sockets close, their push
 * subscriptions and uploads go, and their parked waits end. A raised minimum
 * generation reaches only credentials stamped below it, never one issued
 * after the change. A notice naming neither ids nor a generation (written by
 * an earlier Worker) closes every socket, push and upload of the person and
 * records nothing: the directory already deleted the credentials, so only
 * live ones come back.
 */
function credentialsRevoked(
  rt: Runtime,
  personId: string,
  credentialIds: string[] | undefined,
  minGen: number | undefined,
): void {
  const now = rt.clock.now();
  const ids = new Set(credentialIds ?? []);
  const bare = credentialIds === undefined && minGen === undefined;
  rt.db.transaction(() => {
    for (const id of ids) {
      rt.db.run(
        "INSERT INTO revoked_credentials (credential_id, person_id, revoked_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(credential_id) DO NOTHING",
        id,
        personId,
        now,
      );
    }
    if (minGen !== undefined) {
      rt.db.run(
        "INSERT INTO credential_generations (person_id, min_generation) VALUES (?, ?) " +
          "ON CONFLICT(person_id) DO UPDATE SET min_generation = max(min_generation, excluded.min_generation)",
        personId,
        minGen,
      );
    }
  });
  const floor = minGeneration(rt, personId);
  const cut = (credentialId: string, generation: number | undefined) =>
    bare || ids.has(credentialId) || (generation ?? 0) < floor;
  for (const socket of rt.deps.sockets.all()) {
    const a = socket.attachment();
    if (
      a &&
      a.caller.personId === personId &&
      cut(a.caller.credentialId, a.caller.credentialGeneration)
    )
      closeSocket(rt, socket, CLOSE_ACCESS_REVOKED, "signed out");
  }
  for (const row of rt.pushStore.listAll()) {
    if (row.personId === personId && cut(row.credentialId, row.credentialGeneration))
      rt.pushStore.remove(row.credentialId);
  }
  for (const [id, p] of rt.pendingCaptures) {
    if (p.personId === personId && cut(p.credentialId, p.credentialGeneration))
      rt.pendingCaptures.delete(id);
  }
  wakeAllWaiters(rt);
}

/* ── re-validation against the directory (R3-S2) ───────────────────── */

const keyOf = (personId: string, credentialId: string) => `${personId}\u0000${credentialId}`;

/**
 * Asks the directory about these sockets' (person, credential) pairs in one
 * call and acts on each answer before anything else runs: a dead credential
 * or one of an old generation closes its sockets (and is recorded, like a
 * notice); no standing closes the person's sockets; a different scope
 * re-scopes them (as an access control at the directory's epoch would);
 * survivors are stamped as validated now. If the directory cannot be asked,
 * the sockets close with a normal close, so their clients reconnect through
 * the edge, which decides afresh. Returns the sockets still open.
 */
async function revalidate(rt: Runtime, sockets: SpaceSocket[]): Promise<SpaceSocket[]> {
  const port = rt.deps.directory;
  if (!port) return sockets;
  const entries = new Map<string, ValidationEntry>();
  for (const socket of sockets) {
    const a = socket.attachment();
    if (!a || a.closedAt !== undefined || a.caller.class === "agent") continue;
    entries.set(keyOf(a.caller.personId, a.caller.credentialId), {
      personId: a.caller.personId,
      credentialId: a.caller.credentialId,
      credentialClass: a.caller.class,
    });
  }
  if (entries.size === 0) return [];
  let results: ValidationResult[];
  try {
    results = await port.validate([...entries.values()]);
  } catch (error) {
    rt.log("revalidate-failed", { error: String(error) });
    for (const socket of sockets) closeSocket(rt, socket, 1000, "re-authorize");
    return [];
  }
  if (purged(rt)) return [];
  const byKey = new Map(results.map((r) => [keyOf(r.personId, r.credentialId), r]));
  const people = new Map<string, ValidationResult>();
  for (const r of results) people.set(r.personId, r);
  for (const [personId, r] of people) {
    // The person's generation moved on: recorded like the notice that may never come.
    if (r.personGeneration !== null && r.personGeneration > minGeneration(rt, personId)) {
      credentialsRevoked(rt, personId, undefined, r.personGeneration);
    }
  }
  for (const r of results) {
    if (!r.live || r.personGeneration === null) {
      credentialsRevoked(rt, r.personId, [r.credentialId], undefined);
    }
  }
  for (const [personId, r] of people) {
    if (r.personGeneration === null) continue;
    const current = r.epoch === null ? null : r.access;
    const prev = storedAccess(rt, personId);
    const unchanged = prev !== undefined && JSON.stringify(prev.access) === JSON.stringify(current);
    const socketsDiffer = rt.deps.sockets.all().some((socket) => {
      const a = socket.attachment();
      return (
        a !== null &&
        a.closedAt === undefined &&
        a.caller.personId === personId &&
        JSON.stringify(a.caller.access) !== JSON.stringify(current)
      );
    });
    if (unchanged && !socketsDiffer) continue;
    // Older than the person's recorded scope: nothing to learn from it (3b-S4).
    if (prev && r.epoch !== null && prev.epoch > r.epoch) continue;
    if (r.epoch !== null && !controlApplies(rt, `access:${personId}`, r.epoch)) continue;
    if (r.epoch !== null) raiseEpoch(rt, r.epoch);
    applyAccess(rt, personId, current, r.epoch, true);
    directoryChanged(rt);
  }
  const now = rt.clock.now();
  const open: SpaceSocket[] = [];
  for (const socket of sockets) {
    const a = socket.attachment();
    if (!a || a.closedAt !== undefined) continue;
    const r = byKey.get(keyOf(a.caller.personId, a.caller.credentialId));
    if (!r?.live) continue;
    socket.setAttachment({ ...a, validatedAt: now });
    open.push(socket);
  }
  return open;
}

/**
 * The edge's control calls. Each is idempotent; an access or person control
 * older than the last applied for that person is accepted and skipped. A
 * deleted space answers only a repeated purge.
 */
async function internal(rt: Runtime, req: Request, path: string): Promise<Response> {
  const epoch = epochOf(req);
  if (path === "/internal/purge") {
    if (req.method !== "POST") return errorResponse("invalid", "Use POST.", "method");
    rt.purging = true;
    try {
      purgeAll(rt.db);
    } finally {
      rt.purging = false;
    }
    rt.interactions.clear();
    rt.variantSets.clear();
    rt.pendingCaptures.clear();
    for (const socket of rt.deps.sockets.all()) socket.close(CLOSE_ACCESS_REVOKED, "space deleted");
    for (const wakes of rt.waiters.values()) for (const wake of wakes) wake();
    rt.waiters.clear();
    return json({ ok: true });
  }
  if (purged(rt)) return notFound();
  if (path === "/internal/access-changed") {
    if (req.method !== "POST") return errorResponse("invalid", "Use POST.", "method");
    const b = await parseBody(req, InternalAccessChangedRequestSchema, CONTROL_MAX_BYTES);
    if (b instanceof Response) return b;
    if (!controlApplies(rt, `access:${b.personId}`, epoch)) return json({ ok: true, stale: true });
    applyAccess(rt, b.personId, b.access, epoch);
    directoryChanged(rt);
    return json({ ok: true });
  }
  if (path === "/internal/credential-revoked") {
    if (req.method !== "POST") return errorResponse("invalid", "Use POST.", "method");
    const b = await parseBody(req, InternalCredentialRevokedRequestSchema, CONTROL_MAX_BYTES);
    if (b instanceof Response) return b;
    // A revocation is never stale: it always applies.
    raiseEpoch(rt, epoch);
    credentialsRevoked(rt, b.personId, b.credentialIds, b.minGeneration);
    return json({ ok: true });
  }
  if (path === "/internal/person") {
    if (req.method !== "POST") return errorResponse("invalid", "Use POST.", "method");
    const b = await parseBody(req, InternalPersonRequestSchema, CONTROL_MAX_BYTES);
    if (b instanceof Response) return b;
    const personId = "person" in b ? b.person.id : b.personId;
    if (!controlApplies(rt, `person:${personId}`, epoch)) return json({ ok: true, stale: true });
    if ("person" in b) rt.people.set(b.person);
    else rt.people.remove(personId);
    directoryChanged(rt);
    return json({ ok: true });
  }
  return notFound();
}

export function createSpace(deps: SpaceDeps): Space {
  const rt = createRuntime(deps);
  rt.revalidate = (sockets) => revalidate(rt, sockets);
  return {
    runtime: rt,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path.startsWith("/internal/")) {
        if (req.headers.get(INTERNAL_HEADER) !== "1" || req.headers.has(CALLER_HEADER)) {
          return notFound();
        }
        return internal(rt, req, path);
      }
      const admitted = admitCaller(rt, req);
      if ("refusal" in admitted) return admitted.refusal;
      const caller = admitted.caller;
      const tooOld = protocolRefusal(rt, req);
      if (tooOld) return tooOld;
      if (path === "/ws") {
        return errorResponse("invalid", "Open this as a WebSocket.", "upgrade-expected");
      }
      try {
        return (await routeRequest(rt, caller, req, path)) ?? notFound();
      } catch (error) {
        // Admitted before a purge, writing after it: as if it had arrived after (R3-S4).
        if (error instanceof SpacePurgedError) return notFound();
        throw error;
      }
    },
    admitSocket(req) {
      const admitted = admitCaller(rt, req);
      if ("refusal" in admitted) return { ok: false, response: admitted.refusal };
      const caller = admitted.caller;
      if (req.method !== "GET") {
        return { ok: false, response: errorResponse("invalid", "Use GET.", "method") };
      }
      if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return {
          ok: false,
          response: errorResponse("invalid", "Open this as a WebSocket.", "upgrade-expected"),
        };
      }
      if (caller.class === "agent") {
        return {
          ok: false,
          response: errorResponse("forbidden", "Agents reach onlay through MCP.", "agent"),
        };
      }
      const offered = (req.headers.get("Sec-WebSocket-Protocol") ?? "")
        .split(",")
        .map((p) => p.trim());
      return {
        ok: true,
        // The edge decided just now: the directory vouched for it at the upgrade.
        attachment: { caller, authorizedAt: rt.clock.now(), validatedAt: rt.clock.now() },
        ...(offered.includes(WS_SUBPROTOCOL) ? { protocol: WS_SUBPROTOCOL } : {}),
      };
    },
    onMessage(socket, raw) {
      return onMessage(rt, socket, raw);
    },
    onClose(socket) {
      onClose(rt, socket);
    },
    alarm() {
      const now = rt.clock.now();
      for (const [id, p] of rt.pendingCaptures) if (p.deadline < now) rt.pendingCaptures.delete(id);
      const result = sweepRetention(rt.db, now);
      if (result.interactionsRemoved > 0 || result.variantSetsRemoved > 0) {
        const live = rt.interactionStore.loadAll();
        for (const id of [...rt.interactions.keys()]) if (!live.has(id)) rt.interactions.delete(id);
        const sets = rt.variantStore.loadAll();
        for (const id of [...rt.variantSets.keys()]) if (!sets.has(id)) rt.variantSets.delete(id);
      }
      rt.accessUpdates.clear();
      return result;
    },
    sweepSockets() {
      for (const socket of rt.deps.sockets.all()) {
        const a = socket.attachment();
        if (a) expiredSocket(rt, socket, a);
      }
    },
    async validateSockets() {
      const open = rt.deps.sockets.all().filter((socket) => {
        const a = socket.attachment();
        return a !== null && !expiredSocket(rt, socket, a);
      });
      if (open.length > 0) await revalidate(rt, open);
    },
    async reportRemovedShares() {
      const report = deps.sharesGone;
      if (!report) return;
      const ids = rt.db
        .all<{ interaction_id: string }>("SELECT interaction_id FROM share_cleanup")
        .map((r) => r.interaction_id);
      if (ids.length === 0) return;
      try {
        await report(ids);
      } catch (error) {
        rt.log("share-cleanup-failed", { count: ids.length, error: String(error) });
        return;
      }
      rt.db.transaction(() => {
        for (const id of ids) rt.db.run("DELETE FROM share_cleanup WHERE interaction_id = ?", id);
      });
    },
  };
}
