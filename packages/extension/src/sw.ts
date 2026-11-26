// onlay service worker — signed in to the hosted service, one socket per space.
//
// MV3 terminates this worker constantly, so nothing depends on its memory:
// the token, the person, the spaces and each space's durable session live in
// chrome.storage. Sign-in replaces pairing (spec §4); every space the person
// can see gets its own WebSocket at `/s/<spaceId>/ws` (spec §10); every frame
// relayed to a tab is tagged with its space; page syncs pass the privacy gate
// (sw/gate.ts); the badge is the sum of each space's needs-you count.
import {
  ExtensionTokenResponseSchema,
  InboxResponseSchema,
  LIMITS,
  MeResponseSchema,
  OriginsResponseSchema,
  type Person,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  parseOutbound,
  ShareListResponseSchema,
  type SpaceSummary,
} from "@onlay/protocol";
import { highlightRuns } from "@onlay/render/highlight";
import { scanFlat } from "./overlay/capture/flat";
import { createAccountApi, type Pin } from "./sw/account";
import { attentionAnswer, INBOX_KEY, INBOX_OWNER_KEY, inboxOwner, keptLists } from "./sw/attention";
import { createSignInFlow, type PendingSignIn } from "./sw/auth";
import { createDraftStore, DRAFTS_KEY } from "./sw/drafts";
import { type Box, createFrameLocator, frameTileDraw } from "./sw/frame-look";
import {
  createFrameRelay,
  type FrameRegistry,
  frameCreateRefusal,
  frameMaySync,
  hostUrlFor,
} from "./sw/frames";
import { PAGE_SYNC_TYPES, splitPageSync } from "./sw/gate";
import {
  createAccountGeneration,
  createSignOutMarker,
  SIGN_OUT_PENDING,
  storeThenAnnounce,
} from "./sw/generation";
import { createPictures } from "./sw/pictures";
import { answerPing, isPing } from "./sw/ping";
import { type SenderPorts, senderMayUpload } from "./sw/sender";
import {
  BUILD_SERVER_ORIGIN,
  BUILD_SITE_ORIGIN,
  resolveOrigin,
  resolveSiteOrigin,
  SERVER_ORIGIN_KEY,
  spaceSocketUrl,
  spaceUrl,
  storedTokenUsable,
} from "./sw/server";
import { type KeyValue, nextSession, pruneSessions } from "./sw/sessions";
import { createSpaceSockets } from "./sw/spaces";
import {
  applyOriginsAnswer,
  applyOriginsFrame,
  badgeCount,
  connectedSpaces,
  createGenerationQueue,
  type UpgradeMark,
  upgradeApplies,
  useSpace,
} from "./sw/state";
import {
  base64ToBytes,
  buildEditContextUpload,
  bytesToBase64,
  harvestGuard,
  patternForOrigin,
  type RawPart,
} from "./sw-capture";

const STALE_MS = 30 * 60_000; // amber badge threshold (ADR-0006 §3)

// ---- capture pipeline constants (ADR-0022 §4/§5) ----
const HARVEST_FETCH_TIMEOUT_MS = 5_000; // per-URL cap on the privileged SW fetch
const WITNESS_OVERLAP = 0.1; // stitch overlap band (first-write-wins crop)
const THUMB_MAX_EDGE = 320; // thumbnail longest edge, px
/** The one broad grant the witness raster + harvest need (BLOCKER-1). */
const CAPTURE_ALL_URLS = "<all_urls>";

/** Our chrome.storage.local slice. */
interface LocalState {
  token?: string;
  /** The origin the token was issued by; a different origin means signed out. */
  tokenOrigin?: string;
  person?: Person;
  spaces?: SpaceSummary[];
  [SERVER_ORIGIN_KEY]?: string;
  /** The server at this origin refused this client protocol: the person must update onlay. */
  upgradeRequired?: UpgradeMark;
  /** When the person last picked or posted to each space: who gets the capped sockets. */
  spaceUse?: Record<string, number>;
  bootCount?: number;
  swRestarts?: number;
}

interface InboxRowLike {
  interactionId: string;
  spaceId: string;
  kind: string;
  ts: number;
  url?: string | undefined;
  stakes?: "routine" | "careful" | "dangerous" | undefined;
}
interface InboxLists {
  needsYou: InboxRowLike[];
  waiting: InboxRowLike[];
  recent: InboxRowLike[];
}

let token: string | null = null;
let origin: string = BUILD_SERVER_ORIGIN;
/** The public site, whose pages may ping the extension (never sign it in). */
let siteOrigin: string = BUILD_SITE_ORIGIN;
let spaces: SpaceSummary[] = [];
/** Where the generation is kept, beside the credentials. */
const GENERATION_KEY = "accountGeneration";
const GENERATION_ORIGIN_KEY = "accountGenerationOrigin";
/** Moves on every sign-in, sign-out and origin change: older requests are dropped.
 *  Kept with the credentials, so a restarted worker keeps its number (3b-C4). */
const accountGen = createAccountGeneration({
  load: async () => {
    const l = (await chrome.storage.local.get([GENERATION_KEY, GENERATION_ORIGIN_KEY])) as Record<
      string,
      unknown
    >;
    return { generation: l[GENERATION_KEY], origin: l[GENERATION_ORIGIN_KEY] };
  },
  // One write: the generation and the credentials that change with it (C-4).
  save: (g, o, alongside) =>
    chrome.storage.local.set({ ...alongside, [GENERATION_KEY]: g, [GENERATION_ORIGIN_KEY]: o }),
});
/** The account keys a sign-out clears: written as null beside the generation, then removed. */
const ACCOUNT_KEYS = ["token", "tokenOrigin", "person", "spaces", "spaceUse"] as const;
const SIGNED_OUT: Record<string, null> = Object.fromEntries(ACCOUNT_KEYS.map((k) => [k, null]));
/** A sign-out's write failed: the next start, browser restarts included, writes it again (3-C5). */
const signOutMarker = createSignOutMarker([
  {
    get: (k) => chrome.storage.local.get(k) as Promise<Record<string, unknown>>,
    set: (i) => chrome.storage.local.set(i),
  },
  {
    get: (k) => chrome.storage.session.get(k) as Promise<Record<string, unknown>>,
    set: (i) => chrome.storage.session.set(i),
  },
]);
/** A stored sign-out (or sign-in) owes nothing more: the marker goes in the same write. */
const NO_SIGN_OUT_OWED = { [SIGN_OUT_PENDING]: null };
let generationRestored = false;
let spaceUse: Record<string, number> = {};
/** When `/api/me` last answered (memory: a restarted worker refreshes at boot anyway). */
let lastMeAt = 0;
/** Per space, how many `origins` frames have arrived: an older HTTP answer yields to them. */
const originsSeq: Record<string, number> = {};
/** Per tab, the spaces its open composers write to: their sockets are never dropped. */
const busyByTab = new Map<number, string[]>();

const ME_REFRESH_MS = 5 * 60_000;

/** chrome.storage.local as the session store's port. */
const localKv: KeyValue = {
  get: (keys) => chrome.storage.local.get(keys) as Promise<Record<string, unknown>>,
  set: (items) => chrome.storage.local.set(items),
  remove: (keys) => chrome.storage.local.remove(keys),
};

function log(...args: unknown[]): void {
  console.log(`[onlay-sw ${new Date().toISOString()}]`, ...args);
}

/** Read the credentials into memory; a token from another origin is dropped. */
async function loadCredentials(): Promise<void> {
  const l = (await chrome.storage.local.get([
    "token",
    "tokenOrigin",
    "spaces",
    "spaceUse",
    SERVER_ORIGIN_KEY,
  ])) as LocalState;
  const next = resolveOrigin(l[SERVER_ORIGIN_KEY]);
  // A token is only ever used with the origin that issued it: one with no
  // recorded issuer, or from another server, is discarded — in the same write
  // that moves the generation on for a new origin (C-4).
  const unusable = !!l.token && !storedTokenUsable(l.token, l.tokenOrigin, next);
  const alongside = unusable ? SIGNED_OUT : undefined;
  if (!generationRestored) {
    generationRestored = true;
    await accountGen.restore(next, alongside);
  } else {
    await accountGen.originIs(next, alongside);
  }
  origin = next;
  siteOrigin = resolveSiteOrigin(l[SERVER_ORIGIN_KEY]);
  // A sign-out whose write failed: still signed out, and written again now.
  if (unusable || (await signOutMarker.pending())) {
    await clearAccount();
    return;
  }
  token = l.token ?? null;
  spaces = token ? (l.spaces ?? []) : [];
  spaceUse = token ? (l.spaceUse ?? {}) : {};
}

// ---- boot: count restarts, load credentials, connect ----
const booted = (async () => {
  const sess = (await chrome.storage.session.get("aliveMarker")) as { aliveMarker?: boolean };
  const local = (await chrome.storage.local.get(["bootCount", "swRestarts"])) as LocalState;
  const bootCount = (local.bootCount ?? 0) + 1;
  const swRestarts = (local.swRestarts ?? 0) + (sess.aliveMarker ? 1 : 0);
  await chrome.storage.local.set({ bootCount, swRestarts });
  await chrome.storage.session.set({ aliveMarker: true });
  await loadCredentials();
})();

booted.then(() => start());
chrome.runtime.onInstalled.addListener((details) => {
  void booted.then(async () => {
    // A new version of onlay is a new client protocol: an old refusal is moot.
    if (details.reason === "update" || details.reason === "install") await clearUpgradeRequired();
    start();
  });
});
chrome.runtime.onStartup.addListener(() => void booted.then(() => start()));

