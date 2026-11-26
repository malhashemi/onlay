/** The hosted redesign's additive wire changes (spec §5, §7, §8). */
import { describe, expect, test } from "bun:test";
import * as z from "zod/mini";
import {
  AgentWorkListingSchema,
  InboxResponseSchema,
  InboxRowSchema,
  InternalAccessChangedRequestSchema,
  InternalCredentialRevokedRequestSchema,
  InternalPersonRequestSchema,
  InternalPersonSchema,
  MeResponseSchema,
  OriginsResponseSchema,
  PEEK_PARAM,
  WorkspaceCreateRequestSchema,
} from "./api";
import { ACCESS_EPOCH_HEADER, decodeCaller, encodeCaller, PERSON_HEADER } from "./caller";
import {
  AgentWorkSchema,
  CHANGE_STATES,
  ChangePayloadSchema,
  InteractionSnapshotSchema,
  LIVE_STATES,
  RichTextSchema,
} from "./interaction";
import { LIMITS, MIN_CLIENT_PROTOCOL, PROTOCOL_VERSION } from "./limits";
import { parseInbound, parseOutbound } from "./parse";
import {
  KeptEditSchema,
  maxOpsFor,
  PageMutationProgramSchema,
  programBytes,
  VariantPickRequestSchema,
} from "./variant";

const IID = "6f0d1b2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const PID = "p_abcdefghijklmnopqrst";
const SID = "s_abcdefghijklmnopqrst";
const PAGE = "https://example.com/pricing";

const element = {
  selector: "main > h1",
  tag: "h1",
  classes: [],
  textSnippet: "Pricing",
  markup: "<h1>Pricing</h1>",
};

const create = {
  v: 1,
  type: "variant-create",
  nonce: "n1",
  frameUrl: PAGE,
  command: "make it friendlier",
  count: 3,
};

test("protocol versions start at 2", () => {
  expect(PROTOCOL_VERSION).toBe(2);
  expect(MIN_CLIENT_PROTOCOL).toBe(2);
});

describe("agent mark and @agent", () => {
  test("rich text carries the agent token beside actor tokens", () => {
    const body = {
      text: "@agent tighten this",
      tokens: [{ t: "agent" }, { t: "actor", actorId: PID }],
    };
    expect(z.safeParse(RichTextSchema, body).success).toBe(true);
  });

  test("a snapshot carries agent-marked messages and agent work", () => {
    const snap = {
      id: IID,
      kind: "comment",
      url: PAGE,
      anchor: { level: "page" },
      authorId: PID,
      participants: [PID],
      waitingOn: [],
      state: "open",
      thread: [{ msgId: "m1", authorId: PID, body: { text: "done" }, ts: 1, agent: true }],
      agentWork: { status: "answered", requestedBy: PID, requestedAt: 0, answeredAt: 1 },
      createdAt: 0,
    };
    const r = z.safeParse(InteractionSnapshotSchema, snap);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.thread[0]?.agent).toBe(true);
  });

  test("agent work refuses unknown statuses", () => {
    expect(
      z.safeParse(AgentWorkSchema, { status: "done", requestedBy: PID, requestedAt: 0 }).success,
    ).toBe(false);
  });
});

describe("kept Edits", () => {
  test("kept is a live Edit state", () => {
    expect(CHANGE_STATES).toContain("kept");
    expect(LIVE_STATES).toContain("kept");
  });

  test("Edit creation carries ownsSource and provenance", () => {
    const r = z.safeParse(ChangePayloadSchema, {
      intent: "x",
      method: "manual-batch",
      ownsSource: true,
      provenance: "git@example.com:acme/site@abc;main;clean",
    });
    expect(r.success).toBe(true);
  });

  test("a kept entry rides the page snapshot", () => {
    const kept = {
      interactionId: IID,
      setId: "vs-1",
      root: { kind: "page" },
      program: [{ op: "setText", target: "h1", text: "Plans" }],
      by: PID,
      at: 5,
      label: "Friendlier",
    };
    expect(z.safeParse(KeptEditSchema, kept).success).toBe(true);
    const r = parseOutbound(
      JSON.stringify({
        v: 1,
        type: "interactions-state",
        url: PAGE,
        interactions: [],
        kept: [kept],
      }),
    );
    expect(r.ok).toBe(true);
  });
});

