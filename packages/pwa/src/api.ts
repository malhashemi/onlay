// The data allowlist: ONE exported function per server route the web app uses
// (free functions over an `ApiClient`). Paths are built only from server-issued
// ids the router already shape-checked (space ids, interaction ids) and, for
// a query, an encoded value — never from free text.
//
// Auth is the session cookie on the same origin (spec §4): every request is
// same-origin with `credentials: "same-origin"`, names its protocol in
// `Onlay-Protocol`, and every write adds `Onlay-CSRF: 1`. There is no token
// anywhere in this file. A 401 anywhere hands control to `onSignInRequired`
// (sign-out.ts: sign-in at boot, the signed-out screen after); a 426 to `onUpgradeRequired` (the reload
// prompt). Errors arrive as `{error: {code, message}}` (one table, spec §5);
// a failed call carries the code and the server's sentence so screens can
// show it.
//
// Successful GETs write through to the person's read cache; on a network
// failure the caller gets the cached copy and shows the offline banner. No
// mutation is ever queued.
//
// One tab, one person: every request names the person this tab booted as in
// `Onlay-Person`, and the server refuses (401, reason `person-changed`) when
// the cookie now belongs to someone else. On that answer the tab drops every
// in-flight result and starts over (`onPersonChanged`); a read is cached only
// under the person it was asked — and verified — for.
import {
  type AdminSettingsPutRequest,
  type AdminSettingsResponse,
  AdminSettingsResponseSchema,
  type AgentWorkListing,
  AgentWorkListingSchema,
  API_ERROR_STATUS,
  type ApiErrorCode,
  ApiErrorSchema,
  CSRF_HEADER,
  type InboxResponse,
  InboxResponseSchema,
  type InvitationCreateResponse,
  InvitationCreateResponseSchema,
  type KeptEdit,
  type MemberRole,
  type MeResponse,
  MeResponseSchema,
  type PersonSummary,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  type RawInteractionSnapshot,
  type RawRichText,
  type ShareListResponse,
  ShareListResponseSchema,
  SignOutResponseSchema,
  type WorkspaceCreateResponse,
  WorkspaceCreateResponseSchema,
  type WorkspaceResponse,
  WorkspaceResponseSchema,
} from "@onlay/protocol";
import type { Store } from "./store";

/** What every call needs: the cache, whose partition, and the two exits. */
export interface ApiClient {
  store: Store;
  /** The signed-in person; keys the read cache and rides `Onlay-Person`. Empty before `/api/me`. */
  personId: string;
  /** A 401 from any route: the session is gone (sign-out.ts decides what the tab does). */
  onSignInRequired(): void;
  /** The cookie belongs to another person now: drop everything and start over. */
  onPersonChanged?(): void;
  /** Set once the person changed: no result is applied or cached after it. */
  personChanged?: boolean;
  /** A 426: this build is older than the server accepts. */
  onUpgradeRequired(): void;
  /** Injected in tests; production uses the global fetch. */
  fetchFn?: typeof fetch;
}

/** How a screen should draw a failure: `hidden` is the one "not here" screen
 *  (missing and unreadable are the same answer), `offline` the banner,
 *  `refused` a sentence from the server, `error` a calm Retry. */
export type FetchVerdict = "hidden" | "offline" | "refused" | "error";

export interface Fail {
  ok: false;
  verdict: FetchVerdict;
  status: number;
  code?: ApiErrorCode;
  /** The server's sentence, when it sent one. */
  message?: string;
}

export type Result<T> = { ok: true; data: T; fromCache: boolean; syncedAt?: number } | Fail;

/** A response schema: anything with zod's `safeParse`. */
interface Schema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false };
}

const CODE_BY_STATUS = new Map<number, ApiErrorCode>(
  (Object.entries(API_ERROR_STATUS) as [ApiErrorCode, number][])
    // `conflict` and `last_admin` share 409; the status alone says conflict.
    .filter(([code]) => code !== "last_admin")
    .map(([code, status]) => [status, code]),
);

