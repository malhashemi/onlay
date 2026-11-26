// The screens, mounted for real against a scripted server: a member's thread
// offers Resolve, Share and Copy for agent and shows agent marks; a guest's
// offers reply, react, attach and pick only; Settings shows Deployment only to
// super admins; a workspace admin can invite (and is told no email is sent)
// while a member sees the list read-only; account deletion waits for the
// typed email and shows the server's `last_admin` sentence.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MeResponse, RawInteractionSnapshot, SpaceSummary } from "@onlay/protocol";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { Window } from "happy-dom";
import type { ApiClient } from "../api";
import type { AppCtx, Screen } from "../context";
import { Router } from "../router";
import { Store } from "../store";
import { composeScreen } from "./compose";
import { inboxScreen } from "./inbox";
import { settingsScreen } from "./settings";
import { threadScreen } from "./thread";
import { workspaceScreen } from "./workspace";

Object.assign(globalThis, { indexedDB, IDBKeyRange });

let win: Window | null = null;
const saved = new Map<string, unknown>();
const GLOBALS = [
  "window",
  "document",
  "location",
  "localStorage",
  "requestAnimationFrame",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "HTMLTextAreaElement",
  "HTMLImageElement",
  "Node",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
] as const;

let store: Store;

beforeEach(async () => {
  win = new Window({ url: "https://onlay.test/app/" });
  const w = win as unknown as Record<string, unknown>;
  const g = globalThis as unknown as Record<string, unknown>;
  for (const k of GLOBALS) {
    saved.set(k, g[k]);
    g[k] = w[k];
  }
  store = await Store.open();
});

afterEach(() => {
  store.close();
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
  const g = globalThis as unknown as Record<string, unknown>;
  for (const [k, v] of saved) g[k] = v;
  saved.clear();
});

const ME = "p_aaaaaaaaaaaaaaaaaaaa";
const BOB = "p_bbbbbbbbbbbbbbbbbbbb";
const S = "s_ssssssssssssssssssss";
const IID = "11111111-2222-4333-8444-555555555555";

function meWith(role: SpaceSummary["role"], superAdmin = false): MeResponse {
  return {
    person: { id: ME, email: "ada@acme.test", name: "Ada", initials: "AD", tint: "#0ea5e9" },
    spaces: [{ id: S, kind: "workspace", name: "acme", role }],
    canCreateWorkspace: true,
    superAdmin,
  };
}

const SNAP: RawInteractionSnapshot = {
  id: IID,
  kind: "comment",
  url: "https://acme.test/pricing",
  anchor: { level: "page" },
  authorId: BOB,
  participants: [BOB, ME],
  waitingOn: [],
  state: "open",
  thread: [
    { msgId: "m1", authorId: BOB, body: { text: "Can you tighten this?" }, ts: 1 },
    { msgId: "m2", authorId: ME, body: { text: "Done, see the diff." }, ts: 2, agent: true },
  ],
  createdAt: 1,
} as RawInteractionSnapshot;

type Responder = (method: string, path: string, body: unknown) => [number, unknown];