describe("variant roots", () => {
  test("the element-only creation is retired from the wire; a block or page root parses", () => {
    expect(parseInbound(JSON.stringify({ ...create, element })).ok).toBe(false);
    const block = parseInbound(JSON.stringify({ ...create, root: { kind: "block", element } }));
    expect(block.ok && block.msg.type === "variant-create" && block.msg.root).toEqual({
      kind: "block",
      element,
    } as never);
    const page = parseInbound(JSON.stringify({ ...create, root: { kind: "page" } }));
    expect(page.ok && page.msg.type === "variant-create" && page.msg.root).toEqual({
      kind: "page",
    });
  });

  test("creation without a root is refused", () => {
    expect(parseInbound(JSON.stringify(create)).ok).toBe(false);
  });

  test("page programs allow 256 ops; block budgets stay at 64", () => {
    const op = { op: "setText", target: "h1", text: "x" };
    const at = (n: number) => Array.from({ length: n }, () => op);
    expect(z.safeParse(PageMutationProgramSchema, at(LIMITS.MAX_MUTATION_OPS_PAGE)).success).toBe(
      true,
    );
    expect(
      z.safeParse(PageMutationProgramSchema, at(LIMITS.MAX_MUTATION_OPS_PAGE + 1)).success,
    ).toBe(false);
    expect(maxOpsFor({ kind: "page" })).toBe(256);
    expect(maxOpsFor({ kind: "block", element })).toBe(64);
  });
});

describe("frames", () => {
  test("hello may name its protocol", () => {
    const hello = {
      v: 1,
      type: "hello",
      sessionId: IID,
      bootCount: 1,
      swRestarts: 0,
      connects: 1,
      protocol: 2,
    };
    const r = parseInbound(JSON.stringify(hello));
    expect(r.ok).toBe(true);
    if (r.ok && r.msg.type === "hello") expect(r.msg.protocol).toBe(2);
  });

  test("origins and tick frames parse; tick carries nothing", () => {
    expect(
      parseOutbound(JSON.stringify({ v: 1, type: "origins", origins: ["https://a.test"] })).ok,
    ).toBe(true);
    expect(parseOutbound(JSON.stringify({ v: 1, type: "tick" })).ok).toBe(true);
    expect(parseOutbound(JSON.stringify({ v: 1, type: "origins" })).ok).toBe(false);
  });
});