chrome.alarms.create("onlay-reconnect-net", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== "onlay-reconnect-net") return;
  void booted.then(() => {
    if (!token) return;
    // Membership changes while every socket stays healthy: re-read it now and then.
    if (spaces.length === 0 || Date.now() - lastMeAt >= ME_REFRESH_MS) void refreshMe();
    sockets.ensure();
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  busyByTab.delete(tabId);
});

// e2e and dev point the extension at another server by writing the override.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[SERVER_ORIGIN_KEY]) return;
  void (async () => {
    await booted;
    const before = origin;
    await loadCredentials();
    if (origin !== before) {
      log(`server origin → ${origin}`);
      // Nothing begun against the old server counts against the new one.
      await signIn.invalidate();
      await clearUpgradeRequired();
      sockets.reconnectAll();
      broadcastStatus();
    }
  })();
});

/** Connect what the stored account allows; refresh the account in the background. */
function start(): void {
  if (!token) {
    setBadge();
    return;
  }
  sockets.sync(spaceIds());
  void refreshMe();
}

/** The spaces holding one of the capped sockets: the most recently used. */
function spaceIds(): string[] {
  return connectedSpaces(
    spaces.map((s) => s.id),
    spaceUse,
    LIMITS.MAX_SPACES_PER_CLIENT,
  );
}

/** Every space the person can see, connected or not. */
function allSpaceIds(): string[] {
  return spaces.map((s) => s.id);
}

function knownSpace(id: unknown): id is string {
  return typeof id === "string" && spaces.some((s) => s.id === id);
}

// ---- HTTP: every call is pinned to the account it started under (sw/account.ts) ----

const account = createAccountApi({
  fetch: (url, init) => fetch(url, init),
  current: () => ({ origin, token, generation: accountGen.current() }),
  signedOut: async (gen) => {
    if (gen === accountGen.current()) await signedOut("401");
  },
  upgradeRequired: (at) => markUpgradeRequired(at),
});

/** One request under the current account. null on a network failure or a stale answer. */
function api(path: string, init: RequestInit = {}, json = false): Promise<Response | null> {
  return account.call(account.pin(), path, init, { json });
}

/** One request and its JSON body, both dropped if the account moved on meanwhile. */
async function apiJson<T>(
  path: string,
  init: RequestInit = {},
  json = false,
): Promise<{ res: Response | null; data: T | null }> {
  const pin = account.pin();
  const res = await account.call(pin, path, init, { json });
  return { res, data: await account.json<T>(pin, res) };
}

function spacePath(spaceId: string, path: string): string {
  return spaceUrl("", spaceId, path);
}