/** Map a non-2xx response to its failure: the body's code when it carries
 *  one (the error table), else the code its status implies. */
export function failureOf(status: number, body: unknown): Fail {
  const parsed = ApiErrorSchema.safeParse(body);
  const code = parsed.success ? parsed.data.error.code : CODE_BY_STATUS.get(status);
  const verdict: FetchVerdict =
    code === "not_found"
      ? "hidden"
      : code === "forbidden" ||
          code === "conflict" ||
          code === "last_admin" ||
          code === "invalid" ||
          code === "rate_limited"
        ? "refused"
        : "error";
  return {
    ok: false,
    verdict,
    status,
    ...(code ? { code } : {}),
    ...(parsed.success ? { message: parsed.data.error.message } : {}),
  };
}

function offline(): Fail {
  return { ok: false, verdict: "offline", status: 0 };
}

/** The header naming the person a request is made as (the server checks it against the cookie). */
export const PERSON_HEADER = "Onlay-Person";

/** The headers every request carries; writes add the CSRF marker. */
function headersFor(method: string, json: boolean, personId = ""): Record<string, string> {
  const h: Record<string, string> = { [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) };
  if (personId) h[PERSON_HEADER] = personId;
  if (method !== "GET" && method !== "HEAD") h[CSRF_HEADER] = "1";
  if (json) h["Content-Type"] = "application/json";
  return h;
}

