// The whole system in workerd (spec §11): the real Worker, the real space
// Durable Object, real D1 migrations and dev-stub sign-in, driven only
// through public routes as the extension (client token, `bearer.` subprotocol)
// and the web app (session cookie) drive them. The one exception is the agent
// class: MCP is the agent's only door, so those calls go straight to the
// space's routes with an agent-class caller header, exactly as the MCP
// endpoint forwards them.
//
// Every assertion here is a seam between seats: if one breaks, a client and
// the server no longer agree.
import { env } from "cloudflare:workers";
import {
  type Caller,
  CLOSE_ACCESS_REVOKED,
  encodeCaller,
  type InboxResponse,
  InboxResponseSchema,
  type MeResponse,
  MeResponseSchema,
  PROTOCOL_VERSION,
  parseOutbound,
} from "@onlay/protocol";
import { describe, expect, test } from "vitest";
import { call, devSignIn, edge, ORIGIN, uniqueEmail, type Who } from "../support/client";
import { d1Epoch } from "../support/mcp";

// biome-ignore lint/suspicious/noExplicitAny: frames and bodies are read loosely
type Json = Record<string, any>;

const PAGE = "https://shop.example.com/pricing";
const OTHER_PAGE = "https://shop.example.com/about";
const ROOT = "root@example.com"; // a super admin (SUPER_ADMINS in vitest.config.ts)

/* ── sockets through the edge ─────────────────────────────────────── */

interface Sock {
  frames: Json[];
  raw: string[];
  closed: Promise<number>;
  send(frame: Json): void;
  /** Index to search from: frames before it are ignored. */
  mark(): number;
  until(pred: (f: Json) => boolean, from?: number): Promise<Json>;
  none(pred: (f: Json) => boolean, from: number): Promise<void>;
  close(): void;
}