/** A JSON body with no account check (the sign-in redemption has no account yet). */
async function readJson<T>(res: Response | null): Promise<T | null> {
  if (!res?.ok) return null;
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ---- account ----

/**
 * A page or the popup asking for status re-reads the account, so a space made
 * or joined elsewhere (the web app, an invitation) shows up without a restart.
 * The floor only coalesces bursts (every frame of a page asks on load); the
 * status broadcast after a refresh goes out only when the account changed, so
 * the tabs asking again on that broadcast end the round.
 */
const ME_REFRESH_FLOOR_MS = 250;
let meAt = 0;
let meKey = "";

/** `/api/me` → person + spaces; sockets follow the space list; then origins. */
let meInFlight: Promise<void> | null = null;
function refreshMe(): Promise<void> {
  if (meInFlight) return meInFlight;
  meInFlight = (async () => {
    try {
      if (!token) return;
      meAt = Date.now();
      // The answer is applied only if the account it was asked for is still the one signed in.
      const pin = account.pin();
      const data = await account.json<unknown>(pin, await account.call(pin, "/api/me"));
      const parsed = MeResponseSchema.safeParse(data);
      if (!parsed.success || !account.isCurrent(pin)) return;
      lastMeAt = Date.now();
      spaces = parsed.data.spaces;
      await chrome.storage.local.set({ person: parsed.data.person, spaces });
      if (!account.isCurrent(pin)) return;
      await clearUpgradeRequired();
      await pruneSpaceState();
      sockets.sync(spaceIds());
      await refreshOrigins(pin);
      scheduleInboxRefresh();
      const key = JSON.stringify(parsed.data);
      if (key !== meKey) {
        meKey = key;
        broadcastStatus();
      }
    } finally {
      meInFlight = null;
    }
  })();
  return meInFlight;
}

// The origins map is read-modify-write from two sources (HTTP answers and
// `origins` frames): one change at a time.
let originsChain: Promise<unknown> = Promise.resolve();
function serialOrigins(fn: () => Promise<void>): Promise<void> {
  const next = originsChain.then(fn, fn);
  originsChain = next.catch(() => {});
  return next;
}

async function readOrigins(): Promise<Record<string, string[]>> {
  const s = (await chrome.storage.session.get("origins")) as {
    origins?: Record<string, string[]>;
  };
  return s.origins ?? {};
}

/**
 * `/api/origins` under the account `pin` names. Applied per space only where
 * no `origins` frame arrived since the request started; newly included
 * origins re-sync the open tabs there.
 */
async function refreshOrigins(pin: Pin): Promise<void> {
  const seqAtStart = { ...originsSeq };
  const data = await account.json<unknown>(pin, await account.call(pin, "/api/origins"));
  const parsed = OriginsResponseSchema.safeParse(data);
  if (!parsed.success) return;
  await serialOrigins(async () => {
    if (!account.isCurrent(pin)) return;
    const r = applyOriginsAnswer(
      await readOrigins(),
      parsed.data.spaces,
      allSpaceIds(),
      seqAtStart,
      originsSeq,
    );
    await chrome.storage.session.set({ origins: r.next });
    resyncTabs(r.added);
  });
}

/**
 * Frames on newly included origins sync again: the gate now lets that space
 * hear them. Every frame of every tab is told which origins came in and
 * re-syncs only when its own document is on one (a frame's origin is not its
 * tab's), so a block inside another site's frame is found too.
 */
function resyncTabs(added: Record<string, string[]>): void {
  for (const [spaceId, origins] of Object.entries(added)) {
    if (origins.length > 0) void broadcastToTabs({ type: "resync", spaceId, origins });
  }
}

/** Per-space state for spaces the person no longer has. */
async function pruneSpaceState(): Promise<void> {
  const keep = new Set(allSpaceIds());
  const s = (await chrome.storage.session.get(["origins", "needs"])) as {
    origins?: Record<string, string[]>;
    needs?: Record<string, number | null>;
  };
  const pick = <T>(m: Record<string, T> | undefined): Record<string, T> =>
    Object.fromEntries(Object.entries(m ?? {}).filter(([k]) => keep.has(k)));
  await serialOrigins(async () => {
    await chrome.storage.session.set({ origins: pick(await readOrigins()) });
  });
  await chrome.storage.session.set({ needs: pick(s.needs) });
  await pruneSessions(localKv, keep);
  spaceUse = pick(spaceUse);
  await chrome.storage.local.set({ spaceUse });
  // A space that left the list takes its people's pictures with it.
  pictures.retain(keep);
  setBadge();
}

async function clearAccount(): Promise<void> {
  token = null;
  spaces = [];
  spaceUse = {};
  meKey = "";
  // The new generation and the cleared credentials in one write (C-4), then
  // tidied away. Signed out in memory whatever happens; a write that failed is
  // tried again at the next worker start (2-C3).
  const stored = await accountGen.bump(origin, { ...SIGNED_OUT, ...NO_SIGN_OUT_OWED });
  pictures.clear();
  if (stored) await signOutMarker.clear();
  else await signOutMarker.mark();
  // Not when a sign-in has written its own token since.
  if (token === null) await chrome.storage.local.remove([...ACCOUNT_KEYS]).catch(() => {});
  await pruneSessions(localKv, new Set());
  await chrome.storage.session.remove([
    "origins",
    "needs",
    INBOX_KEY,
    INBOX_OWNER_KEY,
    "announcedNeeds",
    "inboxNeedsYou",
    DRAFTS_KEY,
  ]);
}

let signingOut = false;
async function signedOut(why: string): Promise<void> {
  if (signingOut || !token) return;
  signingOut = true;
  try {
    log(`signed out (${why})`);
    sockets.closeAll();
    await clearAccount();
    setBadge();
    broadcastStatus();
  } finally {
    signingOut = false;
  }
}

/** The server at `at` refused this client's protocol (recorded only for the configured origin). */
async function markUpgradeRequired(at: string): Promise<void> {
  if (at !== origin) return;
  const l = (await chrome.storage.local.get("upgradeRequired")) as LocalState;
  if (upgradeApplies(l.upgradeRequired, at, PROTOCOL_VERSION)) return;
  log("server requires a newer onlay");
  const mark: UpgradeMark = { origin: at, protocol: PROTOCOL_VERSION };
  await chrome.storage.local.set({ upgradeRequired: mark });
  broadcastStatus();
}

async function clearUpgradeRequired(): Promise<void> {
  const l = (await chrome.storage.local.get("upgradeRequired")) as LocalState;
  if (l.upgradeRequired !== undefined) await chrome.storage.local.remove("upgradeRequired");
}

/** The refusal applies to this server and this build's protocol. */
async function upgradeActive(): Promise<boolean> {
  const l = (await chrome.storage.local.get("upgradeRequired")) as LocalState;
  return upgradeApplies(l.upgradeRequired, origin, PROTOCOL_VERSION);
}

// ---- sign-in (spec §4) ----

const signIn = createSignInFlow({
  load: async () => {
    const s = (await chrome.storage.session.get("pendingSignIn")) as {
      pendingSignIn?: PendingSignIn;
    };
    return s.pendingSignIn ?? null;
  },
  save: async (pending) => {
    if (pending) await chrome.storage.session.set({ pendingSignIn: pending });
    else await chrome.storage.session.remove("pendingSignIn");
  },
  randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
  now: () => Date.now(),
  origin: async () => {
    await booted;
    return origin;
  },
  extensionId: chrome.runtime.id,
  openTab: async (url) => {
    const tab = await chrome.tabs.create({ url });
    return tab.id;
  },
  redeem: async (at, code, verifier) => {
    try {
      const res = await fetch(`${at}/auth/extension/token`, {
        method: "POST",
        headers: {
          [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
          "content-type": "application/json",
        },
        body: JSON.stringify({ code, verifier }),
      });
      if (res.status === 426) await markUpgradeRequired(at);
      const parsed = ExtensionTokenResponseSchema.safeParse(await readJson<unknown>(res));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  },
  signedIn: async (at, result) => {
    await booted;
    if (at !== origin) return; // the override moved while the tab was open
    // The token and the generation it belongs to in one write (C-4), stored
    // before anything changes in memory or is told to a tab: a failed write
    // fails the sign-in and the person stays signed out (2-C3).
    // Once stored, the sign-in stands: what follows cannot fail it (3-C4).
    await storeThenAnnounce(
      async () => {
        await accountGen.commit(origin, {
          token: result.token,
          tokenOrigin: at,
          person: result.person,
          ...NO_SIGN_OUT_OWED,
        });
        token = result.token;
      },
      async () => {
        await signOutMarker.clear();
        await clearUpgradeRequired();
        // Drafts kept for whoever was signed in before go now.
        await drafts.check().catch(() => {});
        log("signed in");
        broadcastStatus();
        await refreshMe();
      },
    );
  },
});

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  // The web app, or the public site's landing page, asks whether the extension
  // is installed (S-3): the version, nothing else.
  if (isPing(msg)) {
    void booted.then(
      () =>
        sendResponse(
          answerPing(sender, [origin, siteOrigin], chrome.runtime.getManifest().version),
        ),
      () => sendResponse({ ok: false }),
    );
    return true;
  }
  // Anything else is a sign-in hand-off, taken from the server origin alone (sw/auth.ts).
  void signIn.receive(msg, sender).then(
    (r) => {
      if (!r.ok) log(`sign-in message refused: ${r.reason}`);
      sendResponse(r);
    },
    () => sendResponse({ ok: false }),
  );
  return true;
});

async function handleSignOut(sendResponse: (r: unknown) => void): Promise<void> {
  await booted;
  if (token) await api("/auth/logout", { method: "POST", body: "{}" }, true);
  await signedOut("sign out");
  sendResponse({ ok: true });
}

// ---- the sockets ----

const sockets = createSpaceSockets({
  connect: (url, protocols) => new WebSocket(url, protocols) as never,
  urlFor: (spaceId) => spaceSocketUrl(origin, spaceId),
  token: () => token,
  hello: async (spaceId) => {
    const l = (await chrome.storage.local.get(["bootCount", "swRestarts"])) as LocalState;
    // Each space's session under its own key: two opening at once never clobber.
    const session = await nextSession(localKv, spaceId, () => crypto.randomUUID());
    return {
      v: 1,
      type: "hello",
      sessionId: session.sessionId,
      bootCount: l.bootCount ?? 0,
      swRestarts: l.swRestarts ?? 0,
      connects: session.connects,
      protocol: PROTOCOL_VERSION,
    };
  },
  frame: (spaceId, raw) => enqueueFrame(spaceId, raw),
  opened: (spaceId) => {
    log(`space ${spaceId} connected`);
    broadcastStatus();
  },
  closed: (spaceId, code, wasOpen) => {
    log(`space ${spaceId} closed code=${code} wasOpen=${wasOpen}`);
    // A refused handshake hides its status: ask the account route why.
    if (!wasOpen) void refreshMe();
    broadcastStatus();
  },
  upgradeRequired: () => void markUpgradeRequired(origin),
  accessRevoked: (spaceId) => {
    log(`space ${spaceId}: access revoked`);
    spaces = spaces.filter((s) => s.id !== spaceId);
    void chrome.storage.local.set({ spaces }).then(() => pruneSpaceState());
    broadcastToTabs({ type: "space-dropped", spaceId });
    broadcastStatus();
    void refreshMe();
  },
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  random: () => Math.random(),
});

// Frames are processed in arrival order (the per-space counters are
// read-modify-write over storage), each only under the account it arrived for.
const enqueueFrame = (spaceId: string, raw: unknown): void => frameQueue({ spaceId, raw });
const frameQueue = createGenerationQueue<{ spaceId: string; raw: unknown }>(
  () => accountGen.current(),
  ({ spaceId, raw }, current) => handleFrame(spaceId, raw, current),
);

async function handleFrame(
  spaceId: string,
  raw: unknown,
  current: () => boolean = () => true,
): Promise<void> {
  const parsed = parseOutbound(raw);
  if (!parsed.ok) {
    log(`rejected frame from ${spaceId}:`, parsed.reason);
    return;
  }
  const msg = parsed.msg;
  switch (msg.type) {
    case "pong":
      return;
    case "welcome":
      if (msg.needsYouCount !== undefined) await setNeeds(spaceId, msg.needsYouCount);
      return;
    case "directory-updated":
      broadcastToTabs({ type: "directory-updated", spaceId });
      // The people list moved: membership may have too (a new workspace).
      void refreshMe();
      return;
    case "attention":
      // The absolute count; without one the space reads as unknown and the
      // badge takes /api/inbox's full count — never the capped row list.
      await setNeeds(spaceId, msg.needsYouCount ?? null);
      if (!current()) return;
      scheduleInboxRefresh();
      // A push-driven "something changed" for surfaces showing off-page rows.
      broadcastToTabs({ type: "attention-tick", spaceId });
      return;
    case "notify":
      void summon(
        spaceId,
        msg.interactionId,
        `onlay — ${msg.title}`,
        msg.body,
        msg.url,
        msg.stakes,
      );
      return;
    case "interactions-state":
    case "interaction-receipt":
    case "variant-state":
    case "variant-receipt":
      // Overlays filter by the URL/id they own and merge per space.
      broadcastToTabs({ ...msg, spaceId });
      return;
    case "origins": {
      originsSeq[spaceId] = (originsSeq[spaceId] ?? 0) + 1;
      await serialOrigins(async () => {
        if (!current()) return;
        const r = applyOriginsFrame(await readOrigins(), spaceId, msg.origins);
        await chrome.storage.session.set({ origins: r.next });
        resyncTabs(r.added);
      });
      return;
    }
    case "tick":
      scheduleInboxRefresh();
      return;
    case "access-changed": {
      // Part of this person's access here went: every tab re-syncs the space
      // and drops what the fresh snapshots no longer carry. Each change gets
      // the space's next access revision, which every frame learns at once,
      // so the top frame can tell a child's snapshot taken before it (3-F5).
      const got = (await chrome.storage.session.get("accessRevs")) as {
        accessRevs?: Record<string, number>;
      };
      const rev = (got.accessRevs?.[spaceId] ?? 0) + 1;
      await chrome.storage.session.set({
        accessRevs: { ...(got.accessRevs ?? {}), [spaceId]: rev },
      });
      pictures.clear();
      broadcastToTabs({ type: "access-changed", spaceId, rev });
      scheduleInboxRefresh();
      return;
    }
    default:
      // `highlight` and `command` belonged to the removed work queue.
      return;
  }
}

// ---- attention: badge = Σ each space's needs-you; the Inbox reads /api/inbox ----

/** One space's absolute needs-you count; null when a frame left it unknown. */
async function setNeeds(spaceId: string, count: number | null): Promise<void> {
  const s = (await chrome.storage.session.get("needs")) as {
    needs?: Record<string, number | null>;
  };
  await chrome.storage.session.set({ needs: { ...(s.needs ?? {}), [spaceId]: count } });
  setBadge();
}

function setBadge(): void {
  void (async () => {
    const s = (await chrome.storage.session.get([
      "needs",
      INBOX_KEY,
      INBOX_OWNER_KEY,
      "inboxNeedsYou",
    ])) as Record<string, unknown> & {
      needs?: Record<string, number | null>;
      inboxNeedsYou?: number;
    };
    const total = token ? badgeCount(s.needs ?? {}, spaceIds(), s.inboxNeedsYou) : 0;
    const now = Date.now();
    const kept = keptLists<InboxLists>(s, accountGen.current());
    const amber = (kept?.lists.needsYou ?? []).some((r) => now - r.ts > STALE_MS);
    chrome.action.setBadgeText({ text: total > 0 ? String(total) : "" }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: amber ? "#f59e0b" : "#007886" }).catch(() => {});
  })();
}