function mount(
  me: MeResponse,
  respond: Responder,
  make: (ctx: AppCtx) => Screen,
): { screen: Screen; calls: string[]; ctx: AppCtx } {
  const calls: string[] = [];
  const client: ApiClient = {
    store,
    personId: ME,
    onSignInRequired: () => calls.push("sign-in"),
    onUpgradeRequired: () => calls.push("upgrade"),
    fetchFn: ((path: string, init: RequestInit) => {
      const method = init.method ?? "GET";
      calls.push(`${method} ${path}`);
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      const [status, out] = respond(method, path, body);
      return Promise.resolve(
        new Response(JSON.stringify(out), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch,
  };
  const ctx: AppCtx = {
    client,
    store,
    router: new Router(),
    me,
    origin: "https://onlay.test",
    people: new Map(),
    reloadMe: async () => true,
    async loadPeople(spaceId) {
      ctx.people.set(
        spaceId,
        new Map([[BOB, { id: BOB, name: "Bob", initials: "BO", tint: "#10b981" }]]),
      );
      return true;
    },
    signOut: async () => true,
  };
  const screen = make(ctx);
  document.body.append(screen.node);
  return { screen, calls, ctx };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

function buttons(node: HTMLElement): string[] {
  return [...node.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
}

function threadServer(): Responder {
  return (method, path) => {
    if (method === "GET" && path === `/s/${S}/interaction/${IID}`)
      return [200, { interaction: SNAP }];
    if (method === "GET" && path.endsWith("/shares")) return [200, []];
    return [404, { error: { code: "not_found", message: "Not found." } }];
  };
}

describe("thread", () => {
  test("a reply quoting a message that opens with code shows the code, not the fence", async () => {
    const quoted: RawInteractionSnapshot = {
      ...SNAP,
      thread: [
        { msgId: "m1", authorId: BOB, body: { text: "```bash\nbun run check\n```" }, ts: 1 },
        { msgId: "m2", authorId: ME, body: { text: "ran it" }, ts: 2, replyTo: { msgId: "m1" } },
      ],
    } as RawInteractionSnapshot;
    const server: Responder = (method, path) =>
      method === "GET" && path === `/s/${S}/interaction/${IID}`
        ? [200, { interaction: quoted }]
        : threadServer()(method, path, undefined);
    const { screen } = mount(meWith("member"), server, (ctx) => threadScreen(ctx, S, IID));
    await settle();
    const chip = screen.node.querySelector(".quote-chip .quote-text")?.textContent ?? "";
    expect(chip).toBe("Bob: bun run check");
    expect(screen.node.querySelector(".msg .code-block .code-text")?.textContent).toBe(
      "bun run check",
    );
    screen.dispose?.();
  });

  test("a member gets Resolve, Share and Copy for agent; agent marks show", async () => {
    const { screen } = mount(meWith("member"), threadServer(), (ctx) => threadScreen(ctx, S, IID));
    await settle();
    const labels = buttons(screen.node);
    expect(labels).toContain("Resolve");
    expect(labels).toContain("Copy for agent");
    expect(labels).toContain("Share");
    expect(labels).toContain("Copy link");
    const tags = [...screen.node.querySelectorAll(".msg-agent")].map((n) => n.textContent);
    expect(tags).toEqual(["agent"]);
    // The agent-written message carries its person's name.
    const authors = [...screen.node.querySelectorAll(".msg-author")].map((n) => n.textContent);
    expect(authors).toEqual(["Bob", "Ada"]);
    screen.dispose?.();
  });

  test("an agent-written message is not offered for editing", async () => {
    const { screen } = mount(meWith("member"), threadServer(), (ctx) => threadScreen(ctx, S, IID));
    await settle();
    const own = screen.node.querySelectorAll(".msg")[1] as HTMLElement;
    expect(buttons(own)).not.toContain("edit");
    screen.dispose?.();
  });

  test("a guest sees reply, react and attach — no resolve, share, copy or edit", async () => {
    const { screen, calls } = mount(meWith("guest"), threadServer(), (ctx) =>
      threadScreen(ctx, S, IID),
    );
    await settle();
    const labels = buttons(screen.node);
    expect(labels).toContain("reply");
    expect(labels).toContain("Send");
    expect(screen.node.querySelector('[aria-label="Attach evidence"]')).not.toBeNull();
    expect(screen.node.querySelector(".reaction")).not.toBeNull();
    for (const hidden of [
      "Resolve",
      "Reopen",
      "Copy for agent",
      "Share",
      "Copy link",
      "edit",
      "delete",
    ]) {
      expect(labels).not.toContain(hidden);
    }
    expect(calls.some((c) => c.includes("/shares"))).toBe(false);
    screen.dispose?.();
  });
});

describe("settings", () => {
  test("Deployment shows only to super admins", () => {
    const plain = mount(
      meWith("member"),
      () => [404, {}],
      (ctx) => settingsScreen(ctx, "index"),
    );
    expect(plain.screen.node.textContent).not.toContain("Server");
    const admin = mount(
      meWith("member", true),
      () => [404, {}],
      (ctx) => settingsScreen(ctx, "index"),
    );
    expect(admin.screen.node.textContent).toContain("Server");
  });

  test("Settings links to the extension's install page", () => {
    const { screen } = mount(
      meWith("member"),
      () => [404, {}],
      (ctx) => settingsScreen(ctx, "index"),
    );
    const opened: unknown[][] = [];
    (window as unknown as { open: (...a: unknown[]) => null }).open = (...a) => {
      opened.push(a);
      return null;
    };
    const row = [...screen.node.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Extension"),
    );
    expect(row?.textContent).toContain("Install Onlay in Chrome");
    const click = new MouseEvent("click", { bubbles: true });
    Object.defineProperty(click, "isTrusted", { value: true });
    row?.dispatchEvent(click);
    expect(opened).toEqual([["https://onlay.test/install", "_blank", "noopener"]]);
  });

  test("the install page is the public site's when the server names one", () => {
    const { screen } = mount(
      { ...meWith("member"), siteOrigin: "https://site.onlay.test" },
      () => [404, {}],
      (ctx) => settingsScreen(ctx, "index"),
    );
    const opened: unknown[][] = [];
    (window as unknown as { open: (...a: unknown[]) => null }).open = (...a) => {
      opened.push(a);
      return null;
    };
    const row = [...screen.node.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Extension"),
    );
    const click = new MouseEvent("click", { bubbles: true });
    Object.defineProperty(click, "isTrusted", { value: true });
    row?.dispatchEvent(click);
    expect(opened).toEqual([["https://site.onlay.test/install", "_blank", "noopener"]]);
  });

  test("the Agent screen shows the MCP URL and the plugin lines", () => {
    const { screen } = mount(
      meWith("member"),
      () => [404, {}],
      (ctx) => settingsScreen(ctx, "agent"),
    );
    const text = screen.node.textContent ?? "";
    expect(text).toContain("https://onlay.test/mcp");
    expect(text).toContain("claude plugin install onlay@onlay");
    expect(text).toContain("codex plugin add onlay@onlay");
    expect(text).toContain("npx skills add malhashemi/onlay --skill onlay");
  });

  test("account deletion waits for the typed email and shows last_admin as sent", async () => {
    const msg = "You're the last admin of acme. Make another member an admin first.";
    const { screen } = mount(
      meWith("admin"),
      (method, path) =>
        method === "DELETE" && path === "/api/me"
          ? [409, { error: { code: "last_admin", message: msg } }]
          : [404, {}],
      (ctx) => settingsScreen(ctx, "account"),
    );
    const del = [...screen.node.querySelectorAll("button")].find(
      (b) => b.textContent === "Delete my account",
    ) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    const input = screen.node.querySelector('input[type="email"]') as HTMLInputElement;
    input.value = "ADA@acme.test";
    input.dispatchEvent(new Event("input"));
    expect(del.disabled).toBe(false);
    const click = new MouseEvent("click", { bubbles: true });
    Object.defineProperty(click, "isTrusted", { value: true });
    del.dispatchEvent(click);
    await settle();
    expect(screen.node.textContent).toContain(msg);
  });
});

describe("workspace", () => {
  const workspace = {
    space: { id: S, kind: "workspace", name: "acme", role: "admin" },
    members: [
      {
        person: { id: ME, email: "ada@acme.test", name: "Ada", initials: "AD", tint: "#0ea5e9" },
        role: "admin",
      },
      {
        person: { id: BOB, email: "bob@acme.test", name: "Bob", initials: "BO", tint: "#10b981" },
        role: "member",
      },
    ],
    invitations: [
      {
        email: "cy@acme.test",
        invitedBy: { id: ME, name: "Ada", initials: "AD", tint: "#0ea5e9" },
        createdAt: 1,
      },
      {
        email: "dee@acme.test",
        invitedBy: { id: ME, name: "Ada", initials: "AD", tint: "#0ea5e9" },
        createdAt: 2,
        waiting: "space-limit",
      },
    ],
  };
  const server: Responder = (method, path) =>
    method === "GET" && path === `/api/workspaces/${S}` ? [200, workspace] : [404, {}];

  test("an admin manages members, invites (no email is sent), and sees pending invitations", async () => {
    const { screen } = mount(meWith("admin"), server, (ctx) => workspaceScreen(ctx, S));
    await settle();
    const labels = buttons(screen.node);
    expect(labels).toContain("Make admin");
    expect(labels).toContain("Remove");
    expect(labels).toContain("Invite");
    expect(labels).toContain("Cancel");
    expect(labels).toContain("Delete workspace");
    expect(screen.node.textContent).toContain("No email is sent.");
    expect(screen.node.textContent).toContain("cy@acme.test");
    // S-3: an invitee at the space limit is marked; the others are not.
    const rows = [...screen.node.querySelectorAll(".settings-row")].map((r) => r.textContent ?? "");
    const dee = rows.find((t) => t.includes("dee@acme.test")) ?? "";
    const cy = rows.find((t) => t.includes("cy@acme.test")) ?? "";
    expect(dee).toContain("waiting: member of 50 spaces, needs to leave one");
    expect(cy).not.toContain("waiting");
  });

  test("a member sees the list read-only and may leave", async () => {
    const { screen } = mount(meWith("member"), server, (ctx) => workspaceScreen(ctx, S));
    await settle();
    const labels = buttons(screen.node);
    expect(screen.node.textContent).toContain("Bob");
    for (const hidden of ["Make admin", "Remove", "Invite", "Delete workspace", "Rename"]) {
      expect(labels).not.toContain(hidden);
    }
    expect(labels).toContain("Leave workspace");
  });
});

describe("thread: shares and kept looks", () => {
  test("a failed share-list read says so with Retry; the empty state waits for a good read", async () => {
    let sharesOk = false;
    const server: Responder = (method, path) => {
      if (method === "GET" && path.endsWith("/shares"))
        return sharesOk ? [200, []] : [500, { error: { code: "invalid", message: "Boom." } }];
      return threadServer()(method, path, undefined);
    };
    const { screen } = mount(meWith("member"), server, (ctx) => threadScreen(ctx, S, IID));
    await settle();
    const text = () => screen.node.textContent ?? "";
    expect(text()).toContain("Couldn't load who has access.");
    expect(text()).not.toContain("Only people in this space.");
    sharesOk = true;
    const retry = [...screen.node.querySelectorAll(".share-section button")].find(
      (b) => b.textContent === "Retry",
    ) as HTMLButtonElement;
    const click = new MouseEvent("click", { bubbles: true });
    Object.defineProperty(click, "isTrusted", { value: true });
    retry.dispatchEvent(click);
    await settle();
    expect(text()).toContain("Only people in this space.");
    expect(text()).not.toContain("Couldn't load who has access.");
    screen.dispose?.();
  });

  const SET = "set-1";
  const EDIT: RawInteractionSnapshot = {
    ...SNAP,
    kind: "change",
    state: "implemented",
    change: { intent: "Tighten the copy", method: "variant-set", variantSetId: SET },
  } as RawInteractionSnapshot;
  const pickedSet = {
    setId: SET,
    status: "resolved",
    command: "tighten",
    outcome: "picked",
    pickedVariantId: "v1",
    changeInteractionId: IID,
    expectUrlPrefix: "https://acme.test/pricing",
    variants: [{ variantId: "v1", label: "Calm", program: [], version: 1 }],
    createdAt: 1,
  };
  function editServer(kept: boolean): Responder {
    return (method, path) => {
      if (method === "GET" && path === `/s/${S}/interaction/${IID}`)
        return [
          200,
          {
            interaction: EDIT,
            ...(kept
              ? {
                  kept: {
                    interactionId: IID,
                    setId: SET,
                    root: { kind: "page" },
                    program: [],
                    by: ME,
                    at: 1,
                    label: "Calm",
                  },
                }
              : {}),
          },
        ];
      if (method === "GET" && path === `/s/${S}/variant-set/${SET}`)
        return [200, { set: pickedSet }];
      if (method === "GET" && path.endsWith("/shares")) return [200, []];
      if (method === "GET" && path.endsWith("/captures")) return [200, { captures: [] }];
      return [404, { error: { code: "not_found", message: "Not found." } }];
    };
  }

  test("a pick whose Edit moved on is shown as history, not as Kept", async () => {
    const { screen } = mount(meWith("member"), editServer(false), (ctx) =>
      threadScreen(ctx, S, IID),
    );
    await settle();
    await settle();
    const label = screen.node.querySelector(".kept-look .hero-label")?.textContent;
    expect(label).toBe("Picked");
    screen.dispose?.();
  });

  test("the Kept card shows only while the thread read carries a kept entry", async () => {
    const { screen } = mount(meWith("member"), editServer(true), (ctx) =>
      threadScreen(ctx, S, IID),
    );
    await settle();
    await settle();
    const label = screen.node.querySelector(".kept-look .hero-label")?.textContent;
    expect(label).toBe("Kept");
    screen.dispose?.();
  });
});

describe("thread: the Kept card shows the pinned revision (R2-C11)", () => {
  test("after an agent revised the picked variant, the card shows the look of the version that was picked", async () => {
    const SET = "set-2";
    const look = (captureId: string, variantVersion: number) => ({
      captureId,
      kind: "variant-look",
      revision: 1,
      variantSetId: SET,
      variantId: "v1",
      variantVersion,
      format: "onlay-cap/1",
      parts: [{ name: "witness", role: "witness", mime: "image/webp", byteLen: 4 }],
      createdAt: 1,
      byteLen: 4,
    });
    const edit = {
      ...SNAP,
      kind: "change",
      state: "kept",
      change: { intent: "Tighten", method: "variant-set", variantSetId: SET },
      captures: [look("c-v1", 1), look("c-v3", 3)],
    } as unknown as RawInteractionSnapshot;
    const fetched: string[] = [];
    const server: Responder = (method, path) => {
      if (method === "GET" && path === `/s/${S}/interaction/${IID}`)
        return [
          200,
          {
            interaction: edit,
            kept: {
              interactionId: IID,
              setId: SET,
              root: { kind: "page" },
              program: [],
              by: ME,
              at: 1,
              label: "Calm",
              variantId: "v1",
              version: 1,
            },
          },
        ];
      if (method === "GET" && path === `/s/${S}/variant-set/${SET}`)
        return [
          200,
          {
            set: {
              setId: SET,
              status: "resolved",
              command: "tighten",
              outcome: "picked",
              pickedVariantId: "v1",
              changeInteractionId: IID,
              expectUrlPrefix: "https://acme.test/pricing",
              variants: [{ variantId: "v1", label: "Calm, revised", program: [], version: 3 }],
              createdAt: 1,
            },
          },
        ];
      if (path.includes("/capture/")) {
        fetched.push(path);
        return [200, [1, 2, 3, 4]];
      }
      if (method === "GET" && path.endsWith("/shares")) return [200, []];
      return [404, { error: { code: "not_found", message: "Not found." } }];
    };
    const { screen } = mount(meWith("member"), server, (ctx) => threadScreen(ctx, S, IID));
    await settle();
    await settle();
    await settle();
    expect(screen.node.querySelector(".kept-look .hero-label")?.textContent).toBe("Kept");
    const looks = fetched.filter((p) => p.includes("/part/witness"));
    expect(looks.some((p) => p.includes("/capture/c-v1/"))).toBe(true);
    expect(looks.some((p) => p.includes("/capture/c-v3/"))).toBe(false);
    screen.dispose?.();
  });
});

describe("thread: a kept version with no look of its own (R3-C12)", () => {
  test("says so, and never shows an older version's look as the kept one", async () => {
    const SET = "set-3";
    const edit = {
      ...SNAP,
      kind: "change",
      state: "kept",
      change: { intent: "Tighten", method: "variant-set", variantSetId: SET },
      // Only version 1 was ever captured; version 2 was kept.
      captures: [
        {
          captureId: "c-v1",
          kind: "variant-look",
          revision: 1,
          variantSetId: SET,
          variantId: "v1",
          variantVersion: 1,
          format: "onlay-cap/1",
          parts: [{ name: "witness", role: "witness", mime: "image/webp", byteLen: 4 }],
          createdAt: 1,
          byteLen: 4,
        },
      ],
    } as unknown as RawInteractionSnapshot;
    const fetched: string[] = [];
    const server: Responder = (method, path) => {
      if (method === "GET" && path === `/s/${S}/interaction/${IID}`)
        return [
          200,
          {
            interaction: edit,
            kept: {
              interactionId: IID,
              setId: SET,
              root: { kind: "page" },
              program: [],
              by: ME,
              at: 1,
              label: "Calm",
              variantId: "v1",
              version: 2,
            },
          },
        ];
      if (method === "GET" && path === `/s/${S}/variant-set/${SET}`)
        return [
          200,
          {
            set: {
              setId: SET,
              status: "resolved",
              command: "tighten",
              outcome: "picked",
              pickedVariantId: "v1",
              changeInteractionId: IID,
              expectUrlPrefix: "https://acme.test/pricing",
              variants: [{ variantId: "v1", label: "Calm", program: [], version: 2 }],
              createdAt: 1,
            },
          },
        ];
      if (path.includes("/capture/")) {
        fetched.push(path);
        return [200, [1, 2, 3, 4]];
      }
      if (method === "GET" && path.endsWith("/shares")) return [200, []];
      return [404, { error: { code: "not_found", message: "Not found." } }];
    };
    const { screen } = mount(meWith("member"), server, (ctx) => threadScreen(ctx, S, IID));
    await settle();
    await settle();
    await settle();
    expect(screen.node.querySelector(".kept-look .hero-label")?.textContent).toBe("Kept");
    expect(screen.node.querySelector(".kept-look img")).toBeNull();
    expect(screen.node.querySelector(".kept-look")?.textContent).toContain(
      "No captured look for the version that was kept.",
    );
    expect(fetched.some((p) => p.includes("/capture/c-v1/"))).toBe(false);
    screen.dispose?.();
  });
});

describe("inbox: why a row is there", () => {
  test("a thread just shared with you says so; an unknown reason adds nothing", async () => {
    const base = {
      kind: "comment",
      state: "open",
      anchorLabel: "page-level",
      fromActorId: BOB,
      waitingOnIds: [ME],
      ts: 1,
      spaceId: S,
    };
    const server: Responder = (method, path) => {
      if (method === "GET" && path === "/api/inbox")
        return [
          200,
          {
            needsYou: [
              { ...base, interactionId: IID, text: "shared one", because: "shared" },
              {
                ...base,
                interactionId: "22222222-2222-4333-8444-555555555555",
                text: "odd one",
                because: "from-the-future",
              },
            ],
            waiting: [],
            recent: [],
            needsYouCount: 2,
          },
        ];
      if (method === "GET" && path.endsWith("/interaction")) return [200, { interactions: [] }];
      return [200, {}];
    };
    const { screen } = mount(meWith("guest"), server, (ctx) => inboxScreen(ctx));
    await settle();
    await settle();
    const text = screen.node.textContent ?? "";
    expect(text).toContain("shared one");
    expect(text).toContain("Shared with you");
    expect(text).not.toContain("from-the-future");
    expect(screen.node.querySelectorAll(".because")).toHaveLength(1);
    screen.dispose?.();
  });
});

describe("compose", () => {
  test("many spaces: one field names the space, and its menu lists them all with a search", async () => {
    const spaces: SpaceSummary[] = [
      { id: "s_pppppppppppppppppppp", kind: "personal", name: "Personal", role: "admin" },
      ...Array.from(
        { length: 49 },
        (_, i): SpaceSummary => ({
          id: `s_${String(i).padStart(20, "w")}`,
          kind: "workspace",
          name: `team ${i + 1}`,
          role: "member",
        }),
      ),
    ];
    const me = { ...meWith("member"), spaces };
    const { screen } = mount(
      me,
      () => [404, {}],
      (ctx) => composeScreen(ctx),
    );
    await settle();
    const fields = screen.node.querySelectorAll(".space-select-field");
    expect(fields).toHaveLength(1);
    expect(screen.node.querySelectorAll(".space-choice .seg")).toHaveLength(0);
    const field = fields[0] as HTMLElement;
    expect(field.textContent).toBe("PersonalJust you");
    const options = screen.node.querySelectorAll(".space-choice [role=option]");
    expect(options).toHaveLength(50);
    expect(
      screen.node.querySelector(".space-choice [role=combobox]")?.getAttribute("aria-label"),
    ).toBe("Search spaces");
  });

  const TWO: SpaceSummary[] = [
    { id: "s_pppppppppppppppppppp", kind: "personal", name: "Personal", role: "admin" },
    { id: "s_tttttttttttttttttttt", kind: "workspace", name: "team", role: "member" },
  ];
  const write = (node: HTMLElement, text: string) => {
    const ta = node.querySelector("textarea") as HTMLTextAreaElement;
    ta.value = text;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    return ta;
  };
  const sendButton = (node: HTMLElement) =>
    [...node.querySelectorAll("button")].find((b) => b.textContent === "Send") as HTMLElement;
  const choose = (node: HTMLElement, name: string) => {
    (node.querySelector(".space-select-field") as HTMLElement).click();
    const row = [...node.querySelectorAll("[role=option]")].find((o) =>
      o.textContent?.startsWith(name),
    ) as HTMLElement;
    row.click();
  };
  const menuOpen = (node: HTMLElement) =>
    (node.querySelector(".space-select-menu") as HTMLElement).style.display !== "none";
  const trusted = () => {
    // happy-dom marks clicks untrusted; the field's gate is tested in render.
    const proto = (win as Window).Event.prototype as unknown as Record<string, unknown>;
    Object.defineProperty(proto, "isTrusted", { configurable: true, get: () => true });
    return () => {
      delete proto.isTrusted;
    };
  };

  test("a space lost since it was chosen: Send sends nothing, keeps the draft and says so; a refresh closes the menu", async () => {
    const untrust = trusted();
    try {
      const me = { ...meWith("member"), spaces: TWO };
      const { screen, calls, ctx } = mount(
        me,
        () => [404, {}],
        (c) => composeScreen(c),
      );
      await settle();
      choose(screen.node, "team");
      (screen.node.querySelector(".space-select-field") as HTMLElement).click();
      expect(menuOpen(screen.node)).toBe(true);
      // A refresh round learns "team" is gone: the open menu closes.
      ctx.me = { ...me, spaces: [TWO[0] as SpaceSummary] };
      await screen.refresh?.();
      expect(menuOpen(screen.node)).toBe(false);
      const ta = write(screen.node, "the hero image is blurry");
      sendButton(screen.node).click();
      await settle();
      expect(calls.filter((c) => c.startsWith("POST"))).toEqual([]);
      expect(ta.value).toBe("the hero image is blurry");
      expect(screen.node.textContent).toContain(
        "You're no longer a member of that space. Choose another space, then send again.",
      );
      // The menu offers what is there now.
      (screen.node.querySelector(".space-select-field") as HTMLElement).click();
      expect(
        [...screen.node.querySelectorAll("[role=option] .space-select-name")].map(
          (o) => o.textContent,
        ),
      ).toEqual(["Personal"]);
      screen.dispose?.();
    } finally {
      untrust();
    }
  });

  test("once sending starts the space is fixed: the menu closes, and nothing chosen moves the Comment", async () => {
    const untrust = trusted();
    try {
      const { screen, calls } = mount(
        { ...meWith("member"), spaces: TWO },
        (method, path) =>
          method === "POST" && path.endsWith("/interaction")
            ? [200, { interactionId: IID }]
            : [404, {}],
        (ctx) => composeScreen(ctx),
      );
      await settle();
      choose(screen.node, "team");
      write(screen.node, "ship it");
      const field = screen.node.querySelector(".space-select-field") as HTMLElement;
      field.click();
      expect(menuOpen(screen.node)).toBe(true);
      sendButton(screen.node).click();
      // Sending: the menu is closed and the field does not open.
      expect(menuOpen(screen.node)).toBe(false);
      field.click();
      expect(menuOpen(screen.node)).toBe(false);
      await settle();
      expect(calls.filter((c) => c.startsWith("POST"))).toEqual([
        "POST /s/s_tttttttttttttttttttt/interaction",
      ]);
      // Posted: the field stays as it was sent.
      field.click();
      expect(menuOpen(screen.node)).toBe(false);
      expect(field.textContent).toBe("team");
      screen.dispose?.();
    } finally {
      untrust();
    }
  });

  test("one space: no space field", async () => {
    const { screen } = mount(
      meWith("member"),
      () => [404, {}],
      (ctx) => composeScreen(ctx),
    );
    await settle();
    expect(screen.node.querySelector(".space-select")).toBeNull();
  });
});
