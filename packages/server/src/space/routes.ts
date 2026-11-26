import { effectiveAgentWork, type InteractionState, isLive, shareSeen } from "@onlay/kernel";
import {
  type AgentWorkItem,
  type AgentWorkListing,
  AnchorSchema,
  AskPayloadSchema,
  type Caller,
  ChangePayloadSchema,
  ClientIdSchema,
  InteractionKindSchema,
  LIMITS,
  makeRef,
  PageMutationProgramSchema,
  PEEK_PARAM,
  type PersonSummary,
  parsePictureUrl,
  RichTextSchema,
  VariantPickRequestSchema,
} from "@onlay/protocol";
import * as z from "zod/mini";
import { readCappedBody } from "./body";
import {
  handleCaptureCommit,
  handleCaptureInit,
  handleCapturePartGet,
  handleCapturePut,
  handleCapturesList,
  handleCaptureUsage,
} from "./captures";
import type { ContentSlot } from "./content-store";
import { errorResponse, json, methodNotAllowed, notFound, parseBody, refusal } from "./http";
import { pictureResponse } from "./picture";
import { pushEndpointRefusal, vapidKeysOf } from "./push";
import {
  buildAttentionFrame,
  canSee,
  credentialRevokedHere,
  isPersonClient,
  keptOf,
  originsFor,
  personSummary,
  type Runtime,
  rowText,
  spaceFacts,
  storedAccess,
  toSnapshot,
  visibleInteractions,
} from "./runtime";
import {
  admit,
  afterMutation,
  answerOp,
  commit,
  createOp,
  deleteOp,
  editOp,
  type Outcome,
  reactOp,
  releaseOp,
  reopenOp,
  replyOp,
  resnapOp,
  resolveOp,
  stateOp,
  takeOp,
  visible,
} from "./service";
import { admitSet, discardOp, pickOp, reviseOp, submitOp, summarizeSet } from "./variants";

/**
 * The space's HTTP routes (spec §7.1). The edge forwards `/s/<spaceId><path>`
 * and this sees `<path>`. Every route enforces its method; every route runs
 * the caller through visibility and the kernel's admission. Errors are
 * `{error: {code, message, reason?}}`; successes keep the broker's shapes.
 */

type Handler = (
  rt: Runtime,
  caller: Caller,
  req: Request,
  params: string[],
) => Promise<Response> | Response;

interface Route {
  pattern: RegExp;
  methods: Partial<Record<string, Handler>>;
}

const ID = "([0-9a-fA-F-]{1,64})";
const NAME = "([^/]{1,64})";

/* ── reads ────────────────────────────────────────────────────────── */

/**
 * Who the caller may see here: a member sees the space's current members and
 * the guests who hold a share now (spec §7); a guest sees only the people of
 * the interactions shared with them. Everyone sees themself.
 */
function visiblePeople(rt: Runtime, caller: Caller): Set<string> {
  const ids = new Set<string>();
  if (caller.access.kind === "member") {
    for (const p of rt.people.all()) if (p.member || p.guest) ids.add(p.id);
  } else {
    for (const s of visibleInteractions(rt, caller.access)) {
      ids.add(s.authorId);
      for (const p of s.participants) ids.add(p);
      for (const p of s.waitingOn) ids.add(p);
    }
  }
  ids.add(caller.personId);
  ids.delete("system");
  return ids;
}

/**
 * The people the caller may see (`visiblePeople`). A member also gets each
 * fellow member's alias (the local part of their email), to find them by;
 * a guest never gets one.
 */