async function fetchInbox(): Promise<InboxLists | null> {
  if (!token) return null;
  // Whose Inbox this is, as the read begins (sw/attention.ts).
  const generation = accountGen.current();
  const l = (await chrome.storage.local.get(["person"])) as LocalState;
  const read = { generation, personId: l.person?.id ?? null };
  const parsed = InboxResponseSchema.safeParse((await apiJson<unknown>("/api/inbox")).data);
  if (!parsed.success) return null;
  const lists: InboxLists = {
    needsYou: parsed.data.needsYou,
    waiting: parsed.data.waiting,
    recent: parsed.data.recent,
  };
  // The account moved on while it was read: it is not this account's to keep or show.
  const owner = inboxOwner(read, accountGen.current());
  if (!owner) return null;
  await chrome.storage.session.set({
    [INBOX_KEY]: lists,
    [INBOX_OWNER_KEY]: owner,
    inboxNeedsYou: parsed.data.needsYouCount,
  });
  setBadge();
  // Thread headers and pins read it (`getAttention`), so they say what the Inbox says.
  void broadcastToTabs({ type: "attention-updated" });
  return lists;
}

let inboxTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleInboxRefresh(): void {
  if (inboxTimer) return;
  inboxTimer = setTimeout(() => {
    inboxTimer = null;
    void fetchInbox();
  }, 300);
}

async function handleGetInbox(sendResponse: (r: unknown) => void): Promise<void> {
  await booted;
  const fresh = await fetchInbox();
  // The kept copy only while it is this account's (sw/attention.ts).
  const cached = fresh
    ? null
    : keptLists<InboxLists>(
        await chrome.storage.session.get([INBOX_KEY, INBOX_OWNER_KEY]),
        accountGen.current(),
      )?.lists;
  sendResponse({ ok: true, signedIn: Boolean(token), attention: fresh ?? cached ?? null });
}

/**
 * The last Inbox read, from the cache (no server call), as only which threads
 * need the person and which wait: what a thread's header and a pin show. Ids
 * alone, never the rows' text, since every frame of every tab may ask; the
 * answer names the person it was read for, from the one read of lists and
 * owner, and is empty when they are another account's.
 */
async function handleGetAttention(sendResponse: (r: unknown) => void): Promise<void> {
  await booted;
  if (!token) return sendResponse({ ok: true, personId: null, attention: null });
  const stored = await chrome.storage.session.get([INBOX_KEY, INBOX_OWNER_KEY]);
  sendResponse({ ok: true, ...attentionAnswer(stored, accountGen.current()) });
}

// ---- notifications ----

function notificationPriority(stakes?: "routine" | "careful" | "dangerous"): -1 | 1 | 2 {
  if (stakes === "dangerous") return 2;
  if (stakes === "careful") return 1;
  return -1;
}

async function summon(
  spaceId: string,
  id: string,
  title: string,
  message: string,
  url: string | undefined,
  stakes?: "routine" | "careful" | "dangerous",
): Promise<void> {
  await chrome.storage.session.set({
    [`notif:${id}`]: { spaceId, interactionId: id, ...(url !== undefined ? { url } : {}) },
  });
  try {
    await chrome.notifications.create(id, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon128.png"),
      title,
      message,
      priority: notificationPriority(stakes),
    });
  } catch (err) {
    log("notification failed:", err instanceof Error ? err.message : err);
  }
}

chrome.notifications.onClicked.addListener((id) => {
  void (async () => {
    const key = `notif:${id}`;
    const stored = (await chrome.storage.session.get(key)) as Record<
      string,
      { spaceId: string; interactionId: string; url?: string } | undefined
    >;
    const n = stored[key];
    if (n?.url) await focusOrOpen(n.url, n.interactionId);
    else if (n) await openFullView(n.spaceId, n.interactionId);
    chrome.notifications.clear(id).catch(() => {});
  })();
});

function openFullView(spaceId: string, interactionId: string): Promise<unknown> {
  const q = new URLSearchParams({ space: spaceId, id: interactionId });
  return chrome.tabs.create({ url: chrome.runtime.getURL(`interaction.html?${q.toString()}`) });
}

/** Focus an existing tab for `url` (or open one), then reveal the interaction. */
async function focusOrOpen(url: string | undefined, interactionId?: string): Promise<void> {
  if (!url) return;
  const base = url.split("#")[0] ?? url;
  const tabs = await chrome.tabs.query({ url: `${base}*` });
  const existing = tabs[0];
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined)
      await chrome.windows.update(existing.windowId, { focused: true });
    if (interactionId)
      chrome.tabs.sendMessage(existing.id, { type: "reveal", interactionId }).catch(() => {});
    return;
  }
  const created = await chrome.tabs.create({ url });
  if (interactionId && created.id !== undefined) pendingReveals.set(created.id, interactionId);
}

const pendingReveals = new Map<number, string>();
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "complete") return;
  const interactionId = pendingReveals.get(tabId);
  if (!interactionId) return;
  pendingReveals.delete(tabId);
  setTimeout(() => {
    chrome.tabs.sendMessage(tabId, { type: "reveal", interactionId }).catch(() => {});
  }, 400);
});

async function broadcastToTabs(msg: Record<string, unknown>): Promise<void> {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    chrome.tabs.sendMessage(tab.id, msg).catch(() => {
      /* tab without content script (chrome://, store, …) — expected */
    });
  }
}

function broadcastStatus(): void {
  void broadcastToTabs({ type: "status", connected: sockets.anyOpen(), signedIn: Boolean(token) });
}

// ---- content → server: the relay ----
// Every frame carries its own frameUrl (the content script's real
// location.href) and, except the syncs, the `spaceId` it belongs to. The
// spaceId is stripped before the frame goes out.
const RELAY_TYPES = new Set([
  "interaction-create",
  "interaction-reply",
  "interaction-edit",
  "interaction-delete",
  "interaction-react",
  "interaction-resolve",
  "interaction-reopen",
  "interaction-anchor",
  "interaction-reanchor",
  "interaction-anchor-lost",
  "ask-answer",
  "change-batch",
  "interaction-sync",
  "attention-sync",
  "variant-create",
  "variant-cycle",
  "variant-pick",
  "variant-discard",
  "variant-tune",
  "variant-steer",
  "variant-sync",
]);

async function relay(
  msg: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
  sendResponse: (r: unknown) => void,
): Promise<void> {
  await booted;
  const { spaceId, ...frame } = msg;
  const type = String(frame.type);
  if (!token) {
    sendResponse({ ok: false, error: "signed-out" });
    return;
  }
  if (type === "attention-sync") {
    for (const id of spaceIds()) sockets.send(id, frame);
    sendResponse({ ok: true });
    return;
  }
  if (PAGE_SYNC_TYPES.has(type)) {
    // A child frame that owns no blocks (an opaque or addressless document)
    // syncs nothing, whatever its URL says (2-A3).
    if (!frameMaySync(sender, frame.frameUrl)) {
      sendResponse({ ok: false, error: "not-a-page" });
      return;
    }
    const targets = spaceId === undefined ? spaceIds() : knownSpace(spaceId) ? [spaceId] : [];
    const s = (await chrome.storage.session.get("origins")) as {
      origins?: Record<string, string[]>;
    };
    const split = splitPageSync(String(frame.frameUrl ?? ""), targets, s.origins ?? {});
    for (const id of split.relay) sockets.send(id, frame);
    // The gated spaces answer locally: nothing here, so the tab clears them.
    if (type === "interaction-sync" && sender.tab?.id !== undefined) {
      for (const id of split.local) {
        chrome.tabs
          .sendMessage(
            sender.tab.id,
            {
              type: "interactions-state",
              v: 1,
              url: frame.frameUrl,
              interactions: [],
              spaceId: id,
            },
            sender.frameId !== undefined ? { frameId: sender.frameId } : {},
          )
          .catch(() => {});
      }
    }
    sendResponse({ ok: true });
    return;
  }
  if (!knownSpace(spaceId)) {
    sendResponse({ ok: false, error: "no-space" });
    return;
  }
  // A create from a child frame is bound to the frame's own URL; the page the
  // person shares is remembered beside it for display, from the tab's URL as
  // the browser reports it (F-3), never from the message.
  // A variant set from a child frame is created like any interaction there (E-1).
  if (type === "interaction-create" || type === "variant-create") {
    // A child frame that owns no blocks (about:blank, srcdoc, an opaque
    // origin) binds nothing (2-F4); a pick made under another account than
    // the one held right now sends nothing (3-F3).
    const refusal = frameCreateRefusal(sender, frame.pickGeneration, accountGen.current());
    delete frame.pickGeneration;
    if (refusal) {
      sendResponse({ ok: false, error: refusal });
      return;
    }
    delete frame.hostUrl;
    const hostUrl = hostUrlFor(sender);
    if (hostUrl !== undefined) frame.hostUrl = hostUrl;
  }
  // A frame's tray batch carries the account generation its edits were made
  // under, checked like a create's right before it goes (3-E3).
  if (type === "change-batch") {
    const refusal = frameCreateRefusal(sender, frame.pickGeneration, accountGen.current());
    delete frame.pickGeneration;
    if (refusal) {
      sendResponse({ ok: false, error: refusal });
      return;
    }
  }
  // Refused until the space's socket is welcomed: the composer shows it at once.
  if (sockets.send(spaceId, frame)) {
    sendResponse({ ok: true });
    if (type === "interaction-create" || type === "variant-create") noteUse(spaceId);
  } else {
    sendResponse({ ok: false, error: "not-connected" });
    sockets.ensure();
  }
}

/** The person posted to this space: it is the most recently used. */
function noteUse(spaceId: string): void {
  spaceUse = { ...spaceUse, [spaceId]: Date.now() };
  void chrome.storage.local.set({ spaceUse }).catch(() => {});
}

