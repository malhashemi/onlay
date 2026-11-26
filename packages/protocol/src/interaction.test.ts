import { describe, expect, test } from "bun:test";
import * as z from "zod/mini";
import { ActorSchema } from "./actor";
import { AnchoredAnchorSchema, AnchorSchema, InteractionSnapshotSchema } from "./interaction";
import { LIMITS } from "./limits";
import { AttentionRowSchema } from "./outbound";
import { parseInbound, parseOutbound } from "./parse";

const IID = "1e8b6a2c-6f0f-4b7e-9a3c-2d1f0e9b8a7c";
const URL_ = "http://127.0.0.1:8125/app/abc";

const create = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1,
    type: "interaction-create",
    nonce: "n1",
    frameUrl: URL_,
    kind: "comment",
    anchor: { level: "element", selector: "#title", blockId: "b2" },
    body: { text: "the overflow starts here" },
    ...over,
  });

describe("interaction-create frames", () => {
  test("comment create parses (inbound union)", () => {
    const r = parseInbound(create());
    expect(r.ok).toBe(true);
    if (r.ok && r.msg.type === "interaction-create") {
      expect(r.msg.kind).toBe("comment");
      expect(r.msg.anchor.level).toBe("element");
    }
  });

  test("page-level anchor parses (the ladder's bottom rung)", () => {
    const r = parseInbound(create({ anchor: { level: "page" } }));
    expect(r.ok).toBe(true);
  });

  test("unanchored rung parses only on the full anchor union", () => {
    expect(z.safeParse(AnchorSchema, { level: "unanchored" }).success).toBe(true);
    expect(z.safeParse(AnchoredAnchorSchema, { level: "unanchored" }).success).toBe(false);
  });

  test("an anchor's framePath: 1 to 4 bounded selectors without control characters (A-3)", () => {
    const at = (framePath: unknown) =>
      z.safeParse(AnchorSchema, { level: "element", selector: "p#x", framePath });
    const ok = at(["iframe#notes", "iframe:nth-of-type(2)"]);
    expect(ok.success).toBe(true);
    if (ok.success && ok.data.level === "element")
      expect(ok.data.framePath).toEqual(["iframe#notes", "iframe:nth-of-type(2)"]);
    expect(
      z.safeParse(AnchorSchema, {
        level: "selection",
        selector: "p",
        text: "t",
        framePath: ["iframe"],
      }).success,
    ).toBe(true);
    expect(at([]).success).toBe(false);
    expect(at(["a", "b", "c", "d", "e"]).success).toBe(false);
    expect(at([""]).success).toBe(false);
    expect(at(["x".repeat(1_025)]).success).toBe(false);
    expect(at(["iframe\n#x"]).success).toBe(false);
    expect(at(["iframe\u0000"]).success).toBe(false);
    expect(at("iframe").success).toBe(false);
    // Absent is the owner document itself.
    expect(at(undefined).success).toBe(true);
    // A page anchor carries none.
    const page = z.safeParse(AnchorSchema, { level: "page", framePath: ["iframe"] });
    expect(page.success && "framePath" in page.data).toBe(false);
  });

  test("ask create parses with the full choice contract", () => {
    const r = parseInbound(
      create({
        kind: "ask",
        body: undefined,
        ask: {
          question: "Split the migration plan into its own ticket?",
          context: "ADR-0023 is collecting delivery detail.",
          waitingOn: ["you"],
          selection: { min: 1, max: 1, submit: "immediate" },
          answerComment: "optional",
          options: [
            { id: "separate-ticket", label: "Separate ticket", recommended: true },
            { id: "keep-inline", label: "Keep in ADR" },
          ],
        },
      }),
    );
    expect(r.ok).toBe(true);
  });

  test("ask with empty waitingOn rejected — an ask always waits on someone", () => {
    const r = parseInbound(
      create({
        kind: "ask",
        ask: {
          question: "q",
          context: "c",
          waitingOn: [],
          selection: { min: 1, max: 1, submit: "immediate" },
          options: [{ id: "yes", label: "Yes" }],
        },
      }),
    );
    expect(r.ok).toBe(false);
  });

  test("ask with zero options rejected — an ask IS a choice", () => {
    const r = parseInbound(
      create({
        kind: "ask",
        ask: {
          question: "q",
          context: "c",
          waitingOn: ["you"],
          selection: { min: 1, max: 1, submit: "immediate" },
          options: [],
        },
      }),
    );
    expect(r.ok).toBe(false);
  });

  test("change create parses with method + routing", () => {
    const r = parseInbound(
      create({
        kind: "change",
        body: undefined,
        change: { intent: "make this warmer", method: "variant-set", routesTo: "agent" },
      }),
    );
    expect(r.ok).toBe(true);
  });

  test("typed tokens ride the body as data", () => {
    const r = parseInbound(
      create({
        body: {
          text: "same bug as {0} — {1} can you confirm?",
          tokens: [
            {
              t: "anchor",
              anchor: { level: "element", selector: "#card" },
              label: "card.tsx:74",
            },
            { t: "actor", actorId: "archsmith" },
          ],
        },
      }),
    );
    expect(r.ok).toBe(true);
  });
});

