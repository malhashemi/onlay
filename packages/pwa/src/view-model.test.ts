// Web-app view-model: the hash-route grammar, draft keys, the merged Inbox and
// its space filter, agent-work labels, search rows, what a role lets a person
// do (guest gating), and mention handles.
import { describe, expect, test } from "bun:test";
import type {
  InboxResponse,
  InboxRow,
  PersonSummary,
  RawInteractionSnapshot,
  SpaceSummary,
} from "@onlay/protocol";
import { mentionablesFor, slugOf } from "./mentions";
import {
  AGENT_WORK_LABEL,
  capabilitiesFor,
  creatorOf,
  draftKey,
  filterInbox,
  filterSearchRows,
  hashFor,
  kindLabel,
  memberSpaces,
  needsYouCopy,
  parseHash,
  type Route,
  rowLocation,
  rowSpaceName,
  rowText,
  searchRowOf,
  showsSpaces,
  signInUrl,
  validFilter,
  webUrl,
  workspaceNameHint,
} from "./view-model";

const S1 = "s_aaaaaaaaaaaaaaaaaaaa";
const S2 = "s_bbbbbbbbbbbbbbbbbbbb";
const IID = "11111111-2222-4333-8444-555555555555";

const PERSONAL: SpaceSummary = { id: S1, kind: "personal", name: "personal", role: "admin" };
const ACME: SpaceSummary = { id: S2, kind: "workspace", name: "acme", role: "member" };

function row(spaceId: string, id: string, extra: Partial<InboxRow> = {}): InboxRow {
  return {
    spaceId,
    interactionId: id,
    kind: "comment",
    state: "open",
    anchorLabel: "hero",
    text: "hello",
    fromActorId: "p_aaaaaaaaaaaaaaaaaaaa",
    waitingOnIds: [],
    ts: 1,
    ...extra,
  };
}

describe("parseHash", () => {
  test("empty / hash-only / #/inbox all resolve to Inbox (the home)", () => {
    expect(parseHash("")).toEqual({ name: "inbox" });
    expect(parseHash("#")).toEqual({ name: "inbox" });
    expect(parseHash("#/inbox")).toEqual({ name: "inbox" });
  });

  test("a thread carries its space and interaction", () => {
    expect(parseHash(`#/t/${S1}/${IID}`)).toEqual({ name: "thread", spaceId: S1, id: IID });
  });

  test("the round carries its space and page", () => {
    const url = "https://x.test/a?b=1#c";
    expect(parseHash(`#/round/${S1}?url=${encodeURIComponent(url)}`)).toEqual({
      name: "round",
      spaceId: S1,
      url,
    });
    expect(parseHash(`#/round/${S1}`)).toEqual({ name: "inbox" });
  });

  test("the round routes only web pages", () => {
    for (const bad of [
      "javascript:alert(1)",
      "javascript://x.test/%0aalert(1)",
      "data:text/html,x",
      "nope",
    ])
      expect(parseHash(`#/round/${S1}?url=${encodeURIComponent(bad)}`)).toEqual({ name: "inbox" });
    expect(webUrl("http://x.test/a")).toBe("http://x.test/a");
    expect(webUrl("ftp://x.test/a")).toBeNull();
    expect(webUrl(undefined)).toBeNull();
  });

  test("settings and its sub-screens", () => {
    expect(parseHash("#/settings")).toEqual({ name: "settings", page: "index" });
    expect(parseHash("#/settings/account")).toEqual({ name: "settings", page: "account" });
    expect(parseHash("#/settings/spaces")).toEqual({ name: "settings", page: "spaces" });
    expect(parseHash("#/settings/deployment")).toEqual({ name: "settings", page: "deployment" });
    expect(parseHash("#/settings/agent")).toEqual({ name: "settings", page: "agent" });
    expect(parseHash(`#/settings/workspace/${S2}`)).toEqual({ name: "workspace", spaceId: S2 });
    expect(parseHash("#/settings/nope")).toEqual({ name: "settings", page: "index" });
  });

  test("hostile or retired fragments fall back to Inbox", () => {
    expect(parseHash("#/t/s_x/../../etc")).toEqual({ name: "inbox" });
    expect(parseHash(`#/t/${S1}/not-a-uuid`)).toEqual({ name: "inbox" });
    expect(parseHash(`#/i/${IID}`)).toEqual({ name: "inbox" });
    expect(parseHash("#/pair")).toEqual({ name: "inbox" });
  });

  test("hashFor round-trips every route", () => {
    const routes: Route[] = [
      { name: "inbox" },
      { name: "compose" },
      { name: "thread", spaceId: S1, id: IID },
      { name: "round", spaceId: S2, url: "https://x.test/p?q=1" },
      { name: "settings", page: "index" },
      { name: "settings", page: "agent" },
      { name: "workspace", spaceId: S2 },
    ];
    for (const r of routes) expect(parseHash(hashFor(r))).toEqual(r);
  });
});

