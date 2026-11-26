/**
 * The directory API (spec §5): `/api/*`. Every route needs a signed-in
 * caller; writes are rate-limited per person.
 */
import {
  AdminSettingsPutRequestSchema,
  type AttentionRow,
  type InboxResponse,
  type InboxRow,
  InvitationCreateRequestSchema,
  LIMITS,
  MAX_PICTURE_BYTES,
  MeDeleteRequestSchema,
  MemberPatchRequestSchema,
  MePatchRequestSchema,
  type MeResponse,
  type OriginsResponse,
  PICTURE_KEY_RE,
  ShareCreateRequestSchema,
  SuperAdminCreateRequestSchema,
  WorkspaceDeleteRequestSchema,
} from "@onlay/protocol";
import * as z from "zod/mini";
import { type SpaceStanding, spacesOf } from "../directory/access";
import type { Later } from "../directory/agent-access";
import { personOf } from "../directory/db";
import { Failure, notFound, signInRequired } from "../directory/failure";
import { deleteAccount, personById, rename } from "../directory/people";
import { choosePicture, pictureByKey, profileOf, uploadPicture } from "../directory/pictures";
import {
  addSuperAdmin,
  isSuperAdmin,
  mayCreateWorkspace,
  readSettings,
  removeSuperAdmin,
  writeSettings,
} from "../directory/settings";
import { createShare, deleteShare, listShares, requireMember } from "../directory/shares";
import {
  createWorkspace,
  deleteWorkspace,
  invite,
  readWorkspace,
  removeMember,
  renameWorkspace,
  setRole,
  uninvite,
} from "../directory/workspaces";
import type { Env } from "../env";
import { readCappedBody } from "../space/body";
import { pictureResponse } from "../space/picture";
import { extensionIds } from "./auth";
import { type Identity, kindOf, resolveCaller } from "./caller";
import { publicSiteOrigin } from "./hosts";
import { clearSessionCookie, INVALID_EMAIL, json, noContent, readBody } from "./http";
import { limit, WRITES_PER_MINUTE } from "./rate";
import { authorizeIn, checkPersonHint, getFromSpace } from "./space";
import { logoutEndpoint } from "./workos";

/** A loose `{name}` body: the workspace name rule gives its own messages. */
const NameBodySchema = z.object({ name: z.string() });

const SUPER_ADMINS_ONLY = "Only super admins can do that.";

type Params = Record<string, string>;
type Handler = (ctx: {
  request: Request;
  env: Env;
  caller: Identity;
  params: Params;
  /** Work for after the response (the request's `waitUntil`). */
  later: Later;
}) => Promise<Response>;