describe("edge API", () => {
  const person = { id: PID, email: "ada@example.com", name: "Ada", initials: "A", tint: "#000" };
  const row = {
    interactionId: IID,
    kind: "comment",
    state: "open",
    anchorLabel: "page-level",
    text: "hello",
    fromActorId: PID,
    waitingOnIds: [],
    ts: 1,
    agentWork: "pending",
  };

  test("me lists spaces with roles", () => {
    const r = z.safeParse(MeResponseSchema, {
      person,
      spaces: [{ id: SID, kind: "personal", name: "Ada", role: "admin" }],
      canCreateWorkspace: false,
      superAdmin: false,
    });
    expect(r.success).toBe(true);
  });

  test("inbox rows are attention rows plus a space id", () => {
    const ok = { needsYou: [{ ...row, spaceId: SID }], waiting: [], recent: [], needsYouCount: 1 };
    expect(z.safeParse(InboxResponseSchema, ok).success).toBe(true);
    const missing = { ...ok, needsYou: [row] };
    expect(z.safeParse(InboxResponseSchema, missing).success).toBe(false);
  });

  test("origins are keyed by space id", () => {
    expect(
      z.safeParse(OriginsResponseSchema, { spaces: { [SID]: ["https://a.test"] } }).success,
    ).toBe(true);
    expect(z.safeParse(OriginsResponseSchema, { spaces: { nope: [] } }).success).toBe(false);
  });

  test("workspace creation validates the name", () => {
    expect(z.safeParse(WorkspaceCreateRequestSchema, { name: "acme" }).success).toBe(true);
    expect(z.safeParse(WorkspaceCreateRequestSchema, { name: "api" }).success).toBe(false);
  });

  test("agent-work listings split yours from teammates", () => {
    const item = {
      ref: `${SID}/${IID}`,
      kind: "change",
      summary: "make it friendlier",
      url: PAGE,
      spaceId: SID,
      spaceName: "acme",
      requestedBy: { id: PID, name: "Ada", initials: "A", tint: "#000" },
      requestedAt: 1,
      status: "taken",
    };
    expect(z.safeParse(AgentWorkListingSchema, { yours: [item], teammates: [] }).success).toBe(
      true,
    );
  });

  test("internal control bodies validate access and shares", () => {
    expect(
      z.safeParse(InternalAccessChangedRequestSchema, { personId: PID, access: null }).success,
    ).toBe(true);
    expect(
      z.safeParse(InternalAccessChangedRequestSchema, {
        personId: PID,
        access: { kind: "member", role: "member" },
      }).success,
    ).toBe(true);
  });
});

test("welcome carries the caller's person and space summary", () => {
  const r = parseOutbound(
    JSON.stringify({
      v: 1,
      type: "welcome",
      sessionId: IID,
      resumedFromSeq: 0,
      serverTime: 1,
      needsYouCount: 2,
      person: { id: PID, name: "Ada", initials: "A", tint: "#123456" },
      space: { id: SID, kind: "workspace", name: "acme", role: "member" },
    }),
  );
  expect(r.ok).toBe(true);
});