function directory(rt: Runtime, caller: Caller): PersonSummary[] {
  const member = caller.access.kind === "member";
  return [...visiblePeople(rt, caller)]
    .flatMap((id) => {
      const cached = rt.people.get(id);
      if (cached === undefined) return [];
      const summary = personSummary(rt, id);
      return [
        member && cached.member && cached.alias ? { ...summary, alias: cached.alias } : summary,
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * `GET /people/:personId/picture/:key`: the picture the space shows for a
 * person the caller may see here, by the key it shows it under. An unknown
 * person, one the caller may not see, one without a picture or with another
 * key now: all the same `not_found`, so a picture never says who exists.
 */
async function getPicture(
  rt: Runtime,
  caller: Caller,
  req: Request,
  personId: string,
  key: string,
) {
  const port = rt.deps.pictures;
  if (port === undefined || !visiblePeople(rt, caller).has(personId)) return notFound();
  const shown = parsePictureUrl(rt.people.get(personId)?.avatarUrl);
  if (shown?.kind !== "space" || shown.personId !== personId || shown.key !== key) {
    return notFound();
  }
  const picture = await port.read(personId, key);
  return picture === null ? notFound() : pictureResponse(req, key, picture.type, picture.bytes);
}

function originOf(url: string): string | null {
  try {
    const o = new URL(url).origin;
    return o === "null" ? null : o;
  } catch {
    return null;
  }
}

/**
 * A repository's identity, `host/owner/name` lower-cased, from a provenance
 * stamp (`origin@sha;branch;dirty`) or a bare repository reference: the
 * `@sha` and branch parts, a scheme or `git@host:` prefix, credentials and a
 * trailing `.git` are ignored. Null when nothing like one is there.
 */
function repoIdentity(raw: string): string | null {
  let head = (raw.split(";")[0] ?? "").trim();
  head = head.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  // Credentials or `git@` come before the host's first `/` or `:`.
  head = head.replace(/^[^@/:]*(:[^@/]*)?@/, "");
  // `@sha` follows the path.
  const at = head.lastIndexOf("@");
  if (at > 0) head = head.slice(0, at);
  // `host:owner/name` (scp-like) and `host:port/owner/name`.
  head = head.replace(/^([^/:]+):\d+\//, "$1/").replace(/^([^/:]+):/, "$1/");
  head = head.replace(/\/+$/, "").replace(/\.git$/i, "");
  const parts = head.split("/").filter((p) => p.length > 0);
  if (parts.length < 3) return null;
  return parts.join("/").toLowerCase();
}

function agentWorkListing(rt: Runtime, caller: Caller, q: URLSearchParams): AgentWorkListing {
  const now = rt.clock.now();
  const url = q.get("url");
  const origin = q.get("origin");
  const repo = q.get("repo");
  // The same repository however it is written; an unreadable one matches nothing.
  const wantRepo = repo ? repoIdentity(repo) : undefined;
  const spaceId = rt.deps.spaceId ?? "";
  const spaceName = spaceFacts(rt)?.name ?? spaceId;
  const yours: AgentWorkItem[] = [];
  const teammates: AgentWorkItem[] = [];
  const items = visibleInteractions(rt, caller.access)
    .map((s) => ({ s, w: effectiveAgentWork(s, now) }))
    // Live interactions only: closed work is nobody's to take.
    .filter(
      (x): x is { s: InteractionState; w: NonNullable<typeof x.w> } =>
        x.w !== undefined && x.w.status !== "answered" && isLive(x.s),
    )
    .sort((a, b) => a.w.requestedAt - b.w.requestedAt);
  for (const { s, w } of items) {
    const anchored = s.anchor.level !== "unanchored";
    if (url && (!anchored || s.url !== url)) continue;
    if (origin && (!anchored || originOf(s.url) !== origin)) continue;
    if (wantRepo !== undefined) {
      const prov =
        (s.anchor.level === "element" ? s.anchor.provenance : undefined) ?? s.change?.provenance;
      if (!prov || wantRepo === null || repoIdentity(prov) !== wantRepo) continue;
    }
    const item: AgentWorkItem = {
      ref: makeRef(spaceId, s.id),
      kind: s.kind,
      summary: rowText(s, isPersonClient(caller)),
      ...(anchored ? { url: s.url } : {}),
      spaceId,
      spaceName,
      requestedBy: personSummary(rt, w.requestedBy),
      requestedAt: w.requestedAt,
      status: w.status,
    };
    (w.requestedBy === caller.personId ? yours : teammates).push(item);
  }
  return { yours, teammates };
}

function getInteraction(rt: Runtime, caller: Caller, id: string, peek: boolean): Response {
  const g = visible(rt, caller, id);
  if (!g.ok) return refusal(g);
  let s = g.s;
  // The person opening what was shared with them pays its "shared with you"
  // debt; their agent reading it never does, nor does a `?peek=1` read (an
  // automatic recovery, R3-S9).
  const seen = caller.class === "agent" || peek ? s : shareSeen(s, caller.personId);
  if (seen !== s) {
    s = commit(
      rt,
      { k: "int-share-seen", ts: rt.clock.now(), id, personId: caller.personId },
      seen,
    );
    afterMutation(rt, g.s, s);
  }
  const kept = keptOf(rt, s);
  return json({
    ok: true,
    interaction: toSnapshot(rt, s, rt.captureStore.listForInteraction(id)),
    seq: rt.journal.lastSeq("interaction", id),
    ...(kept ? { kept } : {}),
  });
}

/* ── wait ─────────────────────────────────────────────────────────── */

/** Outstanding waits one person may hold in a space; the next is `rate_limited`. */
const MAX_WAITS_PER_PERSON = 4;

const WaitParams = z.object({
  since: z.number().check(z.int(), z.gte(0)),
  timeout: z.number().check(z.gte(0), z.lte(LIMITS.MAX_WAIT_SECONDS)),
});

/**
 * Resolves at the next journal event for the interaction, or at the timeout.
 * The waiter lives in memory: an eviction drops the request with it, and the
 * client simply waits again from the same `since`.
 */
function wait(rt: Runtime, caller: Caller, req: Request, id: string): Promise<Response> | Response {
  const g = visible(rt, caller, id);
  if (!g.ok) return refusal(g);
  const q = new URL(req.url).searchParams;
  const parsed = z.safeParse(WaitParams, {
    since: Number(q.get("since") ?? "0"),
    timeout: Number(q.get("timeout") ?? String(LIMITS.MAX_WAIT_SECONDS)),
  });
  if (!parsed.success)
    return errorResponse("invalid", "Use since ≥ 0 and timeout ≤ 25.", "schema-invalid");
  const { since, timeout } = parsed.data;
  const startedAt = rt.clock.now();
  const accessNow = () => {
    const update = rt.accessUpdates.get(caller.personId);
    return update && update.at >= startedAt ? update.access : caller.access;
  };
  const answer = (): Response | null => {
    // A credential signed out since the wait began ends it at once.
    if (credentialRevokedHere(rt, caller)) return notFound();
    const events = rt.journal.since("interaction", id, since);
    const access = accessNow();
    if (!access || !canSee(access, id) || !rt.interactions.has(id)) return notFound();
    if (events.length === 0) return null;
    const s = rt.interactions.get(id);
    if (!s) return notFound();
    return json({
      ok: true,
      interactionId: id,
      seq: events.at(-1)?.seq ?? since,
      events,
      interaction: toSnapshot(rt, s, rt.captureStore.listForInteraction(id)),
    });
  };
  const ready = answer();
  if (ready) return ready;
  const timedOut = () =>
    json({ ok: true, interactionId: id, seq: since, events: [], timedOut: true });
  if (timeout === 0) return timedOut();
  // At most MAX_WAITS_PER_PERSON parked waits per person in this space.
  const parked = rt.waitsByPerson.get(caller.personId) ?? 0;
  if (parked >= MAX_WAITS_PER_PERSON) {
    return errorResponse(
      "rate_limited",
      `At most ${MAX_WAITS_PER_PERSON} waits at once. Let one finish, then wait again.`,
      "too-many-waits",
    );
  }
  rt.waitsByPerson.set(caller.personId, parked + 1);
  const setTimer =
    rt.deps.setTimer ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });
  return new Promise<Response>((resolve) => {
    let settled = false;
    const finish = (res: Response) => {
      if (settled) return;
      settled = true;
      const left = (rt.waitsByPerson.get(caller.personId) ?? 1) - 1;
      if (left > 0) rt.waitsByPerson.set(caller.personId, left);
      else rt.waitsByPerson.delete(caller.personId);
      cancel();
      rt.waiters.get(id)?.delete(wake);
      resolve(res);
    };
    const wake = () => {
      const res = answer();
      if (res) finish(res);
      else register(); // woken without a journal event (e.g. a new capture): keep waiting
    };
    const register = () => {
      const set = rt.waiters.get(id) ?? new Set();
      set.add(wake);
      rt.waiters.set(id, set);
    };
    const cancel = setTimer(() => finish(timedOut()), timeout * 1000);
    register();
  });
}

/* ── captured HTML ────────────────────────────────────────────────── */

/**
 * Each route's body limit in bytes, checked while the body streams and
 * before it is parsed. Text limits allow for JSON escaping (up to six bytes
 * per character).
 */
const BODY = {
  /** delete, react, state, take, pick: a few ids. */
  small: 16_384,
  /** reply, edit, answer: one rich-text message and its tokens. */
  message: 65_536,
  /** create: an Ask's context is the largest field. */
  create: 6 * LIMITS.MAX_ASK_CONTEXT + 65_536,
  /** a push subscription. */
  subscribe: 8_192,
  /** an agent's variants: one set's programs. */
  variants: LIMITS.MAX_SET_PROGRAM_BYTES + 65_536,
  /** one revised program. */
  revise: LIMITS.MAX_PROGRAM_BYTES + 16_384,
  /** captured block or page markup. */
  anchorContent: 6 * LIMITS.MAX_ANCHOR_CONTENT + 4_096,
  pageContent: 6 * LIMITS.MAX_PAGE_CONTENT + 4_096,
} as const;

const ContentBody = (max: number) =>
  z.object({
    content: z.string().check(z.maxLength(max)),
    format: z.optional(z.literal("html")),
    truncated: z.optional(z.boolean()),
  });

/**
 * Write-once captured HTML: the block an element anchor sits on, or a page
 * edit's page. Seeding page markup is a member's Full-client act, which the
 * kernel admits as `reanchor` (only a member's extension holds it).
 */
async function uploadContent(
  rt: Runtime,
  caller: Caller,
  req: Request,
  id: string,
  slot: ContentSlot,
): Promise<Response> {
  const check = (): Response | null => {
    const g = admit(rt, caller, "reanchor", id);
    if (!g.ok) return refusal(g);
    const s = g.s;
    // Only the author supplies the source markup, or the person who last
    // anchored or re-anchored it (that move's own upload; journaled).
    if (s.authorId !== caller.personId && s.anchoredBy !== caller.personId) {
      return errorResponse(
        "forbidden",
        "Only the person who made this thread can supply its markup.",
        "not-yours",
      );
    }
    if (slot === "anchor" && s.anchor.level !== "element") {
      return errorResponse("conflict", "Only a block anchor has captured markup.", "not-element");
    }
    if (slot === "page" && (s.kind !== "change" || s.anchor.level !== "page")) {
      return errorResponse("conflict", "Only a page edit has captured page markup.", "not-page");
    }
    if (s.resolvedAt !== undefined || s.state === "dropped") {
      return errorResponse("conflict", "This interaction is closed.", "closed");
    }
    if (rt.contentStore.read(id, slot)) return exists();
    return null;
  };
  const refused = check();
  if (refused) return refused;
  const max = slot === "page" ? LIMITS.MAX_PAGE_CONTENT : LIMITS.MAX_ANCHOR_CONTENT;
  const body = await parseBody(
    req,
    ContentBody(max),
    slot === "page" ? BODY.pageContent : BODY.anchorContent,
  );
  if (body instanceof Response) return body;
  // The body was awaited: the interaction may have closed, or another upload won.
  const late = check();
  if (late) return late;
  const written = rt.contentStore.write(
    id,
    slot,
    body.content,
    body.format ?? "html",
    body.truncated ?? false,
    rt.clock.now(),
  );
  if (!written) return exists();
  return json({ ok: true, interactionId: id });
}

const exists = () => errorResponse("conflict", "Markup was already captured.", "exists");

function readContent(rt: Runtime, caller: Caller, id: string, slot: ContentSlot): Response {
  const g = visible(rt, caller, id);
  if (!g.ok) return refusal(g);
  const stored = rt.contentStore.read(id, slot);
  if (!stored) return errorResponse("not_found", "No markup was captured.", "no-content");
  return json({
    ok: true,
    interactionId: id,
    format: stored.format,
    truncated: stored.truncated,
    content: stored.content,
  });
}

/* ── push ─────────────────────────────────────────────────────────── */

const SubscribeBody = z.object({
  endpoint: z.url().check(z.maxLength(LIMITS.MAX_URL)),
  expirationTime: z.optional(z.nullable(z.number())),
  keys: z.object({
    p256dh: z.string().check(z.minLength(1), z.maxLength(256)),
    auth: z.string().check(z.minLength(1), z.maxLength(64)),
  }),
});

const pushOff = () =>
  errorResponse("not_found", "Notifications aren't set up on this server.", "push-off");

const webAppOnly = () =>
  errorResponse(
    "forbidden",
    "Notifications are set up from the web app.",
    "interaction-client-required",
  );

/* ── bodies ───────────────────────────────────────────────────────── */

const CreateBody = z.object({
  kind: InteractionKindSchema,
  anchor: z.optional(AnchorSchema),
  url: z.optional(z.string().check(z.maxLength(LIMITS.MAX_URL))),
  body: z.optional(RichTextSchema),
  ask: z.optional(AskPayloadSchema),
  change: z.optional(ChangePayloadSchema),
});
const ReplyBody = z.object({
  body: RichTextSchema,
  replyTo: z.optional(z.object({ msgId: z.string().check(z.maxLength(LIMITS.MAX_ANCHOR_ID)) })),
  /** The client's id for this send: a repeat answers with the first message (M-1). */
  clientId: z.optional(ClientIdSchema),
});
const EditBody = z.object({
  msgId: z.string().check(z.maxLength(LIMITS.MAX_ANCHOR_ID)),
  body: RichTextSchema,
});
const DeleteBody = z.object({ msgId: z.string().check(z.maxLength(LIMITS.MAX_ANCHOR_ID)) });
const ReactBody = z.object({
  msgId: z.string().check(z.maxLength(LIMITS.MAX_ANCHOR_ID)),
  emoji: z.string().check(z.minLength(1), z.maxLength(LIMITS.MAX_EMOJI)),
  on: z.optional(z.boolean()),
});
const AnswerBody = z.object({
  optionIds: z
    .array(z.string().check(z.maxLength(LIMITS.MAX_OPTION_ID)))
    .check(z.maxLength(LIMITS.MAX_ASK_OPTIONS)),
  comment: z.optional(RichTextSchema),
});
const StateBody = z.object({
  state: z.enum(["working", "implemented", "verifying", "resolved", "dropped"]),
});
const TakeBody = z.object({ onBehalf: z.optional(z.boolean()) });
const SubmitBody = z.object({
  variants: z
    .array(
      z.object({
        variantId: z.optional(
          z.string().check(z.minLength(1), z.maxLength(LIMITS.MAX_VARIANT_SET_ID)),
        ),
        label: z.string().check(z.minLength(1), z.maxLength(LIMITS.MAX_VARIANT_LABEL)),
        program: PageMutationProgramSchema,
      }),
    )
    .check(z.minLength(1), z.maxLength(LIMITS.MAX_VARIANTS_PER_SET)),
});
const ReviseBody = z.object({
  program: PageMutationProgramSchema,
  /** The client's id for this revision: a repeat answers with the first version (2-S1). */
  clientId: z.optional(ClientIdSchema),
});

/** An empty body reads as `{}` for routes whose body is optional. */
async function optionalBody<S extends z.ZodMiniType>(
  req: Request,
  schema: S,
  maxBytes: number,
): Promise<z.infer<S> | Response> {
  const bytes = await readCappedBody(req, maxBytes);
  if (bytes === null) {
    return errorResponse("invalid", `The body is larger than ${maxBytes} bytes.`, "too-large");
  }
  const text = new TextDecoder().decode(bytes);
  let data: unknown = {};
  if (text.trim() !== "") {
    try {
      data = JSON.parse(text);
    } catch {
      return errorResponse("invalid", "The body isn't JSON.", "invalid-json");
    }
  }
  const parsed = z.safeParse(schema, data);
  return parsed.success
    ? parsed.data
    : errorResponse("invalid", "The body doesn't fit.", "schema-invalid");
}

function ok<T extends object>(r: Outcome<T>, body: (r: T) => object): Response {
  return r.ok ? json({ ok: true, ...body(r) }) : refusal(r);
}

/* ── the table ────────────────────────────────────────────────────── */

/*
 * By-id writes over HTTP (`/interaction/:id/*`, `/variant-set/:id/*`) carry no
 * frame URL and are not URL-bound, by design: they are the pageless path the
 * Inbox and agents use to act on threads that live on other pages, scoped by
 * visibility and admission (involvement), as by-id HTTP always was. URL
 * binding guards frames that arrive from a page's content script
 * (frames.ts), where the frame's real URL must sit under the interaction's.
 */

const routes: Route[] = [
  {
    pattern: /^\/directory$/,
    methods: { GET: (rt, caller) => json({ people: directory(rt, caller) }) },
  },
  {
    pattern: /^\/people\/(p_[a-z2-7]{20})\/picture\/([a-z2-7]{16})$/,
    methods: {
      GET: (rt, caller, req, [personId = "", key = ""]) =>
        getPicture(rt, caller, req, personId, key),
    },
  },
  {
    pattern: /^\/attention$/,
    // The frame's rows are capped; `needsYouCount` is the full count the badge reads.
    methods: {
      GET: (rt, caller, req) => {
        // `url` (one page) or `origin` (one site) narrow the rows before the row cap.
        const q = new URL(req.url).searchParams;
        const filter = {
          ...(q.get("url") ? { url: q.get("url") as string } : {}),
          ...(q.get("origin") ? { origin: q.get("origin") as string } : {}),
        };
        const frame = buildAttentionFrame(rt, caller, filter);
        return json({ ...frame, needsYouCount: frame.needsYouCount });
      },
    },
  },
  {
    pattern: /^\/origins$/,
    methods: { GET: (rt, caller) => json({ origins: originsFor(rt, caller.access) }) },
  },
  {
    pattern: /^\/agent-work$/,
    methods: {
      GET: (rt, caller, req) => json(agentWorkListing(rt, caller, new URL(req.url).searchParams)),
    },
  },
  {
    pattern: /^\/interaction$/,
    methods: {
      GET: (rt, caller, req) => {
        const url = new URL(req.url).searchParams.get("url");
        const rows = visibleInteractions(rt, caller.access)
          .filter((s) => !url || s.url === url)
          .sort((a, b) => b.createdAt - a.createdAt)
          // A summary surface: captures ride the by-id read and page frames.
          .map((s) => toSnapshot(rt, s));
        return json({ ok: true, interactions: rows });
      },
      POST: async (rt, caller, req) => {
        const d = await parseBody(req, CreateBody, BODY.create);
        if (d instanceof Response) return d;
        const anchor =
          d.anchor ??
          (caller.class === "full" && d.url
            ? { level: "page" as const }
            : { level: "unanchored" as const });
        const r = createOp(rt, caller, {
          kind: d.kind,
          anchor,
          ...(d.url !== undefined ? { url: d.url } : {}),
          ...(d.body ? { body: d.body } : {}),
          ...(d.ask ? { ask: d.ask } : {}),
          ...(d.change ? { change: d.change } : {}),
        });
        return ok(r, ({ state }) => ({
          interactionId: state.id,
          ...(state.anchor.level !== "unanchored" ? { url: state.url } : {}),
        }));
      },
    },
  },
  {
    pattern: new RegExp(`^/interaction/${ID}$`),
    methods: {
      GET: (rt, caller, req, [id = ""]) =>
        getInteraction(rt, caller, id, new URL(req.url).searchParams.get(PEEK_PARAM) === "1"),
    },
  },
  {
    pattern: new RegExp(`^/interaction/${ID}/reply$`),
    methods: {
      POST: async (rt, caller, req, [id = ""]) => {
        const b = await parseBody(req, ReplyBody, BODY.message);
        if (b instanceof Response) return b;
        const r = replyOp(rt, caller, id, {
          body: b.body,
          ...(b.replyTo ? { replyTo: b.replyTo } : {}),
          ...(b.clientId !== undefined ? { clientId: b.clientId } : {}),
        });
        return ok(r, ({ msgId }) => ({
          interactionId: id,
          msgId,
          ...(b.clientId !== undefined ? { clientId: b.clientId } : {}),
        }));
      },
    },
  },
  {
    pattern: new RegExp(`^/interaction/${ID}/edit$`),
    methods: {
      POST: async (rt, caller, req, [id = ""]) => {
        const b = await parseBody(req, EditBody, BODY.message);
        if (b instanceof Response) return b;
        return ok(editOp(rt, caller, id, b), () => ({ interactionId: id, msgId: b.msgId }));
      },
    },
  },
  {
    pattern: new RegExp(`^/interaction/${ID}/delete$`),
    methods: {
      POST: async (rt, caller, req, [id = ""]) => {
        const b = await parseBody(req, DeleteBody, BODY.small);
        if (b instanceof Response) return b;
        return ok(deleteOp(rt, caller, id, b.msgId), () => ({ interactionId: id, msgId: b.msgId }));
      },
    },
  },
  {
    pattern: new RegExp(`^/interaction/${ID}/react$`),
    methods: {
      POST: async (rt, caller, req, [id = ""]) => {
        const b = await parseBody(req, ReactBody, BODY.small);
        if (b instanceof Response) return b;
        const on = b.on ?? true;
        return ok(reactOp(rt, caller, id, { msgId: b.msgId, emoji: b.emoji, on }), () => ({
          interactionId: id,
          msgId: b.msgId,
          emoji: b.emoji,
          on,
        }));
      },
    },
  },
  {
    pattern: new RegExp(`^/interaction/${ID}/answer$`),
    methods: {
      POST: async (rt, caller, req, [id = ""]) => {
        const b = await parseBody(req, AnswerBody, BODY.message);
        if (b instanceof Response) return b;
        const r = answerOp(rt, caller, id, {
          optionIds: b.optionIds,
          ...(b.comment ? { comment: b.comment } : {}),
        });
        return ok(r, ({ state }) => ({ interactionId: id, state: state.state }));
      },
    },
  },
  {
    pattern: new RegExp(`^/interaction/${ID}/resolve$`),
    methods: {
      POST: (rt, caller, _req, [id = ""]) =>
        ok(resolveOp(rt, caller, id), ({ changed }) => ({ interactionId: id, changed })),
    },
  },
  {
    pattern: new RegExp(`^/interaction/${ID}/reopen$`),
    methods: {
      POST: (rt, caller, _req, [id = ""]) =>
        ok(reopenOp(rt, caller, id), ({ changed }) => ({ interactionId: id, changed })),
    },
  },
  {
    pattern: new RegExp(`^/interaction/${ID}/resnap$`),
    methods: {
      POST: (rt, caller, _req, [id = ""]) =>
        ok(resnapOp(rt, caller, id), ({ pending }) => ({
          interactionId: id,
          ...(pending ? { pending: true } : { requested: true }),
        })),
    },
  },
  {
    pattern: new RegExp(`^/interaction/${ID}/state$`),
    methods: {
      POST: async (rt, caller, req, [id = ""]) => {
        const b = await parseBody(req, StateBody, BODY.small);
        if (b instanceof Response) return b;
        return ok(stateOp(rt, caller, id, b.state), ({ state }) => ({
          interactionId: id,
          state: state.state,
        }));
      },
    },
  },
  {
    pattern: new RegExp(`^/interaction/${ID}/agent/take$`),
    methods: {
      POST: async (rt, caller, req, [id = ""]) => {
        const b = await optionalBody(req, TakeBody, BODY.small);
        if (b instanceof Response) return b;
        return ok(takeOp(rt, caller, id, b.onBehalf === true), ({ state }) => ({
          interactionId: id,
          agentWork: effectiveAgentWork(state, rt.clock.now()),
        }));
      },
    },
  },
  {
    pattern: new RegExp(`^/interaction/${ID}/agent/release$`),
    methods: {
      POST: (rt, caller, _req, [id = ""]) =>
        ok(releaseOp(rt, caller, id), ({ state }) => ({
          interactionId: id,
          agentWork: effectiveAgentWork(state, rt.clock.now()),
        })),
    },
  },
  {
    pattern: new RegExp(`^/interaction/${ID}/wait$`),
    methods: { GET: (rt, caller, req, [id = ""]) => wait(rt, caller, req, id) },
  },
  {
    pattern: new RegExp(`^/interaction/${ID}/anchor-content$`),
    methods: {
      GET: (rt, caller, _req, [id = ""]) => readContent(rt, caller, id, "anchor"),
      POST: (rt, caller, req, [id = ""]) => uploadContent(rt, caller, req, id, "anchor"),
    },
  },
  {
    pattern: new RegExp(`^/interaction/${ID}/page-content$`),
    methods: {
      GET: (rt, caller, _req, [id = ""]) => readContent(rt, caller, id, "page"),
      POST: (rt, caller, req, [id = ""]) => uploadContent(rt, caller, req, id, "page"),
    },
  },
  {
    pattern: new RegExp(`^/interaction/${ID}/captures$`),
    methods: { GET: (rt, caller, _req, [id = ""]) => handleCapturesList(rt, caller, id) },
  },
  {
    pattern: new RegExp(`^/interaction/${ID}/capture$`),
    methods: { POST: (rt, caller, req, [id = ""]) => handleCaptureInit(rt, caller, req, id) },
  },
  {
    pattern: new RegExp(`^/interaction/${ID}/capture/${ID}/part/${NAME}$`),
    methods: {
      PUT: (rt, caller, req, [id = "", captureId = "", name = ""]) =>
        handleCapturePut(rt, caller, req, id, captureId, decodeURIComponent(name)),
      GET: (rt, caller, _req, [id = "", captureId = "", name = ""]) =>
        handleCapturePartGet(rt, caller, id, captureId, decodeURIComponent(name)),
    },
  },
  {
    pattern: new RegExp(`^/interaction/${ID}/capture/${ID}/commit$`),
    methods: {
      POST: (rt, caller, _req, [id = "", captureId = ""]) =>
        handleCaptureCommit(rt, caller, id, captureId),
    },
  },
  {
    pattern: /^\/captures\/usage$/,
    methods: { GET: (rt, caller) => handleCaptureUsage(rt, caller) },
  },
  {
    pattern: new RegExp(`^/variant-set/${ID}$`),
    methods: {
      GET: (rt, caller, _req, [setId = ""]) => {
        const g = admitSet(rt, caller, "read", setId);
        return g.ok ? json({ ok: true, set: summarizeSet(g.set) }) : refusal(g);
      },
    },
  },
  {
    pattern: new RegExp(`^/variant-set/${ID}/pick$`),
    methods: {
      POST: async (rt, caller, req, [setId = ""]) => {
        const b = await parseBody(req, VariantPickRequestSchema, BODY.small);
        if (b instanceof Response) return b;
        const pick = {
          variantId: b.variantId,
          version: b.version,
          ...(b.index !== undefined ? { index: b.index } : {}),
        };
        return ok(pickOp(rt, caller, setId, pick), ({ set, owner }) => ({
          set: summarizeSet(set),
          interactionId: owner.id,
          state: owner.state,
        }));
      },
    },
  },
  {
    pattern: new RegExp(`^/variant-set/${ID}/discard$`),
    methods: {
      POST: (rt, caller, _req, [setId = ""]) =>
        ok(discardOp(rt, caller, setId), ({ set, owner }) => ({
          set: summarizeSet(set),
          interactionId: owner.id,
          state: owner.state,
        })),
    },
  },
  {
    pattern: new RegExp(`^/variant-set/${ID}/variants$`),
    methods: {
      POST: async (rt, caller, req, [setId = ""]) => {
        const b = await parseBody(req, SubmitBody, BODY.variants);
        if (b instanceof Response) return b;
        const r = submitOp(rt, caller, setId, b.variants);
        if (!r.ok) return refusal(r, "results" in r ? { results: r.results } : undefined);
        return json({ ok: true, set: summarizeSet(r.set), results: r.results });
      },
    },
  },
  {
    pattern: new RegExp(`^/variant-set/${ID}/variants/(\\d{1,3})$`),
    methods: {
      POST: async (rt, caller, req, [setId = "", index = ""]) => {
        const b = await parseBody(req, ReviseBody, BODY.revise);
        if (b instanceof Response) return b;
        const r = reviseOp(rt, caller, setId, Number(index), b.program, b.clientId);
        if (!r.ok) return refusal(r, "result" in r ? { result: r.result } : undefined);
        return json({
          ok: true,
          setId,
          index: Number(index),
          // A repeat's index, version and op count are the first revision's.
          ...(r.made ?? {}),
          ...(r.repeat ? { repeat: true } : {}),
          result: r.result,
        });
      },
    },
  },
  {
    pattern: /^\/push\/config$/,
    methods: {
      GET: (rt) => {
        const keys = vapidKeysOf(rt);
        return keys ? json({ ok: true, vapidPublicKey: keys.publicKey }) : pushOff();
      },
    },
  },
  {
    pattern: /^\/push\/subscribe$/,
    methods: {
      POST: async (rt, caller, req) => {
        if (caller.class !== "interaction") return webAppOnly();
        if (!vapidKeysOf(rt)) return pushOff();
        const b = await parseBody(req, SubscribeBody, BODY.subscribe);
        if (b instanceof Response) return b;
        const why = pushEndpointRefusal(b.endpoint, rt.deps.allowHttpPush === true);
        if (why) return errorResponse("invalid", "That push endpoint isn't accepted.", why);
        // Re-checked after the body, immediately before the write (R3-S3): a
        // revocation or access change that landed meanwhile wins.
        if (credentialRevokedHere(rt, caller)) {
          return errorResponse(
            "sign_in_required",
            "You were signed out. Sign in again.",
            "credential-revoked",
          );
        }
        const recorded = storedAccess(rt, caller.personId);
        const current =
          recorded && recorded.epoch >= (caller.accessEpoch ?? 0) ? recorded.access : caller.access;
        if (current === null) return notFound();
        const epoch = caller.accessEpoch ?? 0;
        if (!recorded || epoch > recorded.epoch) {
          // Delivery reads the person's access record: the edge's newer word
          // replaces it, so a renewal never keeps a scope already narrowed (3b-S2).
          rt.db.run(
            "INSERT INTO person_access (person_id, access_json, epoch) VALUES (?, ?, ?) " +
              "ON CONFLICT(person_id) DO UPDATE SET access_json = excluded.access_json, epoch = excluded.epoch " +
              "WHERE excluded.epoch > person_access.epoch",
            caller.personId,
            JSON.stringify(current),
            epoch,
          );
        }
        rt.pushStore.upsert(
          caller.credentialId,
          caller.personId,
          current,
          b,
          rt.clock.now(),
          caller.credentialGeneration,
        );
        return json({ ok: true });
      },
    },
  },
  {
    pattern: /^\/push\/unsubscribe$/,
    methods: {
      POST: (rt, caller) => {
        if (caller.class !== "interaction") return webAppOnly();
        rt.pushStore.remove(caller.credentialId);
        return json({ ok: true });
      },
    },
  },
];

/** Routes a caller's request; null when no route matches the path. */
export async function routeRequest(
  rt: Runtime,
  caller: Caller,
  req: Request,
  path: string,
): Promise<Response | null> {
  for (const route of routes) {
    const m = route.pattern.exec(path);
    if (!m) continue;
    const handler = route.methods[req.method];
    if (!handler) return methodNotAllowed(Object.keys(route.methods));
    return handler(rt, caller, req, m.slice(1));
  }
  return null;
}