describe("ask-answer frames", () => {
  const answer = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      v: 1,
      type: "ask-answer",
      interactionId: IID,
      frameUrl: URL_,
      optionIds: ["separate-ticket"],
      ...over,
    });

  test("valid answer parses; comment rides the pick", () => {
    const r = parseInbound(answer({ comment: { text: "keeps the ADR immutable" } }));
    expect(r.ok).toBe(true);
  });

  test("empty optionIds parse as an explicit no-pick answer", () => {
    expect(parseInbound(answer({ optionIds: [] })).ok).toBe(true);
  });
});

describe("thread mutation frames", () => {
  test("reply / edit / delete / react / resolve / anchor / reanchor parse", () => {
    const frames = [
      { type: "interaction-reply", interactionId: IID, body: { text: "hi" } },
      { type: "interaction-edit", interactionId: IID, msgId: "m1", body: { text: "hi2" } },
      { type: "interaction-delete", interactionId: IID, msgId: "m1" },
      { type: "interaction-react", interactionId: IID, msgId: "m1", emoji: "👍", on: true },
      { type: "interaction-resolve", interactionId: IID },
      {
        type: "interaction-anchor",
        interactionId: IID,
        anchor: { level: "page" },
      },
      {
        type: "interaction-reanchor",
        interactionId: IID,
        anchor: { level: "element", selector: "#next" },
      },
      { type: "interaction-sync" },
    ];
    for (const f of frames) {
      const r = parseInbound(JSON.stringify({ v: 1, frameUrl: URL_, ...f }));
      expect(r.ok).toBe(true);
    }
  });

  test("anchor and reanchor frames reject the unanchored rung", () => {
    const base = { v: 1, frameUrl: URL_, interactionId: IID, anchor: { level: "unanchored" } };
    expect(parseInbound(JSON.stringify({ ...base, type: "interaction-anchor" })).ok).toBe(false);
    expect(parseInbound(JSON.stringify({ ...base, type: "interaction-reanchor" })).ok).toBe(false);
  });

  test("attention-sync parses without frameUrl", () => {
    expect(parseInbound(JSON.stringify({ v: 1, type: "attention-sync" })).ok).toBe(true);
  });
});

describe("actor summaries", () => {
  test("avatar is optional and length-bounded", () => {
    const actor = {
      id: "you",
      name: "you",
      kind: "human",
      tint: "#7c3aed",
      initials: "M",
      avatar: `data:image/png;base64,${"a".repeat(32)}`,
    };
    expect(z.safeParse(ActorSchema, actor).success).toBe(true);
    expect(
      z.safeParse(ActorSchema, { ...actor, avatar: "a".repeat(LIMITS.MAX_AVATAR_DATA + 1) })
        .success,
    ).toBe(false);
  });
});