describe("review fixes: picks, program sizes, control calls, attention count", () => {
  test("a pick names the variant and the version previewed; index is only a hint", () => {
    const pick = { v: 1, type: "variant-pick", setId: "vs-1", frameUrl: PAGE };
    expect(parseInbound(JSON.stringify({ ...pick, variantId: "v1", version: 2 })).ok).toBe(true);
    expect(
      parseInbound(JSON.stringify({ ...pick, variantId: "v1", version: 2, index: 0 })).ok,
    ).toBe(true);
    expect(parseInbound(JSON.stringify({ ...pick, index: 0 })).ok).toBe(false);
    expect(parseInbound(JSON.stringify({ ...pick, variantId: "v1", version: 0 })).ok).toBe(false);
    expect(z.safeParse(VariantPickRequestSchema, { variantId: "v1", version: 1 }).success).toBe(
      true,
    );
    expect(z.safeParse(VariantPickRequestSchema, { index: 0 }).success).toBe(false);
  });

  test("program sizes are measured in UTF-8 bytes of the serialized program", () => {
    expect(LIMITS.MAX_PROGRAM_BYTES).toBe(262_144);
    expect(LIMITS.MAX_SET_PROGRAM_BYTES).toBe(1_048_576);
    const ascii = [{ op: "setText" as const, target: ":scope", text: "abc" }];
    expect(programBytes(ascii)).toBe(JSON.stringify(ascii).length);
    const wide = [{ op: "setText" as const, target: ":scope", text: "é🙂" }];
    expect(programBytes(wide)).toBe(JSON.stringify(wide).length - 3 + 2 + 4);
  });

  test("credential-revoked names the person and, optionally, the credentials", () => {
    expect(z.safeParse(InternalCredentialRevokedRequestSchema, { personId: PID }).success).toBe(
      true,
    );
    expect(
      z.safeParse(InternalCredentialRevokedRequestSchema, {
        personId: PID,
        credentialIds: ["ses_1", "tok_2"],
      }).success,
    ).toBe(true);
    expect(z.safeParse(InternalCredentialRevokedRequestSchema, { personId: "x" }).success).toBe(
      false,
    );
  });

  test("the attention frame may carry the full needs-you count", () => {
    const frame = {
      v: 1,
      type: "attention",
      person: { id: PID, name: "Ada", initials: "A", tint: "#336699" },
      needsYou: [],
      waiting: [],
      recent: [],
      needsYouCount: 73,
    };
    expect(parseOutbound(JSON.stringify(frame)).ok).toBe(true);
    expect(parseOutbound(JSON.stringify({ ...frame, needsYouCount: -1 })).ok).toBe(false);
  });

  test("the people list may mark who holds a share now", () => {
    const person = { id: PID, name: "Gus", initials: "G", tint: "#333333", member: false };
    expect(z.safeParse(InternalPersonSchema, { ...person, guest: true }).success).toBe(true);
    expect(z.safeParse(InternalPersonSchema, person).success).toBe(true);
  });

  test("a kept entry may name the picked variant and version; a batch's names neither", () => {
    const base = {
      interactionId: IID,
      root: { kind: "page" },
      program: [],
      by: PID,
      at: 1,
      label: "Calm",
    };
    expect(z.safeParse(KeptEditSchema, base).success).toBe(true);
    const picked = { ...base, setId: "vs-1", variantId: "v1", version: 2 };
    expect(z.safeParse(KeptEditSchema, picked).success).toBe(true);
    expect(z.safeParse(KeptEditSchema, { ...picked, version: 0 }).success).toBe(false);
    expect(z.safeParse(KeptEditSchema, { ...picked, version: 1.5 }).success).toBe(false);
  });

  test("an attention row may say why it is there; an unknown reason still parses", () => {
    const row = {
      interactionId: IID,
      kind: "comment",
      state: "open",
      anchorLabel: "page-level",
      text: "for you",
      fromActorId: PID,
      waitingOnIds: [],
      ts: 1,
    };
    const frame = (r: object) =>
      JSON.stringify({
        v: 1,
        type: "attention",
        person: { id: PID, name: "Gus", initials: "G", tint: "#333333" },
        needsYou: [r],
        waiting: [],
        recent: [],
      });
    expect(parseOutbound(frame({ ...row, because: "shared" })).ok).toBe(true);
    expect(parseOutbound(frame(row)).ok).toBe(true);
    // A reason this client does not know still parses (and is shown as nothing).
    expect(parseOutbound(frame({ ...row, because: "a-reason-from-later" })).ok).toBe(true);
  });

  test("a space holds at most 5000 live interactions", () => {
    expect(LIMITS.MAX_LIVE_INTERACTIONS).toBe(5_000);
  });

  test("the person header and the access-epoch header are named", () => {
    expect(PERSON_HEADER).toBe("Onlay-Person");
    expect(ACCESS_EPOCH_HEADER).toBe("X-Onlay-Access-Epoch");
  });
});

test("an attention frame may carry the absolute needs-you count (the rows are capped)", () => {
  const frame = {
    v: 1,
    type: "attention",
    person: { id: PID, name: "Ada", initials: "A", tint: "#123456" },
    needsYou: [],
    waiting: [],
    recent: [],
  };
  const withCount = parseOutbound(JSON.stringify({ ...frame, needsYouCount: 250 }));
  expect(withCount.ok && withCount.msg.type === "attention" && withCount.msg.needsYouCount).toBe(
    250,
  );
  expect(parseOutbound(JSON.stringify(frame)).ok).toBe(true);
  expect(parseOutbound(JSON.stringify({ ...frame, needsYouCount: -1 })).ok).toBe(false);
});

test("a kept entry may name the picked variant and the revision that was picked", () => {
  const kept = {
    interactionId: IID,
    setId: "vs-1",
    root: { kind: "page" },
    program: [],
    by: PID,
    at: 5,
    label: "Friendlier",
    variantId: "v-2",
    version: 3,
  };
  const r = z.safeParse(KeptEditSchema, kept);
  expect(r.success && r.data.variantId === "v-2" && r.data.version === 3).toBe(true);
  expect(z.safeParse(KeptEditSchema, { ...kept, version: -1 }).success).toBe(false);
});