async function waitFor<T>(probe: () => T | undefined, what: string, ms = 3_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = probe();
    if (hit !== undefined) return hit;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function upgrade(who: Who, spaceId: string, as: "extension" | "web"): Promise<Response> {
  const headers: Record<string, string> =
    as === "extension"
      ? { Upgrade: "websocket", "Sec-WebSocket-Protocol": `onlay.v1, bearer.${who.token}` }
      : {
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": "onlay.v1",
          Cookie: who.cookie,
          Origin: ORIGIN,
        };
  return edge(`/s/${spaceId}/ws`, { headers });
}

/** Opens `/s/<space>/ws` through the edge, says hello, and waits for welcome. */
async function connect(who: Who, spaceId: string, as: "extension" | "web" = "extension") {
  const res = await upgrade(who, spaceId, as);
  expect(res.status).toBe(101);
  // `onlay.v1` survives the edge; the `bearer.` entry stops there.
  expect(res.headers.get("Sec-WebSocket-Protocol")).toBe("onlay.v1");
  const ws = res.webSocket;
  if (!ws) throw new Error("no socket");
  ws.accept();
  const frames: Json[] = [];
  const raw: string[] = [];
  let onClose: (code: number) => void = () => {};
  const closed = new Promise<number>((resolve) => {
    onClose = resolve;
  });
  ws.addEventListener("message", (e) => {
    raw.push(String(e.data));
    frames.push(JSON.parse(String(e.data)));
  });
  ws.addEventListener("close", (e) => onClose(e.code));
  const sock: Sock = {
    frames,
    raw,
    closed,
    send: (frame) => ws.send(JSON.stringify(frame)),
    mark: () => frames.length,
    until: (pred, from = 0) => waitFor(() => frames.slice(from).find(pred), "a matching frame"),
    async none(pred, from) {
      await new Promise((r) => setTimeout(r, 250));
      expect(frames.slice(from).filter(pred)).toEqual([]);
    },
    close: () => ws.close(1000),
  };
  sock.send({
    v: 1,
    type: "hello",
    sessionId: crypto.randomUUID(),
    bootCount: 1,
    swRestarts: 0,
    connects: 1,
    protocol: PROTOCOL_VERSION,
  });
  await sock.until((f) => f.type === "welcome");
  return sock;
}

const ofType = (type: string) => (f: Json) => f.type === type;

/** Every frame the extension's service worker would accept parses with the protocol. */
function parsesAsExtensionDoes(sock: Sock): void {
  for (const raw of sock.raw) {
    const parsed = parseOutbound(raw);
    expect(parsed.ok, raw.slice(0, 200)).toBe(true);
  }
}

/* ── people and spaces ────────────────────────────────────────────── */

async function json(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

async function me(who: Who): Promise<MeResponse> {
  const res = await call(who, "GET", "/api/me");
  expect(res.status).toBe(200);
  return MeResponseSchema.parse(await res.json());
}

async function inbox(who: Who, as: "web" | "extension" = "web"): Promise<InboxResponse> {
  const res = await call(who, "GET", "/api/inbox", undefined, as);
  expect(res.status).toBe(200);
  return InboxResponseSchema.parse(await res.json());
}

async function code(res: Response): Promise<string> {
  return ((await res.json()) as Json).error?.code;
}

/** Workspace creation open to anyone, set once by the super admin through the admin API. */
async function openWorkspaceCreation(): Promise<void> {
  const root = await devSignIn(ROOT, "Root");
  const res = await call(root, "PUT", "/api/admin/settings", {
    workspaceCreation: "anyone",
    creators: [],
  });
  expect(res.status).toBe(200);
}

let wsCounter = 0;
/** Ada (admin) and Bea (member) in a fresh workspace, made through the public API. */
async function world() {
  await openWorkspaceCreation();
  const ada = await devSignIn(uniqueEmail("ada"), "Ada Lovelace");
  const bea = await devSignIn(uniqueEmail("bea"), "Bea Brown");
  wsCounter += 1;
  const name = `acme-${Date.now().toString(36)}-${wsCounter}`;
  const created = await call(ada, "POST", "/api/workspaces", { name });
  expect(created.status).toBe(201);
  const spaceId = (await json(created)).space.id as string;
  const invited = await call(ada, "POST", `/api/workspaces/${spaceId}/invitations`, {
    email: bea.person.email,
  });
  expect(await json(invited)).toEqual({ joined: true });
  return { ada, bea, spaceId, name };
}

/** The agent of `who`, calling the space as the MCP endpoint does. */
async function asAgent(
  who: Who,
  spaceId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Json }> {
  const caller: Caller = {
    personId: who.person.id,
    name: who.person.name,
    initials: who.person.initials,
    tint: who.person.tint,
    class: "agent",
    access: { kind: "member", role: "member" },
    credentialId: `dev:${who.person.email}`,
    accessEpoch: await d1Epoch(spaceId),
    credentialGeneration: 0,
  };
  const stub = env.SPACE.get(env.SPACE.idFromName(spaceId));
  const res = await stub.fetch(`https://space${path}`, {
    method,
    headers: {
      "X-Onlay-Caller": encodeCaller(caller),
      "Onlay-Protocol": String(PROTOCOL_VERSION),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await json(res) };
}

/* ── interactions over the extension's socket ─────────────────────── */

let nonceCounter = 0;
async function comment(
  sock: Sock,
  url: string,
  text: string,
  tokens?: Json[],
  anchor: Json = { level: "element", selector: "main > h1", snippet: "Pricing" },
): Promise<string> {
  nonceCounter += 1;
  const nonce = `c${nonceCounter}`;
  const from = sock.mark();
  sock.send({
    v: 1,
    type: "interaction-create",
    nonce,
    frameUrl: url,
    kind: "comment",
    anchor,
    body: tokens ? { text, tokens } : { text },
  });
  const receipt = await sock.until(
    (f) => f.type === "interaction-receipt" && f.nonce === nonce,
    from,
  );
  expect(receipt).toMatchObject({ kind: "create", ok: true });
  return receipt.interactionId as string;
}

const block = (sourcePointer?: string) => ({
  selector: "main > h1",
  tag: "h1",
  classes: [],
  textSnippet: "Pricing",
  markup: "<h1>Pricing</h1>",
  ...(sourcePointer ? { sourcePointer } : {}),
});

const calm = [{ op: "setStyle", target: ":scope", props: [{ prop: "color", value: "slateblue" }] }];

/* ── the suite ────────────────────────────────────────────────────── */

describe("the hosted system, whole", () => {
  test("sign-in makes personal spaces; an invitation by email turns into membership at the next sign-in", async () => {
    await openWorkspaceCreation();
    const adaEmail = uniqueEmail("ada");
    const ada = await devSignIn(adaEmail, "Ada Lovelace");
    const adaMe = await me(ada);
    expect(adaMe.person).toEqual({
      id: ada.person.id,
      email: adaEmail,
      name: "Ada Lovelace",
      initials: expect.any(String),
      tint: expect.any(String),
    });
    expect(adaMe.spaces).toEqual([
      { id: expect.stringMatching(/^s_/), kind: "personal", name: "Personal", role: "admin" },
    ]);
    expect(adaMe.canCreateWorkspace).toBe(true);

    const name = `team-${Date.now().toString(36)}`;
    const created = await call(ada, "POST", "/api/workspaces", { name });
    expect(created.status).toBe(201);
    const spaceId = (await json(created)).space.id as string;

    const beaEmail = uniqueEmail("bea");
    const invited = await call(ada, "POST", `/api/workspaces/${spaceId}/invitations`, {
      email: beaEmail,
    });
    expect(await json(invited)).toEqual({ joined: false });

    const bea = await devSignIn(beaEmail, "Bea Brown");
    const beaMe = await me(bea);
    expect(beaMe.spaces.map((s) => [s.kind, s.name, s.role])).toEqual([
      ["personal", "Personal", "admin"],
      ["workspace", name, "member"],
    ]);
    expect(beaMe.spaces[0]?.id).not.toBe(adaMe.spaces[0]?.id);

    const workspace = await json(await call(ada, "GET", `/api/workspaces/${spaceId}`));
    expect(workspace.invitations).toEqual([]);
    expect(workspace.members.map((m: Json) => [m.person.id, m.role]).sort()).toEqual(
      [
        [ada.person.id, "admin"],
        [bea.person.id, "member"],
      ].sort(),
    );
  });

  test("a mention travels from one person's extension to the other's socket, attention and inbox", async () => {
    const { ada, bea, spaceId, name } = await world();
    const adaSock = await connect(ada, spaceId);
    const beaSock = await connect(bea, spaceId);
    const welcome = beaSock.frames.find(ofType("welcome"));
    expect(welcome?.person).toEqual({
      id: bea.person.id,
      name: "Bea Brown",
      initials: bea.person.initials,
      tint: bea.person.tint,
    });
    expect(welcome?.space).toEqual({ id: spaceId, kind: "workspace", name, role: "member" });

    const from = beaSock.mark();
    const id = await comment(adaSock, PAGE, "@Bea Brown is this price right?", [
      { t: "actor", actorId: bea.person.id },
    ]);

    const state = await beaSock.until(
      (f) => f.type === "interactions-state" && f.url === PAGE && f.interactions.length > 0,
      from,
    );
    expect(state.interactions.map((s: Json) => s.id)).toEqual([id]);
    const attention = await beaSock.until(
      (f) => f.type === "attention" && f.needsYou.length > 0,
      from,
    );
    expect(attention.person.id).toBe(bea.person.id);
    expect(attention.needsYou[0]).toMatchObject({ interactionId: id, kind: "comment", url: PAGE });

    const beaInbox = await inbox(bea, "extension");
    expect(beaInbox.needsYouCount).toBe(1);
    expect(beaInbox.needsYou).toEqual([
      expect.objectContaining({ interactionId: id, spaceId, fromActorId: ada.person.id }),
    ]);
    // The author waits on nobody: nothing needs Ada.
    expect((await inbox(ada)).needsYouCount).toBe(0);

    // Every frame either socket got parses the way the extension parses it.
    parsesAsExtensionDoes(beaSock);
    parsesAsExtensionDoes(adaSock);
    adaSock.close();
    beaSock.close();
  });

  test("a stranger sees nothing; a share shows exactly one thread until it is removed", async () => {
    const { ada, bea, spaceId } = await world();
    const cal = await devSignIn(uniqueEmail("cal"), "Cal Carter");
    const adaSock = await connect(ada, spaceId);
    const shared = await comment(adaSock, PAGE, "@Bea Brown please check", [
      { t: "actor", actorId: bea.person.id },
    ]);
    const hidden = await comment(adaSock, PAGE, "internal note");

    // Not a member, no share: missing, everywhere.
    expect(await code(await call(cal, "GET", `/s/${spaceId}/directory`))).toBe("not_found");
    expect(await code(await call(cal, "GET", `/s/${spaceId}/interaction/${shared}`))).toBe(
      "not_found",
    );
    expect((await upgrade(cal, spaceId, "extension")).status).toBe(404);

    const share = await call(ada, "POST", `/api/spaces/${spaceId}/interactions/${shared}/shares`, {
      email: cal.person.email,
    });
    expect(share.status).toBe(201);

    expect((await me(cal)).spaces.find((s) => s.id === spaceId)?.role).toBe("guest");
    const read = await call(cal, "GET", `/s/${spaceId}/interaction/${shared}`);
    expect(read.status).toBe(200);
    expect((await json(read)).interaction.id).toBe(shared);
    expect(await code(await call(cal, "GET", `/s/${spaceId}/interaction/${hidden}`))).toBe(
      "not_found",
    );
    const list = await json(await call(cal, "GET", `/s/${spaceId}/interaction`));
    expect(list.interactions.map((s: Json) => s.id)).toEqual([shared]);
    const people = await json(await call(cal, "GET", `/s/${spaceId}/directory`));
    expect(people.people.map((p: Json) => p.id).sort()).toEqual(
      [ada.person.id, bea.person.id, cal.person.id].sort(),
    );
    for (const p of people.people) expect(p.avatarUrl).toBeUndefined();

    const calSock = await connect(cal, spaceId);
    const from = calSock.mark();
    calSock.send({ v: 1, type: "interaction-sync", frameUrl: PAGE });
    const snapshot = await calSock.until(ofType("interactions-state"), from);
    expect(snapshot.interactions.map((s: Json) => s.id)).toEqual([shared]);

    // A guest may reply; may not create, resolve or share.
    const reply = await call(cal, "POST", `/s/${spaceId}/interaction/${shared}/reply`, {
      body: { text: "Looks right to me." },
    });
    expect(reply.status).toBe(200);
    const created = await call(cal, "POST", `/s/${spaceId}/interaction`, {
      kind: "comment",
      body: { text: "new" },
      anchor: { level: "unanchored" },
    });
    expect(await code(created)).toBe("forbidden");
    expect(await code(await call(cal, "POST", `/s/${spaceId}/interaction/${shared}/resolve`))).toBe(
      "forbidden",
    );
    const reshare = await call(
      cal,
      "POST",
      `/api/spaces/${spaceId}/interactions/${shared}/shares`,
      {
        email: uniqueEmail("dan"),
      },
    );
    expect(reshare.status).toBeGreaterThanOrEqual(403);
    expect(reshare.status).toBeLessThanOrEqual(404);

    // Removing the share closes the guest's socket and their access.
    const removed = await call(
      ada,
      "DELETE",
      `/api/spaces/${spaceId}/interactions/${shared}/shares/${encodeURIComponent(cal.person.email)}`,
    );
    expect(removed.status).toBe(204);
    expect(await calSock.closed).toBe(CLOSE_ACCESS_REVOKED);
    expect(await code(await call(cal, "GET", `/s/${spaceId}/interaction/${shared}`))).toBe(
      "not_found",
    );
    expect((await me(cal)).spaces.some((s) => s.id === spaceId)).toBe(false);
    adaSock.close();
  });

  test("an agent's variants, picked by a member: kept without a source pointer, working with one", async () => {
    const { ada, bea, spaceId } = await world();
    const adaSock = await connect(ada, spaceId);

    async function createSet(sourcePointer?: string) {
      nonceCounter += 1;
      const nonce = `v${nonceCounter}`;
      const from = adaSock.mark();
      adaSock.send({
        v: 1,
        type: "variant-create",
        nonce,
        frameUrl: PAGE,
        root: { kind: "block", element: block(sourcePointer) },
        command: "make it calmer",
        count: 2,
      });
      const state = await adaSock.until(
        (f) => f.type === "variant-state" && f.nonce === nonce,
        from,
      );
      return { setId: state.setId as string, editId: state.changeInteractionId as string };
    }

    // No source pointer: the pick keeps the program on the page.
    const unowned = await createSet();
    const posted = await asAgent(ada, spaceId, "POST", `/variant-set/${unowned.setId}/variants`, {
      variants: [
        { label: "Calm", program: calm },
        { label: "Calmer", program: calm },
      ],
    });
    expect(posted.status).toBe(200);
    const from = adaSock.mark();
    const picked = await call(bea, "POST", `/s/${spaceId}/variant-set/${unowned.setId}/pick`, {
      variantId: posted.body.set.variants[0].variantId,
      version: 1,
    });
    expect(await json(picked)).toMatchObject({
      ok: true,
      interactionId: unowned.editId,
      state: "kept",
    });
    const page = await adaSock.until(
      (f) => f.type === "interactions-state" && f.url === PAGE && (f.kept ?? []).length > 0,
      from,
    );
    expect(page.kept).toEqual([
      expect.objectContaining({
        interactionId: unowned.editId,
        setId: unowned.setId,
        root: { kind: "block", element: block() },
        program: calm,
        by: bea.person.id,
        label: "Calm",
      }),
    ]);

    // A source pointer: the pick hands the Edit to an agent to implement.
    const owned = await createSet("src/Pricing.tsx:4:2");
    const postedOwned = await asAgent(
      ada,
      spaceId,
      "POST",
      `/variant-set/${owned.setId}/variants`,
      {
        variants: [{ label: "Calm", program: calm }],
      },
    );
    const pickedOwned = await call(bea, "POST", `/s/${spaceId}/variant-set/${owned.setId}/pick`, {
      variantId: postedOwned.body.set.variants[0].variantId,
      version: 1,
    });
    expect(await json(pickedOwned)).toMatchObject({ ok: true, state: "working" });
    const read = await json(await call(ada, "GET", `/s/${spaceId}/interaction/${owned.editId}`));
    expect(read.interaction.agentWork).toMatchObject({
      status: "pending",
      requestedBy: bea.person.id,
    });
    parsesAsExtensionDoes(adaSock);
    adaSock.close();
  });

  test("@agent creates pending agent work: yours for the writer's agent, teammates' for another member's", async () => {
    const { ada, bea, spaceId, name } = await world();
    const adaSock = await connect(ada, spaceId);
    const id = await comment(adaSock, PAGE, "@agent tighten this headline", [{ t: "agent" }]);

    const mine = await asAgent(ada, spaceId, "GET", `/agent-work?url=${encodeURIComponent(PAGE)}`);
    expect(mine.status).toBe(200);
    expect(mine.body.teammates).toEqual([]);
    expect(mine.body.yours).toEqual([
      expect.objectContaining({
        ref: `${spaceId}/${id}`,
        kind: "comment",
        spaceId,
        spaceName: name,
        status: "pending",
        requestedBy: expect.objectContaining({ id: ada.person.id }),
      }),
    ]);
    const theirs = await asAgent(bea, spaceId, "GET", "/agent-work");
    expect(theirs.body.yours).toEqual([]);
    expect(theirs.body.teammates.map((w: Json) => w.ref)).toEqual([`${spaceId}/${id}`]);
    adaSock.close();
  });

  test("removing a member closes their socket and the space goes missing for them", async () => {
    const { ada, bea, spaceId } = await world();
    const beaSock = await connect(bea, spaceId);
    const removed = await call(
      ada,
      "DELETE",
      `/api/workspaces/${spaceId}/members/${bea.person.id}`,
    );
    expect(removed.status).toBe(204);
    expect(await beaSock.closed).toBe(CLOSE_ACCESS_REVOKED);
    expect(await code(await call(bea, "GET", `/s/${spaceId}/directory`))).toBe("not_found");
    expect((await upgrade(bea, spaceId, "extension")).status).toBe(404);
  });

  test("a web app socket gets a tick for a change it may see and nothing for one it may not", async () => {
    const { ada, bea, spaceId } = await world();
    const cal = await devSignIn(uniqueEmail("cal"), "Cal Carter");
    const adaSock = await connect(ada, spaceId);
    const shared = await comment(adaSock, PAGE, "shared thread");
    const hidden = await comment(adaSock, OTHER_PAGE, "members only", undefined, {
      level: "page",
    });
    await call(ada, "POST", `/api/spaces/${spaceId}/interactions/${shared}/shares`, {
      email: cal.person.email,
    });

    const beaWeb = await connect(bea, spaceId, "web");
    const calWeb = await connect(cal, spaceId, "web");
    const beaFrom = beaWeb.mark();
    const calFrom = calWeb.mark();

    // A change only members may see: Bea hears it, the guest hears nothing.
    adaSock.send({
      v: 1,
      type: "interaction-reply",
      frameUrl: OTHER_PAGE,
      interactionId: hidden,
      body: { text: "still members only" },
    });
    await beaWeb.until(ofType("tick"), beaFrom);
    await calWeb.none(() => true, calFrom);

    // A change on the shared thread reaches both, as a tick and nothing more.
    const calShared = calWeb.mark();
    await call(
      ada,
      "POST",
      `/s/${spaceId}/interaction/${shared}/reply`,
      {
        body: { text: "for everyone here" },
      },
      "extension",
    );
    await calWeb.until(ofType("tick"), calShared);
    expect(
      calWeb.frames
        .slice(calShared)
        .filter((f) => f.type === "interactions-state" || f.type === "variant-state"),
    ).toEqual([]);
    beaWeb.close();
    calWeb.close();
    adaSock.close();
  });
});