describe("sign-in", () => {
  test("return_to carries the current path and hash", () => {
    expect(signInUrl({ pathname: "/app/", search: "", hash: `#/t/${S1}/${IID}` })).toBe(
      `/auth/login?return_to=%2Fapp%2F%23%2Ft%2F${S1}%2F${IID}`,
    );
  });
});

describe("draft keys", () => {
  test("scoped per route+interaction (the store adds the person)", () => {
    expect(draftKey("reply", IID)).toBe(`reply:${IID}`);
    expect(draftKey("reply", IID)).not.toBe(draftKey("variant-comment", IID));
  });
});

describe("the merged Inbox", () => {
  const inbox: InboxResponse = {
    needsYou: [row(S1, "a"), row(S2, "b")],
    waiting: [row(S2, "c")],
    recent: [row(S1, "d")],
    needsYouCount: 2,
  };

  test("no filter keeps every space's rows", () => {
    const f = filterInbox(inbox, null);
    expect(f.needsYou.map((r) => r.interactionId)).toEqual(["a", "b"]);
    expect(f.waiting.length).toBe(1);
    expect(f.recent.length).toBe(1);
  });

  test("a space filter narrows every section", () => {
    const f = filterInbox(inbox, S2);
    expect(f.needsYou.map((r) => r.interactionId)).toEqual(["b"]);
    expect(f.waiting.map((r) => r.interactionId)).toEqual(["c"]);
    expect(f.recent).toEqual([]);
  });

  test("space chips and row space names only with more than one space", () => {
    expect(showsSpaces([PERSONAL])).toBe(false);
    expect(showsSpaces([PERSONAL, ACME])).toBe(true);
    expect(rowSpaceName(row(S2, "x"), [PERSONAL])).toBeNull();
    expect(rowSpaceName(row(S2, "x"), [PERSONAL, ACME])).toBe("acme");
  });

  test("a filter naming a space no longer seen falls back to all", () => {
    expect(validFilter(S2, [PERSONAL, ACME])).toBe(S2);
    expect(validFilter(S2, [PERSONAL])).toBeNull();
    expect(validFilter("s_zzzzzzzzzzzzzzzzzzzz", [PERSONAL, ACME])).toBeNull();
  });

  test("agent work reads for agent / taken / answered", () => {
    expect(AGENT_WORK_LABEL).toEqual({
      pending: "for agent",
      taken: "taken",
      answered: "answered",
    });
  });

  test("row copy", () => {
    expect(rowText(row(S1, "a", { text: "  " }))).toBe("Comment");
    expect(rowLocation(row(S1, "a", { unanchored: true }))).toBe("Inbox · unanchored");
    expect(rowLocation(row(S1, "a", { anchorLost: true }))).toBe("hero · anchor lost");
    expect(kindLabel("change")).toBe("Edit");
    expect(needsYouCopy(1)).toBe("1 needs you");
    expect(needsYouCopy(3)).toBe("3 need you");
  });
});

describe("search rows", () => {
  const snap = {
    id: IID,
    kind: "comment",
    anchor: { level: "unanchored" },
    authorId: "p_aaaaaaaaaaaaaaaaaaaa",
    participants: [],
    waitingOn: [],
    state: "open",
    thread: [{ msgId: "m1", authorId: "p_aaaaaaaaaaaaaaaaaaaa", body: { text: "pricing" }, ts: 5 }],
    agentWork: { status: "pending", requestedBy: "p_aaaaaaaaaaaaaaaaaaaa", requestedAt: 4 },
    createdAt: 1,
  } as RawInteractionSnapshot;

  test("searchRowOf carries the space and the agent work status", () => {
    const r = searchRowOf(S2, snap);
    expect(r.spaceId).toBe(S2);
    expect(r.unanchored).toBe(true);
    expect(r.agentWork).toBe("pending");
  });

  test("a search row's text is formatted once: a fence line inside the code stays", () => {
    const code = {
      ...snap,
      thread: [
        {
          msgId: "m1",
          authorId: "p_aaaaaaaaaaaaaaaaaaaa",
          body: { text: "```md\n```js\nx\n```" },
          ts: 5,
        },
      ],
    } as RawInteractionSnapshot;
    expect(rowText(searchRowOf(S2, code))).toBe("```js\nx");
  });

  test("needs-you first, then newest", () => {
    const rows = [
      row(S1, "old", { ts: 1, text: "pricing a" }),
      row(S1, "new", { ts: 9, text: "pricing b" }),
    ];
    const out = filterSearchRows(rows, "pricing", new Set(["old"]), () => "Ada");
    expect(out.map((r) => r.interactionId)).toEqual(["old", "new"]);
  });
});