const ROUTES: [method: string, pattern: string, handler: Handler][] = [
  ["GET", "/api/me", me],
  ["PATCH", "/api/me", patchMe],
  ["DELETE", "/api/me", deleteMe],
  ["PUT", "/api/me/picture", putPicture],
  ["GET", "/api/me/picture/:key", getOwnPicture],
  ["GET", "/api/inbox", inbox],
  ["GET", "/api/origins", origins],
  [
    "POST",
    "/api/workspaces",
    async ({ request, env, caller }) => {
      const { name } = await readBody(request, NameBodySchema);
      return json({ space: await createWorkspace(env, caller.person, name) }, { status: 201 });
    },
  ],
  [
    "GET",
    "/api/workspaces/:id",
    async ({ env, caller, params }) =>
      json(await readWorkspace(env.DB, caller.person, params.id ?? "")),
  ],
  [
    "PATCH",
    "/api/workspaces/:id",
    async ({ request, env, caller, params }) => {
      const { name } = await readBody(request, NameBodySchema);
      await renameWorkspace(env, caller.person, params.id ?? "", name);
      return json(await readWorkspace(env.DB, caller.person, params.id ?? ""));
    },
  ],
  [
    "DELETE",
    "/api/workspaces/:id",
    async ({ request, env, caller, params }) => {
      const { confirm } = await readBody(request, WorkspaceDeleteRequestSchema);
      await deleteWorkspace(env, caller.person, params.id ?? "", confirm);
      return noContent();
    },
  ],
  [
    "POST",
    "/api/workspaces/:id/invitations",
    async ({ request, env, caller, params }) => {
      const { email } = await readBody(request, InvitationCreateRequestSchema, {
        email: INVALID_EMAIL,
      });
      return json(await invite(env, caller.person, params.id ?? "", email));
    },
  ],
  [
    "DELETE",
    "/api/workspaces/:id/invitations/:email",
    async ({ env, caller, params }) => {
      await uninvite(env, caller.person, params.id ?? "", params.email ?? "");
      return noContent();
    },
  ],
  [
    "PATCH",
    "/api/workspaces/:id/members/:personId",
    async ({ request, env, caller, params }) => {
      const { role } = await readBody(request, MemberPatchRequestSchema, {
        role: "Choose admin or member.",
      });
      await setRole(env, caller.person, params.id ?? "", params.personId ?? "", role);
      return noContent();
    },
  ],
  [
    "DELETE",
    "/api/workspaces/:id/members/:personId",
    async ({ env, caller, params }) => {
      await removeMember(env, caller.person, params.id ?? "", params.personId ?? "");
      return noContent();
    },
  ],
  [
    "GET",
    "/api/admin/settings",
    async ({ env, caller }) => {
      await requireSuperAdmin(env, caller);
      return json(await readSettings(env.DB));
    },
  ],
  [
    "PUT",
    "/api/admin/settings",
    async ({ request, env, caller }) => {
      await requireSuperAdmin(env, caller);
      const body = await readBody(request, AdminSettingsPutRequestSchema, {
        workspaceCreation: "Choose who can create workspaces.",
        creators: "Enter an email like name@example.com, or a domain like example.com.",
      });
      await writeSettings(env.DB, caller.person.id, body.workspaceCreation, body.creators);
      return json(await readSettings(env.DB));
    },
  ],
  [
    "POST",
    "/api/admin/super-admins",
    async ({ request, env, caller }) => {
      await requireSuperAdmin(env, caller);
      const { email } = await readBody(request, SuperAdminCreateRequestSchema, {
        email: INVALID_EMAIL,
      });
      await addSuperAdmin(env.DB, caller.person.id, email);
      return json(await readSettings(env.DB));
    },
  ],
  [
    "DELETE",
    "/api/admin/super-admins/:personId",
    async ({ env, caller, params }) => {
      await requireSuperAdmin(env, caller);
      await removeSuperAdmin(env.DB, caller.person.id, params.personId ?? "");
      return noContent();
    },
  ],
  [
    "GET",
    "/api/spaces/:sid/interactions/:iid/shares",
    async ({ env, caller, params }) => {
      const spaceId = params.sid ?? "";
      const interactionId = params.iid ?? "";
      await requireMember(env.DB, caller.person, spaceId);
      await requireInteraction(env, caller, spaceId, interactionId);
      return json(await listShares(env.DB, caller.person, spaceId, interactionId));
    },
  ],
  ["POST", "/api/spaces/:sid/interactions/:iid/shares", postShare],
  [
    "DELETE",
    "/api/spaces/:sid/interactions/:iid/shares/:email",
    async ({ env, caller, params }) => {
      await deleteShare(env, caller.person, params.sid ?? "", params.iid ?? "", params.email ?? "");
      return noContent();
    },
  ],
];

function match(pattern: string, path: string): Params | null {
  const want = pattern.split("/");
  const got = path.split("/");
  if (want.length !== got.length) return null;
  const params: Params = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i] ?? "";
    const g = got[i] ?? "";
    if (w.startsWith(":")) {
      if (g.length === 0) return null;
      try {
        params[w.slice(1)] = decodeURIComponent(g);
      } catch {
        return null;
      }
    } else if (w !== g) return null;
  }
  return params;
}

/** `/api/*`; null when no route has that path. */
export async function handleApi(
  request: Request,
  env: Env,
  path: string,
  later: Later,
): Promise<{ response: Response; identity: Identity } | null> {
  let found: { handler: Handler; params: Params } | null = null;
  let pathKnown = false;
  for (const [method, pattern, handler] of ROUTES) {
    const params = match(pattern, path);
    if (params === null) continue;
    pathKnown = true;
    if (method === request.method) {
      found = { handler, params };
      break;
    }
  }
  if (!pathKnown) return null;
  const caller = await resolveCaller(request, env, kindOf(request));
  if (caller === null) throw signInRequired();
  checkPersonHint(request, caller, false);
  if (found === null) return { response: new Response(null, { status: 405 }), identity: caller };
  if (kindOf(request) === "write")
    await limit(env.DB, `write:${caller.person.id}`, WRITES_PER_MINUTE);
  const response = await found.handler({ request, env, caller, params: found.params, later });
  return { response, identity: caller };
}