/** Canonical cache key: path + sorted query. */
function cacheKey(url: string): string {
  const u = new URL(url, "http://x");
  const sorted = [...u.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const qs = new URLSearchParams(sorted).toString();
  return qs ? `${u.pathname}?${qs}` : u.pathname;
}

/** The answer arrived for a person this tab no longer is: never applied, never cached. */
const DROPPED = "dropped";

/** The person this tab is still the person `who` the request went out as. */
function stillFor(c: ApiClient, who: string): boolean {
  return c.personChanged !== true && c.personId === who;
}

async function personChanged(res: Response): Promise<boolean> {
  try {
    const body = (await res.clone().json()) as { error?: { reason?: unknown } } | null;
    return body?.error?.reason === "person-changed";
  } catch {
    return false;
  }
}

async function raw(
  c: ApiClient,
  path: string,
  method: string,
  body?: BodyInit,
  contentType?: string,
): Promise<Response | null | typeof DROPPED> {
  if (c.personChanged) return DROPPED;
  const who = c.personId;
  const headers = headersFor(method, false, who);
  if (contentType) headers["Content-Type"] = contentType;
  let res: Response;
  try {
    res = await (c.fetchFn ?? fetch)(path, {
      method,
      headers,
      credentials: "same-origin",
      ...(body !== undefined ? { body } : {}),
    });
  } catch {
    return stillFor(c, who) ? null : DROPPED;
  }
  if (res.status === 401 && (await personChanged(res))) {
    c.personChanged = true;
    c.onPersonChanged?.();
    return DROPPED;
  }
  if (!stillFor(c, who)) return DROPPED;
  if (res.status === 401) c.onSignInRequired();
  else if (res.status === 426) c.onUpgradeRequired();
  return res;
}

function dropped(): Fail {
  return { ok: false, verdict: "error", status: 0 };
}

async function bodyOf(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function getJson<T>(c: ApiClient, path: string, schema?: Schema<T>): Promise<Result<T>> {
  const key = cacheKey(path);
  const who = c.personId;
  const res = await raw(c, path, "GET");
  if (res === DROPPED) return dropped();
  if (!res) {
    const cached = who ? await c.store.getRead(who, key) : null;
    if (cached)
      return { ok: true, data: cached.value as T, fromCache: true, syncedAt: cached.syncedAt };
    return offline();
  }
  const body = await bodyOf(res);
  if (!res.ok) return failureOf(res.status, body);
  let data = body as T;
  if (schema) {
    const parsed = schema.safeParse(body);
    if (!parsed.success) return { ok: false, verdict: "error", status: res.status };
    data = parsed.data;
  }
  // Cached only under the person this read went out as, if the tab still is them.
  if (!stillFor(c, who)) return dropped();
  const now = Date.now();
  if (who) await c.store.putRead(who, key, data, now);
  return { ok: true, data, fromCache: false, syncedAt: now };
}

async function send<T>(
  c: ApiClient,
  path: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  payload?: unknown,
  schema?: Schema<T>,
): Promise<Result<T>> {
  const res = await raw(
    c,
    path,
    method,
    payload !== undefined ? JSON.stringify(payload) : undefined,
    payload !== undefined ? "application/json" : undefined,
  );
  if (res === DROPPED) return dropped();
  if (!res) return offline();
  const body = await bodyOf(res);
  if (!res.ok) return failureOf(res.status, body);
  if (schema) {
    const parsed = schema.safeParse(body);
    if (!parsed.success) return { ok: false, verdict: "error", status: res.status };
    return { ok: true, data: parsed.data, fromCache: false };
  }
  return { ok: true, data: body as T, fromCache: false };
}

const enc = encodeURIComponent;

/* ── sign-in (spec §4) ─────────────────────────────────────────────── */

export function logout(c: ApiClient): Promise<Result<unknown>> {
  return send(c, "/auth/logout", "POST");
}

export function logoutEverywhere(c: ApiClient): Promise<Result<unknown>> {
  return send(c, "/auth/logout-everywhere", "POST");
}

/**
 * Where a sign-out's answer sends the browser next: AuthKit's logout, which
 * ends the sign-in itself so the next visit asks who you are, when the server
 * named one (`{signOutUrl}`, an http(s) address); null for a 204 (a session
 * that never came from AuthKit) or anything else.
 */
export function signOutUrlOf(res: Result<unknown>): string | null {
  if (!res.ok) return null;
  const parsed = SignOutResponseSchema.safeParse(res.data);
  return parsed.success ? parsed.data.signOutUrl : null;
}

/* ── the person (spec §5) ──────────────────────────────────────────── */

export function me(c: ApiClient): Promise<Result<MeResponse>> {
  return getJson(c, "/api/me", MeResponseSchema);
}

export function rename(c: ApiClient, name: string): Promise<Result<unknown>> {
  return send(c, "/api/me", "PATCH", { name });
}

/** Which picture shows: the sign-in provider's, or initials (either forgets an upload). */
export function choosePicture(
  c: ApiClient,
  picture: "provider" | "none",
): Promise<Result<unknown>> {
  return send(c, "/api/me", "PATCH", { picture });
}

/** The person's own picture: the image's bytes, already resized by the browser. */
export async function uploadPicture(c: ApiClient, image: Blob): Promise<Result<unknown>> {
  const res = await raw(c, "/api/me/picture", "PUT", image, image.type || "image/png");
  if (res === DROPPED) return dropped();
  if (!res) return offline();
  const body = await bodyOf(res);
  if (!res.ok) return failureOf(res.status, body);
  return { ok: true, data: body, fromCache: false };
}

export function deleteAccount(c: ApiClient, confirm: string): Promise<Result<unknown>> {
  return send(c, "/api/me", "DELETE", { confirm });
}

export function inbox(c: ApiClient): Promise<Result<InboxResponse>> {
  return getJson(c, "/api/inbox", InboxResponseSchema);
}

/* ── workspaces ────────────────────────────────────────────────────── */

export function createWorkspace(
  c: ApiClient,
  name: string,
): Promise<Result<WorkspaceCreateResponse>> {
  return send(c, "/api/workspaces", "POST", { name }, WorkspaceCreateResponseSchema);
}

export function workspace(c: ApiClient, spaceId: string): Promise<Result<WorkspaceResponse>> {
  return getJson(c, `/api/workspaces/${spaceId}`, WorkspaceResponseSchema);
}

export function renameWorkspace(
  c: ApiClient,
  spaceId: string,
  name: string,
): Promise<Result<unknown>> {
  return send(c, `/api/workspaces/${spaceId}`, "PATCH", { name });
}

export function deleteWorkspace(
  c: ApiClient,
  spaceId: string,
  confirm: string,
): Promise<Result<unknown>> {
  return send(c, `/api/workspaces/${spaceId}`, "DELETE", { confirm });
}

export function invite(
  c: ApiClient,
  spaceId: string,
  email: string,
): Promise<Result<InvitationCreateResponse>> {
  return send(
    c,
    `/api/workspaces/${spaceId}/invitations`,
    "POST",
    { email },
    InvitationCreateResponseSchema,
  );
}

export function cancelInvitation(
  c: ApiClient,
  spaceId: string,
  email: string,
): Promise<Result<unknown>> {
  return send(c, `/api/workspaces/${spaceId}/invitations/${enc(email)}`, "DELETE");
}

export function setMemberRole(
  c: ApiClient,
  spaceId: string,
  personId: string,
  role: MemberRole,
): Promise<Result<unknown>> {
  return send(c, `/api/workspaces/${spaceId}/members/${personId}`, "PATCH", { role });
}

/** Remove a member, or — with your own id — leave the workspace. */
export function removeMember(
  c: ApiClient,
  spaceId: string,
  personId: string,
): Promise<Result<unknown>> {
  return send(c, `/api/workspaces/${spaceId}/members/${personId}`, "DELETE");
}

/* ── deployment administration (super admins) ──────────────────────── */

export function adminSettings(c: ApiClient): Promise<Result<AdminSettingsResponse>> {
  return getJson(c, "/api/admin/settings", AdminSettingsResponseSchema);
}

export function putAdminSettings(
  c: ApiClient,
  settings: AdminSettingsPutRequest,
): Promise<Result<unknown>> {
  return send(c, "/api/admin/settings", "PUT", settings);
}

export function addSuperAdmin(c: ApiClient, email: string): Promise<Result<unknown>> {
  return send(c, "/api/admin/super-admins", "POST", { email });
}

export function removeSuperAdmin(c: ApiClient, personId: string): Promise<Result<unknown>> {
  return send(c, `/api/admin/super-admins/${personId}`, "DELETE");
}

/* ── shares ────────────────────────────────────────────────────────── */

export function shares(
  c: ApiClient,
  spaceId: string,
  id: string,
): Promise<Result<ShareListResponse>> {
  return getJson(c, `/api/spaces/${spaceId}/interactions/${id}/shares`, ShareListResponseSchema);
}

export function addShare(
  c: ApiClient,
  spaceId: string,
  id: string,
  email: string,
): Promise<Result<unknown>> {
  return send(c, `/api/spaces/${spaceId}/interactions/${id}/shares`, "POST", { email });
}

export function removeShare(
  c: ApiClient,
  spaceId: string,
  id: string,
  email: string,
): Promise<Result<unknown>> {
  return send(c, `/api/spaces/${spaceId}/interactions/${id}/shares/${enc(email)}`, "DELETE");
}

/* ── space routes (spec §7.1: `/s/<spaceId><path>`) ────────────────── */

export interface VariantSummary {
  variantId: string;
  label?: string;
  program: unknown;
  version?: number;
  agent?: boolean;
}

export interface VariantSetSummary {
  setId: string;
  status?: string;
  outcome?: string;
  activeIndex?: number;
  pickedVariantId?: string;
  changeInteractionId?: string;
  variants: VariantSummary[];
}

/** The by-id read: the snapshot (its captures and agentWork ride on it) and,
 *  for a kept Edit, its kept entry. */
export interface InteractionRead {
  interaction: RawInteractionSnapshot;
  kept?: KeptEdit;
}

const sp = (spaceId: string, path: string): string => `/s/${spaceId}${path}`;

export function directory(
  c: ApiClient,
  spaceId: string,
): Promise<Result<{ people: PersonSummary[] }>> {
  return getJson(c, sp(spaceId, "/directory"));
}

export function interaction(
  c: ApiClient,
  spaceId: string,
  id: string,
): Promise<Result<InteractionRead>> {
  return getJson(c, sp(spaceId, `/interaction/${id}`));
}

/** Every interaction the person may see in one space — the search corpus. */
export function interactions(
  c: ApiClient,
  spaceId: string,
): Promise<Result<{ interactions: RawInteractionSnapshot[] }>> {
  return getJson(c, sp(spaceId, "/interaction"));
}

export function agentWork(
  c: ApiClient,
  spaceId: string,
  url: string,
): Promise<Result<AgentWorkListing>> {
  return getJson(c, sp(spaceId, `/agent-work?url=${enc(url)}`), AgentWorkListingSchema);
}

export function variantSet(
  c: ApiClient,
  spaceId: string,
  setId: string,
): Promise<Result<{ set: VariantSetSummary }>> {
  return getJson(c, sp(spaceId, `/variant-set/${setId}`));
}

export function reply(
  c: ApiClient,
  spaceId: string,
  id: string,
  body: RawRichText,
  replyTo?: { msgId: string },
  /** The send's request id: a retry of an unconfirmed send reuses it (M-1). */
  clientId?: string,
): Promise<Result<{ msgId: string }>> {
  return send(c, sp(spaceId, `/interaction/${id}/reply`), "POST", {
    body,
    ...(replyTo ? { replyTo } : {}),
    ...(clientId !== undefined ? { clientId } : {}),
  });
}

/** Edit an OWN thread message — the server refuses everything else. */
export function editMsg(
  c: ApiClient,
  spaceId: string,
  id: string,
  msgId: string,
  body: RawRichText,
): Promise<Result<{ msgId: string }>> {
  return send(c, sp(spaceId, `/interaction/${id}/edit`), "POST", { msgId, body });
}

/** Tombstone an OWN thread message — body empties, structure stays. */
export function deleteMsg(
  c: ApiClient,
  spaceId: string,
  id: string,
  msgId: string,
): Promise<Result<{ msgId: string }>> {
  return send(c, sp(spaceId, `/interaction/${id}/delete`), "POST", { msgId });
}

export function react(
  c: ApiClient,
  spaceId: string,
  id: string,
  msgId: string,
  emoji: string,
  on: boolean,
): Promise<Result<unknown>> {
  return send(c, sp(spaceId, `/interaction/${id}/react`), "POST", { msgId, emoji, on });
}

/** Answer an existing Ask (Asks are hidden from creation, still answerable). */
export function answer(
  c: ApiClient,
  spaceId: string,
  id: string,
  optionIds: string[],
): Promise<Result<{ interactionId: string; state: string }>> {
  return send(c, sp(spaceId, `/interaction/${id}/answer`), "POST", { optionIds });
}

export function resolve(c: ApiClient, spaceId: string, id: string): Promise<Result<unknown>> {
  return send(c, sp(spaceId, `/interaction/${id}/resolve`), "POST");
}

export function reopen(c: ApiClient, spaceId: string, id: string): Promise<Result<unknown>> {
  return send(c, sp(spaceId, `/interaction/${id}/reopen`), "POST");
}

export function resnap(c: ApiClient, spaceId: string, id: string): Promise<Result<unknown>> {
  return send(c, sp(spaceId, `/interaction/${id}/resnap`), "POST");
}

/** Picks the variant shown, by its id and the version previewed (the server refuses a changed one). */
export function pick(
  c: ApiClient,
  spaceId: string,
  setId: string,
  variant: { variantId: string; version: number },
): Promise<Result<unknown>> {
  return send(c, sp(spaceId, `/variant-set/${setId}/pick`), "POST", {
    variantId: variant.variantId,
    version: variant.version,
  });
}

export function discard(c: ApiClient, spaceId: string, setId: string): Promise<Result<unknown>> {
  return send(c, sp(spaceId, `/variant-set/${setId}/discard`), "POST");
}

/** Create an unanchored Comment — the one thing the web app creates. */
export function createComment(
  c: ApiClient,
  spaceId: string,
  body: RawRichText,
): Promise<Result<{ interactionId: string }>> {
  return send(c, sp(spaceId, "/interaction"), "POST", {
    kind: "comment",
    body,
    anchor: { level: "unanchored" },
  });
}

/* ── web push, per space ───────────────────────────────────────────── */

/** The subscribe body is `PushSubscription.toJSON()` verbatim. */
export interface PushSubscriptionJson {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

export function pushConfig(
  c: ApiClient,
  spaceId: string,
): Promise<Result<{ vapidPublicKey: string }>> {
  return getJson(c, sp(spaceId, "/push/config"));
}

/** Upserts the subscription for this session in this space — re-POSTing is safe. */
export function pushSubscribe(
  c: ApiClient,
  spaceId: string,
  sub: PushSubscriptionJson,
): Promise<Result<unknown>> {
  return send(c, sp(spaceId, "/push/subscribe"), "POST", sub);
}

export function pushUnsubscribe(c: ApiClient, spaceId: string): Promise<Result<unknown>> {
  return send(c, sp(spaceId, "/push/unsubscribe"), "POST", {});
}

/* ── capture parts and attachment upload ───────────────────────────── */

/** Fetch a capture part as bytes (the renderer's `fetchPart`, attachment and
 *  look images). Cached read-through for offline reveal unless `persist` is
 *  false (variant rasters stay session-only). */
export async function part(
  c: ApiClient,
  spaceId: string,
  id: string,
  captureId: string,
  name: string,
  opts: { persist?: boolean } = {},
): Promise<Uint8Array | null> {
  const path = sp(spaceId, `/interaction/${id}/capture/${captureId}/part/${name}`);
  const who = c.personId;
  const res = await raw(c, path, "GET");
  if (res === DROPPED) return null;
  if (!res) {
    const cached = who ? await c.store.getRead(who, cacheKey(path)) : null;
    if (cached && Array.isArray(cached.value)) return Uint8Array.from(cached.value as number[]);
    return null;
  }
  if (!res.ok) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!stillFor(c, who)) return null;
  if (opts.persist !== false && who) {
    await c.store.putRead(who, cacheKey(path), [...bytes], Date.now());
  }
  return bytes;
}

export async function captureInit(
  c: ApiClient,
  spaceId: string,
  id: string,
  manifest: unknown,
): Promise<{ captureId: string } | null> {
  const res = await send<{ captureId: string }>(
    c,
    sp(spaceId, `/interaction/${id}/capture`),
    "POST",
    manifest,
  );
  return res.ok ? { captureId: res.data.captureId } : null;
}

export async function capturePutPart(
  c: ApiClient,
  spaceId: string,
  id: string,
  captureId: string,
  name: string,
  bytes: Uint8Array,
  mime: string,
): Promise<boolean> {
  const res = await raw(
    c,
    sp(spaceId, `/interaction/${id}/capture/${captureId}/part/${name}`),
    "PUT",
    bytes as BodyInit,
    mime,
  );
  return res !== DROPPED && res?.ok === true;
}

export async function captureCommit(
  c: ApiClient,
  spaceId: string,
  id: string,
  captureId: string,
): Promise<boolean> {
  const res = await send(
    c,
    sp(spaceId, `/interaction/${id}/capture/${captureId}/commit`),
    "POST",
    {},
  );
  return res.ok;
}