describe("what a role lets a person do", () => {
  test("a guest sees reply, react, attach and pick only", () => {
    const g = capabilitiesFor("guest");
    const on = Object.entries(g)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .sort();
    expect(on).toEqual(["attach", "pick", "react", "reply"]);
  });

  test("members and admins get the full thread", () => {
    for (const role of ["member", "admin"] as const) {
      const c = capabilitiesFor(role);
      expect(Object.values(c).every(Boolean)).toBe(true);
    }
  });

  test("an unknown space role is treated as a guest", () => {
    expect(capabilitiesFor(undefined).share).toBe(false);
  });

  test("guest spaces are never offered for composing or listed in settings", () => {
    const guest: SpaceSummary = {
      id: "s_cccccccccccccccccccc",
      kind: "workspace",
      name: "theirs",
      role: "guest",
    };
    expect(memberSpaces([PERSONAL, ACME, guest]).map((s) => s.name)).toEqual(["personal", "acme"]);
  });
});

describe("mention handles", () => {
  const person = (id: string, name: string): PersonSummary => ({
    id,
    name,
    initials: name.slice(0, 2).toUpperCase(),
    tint: "#000000",
  });

  test("names become slugs", () => {
    expect(slugOf("Ada Lovelace")).toBe("ada-lovelace");
    expect(slugOf("Zoë  O'Neil")).toBe("zoe-o-neil");
    expect(slugOf("世界")).toBe("person");
  });

  test("collisions disambiguate in id order; agent is never a person's handle", () => {
    const m = mentionablesFor(
      [
        person("p_bbbbbbbbbbbbbbbbbbbb", "Ada"),
        person("p_aaaaaaaaaaaaaaaaaaaa", "Ada"),
        person("p_cccccccccccccccccccc", "Agent"),
      ],
      { agent: true },
    );
    expect(m.get("ada")?.id).toBe("p_aaaaaaaaaaaaaaaaaaaa");
    expect(m.get("ada-2")?.id).toBe("p_bbbbbbbbbbbbbbbbbbbb");
    expect(m.get("agent")?.agent).toBe(true);
    expect(m.get("agent-2")?.id).toBe("p_cccccccccccccccccccc");
  });

  test("@agent is left out when not allowed", () => {
    expect(mentionablesFor([], { agent: false }).has("agent")).toBe(false);
  });
});

describe("workspace names", () => {
  test("live feedback comes from the protocol's rule", () => {
    expect(workspaceNameHint("")).toEqual({ ok: false, message: "" });
    expect(workspaceNameHint("acme-design")).toEqual({ ok: true, message: "" });
    expect(workspaceNameHint("Acme").message).toBe(
      "Use lowercase letters, digits and hyphens, and don't start with a hyphen.",
    );
    expect(workspaceNameHint("-acme").ok).toBe(false);
    expect(workspaceNameHint("api").message).toBe("The name api is reserved.");
    expect(workspaceNameHint("a".repeat(64)).message).toBe("Use 1 to 63 characters.");
  });
});

describe("workspace creators", () => {
  test("an email or a domain, lower-cased; anything else is refused", () => {
    expect(creatorOf(" Ada@Acme.test ")).toEqual({ entry: "ada@acme.test", kind: "email" });
    expect(creatorOf("acme.test")).toEqual({ entry: "acme.test", kind: "domain" });
    expect(creatorOf("@acme.test")).toEqual({ entry: "acme.test", kind: "domain" });
    expect(creatorOf("acme")).toBeNull();
    expect(creatorOf("a@b")).toBeNull();
    expect(creatorOf("")).toBeNull();
  });
});