async function requireSuperAdmin(env: Env, caller: Identity): Promise<void> {
  if (!(await isSuperAdmin(env.DB, caller.person.id)))
    throw new Failure("forbidden", SUPER_ADMINS_ONLY);
}

async function me({ env, caller }: { env: Env; caller: Identity }): Promise<Response> {
  const body: MeResponse = {
    person: personOf(caller.person, "self"),
    spaces: await spacesOf(env.DB, caller.person),
    canCreateWorkspace: await mayCreateWorkspace(env.DB, caller.person),
    superAdmin: await isSuperAdmin(env.DB, caller.person.id),
    // Not secrets (an extension id is public): the web app pings each (S-3).
    extensionIds: [...extensionIds(env)].slice(0, 8),
    siteOrigin: publicSiteOrigin(env),
    signOutEndpoint: logoutEndpoint(env),
    profile: await profileOf(env.DB, caller.person),
  };
  return json(body);
}

/** The person and their profile as they are now, after a change of either. */
async function meNow(env: Env, caller: Identity): Promise<Response> {
  const person = await personById(env.DB, caller.person.id);
  if (person === null || person.email === null) throw signInRequired();
  return json({ person: personOf(person, "self"), profile: await profileOf(env.DB, person) });
}

async function patchMe({ request, env, caller }: { request: Request; env: Env; caller: Identity }) {
  const body = await readBody(request, MePatchRequestSchema, {
    name: "Enter a name between 1 and 80 characters.",
  });
  if (body.name !== undefined) await rename(env, caller.person, body.name);
  if (body.picture !== undefined) await choosePicture(env, caller.person, body.picture);
  return meNow(env, caller);
}

const PICTURE_TOO_LARGE = `Choose an image up to ${MAX_PICTURE_BYTES / 1024} KB.`;

/**
 * `PUT /api/me/picture`: the image's bytes as the body, its size checked
 * before anything is read (a declared length over the limit is refused
 * unread) and while it streams; its type from its own bytes.
 */
async function putPicture({
  request,
  env,
  caller,
}: {
  request: Request;
  env: Env;
  caller: Identity;
}) {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > MAX_PICTURE_BYTES) {
    throw new Failure("invalid", PICTURE_TOO_LARGE, "too-large");
  }
  const bytes = await readCappedBody(request, MAX_PICTURE_BYTES);
  if (bytes === null) throw new Failure("invalid", PICTURE_TOO_LARGE, "too-large");
  await uploadPicture(env, caller.person, bytes);
  return meNow(env, caller);
}

/** `GET /api/me/picture/:key`: the person's own stored picture; anything else is `not_found`. */
async function getOwnPicture({
  request,
  env,
  caller,
  params,
}: {
  request: Request;
  env: Env;
  caller: Identity;
  params: Params;
}) {
  const key = params.key ?? "";
  const picture = PICTURE_KEY_RE.test(key)
    ? await pictureByKey(env.DB, caller.person.id, key)
    : null;
  if (picture === null) throw notFound();
  return pictureResponse(request, key, picture.type, picture.bytes);
}

async function deleteMe({
  request,
  env,
  caller,
  later,
}: {
  request: Request;
  env: Env;
  caller: Identity;
  later: Later;
}) {
  const { confirm } = await readBody(request, MeDeleteRequestSchema);
  await deleteAccount(env, caller.person, confirm, later);
  return noContent({ "Set-Cookie": clearSessionCookie() });
}

/** How many spaces a fan-out asks at once, and how long it waits for each. */
const FAN_OUT_CONCURRENCY = 6;
const FAN_OUT_DEADLINE_MS = 5_000;

/**
 * Each of the caller's spaces answers `path`, `FAN_OUT_CONCURRENCY` at a time,
 * each within `FAN_OUT_DEADLINE_MS`. Their standing comes from one grouped D1
 * query; a space that fails or runs late is logged and left out, and the
 * others still answer.
 */