/** The spaces any tab's open composer writes to. */
function busySpaces(): Set<string> {
  return new Set([...busyByTab.values()].flat());
}

/** Unsent text kept across page reloads, in session storage only (D-1). */
const drafts = createDraftStore({
  get: (k) => chrome.storage.session.get(k) as Promise<Record<string, unknown>>,
  set: (i) => chrome.storage.session.set(i),
  remove: (k) => chrome.storage.session.remove(k),
  scope: async () => {
    await booted;
    if (!token) return null;
    const l = (await chrome.storage.local.get(["person"])) as LocalState;
    return l.person ? `${l.person.id}|${origin}` : null;
  },
});

// ---- people's pictures (sw/pictures.ts) ----
const pictures = createPictures({
  get: (path) => api(path),
  // The account's generation and the space's access revision (3-F5).
  scope: async (spaceId) => {
    const generation = accountGen.current();
    if (spaceId === null) return `${generation}|me`;
    const got = (await chrome.storage.session.get("accessRevs")) as {
      accessRevs?: Record<string, number>;
    };
    return `${generation}|${spaceId}:${got.accessRevs?.[spaceId] ?? 0}`;
  },
  hasSpace: (spaceId) => knownSpace(spaceId),
  now: () => Date.now(),
});

// ---- messages from content scripts, the popup, options and the full view ----
// ---- frames of one tab (sw/frames.ts): picks, opens and calls between them ----
const frames = createFrameRelay({
  send: (tabId, msg, to) => chrome.tabs.sendMessage(tabId, msg, to ?? {}),
  load: async () =>
    ((await chrome.storage.session.get("frames")) as { frames?: FrameRegistry }).frames ?? {},
  save: (next) => chrome.storage.session.set({ frames: next }),
  generation: () => accountGen.current(),
});
chrome.tabs.onRemoved.addListener((tabId) => void frames.tabClosed(tabId).catch(() => {}));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading" && info.url !== undefined)
    void frames.tabNavigated(tabId).catch(() => {});
});

// A look of a block inside a child frame (sw/frame-look.ts): the overlay is
// hidden in every frame of the tab for the grab, and the block's place in the
// tab is found frame by frame.
const locator = createFrameLocator({
  send: (tabId, msg, to) => chrome.tabs.sendMessage(tabId, msg, to ?? {}),
  nonce: () => crypto.randomUUID().replace(/-/g, ""),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
});
const HOLD_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Tell every frame of the sender's tab to take or let go of a hold. */
function holdAcrossTab(type: "frame-hold" | "frame-release"): Handler {
  return (m, s, send) => {
    const tabId = s.tab?.id;
    const holdId = typeof m.holdId === "string" ? m.holdId : "";
    if (tabId === undefined || !HOLD_ID.test(holdId)) return send({ ok: false });
    return chrome.tabs.sendMessage(tabId, { type, holdId }).then(
      () => send({ ok: true }),
      () => send({ ok: true }),
    );
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (typeof msg?.type === "string" && RELAY_TYPES.has(msg.type)) {
    void relay(msg, sender, sendResponse);
    return true;
  }
  const framed = typeof msg?.type === "string" ? frames.handle(msg.type, msg, sender) : undefined;
  if (framed) {
    void framed.then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  const handler = HANDLERS[msg?.type as string];
  if (!handler) return false;
  void Promise.resolve(handler(msg, sender, sendResponse)).catch(() => sendResponse({ ok: false }));
  return true;
});

type Handler = (
  msg: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
  sendResponse: (r: unknown) => void,
) => unknown;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** What the upload sender check reads from the browser and the account (R3-C4). */
const senderPorts: SenderPorts = {
  generation: () => accountGen.current(),
  tab: (tabId) =>
    chrome.tabs.get(tabId).then(
      (t) => t ?? null,
      () => null,
    ),
};

const HANDLERS: Record<string, Handler> = {
  getStatus: (_m, _s, send) => handleGetStatus(send),
  drafts: (m, sender, send) => drafts.handle(m, sender).then(send),
  // Syntax colors for a code block (Shiki lives here, never in a page): runs
  // of text and a token kind, which the page checks against its code.
  // A person's picture: Onlay's own copy, fetched here and checked (sw/pictures.ts).
  picture: (m, _s, send) => booted.then(() => pictures.get(m.url, m.held)).then(send),
  highlight: (m, _s, send) =>
    highlightRuns(str(m.lang), str(m.code)).then((runs) =>
      send(runs ? { ok: true, runs } : { ok: false }),
    ),
  // The person picked a space: it gets a socket, past the cap if need be.
  useSpace: async (m, _s, send) => {
    await booted;
    const id = str(m.spaceId);
    if (!token || !knownSpace(id)) return send({ ok: false });
    const r = useSpace(
      allSpaceIds(),
      spaceUse,
      id,
      busySpaces(),
      Date.now(),
      LIMITS.MAX_SPACES_PER_CLIENT,
    );
    if (r.ok) {
      spaceUse = r.used;
      await chrome.storage.local.set({ spaceUse });
      sockets.sync(spaceIds());
      setBadge();
    }
    send({ ok: r.ok });
  },
  spacesInUse: (m, sender, send) => {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      const list = Array.isArray(m.spaces)
        ? m.spaces.filter((x): x is string => typeof x === "string")
        : [];
      if (list.length > 0) busyByTab.set(tabId, list);
      else busyByTab.delete(tabId);
    }
    send({ ok: true });
  },
  signIn: async (_m, _s, send) => {
    await signIn.start();
    send({ ok: true });
  },
  signOut: (_m, _s, send) => handleSignOut(send),
  getInbox: (_m, _s, send) => handleGetInbox(send),
  getAttention: (_m, _s, send) => handleGetAttention(send),
  getDirectory: (m, _s, send) => handleGetDirectory(m, send),
  getInteraction: (m, _s, send) => handleGetInteraction(m, send),
  interactionCall: (m, _s, send) => handleInteractionCall(m, send),
  resnapRequest: (m, _s, send) => handleResnapRequest(m, send),
  getVariantSet: (m, _s, send) => handleGetVariantSet(m, send),
  variantCall: (m, _s, send) => handleVariantCall(m, send),
  getCaptures: (m, _s, send) => handleGetCaptures(m, send),
  getCapturePart: (m, _s, send) => handleGetCapturePart(m, send),
  uploadAnchorContent: (m, sender, send) => handleUploadAnchorContent(m, sender, send),
  uploadPageContent: (m, sender, send) => handleUploadPageContent(m, sender, send),
  captureUpload: (m, sender, send) => handleCaptureUpload(m, sender, send),
  shares: (m, _s, send) => handleShares(m, send),
  queryGrant: (m, _s, send) => handleQueryGrant(m, send),
  harvestFetch: (m, s, send) => handleHarvestFetch(m, s, send),
  witnessGrab: (_m, s, send) => handleWitnessGrab(s, send),
  frameHold: holdAcrossTab("frame-hold"),
  frameRelease: holdAcrossTab("frame-release"),
  frameLocate: (m, s, send) => locator.locate(m, s).then(send),
  frameLocated: (m, s, send) => send(locator.located(m, s)),
  frameEchoed: (m, s, send) => send(locator.echoed(m, s)),
  witnessStitch: (m, _s, send) => handleWitnessStitch(m as never, send),
  // F30: the variant pass's eligibility probe — is this tab the one a grab
  // would raster (active in its window) AND is that window the last-focused
  // one (dedups a multi-window double pass), and is the broad capture grant
  // on (the SAME grant witnessGrab gates on, not the per-origin harvest one)?
  passEligible: async (_m, sender, send) => {
    try {
      const visible = await senderTabIsVisible(sender);
      const granted = await chrome.permissions.contains({ origins: [CAPTURE_ALL_URLS] });
      let focused = true;
      try {
        const win = await chrome.windows.getLastFocused();
        focused = win?.id === sender?.tab?.windowId;
      } catch {
        /* single-window fallbacks stay eligible */
      }
      send({ ok: true, eligible: visible && focused && granted });
    } catch {
      send({ ok: true, eligible: false });
    }
  },
  openSettings: (_m, _s, send) =>
    chrome.runtime.openOptionsPage().then(
      () => send({ ok: true }),
      () => send({ ok: false }),
    ),
  openFullView: (m, _s, send) => {
    const id = str(m.id);
    if (!id || !knownSpace(m.spaceId)) return send({ ok: false });
    return openFullView(m.spaceId, id).then(
      () => send({ ok: true }),
      () => send({ ok: false }),
    );
  },
  openRow: (m, _s, send) => {
    const url = str(m.url);
    if (!url) {
      if (knownSpace(m.spaceId) && str(m.interactionId))
        return openFullView(m.spaceId, str(m.interactionId)).then(() => send({ ok: true }));
      return send({ ok: true });
    }
    return focusOrOpen(url, str(m.interactionId) || undefined).then(
      () => send({ ok: true }),
      () => send({ ok: false }),
    );
  },
};