test("an Inbox row may say why it is there, as an open tag", () => {
  const row = {
    interactionId: IID,
    kind: "comment",
    state: "open",
    anchorLabel: "page-level",
    text: "x",
    fromActorId: PID,
    waitingOnIds: [],
    ts: 1,
    spaceId: SID,
  };
  const shared = z.safeParse(InboxRowSchema, { ...row, because: "shared" });
  expect(shared.success && shared.data.because).toBe("shared");
  expect(z.safeParse(InboxRowSchema, { ...row, because: "a-reason-from-later" }).success).toBe(
    true,
  );
});

describe("round 2 wire changes", () => {
  test("the caller header may carry the credential's generation", () => {
    const caller = {
      personId: PID,
      name: "Ada",
      initials: "A",
      tint: "#111111",
      class: "full",
      access: { kind: "member", role: "member" },
      credentialId: "tok_1",
      accessEpoch: 3,
      credentialGeneration: 4,
    } as const;
    expect(decodeCaller(encodeCaller(caller))).toEqual(caller);
    expect(decodeCaller(encodeCaller({ ...caller, credentialGeneration: -1 }))).toBeNull();
    expect(decodeCaller(encodeCaller({ ...caller, credentialGeneration: 1.5 }))).toBeNull();
  });

  test("credential-revoked may carry the person's new minimum generation", () => {
    expect(
      z.safeParse(InternalCredentialRevokedRequestSchema, { personId: PID, minGeneration: 2 })
        .success,
    ).toBe(true);
    expect(
      z.safeParse(InternalCredentialRevokedRequestSchema, { personId: PID, minGeneration: -1 })
        .success,
    ).toBe(false);
    expect(PEEK_PARAM).toBe("peek");
  });

  test("a person control upserts one person or removes them", () => {
    const person = {
      id: PID,
      name: "Gus",
      initials: "G",
      tint: "#333",
      member: false,
      guest: true,
    };
    expect(z.safeParse(InternalPersonRequestSchema, { person }).success).toBe(true);
    expect(z.safeParse(InternalPersonRequestSchema, { personId: PID, removed: true }).success).toBe(
      true,
    );
    expect(
      z.safeParse(InternalPersonRequestSchema, { person: { ...person, initials: "ABCDE" } })
        .success,
    ).toBe(false);
  });

  test("the access-changed frame is payload-less", () => {
    expect(parseOutbound(JSON.stringify({ v: 1, type: "access-changed" })).ok).toBe(true);
  });

  test("a variant may say who wrote it; a page frame may list kept Edits it left out", () => {
    const frame = {
      v: 1,
      type: "variant-state",
      setId: "vs-1",
      status: "previewing",
      variants: [{ variantId: "v1", label: "Calm", program: [], version: 1, by: PID }],
    };
    expect(parseOutbound(JSON.stringify(frame)).ok).toBe(true);
    const page = {
      v: 1,
      type: "interactions-state",
      url: PAGE,
      interactions: [],
      keptOmitted: [IID],
    };
    expect(parseOutbound(JSON.stringify(page)).ok).toBe(true);
    expect(parseOutbound(JSON.stringify({ ...page, keptOmitted: ["not-a-uuid"] })).ok).toBe(false);
  });
});

test("access-changed parses, and a page snapshot may name kept entries it left out", () => {
  expect(parseOutbound(JSON.stringify({ v: 1, type: "access-changed" })).ok).toBe(true);
  const r = parseOutbound(
    JSON.stringify({
      v: 1,
      type: "interactions-state",
      url: "https://acme.test/p",
      interactions: [],
      keptOmitted: [IID],
    }),
  );
  expect(r.ok && r.msg.type === "interactions-state" && r.msg.keptOmitted).toEqual([IID]);
});