async function fanOut<T>(
  env: Env,
  caller: Identity,
  path: string,
  read: (body: unknown) => T,
): Promise<{ spaceId: string; value: T }[]> {
  // One batch: the credential still live, the person now, every standing and epoch.
  const { who, standings: spaces } = await authorizeIn(env, caller);
  const one = async (standing: SpaceStanding) => {
    const spaceId = standing.space.id;
    // The deadline aborts the call itself, not just the wait for it (round 2, S16).
    const deadline = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => {
        deadline.abort(new Error(`deadline of ${FAN_OUT_DEADLINE_MS} ms`));
        resolve("late");
      }, FAN_OUT_DEADLINE_MS);
    });
    try {
      const raced = await Promise.race([
        getFromSpace(env, who, standing, path, deadline.signal),
        late,
      ]);
      if (raced === "late") {
        console.error(`space ${spaceId} GET ${path} took longer than ${FAN_OUT_DEADLINE_MS} ms`);
        return null;
      }
      const res = raced;
      if (!res.ok) {
        console.error(`space ${spaceId} GET ${path} answered ${res.status}`);
        await res.body?.cancel();
        return null;
      }
      return { spaceId, value: read(await res.json()) };
    } catch (error) {
      console.error(`space ${spaceId} GET ${path} failed`, error);
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  // A small pool: never more than FAN_OUT_CONCURRENCY spaces in flight.
  const results: ({ spaceId: string; value: T } | null)[] = new Array(spaces.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < spaces.length) {
      const i = next++;
      const standing = spaces[i];
      if (standing) results[i] = await one(standing);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FAN_OUT_CONCURRENCY, spaces.length) }, worker));
  return results.filter((result) => result !== null);
}

/** The interaction exists in the space as this member sees it; `not_found` otherwise. */
async function requireInteraction(
  env: Env,
  caller: Identity,
  spaceId: string,
  interactionId: string,
): Promise<void> {
  if (!z.safeParse(z.uuid(), interactionId).success) throw notFound();
  const { who, standings } = await authorizeIn(env, caller, [spaceId]);
  const standing = standings[0];
  if (standing === undefined) throw notFound();
  const res = await getFromSpace(env, who, standing, `/interaction/${interactionId}`);
  await res.body?.cancel();
  if (res.status === 404) throw notFound();
  if (!res.ok) throw new Error(`space ${spaceId} answered ${res.status} for an interaction read`);
}

function rowsOf(value: unknown): AttentionRow[] {
  return Array.isArray(value) ? (value as AttentionRow[]) : [];
}

/** `GET /api/inbox`: each space's `GET /attention`, merged newest first, rows tagged with `spaceId`. */
async function inbox({ env, caller }: { env: Env; caller: Identity }): Promise<Response> {
  const parts = await fanOut(env, caller, "/attention", (body) => {
    const frame = (body ?? {}) as Record<string, unknown>;
    return {
      needsYou: rowsOf(frame.needsYou),
      waiting: rowsOf(frame.waiting),
      recent: rowsOf(frame.recent),
      needsYouCount:
        typeof frame.needsYouCount === "number"
          ? frame.needsYouCount
          : rowsOf(frame.needsYou).length,
    };
  });
  const merge = (pick: (part: (typeof parts)[number]["value"]) => AttentionRow[]): InboxRow[] =>
    parts
      .flatMap((part) => pick(part.value).map((row) => ({ ...row, spaceId: part.spaceId })))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, LIMITS.MAX_ATTENTION_ROWS);
  const body: InboxResponse = {
    needsYou: merge((part) => part.needsYou),
    waiting: merge((part) => part.waiting),
    recent: merge((part) => part.recent),
    needsYouCount: parts.reduce((sum, part) => sum + part.value.needsYouCount, 0),
  };
  return json(body);
}

/** `GET /api/origins`: each space's `GET /origins`. */
async function origins({ env, caller }: { env: Env; caller: Identity }): Promise<Response> {
  const parts = await fanOut(env, caller, "/origins", (body) => {
    const list = (body as { origins?: unknown } | null)?.origins;
    return Array.isArray(list)
      ? list.filter((origin): origin is string => typeof origin === "string")
      : [];
  });
  const body: OriginsResponse = { spaces: {} };
  for (const part of parts) body.spaces[part.spaceId] = part.value;
  return json(body);
}

/**
 * `POST /api/spaces/:sid/interactions/:iid/shares`: members only; the space
 * confirms the interaction exists (as this member sees it) before the share
 * is written.
 */
async function postShare({
  request,
  env,
  caller,
  params,
}: Parameters<Handler>[0]): Promise<Response> {
  const spaceId = params.sid ?? "";
  const interactionId = params.iid ?? "";
  await requireMember(env.DB, caller.person, spaceId);
  const { email } = await readBody(request, ShareCreateRequestSchema, { email: INVALID_EMAIL });
  await requireInteraction(env, caller, spaceId, interactionId);
  await createShare(env, caller.person, spaceId, interactionId, email);
  return json(await listShares(env.DB, caller.person, spaceId, interactionId), { status: 201 });
}