async function handleGetStatus(send: (r: unknown) => void): Promise<void> {
  await booted;
  const l = (await chrome.storage.local.get(["person"])) as LocalState;
  const revs = (await chrome.storage.session.get("accessRevs")) as {
    accessRevs?: Record<string, number>;
  };
  send({
    signedIn: Boolean(token),
    connected: sockets.anyOpen(),
    person: token ? (l.person ?? null) : null,
    spaces: token ? spaces : [],
    openSpaces: spaceIds().filter((id) => sockets.isOpen(id)),
    serverOrigin: origin,
    // Uploads carry it back; one composed under another account is refused (R3-C4).
    generation: accountGen.current(),
    // Each space's newest access revision (3-F5).
    accessRevs: revs.accessRevs ?? {},
    upgradeRequired: await upgradeActive(),
  });
  if (token) sockets.ensure();
  if (token && Date.now() - meAt > ME_REFRESH_FLOOR_MS) void refreshMe();
}

// ---- by-id HTTP proxies: every path lives under its space (spec §7.1) ----

/** The validated space + id a by-id proxy needs, or null. */
function target(m: Record<string, unknown>): { spaceId: string; id: string } | null {
  const id = str(m.id);
  if (!token || !id || !knownSpace(m.spaceId)) return null;
  return { spaceId: m.spaceId, id };
}

async function handleGetDirectory(
  m: Record<string, unknown>,
  send: (r: unknown) => void,
): Promise<void> {
  await booted;
  if (!token || !knownSpace(m.spaceId)) return send({ ok: false, people: [] });
  const { data } = await apiJson<{ people?: unknown[] }>(spacePath(m.spaceId, "/directory"));
  send({ ok: data !== null, people: data?.people ?? [] });
}

/**
 * Participant-scoped by-id read (ADR-0020): the Inbox's interaction modal and
 * the full-page view render interactions that live on no page from server
 * truth. 404 means not-yours-or-not-there — fail soft.
 */
async function handleGetInteraction(
  m: Record<string, unknown>,
  send: (r: unknown) => void,
): Promise<void> {
  await booted;
  const t = target(m);
  // Signed in, but the space is no longer one of the person's: gone for them (R3-C8).
  if (!t) return send({ ok: false, ...(token && str(m.id) ? { notFound: true } : {}) });
  // `peek`: a read that never pays the "shared with you" debt (automatic recovery).
  const peek = m.peek === true ? "?peek=1" : "";
  const { res, data } = await apiJson<{ interaction?: unknown; kept?: unknown }>(
    spacePath(t.spaceId, `/interaction/${encodeURIComponent(t.id)}${peek}`),
  );
  if (!data) return send({ ok: false, status: res?.status, notFound: res?.status === 404 });
  send({
    ok: true,
    interaction: data.interaction ?? data,
    ...(data.kept !== undefined ? { kept: data.kept } : {}),
  });
}

/** Off-page mutations ride HTTP: rows bound to other pages can't pass the WS URL gate. */
const INTERACTION_CALL_OPS = new Set([
  "reply",
  "edit",
  "delete",
  "react",
  "answer",
  "resolve",
  "reopen",
]);

async function handleInteractionCall(
  m: Record<string, unknown>,
  send: (r: unknown) => void,
): Promise<void> {
  await booted;
  const t = target(m);
  const op = str(m.op);
  if (!t || !INTERACTION_CALL_OPS.has(op)) return send({ ok: false });
  const res = await api(
    spacePath(t.spaceId, `/interaction/${encodeURIComponent(t.id)}/${op}`),
    { method: "POST", body: JSON.stringify(m.body ?? {}) },
    true,
  );
  send({ ok: res?.ok === true, status: res?.status });
}

/** Request a fresh look (Stage 2 §2.5) through the space's resnap route. */
async function handleResnapRequest(
  m: Record<string, unknown>,
  send: (r: unknown) => void,
): Promise<void> {
  await booted;
  const t = target(m);
  if (!t) return send({ ok: false });
  const res = await api(
    spacePath(t.spaceId, `/interaction/${encodeURIComponent(t.id)}/resnap`),
    { method: "POST", body: "{}" },
    true,
  );
  const data = (await res?.json().catch(() => ({}))) as Record<string, unknown> | undefined;
  send({ ok: res?.ok === true && data?.ok !== false, status: res?.status, ...(data ?? {}) });
}

/**
 * Variant-set read. Without a space (a reload bookmark knows only the set id)
 * each space is asked in turn; the first that holds it answers.
 */
async function handleGetVariantSet(
  m: Record<string, unknown>,
  send: (r: unknown) => void,
): Promise<void> {
  await booted;
  const id = str(m.id);
  if (!token || !id) return send({ ok: false });
  const candidates = knownSpace(m.spaceId) ? [m.spaceId] : spaceIds();
  for (const spaceId of candidates) {
    const { data } = await apiJson<{ set?: unknown }>(
      spacePath(spaceId, `/variant-set/${encodeURIComponent(id)}`),
    );
    if (data) return send({ ok: true, spaceId, set: data.set ?? data });
  }
  send({ ok: false });
}

/** Pick / Discard from page contexts with no WS URL binding (the full view). */
const VARIANT_CALL_OPS = new Set(["pick", "discard"]);

async function handleVariantCall(
  m: Record<string, unknown>,
  send: (r: unknown) => void,
): Promise<void> {
  await booted;
  const t = target(m);
  const op = str(m.op);
  if (!t || !VARIANT_CALL_OPS.has(op)) return send({ ok: false });
  const res = await api(
    spacePath(t.spaceId, `/variant-set/${encodeURIComponent(t.id)}/${op}`),
    { method: "POST", body: JSON.stringify(m.body ?? {}) },
    true,
  );
  send({ ok: res?.ok === true, status: res?.status });
}

async function handleGetCaptures(
  m: Record<string, unknown>,
  send: (r: unknown) => void,
): Promise<void> {
  await booted;
  const t = target(m);
  if (!t) return send({ ok: false });
  const { res, data } = await apiJson<{ captures?: unknown }>(
    spacePath(t.spaceId, `/interaction/${encodeURIComponent(t.id)}/captures`),
  );
  if (!data) return send({ ok: false, status: res?.status });
  send({ ok: true, captures: data.captures ?? [] });
}

/**
 * One attachment part's bytes, handed back as base64: a runtime message is
 * JSON with no transferables, and an MV3 worker has no createObjectURL. The
 * page decodes it and types the Blob from the echoed mime.
 */
async function handleGetCapturePart(
  m: Record<string, unknown>,
  send: (r: unknown) => void,
): Promise<void> {
  await booted;
  const t = target(m);
  const captureId = str(m.captureId);
  const name = str(m.name);
  const mime = str(m.mime) || "application/octet-stream";
  if (!t || !captureId || !name) return send({ ok: false });
  const res = await api(
    spacePath(
      t.spaceId,
      `/interaction/${encodeURIComponent(t.id)}/capture/${encodeURIComponent(captureId)}/part/${encodeURIComponent(name)}`,
    ),
  );
  if (!res?.ok) return send({ ok: false, status: res?.status });
  const bytes = new Uint8Array(await res.arrayBuffer());
  send({ ok: true, b64: bytesToBase64(bytes), mime });
}

/** Upload a captured block (ADR-0017 §1). Fail-soft: the overlay only toasts. */
async function handleUploadAnchorContent(
  m: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
  send: (r: unknown) => void,
): Promise<void> {
  await booted;
  const t = target({ spaceId: m.spaceId, id: m.interactionId });
  if (!t) return send({ ok: false, error: "no-interaction" });
  if (!(await senderMayUpload(m, sender, senderPorts))) return send({ ok: false, error: "sender" });
  const res = await api(
    spacePath(t.spaceId, `/interaction/${encodeURIComponent(t.id)}/anchor-content`),
    {
      method: "POST",
      body: JSON.stringify({
        content: String(m.content ?? ""),
        format: "html",
        truncated: m.truncated === true,
      }),
    },
    true,
  );
  send(res?.ok ? { ok: true } : { ok: false, error: res ? `HTTP ${res.status}` : "network error" });
}

/**
 * Upload a page edit's sanitized body (spec §8), write-once on the server:
 * `POST /s/<spaceId>/interaction/<id>/page-content {content, format, truncated}`.
 */
async function handleUploadPageContent(
  m: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
  send: (r: unknown) => void,
): Promise<void> {
  await booted;
  const t = target({ spaceId: m.spaceId, id: m.interactionId });
  if (!t) return send({ ok: false, error: "no-interaction" });
  const content = String(m.content ?? "").slice(0, LIMITS.MAX_PAGE_CONTENT);
  if (!(await senderMayUpload(m, sender, senderPorts))) return send({ ok: false, error: "sender" });
  const res = await api(
    spacePath(t.spaceId, `/interaction/${encodeURIComponent(t.id)}/page-content`),
    {
      method: "POST",
      body: JSON.stringify({
        content,
        format: "html",
        truncated: m.truncated === true || content.length < String(m.content ?? "").length,
      }),
    },
    true,
  );
  send(res?.ok ? { ok: true } : { ok: false, error: res ? `HTTP ${res.status}` : "network error" });
}

/**
 * Shares on one interaction (members only, spec §5):
 * `GET|POST /api/spaces/:sid/interactions/:iid/shares`, `DELETE …/shares/:email`.
 */