describe("interactions-state (outbound snapshot)", () => {
  const snapshot = {
    id: IID,
    kind: "ask",
    url: URL_,
    anchor: { level: "page" },
    authorId: "archsmith",
    participants: ["archsmith", "you"],
    waitingOn: ["you"],
    state: "open",
    thread: [
      {
        msgId: "m1",
        authorId: "system",
        body: { text: "ask opened" },
        ts: 1,
        system: true,
        reactions: { "👍": ["you"] },
      },
    ],
    ask: {
      question: "Verdict on plan?",
      context: "decision",
      stakes: "careful",
      waitingOn: ["you"],
      selection: { min: 1, max: 1, submit: "immediate" },
      options: [
        { id: "approve", label: "Approve" },
        { id: "request-changes", label: "Request changes" },
        { id: "reject", label: "Reject" },
      ],
      answers: [],
    },
    createdAt: 1,
  };

  test("full frame parses outbound", () => {
    const r = parseOutbound(
      JSON.stringify({ v: 1, type: "interactions-state", url: URL_, interactions: [snapshot] }),
    );
    expect(r.ok).toBe(true);
  });

  test("unanchored snapshots omit url", () => {
    const unanchoredSnapshot: Record<string, unknown> = {
      ...snapshot,
      anchor: { level: "unanchored" },
    };
    delete unanchoredSnapshot.url;
    const r = z.safeParse(InteractionSnapshotSchema, unanchoredSnapshot);
    expect(r.success).toBe(true);
  });

  test("attention frame parses with rows", () => {
    const r = parseOutbound(
      JSON.stringify({
        v: 1,
        type: "attention",
        person: { id: "p_aaaaaaaaaaaaaaaaaaaa", name: "you", tint: "#7c3aed", initials: "M" },
        needsYou: [
          {
            interactionId: IID,
            kind: "ask",
            state: "open",
            url: URL_,
            anchorLabel: "§decision-matrix",
            text: "Migration-cost weights — confirm?",
            fromActorId: "archsmith",
            waitingOnIds: ["you"],
            ts: 2,
          },
        ],
        waiting: [],
        recent: [],
      }),
    );
    expect(r.ok).toBe(true);
  });

  test("attention rows can omit url and carry unanchored metadata", () => {
    const r = z.safeParse(AttentionRowSchema, {
      interactionId: IID,
      kind: "ask",
      state: "open",
      unanchored: true,
      anchorLost: false,
      stakes: "careful",
      anchorLabel: "Inbox",
      text: "Pick a path",
      fromActorId: "archsmith",
      waitingOnIds: ["you"],
      ts: 2,
    });
    expect(r.success).toBe(true);
  });

  test("notify frame parses (stakes decide loudness)", () => {
    const r = parseOutbound(
      JSON.stringify({
        v: 1,
        type: "notify",
        interactionId: IID,
        kind: "ask",
        title: "plan.md",
        body: "needs your verdict",
        url: URL_,
        stakes: "dangerous",
      }),
    );
    expect(r.ok).toBe(true);
  });

  test("notify frame can omit url for unanchored asks", () => {
    const r = parseOutbound(
      JSON.stringify({
        v: 1,
        type: "notify",
        interactionId: IID,
        kind: "ask",
        title: "Inbox",
        body: "needs your verdict",
      }),
    );
    expect(r.ok).toBe(true);
  });

  test("interaction receipts carry nonce on create and reasons on rejection", () => {
    const ok = parseOutbound(
      JSON.stringify({
        v: 1,
        type: "interaction-receipt",
        nonce: "n1",
        interactionId: IID,
        kind: "create",
        ok: true,
      }),
    );
    expect(ok.ok).toBe(true);
    const rej = parseOutbound(
      JSON.stringify({
        v: 1,
        type: "interaction-receipt",
        kind: "answer",
        ok: false,
        reason: "blocked",
      }),
    );
    expect(rej.ok).toBe(true);
    const anchored = parseOutbound(
      JSON.stringify({
        v: 1,
        type: "interaction-receipt",
        interactionId: IID,
        kind: "anchor",
        ok: true,
      }),
    );
    expect(anchored.ok).toBe(true);
  });
});

describe("replyTo (ADR-0018 §1) — additive, backward-compatible", () => {
  test("a reply frame carries an optional replyTo target", () => {
    const r = parseInbound(
      JSON.stringify({
        v: 1,
        frameUrl: URL_,
        type: "interaction-reply",
        interactionId: IID,
        body: { text: "answering m2" },
        replyTo: { msgId: "m2" },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.msg.type === "interaction-reply") {
      expect(r.msg.replyTo).toEqual({ msgId: "m2" });
    }
  });

  test("thread messages round-trip replyTo through the outbound snapshot", () => {
    const frame = {
      v: 1,
      type: "interactions-state",
      url: URL_,
      interactions: [
        {
          id: IID,
          kind: "comment",
          url: URL_,
          anchor: { level: "page" },
          authorId: "sara",
          participants: ["sara", "moh"],
          waitingOn: [],
          state: "open",
          thread: [
            { msgId: "m1", authorId: "sara", body: { text: "root" }, ts: 1 },
            {
              msgId: "m2",
              authorId: "moh",
              body: { text: "answering the root" },
              ts: 2,
              replyTo: { msgId: "m1" },
            },
          ],
          createdAt: 1,
        },
      ],
    };
    const r = parseOutbound(JSON.stringify(frame));
    expect(r.ok).toBe(true);
    if (r.ok && r.msg.type === "interactions-state") {
      expect(r.msg.interactions[0]?.thread[1]?.replyTo).toEqual({ msgId: "m1" });
    }
  });

  test("old frames without replyTo still parse (optional field)", () => {
    const r = parseInbound(
      JSON.stringify({
        v: 1,
        frameUrl: URL_,
        type: "interaction-reply",
        interactionId: IID,
        body: { text: "plain" },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.msg.type === "interaction-reply") expect(r.msg.replyTo).toBeUndefined();
  });
});