async function handleShares(m: Record<string, unknown>, send: (r: unknown) => void): Promise<void> {
  await booted;
  const t = target(m);
  if (!t) return send({ ok: false });
  const base = `/api/spaces/${encodeURIComponent(t.spaceId)}/interactions/${encodeURIComponent(t.id)}/shares`;
  const op = str(m.op);
  const email = str(m.email).trim().toLowerCase();
  const pin = account.pin();
  let res: Response | null;
  if (op === "add" && email)
    res = await account.call(
      pin,
      base,
      { method: "POST", body: JSON.stringify({ email }) },
      { json: true },
    );
  else if (op === "remove" && email)
    res = await account.call(pin, `${base}/${encodeURIComponent(email)}`, { method: "DELETE" });
  else if (op === "list") res = await account.call(pin, base);
  else return send({ ok: false });
  if (!res?.ok) {
    const err = (await res?.json().catch(() => null)) as { error?: { message?: string } } | null;
    return send({ ok: false, status: res?.status, message: err?.error?.message });
  }
  if (op !== "list") return send({ ok: true });
  const parsed = ShareListResponseSchema.safeParse(await account.json<unknown>(pin, res));
  send(parsed.success ? { ok: true, shares: parsed.data } : { ok: false });
}
// ═══════════════════════════════════════════════════════════════════════════
// Capture pipeline (ADR-0022 §4/§5/§8) — the privileged boundary. Content
// scripts drive DOM + scrolling; the SW owns cross-origin fetch, tab raster,
// part hashing, and the two-phase upload, because only it holds the host grant,
// `chrome.tabs.*`, and a guaranteed secure context (crypto.subtle).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Reflect a host's grant state to the residue meter (render §3 item 2). Never
 * prompts (no gesture in the SW context) — the ceremony lives in options/popup.
 */
async function handleQueryGrant(
  msg: { origin?: unknown },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  try {
    const origin = typeof msg.origin === "string" ? msg.origin : "";
    if (!origin) {
      sendResponse({ ok: true, granted: false });
      return;
    }
    const granted = await chrome.permissions.contains({ origins: [patternForOrigin(origin)] });
    sendResponse({ ok: true, granted });
  } catch {
    sendResponse({ ok: true, granted: false });
  }
}

/** Streaming, memory-bounded read of a fetch body — aborts past `cap`. */
async function readCappedResponse(res: Response, cap: number): Promise<Uint8Array | null> {
  const body = res.body;
  if (!body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.byteLength > cap ? null : buf;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * The privileged cross-origin fetch leg of the harvest (capture §4). The
 * content script never fetches cross-origin itself; it hands the SW a URL to
 * pull under the host grant. Hardened: grant-checked (port-stripped,
 * host-granularity), private-network-guarded (F7), `credentials:'omit'`,
 * `redirect:'manual'` (a cross-origin redirect yields an opaque response whose
 * hop URL the SW cannot re-validate, so redirects are REFUSED rather than
 * followed blindly — A15's "re-check each hop" is unattainable in-browser),
 * size-capped, timed out, and `{http,https}`-only.
 */
async function handleHarvestFetch(
  msg: { url?: unknown; origin?: unknown; as?: unknown },
  sender: chrome.runtime.MessageSender | undefined,
  sendResponse: (r: unknown) => void,
): Promise<void> {
  try {
    const url = typeof msg.url === "string" ? msg.url : "";
    if (!url) {
      sendResponse({ ok: false, reason: "error" });
      return;
    }
    // Grant check first (host-granularity, port-stripped). The pattern is
    // derived from the URL the SW will actually fetch — NEVER a caller-supplied
    // `msg.origin` (capture §4/F8): trusting the caller's origin would let a
    // message launder an ungranted public host through an unrelated granted one.
    let pattern: string;
    try {
      pattern = patternForOrigin(url);
    } catch {
      sendResponse({ ok: false, reason: "error" });
      return;
    }
    if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
      sendResponse({ ok: false, reason: "declined-grant" });
      return;
    }
    // Private-network guard: derive the page origin from the SENDER (never a
    // caller-supplied field); the server is allowed at its exact origin.
    const pageUrl = sender?.tab?.url ?? sender?.origin ?? undefined;
    const guard = harvestGuard(url, pageUrl, origin);
    if (!guard.ok) {
      sendResponse({ ok: false, reason: "blocked" });
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HARVEST_FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        credentials: "omit",
        redirect: "manual",
        cache: "force-cache",
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    // Opaque redirect (type "opaqueredirect", status 0) or any 3xx → refuse: the
    // hop URL cannot be re-checked against the grant + private-network guard.
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      sendResponse({ ok: false, reason: "blocked" });
      return;
    }
    if (!res.ok) {
      sendResponse({ ok: false, reason: "error" });
      return;
    }
    const bytes = await readCappedResponse(res, LIMITS.MAX_CAPTURE_PART_BYTES);
    if (!bytes) {
      sendResponse({ ok: false, reason: "too-large" });
      return;
    }
    const mime =
      res.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
    sendResponse({ ok: true, b64: bytesToBase64(bytes), mime });
  } catch {
    sendResponse({ ok: false, reason: "error" });
  }
}

/**
 * One witness tile (capture §5). The CONTENT SCRIPT drives scrolling (only it
 * can); the SW just rasters the currently-visible viewport. Requires the broad
 * `<all_urls>` grant specifically — `captureVisibleTab` rejects the http+https
 * pair (PINNED, BLOCKER-1). No scroll data in the request: the SW never scrolls.
 */
/** The sender tab is the one `captureVisibleTab(windowId)` will raster: the
 *  ACTIVE tab of its window. Checked immediately before AND after every grab
 *  (F30 sol-6 TOCTOU) — a tab switch mid-grab discards the raster instead of
 *  committing another tab's pixels as this page's evidence. Pre-F30 grabs were
 *  safe by usage (human gesture in the active tab); the check now makes that
 *  safety structural for every caller. */
async function senderTabIsVisible(
  sender: chrome.runtime.MessageSender | undefined,
): Promise<boolean> {
  const tabId = sender?.tab?.id;
  const windowId = sender?.tab?.windowId;
  if (tabId === undefined || windowId === undefined) return false;
  try {
    const [active] = await chrome.tabs.query({ active: true, windowId });
    if (active?.id !== tabId) return false;
    // Focus can move to ANOTHER window mid-pass — single-window election must
    // hold per grab, not just at pass start.
    try {
      const win = await chrome.windows.getLastFocused();
      return win?.id === windowId;
    } catch {
      return true; // single-window environments
    }
  } catch {
    return false;
  }
}

async function handleWitnessGrab(
  sender: chrome.runtime.MessageSender | undefined,
  sendResponse: (r: unknown) => void,
): Promise<void> {
  try {
    if (!(await chrome.permissions.contains({ origins: [CAPTURE_ALL_URLS] }))) {
      sendResponse({ ok: false, reason: "declined-grant" });
      return;
    }
    if (!(await senderTabIsVisible(sender))) {
      sendResponse({ ok: false, reason: "error" });
      return;
    }
    const windowId = sender?.tab?.windowId;
    const dataUrl =
      windowId !== undefined
        ? await chrome.tabs.captureVisibleTab(windowId, { format: "png" })
        : await chrome.tabs.captureVisibleTab({ format: "png" });
    // Post-grab re-check: a switch DURING the async grab means these pixels
    // may be another tab's — discard, never guess.
    if (!(await senderTabIsVisible(sender))) {
      sendResponse({ ok: false, reason: "error" });
      return;
    }
    const comma = dataUrl.indexOf(",");
    const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    const bmp = await createImageBitmap(new Blob([base64ToBytes(b64)], { type: "image/png" }));
    const w = bmp.width;
    const h = bmp.height;
    bmp.close();
    sendResponse({ ok: true, b64, w, h });
  } catch {
    sendResponse({ ok: false, reason: "error" });
  }
}

/** Encode an OffscreenCanvas to raw bytes of the given type/quality. */
async function encodeCanvas(
  canvas: OffscreenCanvas,
  type: string,
  quality: number,
): Promise<Uint8Array> {
  const blob = await canvas.convertToBlob({ type, quality });
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Composite the grabbed tiles into the final witness raster (capture §5, F5).
 * First-write-wins in every overlap band: tile 0 lands at y=0; each later tile
 * is cropped by its top `OVERLAP × innerHeight` band before pasting, so the
 * EARLIER tile owns the seam (a last-write-wins paste would stamp the newer
 * tile's top-of-viewport chrome — a sticky header — into the page interior).
 * The habitat's x-range is cropped in too. Emits a downscaled thumbnail so
 * Stage 2 needs no re-derive.
 */
async function handleWitnessStitch(
  msg: {
    tiles?: unknown;
    rect?: { x?: number; y?: number; width?: number; height?: number };
    dpr?: unknown;
    scrollX?: unknown;
  },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  try {
    const tiles = Array.isArray(msg.tiles)
      ? (msg.tiles as Array<{ scrollY?: number; b64?: string }>)
      : [];
    const rect = msg.rect;
    const dpr = typeof msg.dpr === "number" && msg.dpr > 0 ? msg.dpr : 1;
    if (tiles.length === 0 || !rect || rect.width === undefined || rect.height === undefined) {
      sendResponse({ ok: false, reason: "error" });
      return;
    }
    const rx = rect.x ?? 0;
    const ry = rect.y ?? 0;
    const scrollX = typeof msg.scrollX === "number" ? msg.scrollX : 0;
    const outW = Math.max(1, Math.round(rect.width * dpr));
    const outH = Math.max(1, Math.round(rect.height * dpr));
    const canvas = new OffscreenCanvas(outW, outH);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      sendResponse({ ok: false, reason: "error" });
      return;
    }
    // A look inside a frame names each tile's proven crop (sw/frame-look.ts):
    // only that is drawn, the later tiles first so the earlier one owns a seam.
    const framed = tiles.some((t) => (t as { crop?: unknown }).crop !== undefined);
    if (framed) {
      for (let i = tiles.length - 1; i >= 0; i -= 1) {
        const t = tiles[i] as { b64?: unknown; crop?: unknown; at?: unknown } | undefined;
        const crop = t?.crop as Box | undefined;
        const at = t?.at as { x: number; y: number } | undefined;
        if (typeof t?.b64 !== "string" || !crop || !at) continue;
        const bmp = await createImageBitmap(
          new Blob([base64ToBytes(t.b64)], { type: "image/png" }),
        );
        const d = frameTileDraw(crop, at, dpr, bmp, { width: outW, height: outH });
        if (d) ctx.drawImage(bmp, d.sx, d.sy, d.sw, d.sh, d.dx, d.dy, d.sw, d.sh);
        bmp.close();
      }
    }
    for (let i = 0; i < (framed ? 0 : tiles.length); i += 1) {
      const t = tiles[i];
      if (!t || typeof t.b64 !== "string") continue;
      const bmp = await createImageBitmap(new Blob([base64ToBytes(t.b64)], { type: "image/png" }));
      const cropTop = i === 0 ? 0 : Math.round(WITNESS_OVERLAP * bmp.height);
      // Source X is the habitat's document-x MINUS the tile's viewport scroll-x
      // (the grab is viewport pixels; x=0 is at scrollX), clamped to the bitmap.
      const sx = Math.max(0, Math.round((rx - scrollX) * dpr));
      const sy = cropTop;
      const sw = Math.min(bmp.width - sx, outW);
      const sh = bmp.height - sy;
      const dy = Math.round(((t.scrollY ?? 0) - ry) * dpr) + cropTop;
      if (sw > 0 && sh > 0) ctx.drawImage(bmp, sx, sy, sw, sh, 0, dy, sw, sh);
      bmp.close();
    }
    // F31 — flat-raster verdict, sampled (a uniform frame at habitat scale is
    // almost always a degenerate grab; the content side may retry on it).
    const flat = scanFlat((y) => ctx.getImageData(0, y, outW, 1).data, outW, outH);

    const witness = await encodeCanvas(canvas, "image/webp", 0.9);

    // Thumbnail — downscale to THUMB_MAX_EDGE longest edge in a fresh canvas.
    let thumb: { b64: string; mime: string; width: number; height: number } | undefined;
    const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(outW, outH));
    const tw = Math.max(1, Math.round(outW * scale));
    const th = Math.max(1, Math.round(outH * scale));
    const thumbCanvas = new OffscreenCanvas(tw, th);
    const tctx = thumbCanvas.getContext("2d");
    if (tctx) {
      tctx.drawImage(canvas, 0, 0, tw, th);
      const thumbBytes = await encodeCanvas(thumbCanvas, "image/webp", 0.7);
      thumb = { b64: bytesToBase64(thumbBytes), mime: "image/webp", width: tw, height: th };
    }

    sendResponse({
      ok: true,
      b64: bytesToBase64(witness),
      mime: "image/webp",
      width: outW,
      height: outH,
      ...(flat ? { flat: true } : {}),
      ...(thumb ? { thumb } : {}),
    });
  } catch {
    sendResponse({ ok: false, reason: "error" });
  }
}

/** The refusal's machine reason: errors are `{error: {code, message, reason?}}` (spec §5). */
async function errorReason(res: Response): Promise<string | undefined> {
  const body = (await res.json().catch(() => null)) as { error?: { reason?: unknown } } | null;
  return typeof body?.error?.reason === "string" ? body.error.reason : undefined;
}

/**
 * The two-phase capture upload (capture §8/A16). The content script hands
 * the SW the manifest SHAPE (part roles/mimes + raw bytes as base64) and the
 * un-hashed source string; the SW computes each part's sha256 + the bounded
 * `meta.targetKey` here (crypto.subtle is undefined on an insecure-context
 * page), then drives init → PUT-missing → commit under the space's routes.
 * Bytes ride HTTP, never a WS frame. Fully fail-soft.
 */
async function handleCaptureUpload(
  msg: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
  sendResponse: (r: unknown) => void,
): Promise<void> {
  try {
    await booted;
    if (!token) {
      sendResponse({ ok: false, reason: "signed-out" });
      return;
    }
    // The server and token this upload started under, together, for every phase.
    const pin = account.pin();
    const t = target({ spaceId: msg.spaceId, id: msg.id });
    if (!t) {
      sendResponse({ ok: false, reason: "no-interaction-id" });
      return;
    }
    const rawIn = Array.isArray(msg.parts)
      ? (msg.parts as Array<{ name?: string; role?: RawPart["role"]; mime?: string; b64?: string }>)
      : [];
    const parts: RawPart[] = rawIn
      .filter((p) => typeof p.b64 === "string" && typeof p.name === "string" && p.role)
      .map((p) => ({
        name: String(p.name),
        role: p.role as RawPart["role"],
        mime: typeof p.mime === "string" ? p.mime : "application/octet-stream",
        bytes: base64ToBytes(String(p.b64)),
      }));
    if (parts.length === 0) {
      sendResponse({ ok: false, reason: "no-parts" });
      return;
    }
    const metaObj =
      msg.meta && typeof msg.meta === "object" ? (msg.meta as Record<string, unknown>) : undefined;
    const targetKeyRaw = typeof msg.targetKeyRaw === "string" ? msg.targetKeyRaw : undefined;
    // The kind rides the manifest so the server routes it to the right lineage
    // (§1.3); an unrecognized value falls back to the edit-context default.
    const kind = msg.kind === "snapshot" || msg.kind === "variant-look" ? msg.kind : "edit-context";
    const { manifest, bytesBySha } = await buildEditContextUpload({
      kind,
      format: typeof msg.format === "string" ? msg.format : "onlay-cap/1",
      parts,
      ...(metaObj ? { meta: metaObj } : {}),
      ...(targetKeyRaw !== undefined ? { targetKeyRaw } : {}),
    });

    const base = spacePath(t.spaceId, `/interaction/${encodeURIComponent(t.id)}`);
    const timeoutMs = LIMITS.CAPTURE_UPLOAD_TIMEOUT_MS;
    // The account moved on (sign-out, another person, another server): stop here.
    const cancelled = (): boolean => {
      if (account.isCurrent(pin)) return false;
      sendResponse({ ok: false, reason: "account-changed" });
      return true;
    };

    // The last check before the first byte leaves: this tab, this document,
    // this page, this account (R3-C4).
    if (!account.isCurrent(pin) || !(await senderMayUpload(msg, sender, senderPorts))) {
      sendResponse({ ok: false, reason: "sender" });
      return;
    }
    // Phase 1 — init the manifest; server replies { captureId, missing: [sha…] }.
    const initRes = await account.call(
      pin,
      `${base}/capture`,
      { method: "POST", body: JSON.stringify(manifest) },
      { json: true, timeoutMs },
    );
    if (!initRes) {
      if (!cancelled()) sendResponse({ ok: false, reason: "init" });
      return;
    }
    if (!initRes.ok) {
      const serverReason = await errorReason(initRes);
      sendResponse({
        ok: false,
        reason: "init",
        status: initRes.status,
        ...(serverReason ? { serverReason } : {}),
      });
      return;
    }
    const init = (await initRes.json()) as { captureId?: string; missing?: string[] };
    const captureId = init.captureId;
    if (!captureId) {
      sendResponse({ ok: false, reason: "init" });
      return;
    }

    // Phase 2 — PUT each missing part's raw bytes (dedup: present shas absent).
    const missing = new Set(init.missing ?? []);
    for (const part of manifest.parts) {
      if (!missing.has(part.sha256)) continue;
      missing.delete(part.sha256); // a shared sha is uploaded once
      const bytes = bytesBySha.get(part.sha256);
      if (!bytes) continue;
      const putRes = await account.call(
        pin,
        `${base}/capture/${encodeURIComponent(captureId)}/part/${encodeURIComponent(part.name)}`,
        { method: "PUT", body: bytes as BodyInit },
        { timeoutMs },
      );
      if (!putRes) {
        if (!cancelled()) sendResponse({ ok: false, reason: "part" });
        return;
      }
      if (!putRes.ok) {
        // Surface the server's reason (the staged-byte quota can refuse HERE, not
        // only at commit) so a storage-cap PUT refusal still reaches the §3 toast.
        const serverReason = await errorReason(putRes);
        sendResponse({
          ok: false,
          reason: "part",
          status: putRes.status,
          ...(serverReason ? { serverReason } : {}),
        });
        return;
      }
    }

    // Phase 3 — commit; server validates possession/quota/series-cap + broadcasts.
    const commitRes = await account.call(
      pin,
      `${base}/capture/${encodeURIComponent(captureId)}/commit`,
      { method: "POST", body: "{}" },
      { json: true, timeoutMs },
    );
    if (!commitRes) {
      if (!cancelled()) sendResponse({ ok: false, reason: "commit" });
      return;
    }
    if (!commitRes.ok) {
      const serverReason = await errorReason(commitRes);
      sendResponse({
        ok: false,
        reason: "commit",
        status: commitRes.status,
        ...(serverReason ? { serverReason } : {}),
      });
      return;
    }
    const commit = (await commitRes.json()) as { capture?: unknown };
    sendResponse({ ok: true, captureId, capture: commit.capture ?? null });
  } catch {
    sendResponse({ ok: false, reason: "error" });
  }
}
