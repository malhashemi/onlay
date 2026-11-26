import { describe, expect, test } from "bun:test";
import type { ActorKind, Anchor, AskPayload, InteractionKind } from "@onlay/protocol";
import {
  addBatch,
  addMessage,
  addSystemMessage,
  anchorInteraction,
  answerAsk,
  attachVariantSet,
  type ClientClass,
  createInteraction,
  decodeInteractionEntry,
  deleteMessage,
  editMessage,
  encodeInteractionEntry,
  fulfillResnap,
  type InteractionJournalEntry,
  type InteractionState,
  markAnchorLost,
  matchesUrlPrefix,
  react,
  reanchor,
  reopenInteraction,
  replayInteractions,
  requestResnap,
  resolveInteraction,
  setChangeState,
  supersedeAsk,
  validateInitiation,
} from "./interaction";

const T0 = 1_750_000_000_000;
const URL_ = "http://127.0.0.1:8125/app/r1";
const MAX = 500;

const ask = (over: Partial<AskPayload> = {}): AskPayload => ({
  question: "Split the plan?",
  context: "ctx",
  waitingOn: ["you"],
  selection: { min: 1, max: 1, submit: "immediate" },
  options: [
    { id: "yes", label: "Yes", recommended: true },
    { id: "no", label: "No" },
  ],
  ...over,
});

function comment(): InteractionState {
  const r = createInteraction(
    {
      id: "i1",
      kind: "comment",
      url: URL_,
      expectUrlPrefix: URL_,
      anchor: { level: "element", selector: "#b2", blockId: "b2" },
      authorId: "sara",
      body: { text: "overflow starts here" },
    },
    T0,
  );
  if (!r.ok) throw new Error("create failed");
  return r.state;
}

function askInt(over: Partial<AskPayload> = {}): InteractionState {
  const r = createInteraction(
    {
      id: "i2",
      kind: "ask",
      url: URL_,
      expectUrlPrefix: URL_,
      anchor: { level: "page" },
      authorId: "archsmith",
      ask: ask(over),
    },
    T0,
  );
  if (!r.ok) throw new Error("create failed");
  return r.state;
}

function unanchoredAsk(): InteractionState {
  const r = createInteraction(
    {
      id: "u1",
      kind: "ask",
      url: "",
      expectUrlPrefix: "",
      anchor: { level: "unanchored" },
      authorId: "archsmith",
      ask: ask(),
    },
    T0,
  );
  if (!r.ok) throw new Error("create failed");
  return r.state;
}

function changeInt(): InteractionState {
  const r = createInteraction(
    {
      id: "i3",
      kind: "change",
      url: URL_,
      expectUrlPrefix: URL_,
      anchor: { level: "element", selector: "#hero" },
      authorId: "you",
      change: { intent: "make this warmer", routesTo: "agent" },
    },
    T0,
  );
  if (!r.ok) throw new Error("create failed");
  return r.state;
}

describe("createInteraction", () => {
  test("comment births open with root message m1 and author participant", () => {
    const s = comment();
    expect(s.state).toBe("open");
    expect(s.thread[0]?.msgId).toBe("m1");
    expect(s.participants).toContain("sara");
    expect(s.waitingOn).toEqual([]);
  });

  test("payload mismatch refused (ask without ask payload)", () => {
    const r = createInteraction(
      {
        id: "x",
        kind: "ask",
        url: URL_,
        expectUrlPrefix: URL_,
        anchor: { level: "page" },
        authorId: "a",
      },
      T0,
    );
    expect(r.ok).toBe(false);
  });

  test("ask waits on its addressees; change waits on routesTo", () => {
    expect(askInt().waitingOn).toEqual(["you"]);
    expect(changeInt().waitingOn).toEqual(["agent"]);
  });

  test("mentioned actors in the root body become participants", () => {
    const r = createInteraction(
      {
        id: "m",
        kind: "comment",
        url: URL_,
        expectUrlPrefix: URL_,
        anchor: { level: "page" },
        authorId: "sara",
        body: { text: "{0} look", tokens: [{ t: "actor", actorId: "archsmith" }] },
      },
      T0,
    );
    if (r.ok) expect(r.state.participants).toContain("archsmith");
  });
});

describe("validateInitiation", () => {
  const anchored: Anchor = { level: "page" };
  const unanchored: Anchor = { level: "unanchored" };
  type Reason = "agent-initiation" | "human-unanchored" | "edit-needs-page";
  type Case = {
    actorKind: ActorKind;
    clientClass: ClientClass;
    kind: InteractionKind;
    anchor: Anchor;
    ok: boolean;
    reason?: Reason;
  };

  const run = (cases: Case[]) => {
    for (const c of cases) {
      const r = validateInitiation(c.actorKind, c.clientClass, c.kind, c.anchor);
      expect(r.ok).toBe(c.ok);
      if (!r.ok) {
        if (c.reason === undefined) throw new Error("missing expected reason");
        expect(r.reason).toBe(c.reason);
      }
    }
  };

  test("agent: unanchored Ask only, every other cell agent-initiation", () => {
    run([
      { actorKind: "agent", clientClass: "agent", kind: "ask", anchor: unanchored, ok: true },
      // DR-009 holds regardless of whether the class is derived from the actor
      // or the token: a human actor on an AGENT-class token (cli/plugin) is an
      // agent-initiation surface too.
      { actorKind: "human", clientClass: "agent", kind: "ask", anchor: unanchored, ok: true },
      {
        actorKind: "human",
        clientClass: "agent",
        kind: "comment",
        anchor: unanchored,
        ok: false,
        reason: "agent-initiation",
      },
      {
        actorKind: "agent",
        clientClass: "agent",
        kind: "comment",
        anchor: anchored,
        ok: false,
        reason: "agent-initiation",
      },
      {
        actorKind: "agent",
        clientClass: "agent",
        kind: "comment",
        anchor: unanchored,
        ok: false,
        reason: "agent-initiation",
      },
      {
        actorKind: "agent",
        clientClass: "agent",
        kind: "ask",
        anchor: anchored,
        ok: false,
        reason: "agent-initiation",
      },
      {
        actorKind: "agent",
        clientClass: "agent",
        kind: "change",
        anchor: anchored,
        ok: false,
        reason: "agent-initiation",
      },
      {
        actorKind: "agent",
        clientClass: "agent",
        kind: "change",
        anchor: unanchored,
        ok: false,
        reason: "agent-initiation",
      },
    ]);
  });

  test("full human (extension): must anchor — the ADR-0020 gate, intact", () => {
    run([
      { actorKind: "human", clientClass: "full", kind: "comment", anchor: anchored, ok: true },
      { actorKind: "human", clientClass: "full", kind: "ask", anchor: anchored, ok: true },
      { actorKind: "human", clientClass: "full", kind: "change", anchor: anchored, ok: true },
      {
        actorKind: "human",
        clientClass: "full",
        kind: "comment",
        anchor: unanchored,
        ok: false,
        reason: "human-unanchored",
      },
      {
        actorKind: "human",
        clientClass: "full",
        kind: "ask",
        anchor: unanchored,
        ok: false,
        reason: "human-unanchored",
      },
      {
        actorKind: "human",
        clientClass: "full",
        kind: "change",
        anchor: unanchored,
        ok: false,
        reason: "human-unanchored",
      },
    ]);
  });

  test("interaction human (pwa): unanchored Ask/Comment; Edit refused; no page to anchor", () => {
    run([
      { actorKind: "human", clientClass: "interaction", kind: "ask", anchor: unanchored, ok: true },
      {
        actorKind: "human",
        clientClass: "interaction",
        kind: "comment",
        anchor: unanchored,
        ok: true,
      },
      // Edit is refused whether or not an anchor is supplied — the pwa holds no page.
      {
        actorKind: "human",
        clientClass: "interaction",
        kind: "change",
        anchor: unanchored,
        ok: false,
        reason: "edit-needs-page",
      },
      {
        actorKind: "human",
        clientClass: "interaction",
        kind: "change",
        anchor: anchored,
        ok: false,
        reason: "edit-needs-page",
      },
      // An anchored Ask/Comment cannot come from a pageless surface.
      {
        actorKind: "human",
        clientClass: "interaction",
        kind: "ask",
        anchor: anchored,
        ok: false,
        reason: "human-unanchored",
      },
      {
        actorKind: "human",
        clientClass: "interaction",
        kind: "comment",
        anchor: anchored,
        ok: false,
        reason: "human-unanchored",
      },
    ]);
  });
});

describe("thread", () => {
  test("messages mint monotonic ids and add participants via mentions", () => {
    let s = comment();
    const r1 = addMessage(
      s,
      {
        authorId: "archsmith",
        body: { text: "same root cause {0}", tokens: [{ t: "actor", actorId: "planner" }] },
      },
      MAX,
      T0 + 1,
    );
    expect(r1.added).toBe(true);
    s = r1.state;
    expect(s.thread[1]?.msgId).toBe("m2");
    expect(s.participants).toEqual(expect.arrayContaining(["sara", "archsmith", "planner"]));
  });

  test("edit is author-only; tombstone keeps structure; system immutable", () => {
    let s = comment();
    const e1 = editMessage(s, { msgId: "m1", actorId: "you", body: { text: "hack" } }, T0 + 1);
    expect(e1.edited).toBe(false);
    const e2 = editMessage(s, { msgId: "m1", actorId: "sara", body: { text: "rev 2" } }, T0 + 2);
    expect(e2.edited).toBe(true);
    s = e2.state;
    const d = deleteMessage(s, { msgId: "m1", actorId: "sara" }, T0 + 3);
    expect(d.deleted).toBe(true);
    expect(d.state.thread[0]?.deleted).toBe(true);
    expect(d.state.thread[0]?.body.text).toBe("");
    const sys = addSystemMessage(d.state, "Sara resolved", MAX, T0 + 4);
    if (!sys.added) throw new Error("system msg");
    const e3 = editMessage(
      sys.state,
      { msgId: sys.msg.msgId, actorId: "system", body: { text: "x" } },
      T0 + 5,
    );
    expect(e3.edited).toBe(false);
  });

  test("edit adds newly mentioned actors as participants", () => {
    const s = comment();
    const e = editMessage(
      s,
      {
        msgId: "m1",
        actorId: "sara",
        body: { text: "loop in {0}", tokens: [{ t: "actor", actorId: "build" }] },
      },
      T0 + 1,
    );
    expect(e.edited).toBe(true);
    expect(e.state.participants).toEqual(expect.arrayContaining(["sara", "build"]));
  });

  test("reactions toggle idempotently and never mutate state", () => {
    let s = comment();
    s = react(s, { msgId: "m1", actorId: "you", emoji: "👍", on: true });
    expect(s.thread[0]?.reactions?.["👍"]).toEqual(["you"]);
    const again = react(s, { msgId: "m1", actorId: "you", emoji: "👍", on: true });
    expect(again).toBe(s);
    s = react(s, { msgId: "m1", actorId: "you", emoji: "👍", on: false });
    expect(s.thread[0]?.reactions).toBeUndefined();
    expect(s.state).toBe("open");
  });

  test("resolved threads accept follow-through speech (F-047)", () => {
    // Live-caught: an ask answer auto-resolved and the human's comment had
    // nowhere to land. The thread outlives the resolution.
    const s = resolveInteraction(comment(), "sara", "human", T0 + 1).state;
    const r = addMessage(
      s,
      {
        authorId: "you",
        body: {
          text: "why request-changes: @helper-agent see §2",
          tokens: [{ t: "actor", actorId: "helper-agent" }],
        },
      },
      MAX,
      T0 + 2,
    );
    expect(r.added).toBe(true);
    if (!r.added) throw new Error("unreachable");
    // Mentions in follow-through still join participants (summons still work).
    expect(r.state.participants).toContain("helper-agent");
    // Own follow-through messages stay editable and deletable.
    const e = editMessage(
      r.state,
      { msgId: r.msg.msgId, actorId: "you", body: { text: "revised" } },
      T0 + 3,
    );
    expect(e.edited).toBe(true);
    const d = deleteMessage(e.state, { msgId: r.msg.msgId, actorId: "you" }, T0 + 4);
    expect(d.deleted).toBe(true);
  });

  test("terminal states (superseded) refuse messages; system notes still land", () => {
    const superseded = supersedeAsk(askInt(), T0 + 1);
    expect(superseded.state).toBe("superseded");
    const r = addMessage(superseded, { authorId: "you", body: { text: "late" } }, MAX, T0 + 2);
    expect(r.added).toBe(false);
    if (r.added) throw new Error("unreachable");
    expect(r.reason).toBe("closed");
    const sys = addSystemMessage(superseded, "archived", MAX, T0 + 3);
    expect(sys.added).toBe(true);
  });
});

describe("answerAsk — the control answers, never the thread", () => {
  test("any-one: first valid answer moves open → answered, clears waitingOn", () => {
    const r = answerAsk(askInt(), { actorId: "you", optionIds: ["yes"] }, [], T0 + 1);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.aggregateMet).toBe(true);
      expect(r.state.state).toBe("answered");
      expect(r.state.waitingOn).toEqual([]);
      expect(r.state.ask?.answers[0]?.optionIds).toEqual(["yes"]);
    }
  });

  test("min-zero ask accepts an explicit no-pick answer", () => {
    const r = answerAsk(
      askInt({ selection: { min: 0, max: 1, submit: "explicit" } }),
      { actorId: "you", optionIds: [] },
      [],
      T0 + 1,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.ask?.answers[0]?.optionIds).toEqual([]);
  });

  test("guards: non-addressee, unknown option, selection bounds, required comment", () => {
    const s = askInt({
      answerComment: "required",
      selection: { min: 1, max: 2, submit: "explicit" },
    });
    expect(answerAsk(s, { actorId: "eve", optionIds: ["yes"] }, [], T0).ok).toBe(false);
    expect(answerAsk(s, { actorId: "you", optionIds: ["nope"] }, [], T0).ok).toBe(false);
    expect(answerAsk(s, { actorId: "you", optionIds: [] }, [], T0).ok).toBe(false);
    expect(
      answerAsk(s, { actorId: "you", optionIds: ["yes", "no"], comment: { text: " " } }, [], T0).ok,
    ).toBe(false);
    const ok = answerAsk(
      s,
      { actorId: "you", optionIds: ["yes", "no"], comment: { text: "both apply" } },
      [],
      T0,
    );
    expect(ok.ok).toBe(true);
  });

  test("blocked options refuse with reason blocked (CR blocks approve)", () => {
    const r = answerAsk(askInt(), { actorId: "you", optionIds: ["yes"] }, ["yes"], T0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("blocked");
  });

  test("everyone: resolves only when all addressees answered; re-answer replaces", () => {
    let s = askInt({ waitingOn: ["you", "sara"], resolvesWhen: "everyone" });
    const r1 = answerAsk(s, { actorId: "you", optionIds: ["yes"] }, [], T0 + 1);
    if (!r1.ok) throw new Error("r1");
    expect(r1.aggregateMet).toBe(false);
    expect(r1.state.waitingOn).toEqual(["sara"]);
    s = r1.state;
    const r1b = answerAsk(s, { actorId: "you", optionIds: ["no"] }, [], T0 + 2);
    if (!r1b.ok) throw new Error("re-answer refused");
    expect(r1b.state.ask?.answers.length).toBe(1);
    const r2 = answerAsk(r1b.state, { actorId: "sara", optionIds: ["yes"] }, [], T0 + 3);
    if (!r2.ok) throw new Error("r2");
    expect(r2.aggregateMet).toBe(true);
  });

  test("majority flip: a re-answer that breaks the majority falls back to open", () => {
    const s = askInt({ waitingOn: ["a", "b", "c"], resolvesWhen: "majority" });
    const r1 = answerAsk(s, { actorId: "a", optionIds: ["yes"] }, [], T0);
    if (!r1.ok) throw new Error();
    const r2 = answerAsk(r1.state, { actorId: "b", optionIds: ["yes"] }, [], T0 + 1);
    if (!r2.ok) throw new Error();
    expect(r2.state.state).toBe("answered");
    const r3 = answerAsk(r2.state, { actorId: "b", optionIds: ["no"] }, [], T0 + 2);
    if (!r3.ok) throw new Error();
    expect(r3.aggregateMet).toBe(false);
    expect(r3.state.state).toBe("open");
    expect(r3.state.waitingOn).toEqual(["c"]); // unanswered addressees still waited on
  });

  test("majority: the most common pick must clear half the addressees", () => {
    const s = askInt({ waitingOn: ["a", "b", "c"], resolvesWhen: "majority" });
    const r1 = answerAsk(s, { actorId: "a", optionIds: ["yes"] }, [], T0);
    if (!r1.ok) throw new Error();
    expect(r1.aggregateMet).toBe(false);
    const r2 = answerAsk(r1.state, { actorId: "b", optionIds: ["yes"] }, [], T0 + 1);
    if (!r2.ok) throw new Error();
    expect(r2.aggregateMet).toBe(true);
  });

  test("answered ask still accepts the asker's resolve; answering after close refused", () => {
    const answered = answerAsk(askInt(), { actorId: "you", optionIds: ["yes"] }, [], T0).state;
    const resolved = resolveInteraction(answered, "archsmith", "agent", T0 + 1);
    expect(resolved.resolved).toBe(true); // author may resolve own
    const late = answerAsk(resolved.state, { actorId: "you", optionIds: ["no"] }, [], T0 + 2);
    expect(late.ok).toBe(false);
  });
});

describe("change lifecycle", () => {
  test("forward-only; verifying hands the wait to the requester; resolve clears", () => {
    let s = changeInt();
    expect(setChangeState(s, "open", T0).changed).toBe(false);
    s = setChangeState(s, "working", T0 + 1).state;
    expect(s.waitingOn).toEqual(["agent"]);
    s = setChangeState(s, "verifying", T0 + 2).state;
    expect(s.state).toBe("verifying");
    expect(s.waitingOn).toEqual(["you"]);
    const done = setChangeState(s, "resolved", T0 + 3).state;
    expect(done.resolvedAt).toBe(T0 + 3);
    expect(setChangeState(done, "dropped", T0 + 4).changed).toBe(false);
  });

  test("dropped exits any live state; batches and variant sets attach", () => {
    let s = changeInt();
    const b = addBatch(s, [{ op: "setText", target: ":scope", text: "Save" }]);
    expect(b.added).toBe(true);
    s = attachVariantSet(b.state, "set-9");
    expect(s.change?.variantSetId).toBe("set-9");
    expect(s.change?.method).toBe("variant-set");
    const dropped = setChangeState(s, "dropped", T0 + 5).state;
    expect(dropped.state).toBe("dropped");
    expect(addBatch(dropped, []).added).toBe(false);
  });
});

describe("anchors (ADR-0005)", () => {
  test("anchorInteraction moves a live unanchored ask onto a page and replies continue", () => {
    const anchored = anchorInteraction(unanchoredAsk(), {
      url: URL_,
      expectUrlPrefix: URL_,
      anchor: { level: "element", selector: "#decision" },
      actorId: "you",
    });
    expect(anchored.ok).toBe(true);
    if (!anchored.ok) throw new Error("anchor refused");
    expect(anchored.state.url).toBe(URL_);
    expect(anchored.state.expectUrlPrefix).toBe(URL_);
    expect(anchored.state.anchor.level).toBe("element");
    const reply = addMessage(
      anchored.state,
      { authorId: "you", body: { text: "same page reply" } },
      MAX,
      T0 + 1,
    );
    expect(reply.added).toBe(true);
    if (reply.added) expect(reply.state.thread[0]?.body.text).toBe("same page reply");
  });

  test("anchorInteraction rejects non-unanchored and closed targets", () => {
    const nonUnanchored = anchorInteraction(askInt(), {
      url: URL_,
      expectUrlPrefix: URL_,
      anchor: { level: "page" },
      actorId: "you",
    });
    expect(nonUnanchored.ok).toBe(false);
    if (!nonUnanchored.ok) expect(nonUnanchored.reason).toBe("not-unanchored");

    const resolved = resolveInteraction(unanchoredAsk(), "archsmith", "agent", T0 + 1).state;
    const closed = anchorInteraction(resolved, {
      url: URL_,
      expectUrlPrefix: URL_,
      anchor: { level: "page" },
      actorId: "you",
    });
    expect(closed.ok).toBe(false);
    if (!closed.ok) expect(closed.reason).toBe("closed");
  });

  test("replay create → anchored → reply reconstructs direct reducer state", () => {
    const created = unanchoredAsk();
    const anchored = anchorInteraction(created, {
      url: URL_,
      expectUrlPrefix: URL_,
      anchor: { level: "page" },
      actorId: "you",
    });
    if (!anchored.ok) throw new Error("anchor refused");
    const replied = addMessage(
      anchored.state,
      { authorId: "you", body: { text: "anchored reply" } },
      MAX,
      T0 + 2,
    );
    if (!replied.added) throw new Error("reply refused");

    const lines = [
      encodeInteractionEntry({
        k: "int-create",
        ts: T0,
        id: "u1",
        kind: "ask",
        url: "",
        expectUrlPrefix: "",
        anchor: { level: "unanchored" },
        authorId: "archsmith",
        ask: ask(),
      }),
      encodeInteractionEntry({
        k: "int-anchored",
        ts: T0 + 1,
        id: "u1",
        url: URL_,
        expectUrlPrefix: URL_,
        anchor: { level: "page" },
        actorId: "you",
      }),
      encodeInteractionEntry({
        k: "int-msg",
        ts: T0 + 2,
        id: "u1",
        msg: replied.msg,
      }),
    ];
    expect(replayInteractions(lines, MAX).get("u1")).toEqual(replied.state);
  });

  test("anchor loss demotes live interactions; reanchor restores; closed unaffected", () => {
    let s = comment();
    s = markAnchorLost(s);
    expect(s.anchorLost).toBe(true);
    s = reanchor(s, { level: "element", selector: "#new" });
    expect(s.anchorLost).toBe(false);
    const closed = resolveInteraction(s, "sara", "human", T0 + 1).state;
    expect(markAnchorLost(closed)).toBe(closed);
  });

  test("a re-anchor into another frame is a real move; the frame path is kept (A-3)", () => {
    const fresh = (): ReturnType<typeof comment> => {
      const { anchoredBy: _by, ...rest } = reanchor(comment(), {
        level: "element",
        selector: "p#a",
      });
      return rest;
    };
    expect(reanchor(fresh(), { level: "element", selector: "p#a" }, "sara").anchoredBy).toBe(
      undefined,
    );
    const s = reanchor(
      fresh(),
      { level: "element", selector: "p#a", framePath: ["iframe#notes"] },
      "sara",
    );
    expect(s.anchoredBy).toBe("sara");
    expect(s.anchor).toEqual({ level: "element", selector: "p#a", framePath: ["iframe#notes"] });
  });

  test("markAnchorLost on an unanchored interaction is a no-op", () => {
    const s = unanchoredAsk();
    expect(markAnchorLost(s)).toBe(s);
  });

  test("int-anchor-lost then int-reanchor replay through the journal (ADR-0017)", () => {
    const lines = [
      encodeInteractionEntry({
        k: "int-create",
        ts: T0,
        id: "c1",
        kind: "comment",
        url: URL_,
        expectUrlPrefix: URL_,
        anchor: { level: "element", selector: "#gone" },
        authorId: "sara",
        body: { text: "here" },
      }),
      encodeInteractionEntry({ k: "int-anchor-lost", ts: T0 + 1, id: "c1" }),
    ];
    let s = replayInteractions(lines, MAX).get("c1");
    expect(s?.anchorLost).toBe(true);
    lines.push(
      encodeInteractionEntry({
        k: "int-reanchor",
        ts: T0 + 2,
        id: "c1",
        anchor: { level: "element", selector: "#found" },
      }),
    );
    s = replayInteractions(lines, MAX).get("c1");
    expect(s?.anchorLost).toBe(false);
    if (s?.anchor.level === "element") expect(s.anchor.selector).toBe("#found");
  });

  test("matchesUrlPrefix: empty prefix never matches; boundaries enforced", () => {
    expect(matchesUrlPrefix(URL_, "")).toBe(false);
    expect(matchesUrlPrefix(URL_, URL_)).toBe(true);
    expect(matchesUrlPrefix(`${URL_}/sub?x=1#y`, URL_)).toBe(true);
    expect(matchesUrlPrefix(`${URL_}-evil`, URL_)).toBe(false); // path smuggling
    expect(matchesUrlPrefix("http://x/item-evil", "http://x/")).toBe(true); // dir prefix
  });
});

describe("resolution authority", () => {
  test("any human may resolve; agents only their own", () => {
    const s = comment(); // authored by sara
    expect(resolveInteraction(s, "agent-x", "agent", T0).resolved).toBe(false);
    expect(resolveInteraction(s, "you", "human", T0).resolved).toBe(true);
    const a = askInt(); // authored by archsmith (agent)
    expect(resolveInteraction(a, "archsmith", "agent", T0).resolved).toBe(true);
  });
});

describe("reopen — resolution is not a one-way door (F26)", () => {
  const resolved = (s: InteractionState): InteractionState =>
    resolveInteraction(s, "you", "human", T0 + 5).state;

  test("mirrors resolve's authority: any human; an agent only its own", () => {
    const s = resolved(comment()); // authored by sara
    expect(reopenInteraction(s, "agent-x", "agent").reopened).toBe(false);
    const byHuman = reopenInteraction(s, "you", "human");
    expect(byHuman.reopened).toBe(true);
    const a = resolved(askInt()); // authored by archsmith (agent)
    expect(reopenInteraction(a, "archsmith", "agent").reopened).toBe(true);
  });

  test("resolved → open with resolvedAt cleared; already-live is idempotent", () => {
    const r = reopenInteraction(resolved(comment()), "you", "human");
    if (!r.reopened) throw new Error("refused");
    expect(r.changed).toBe(true);
    expect(r.state.state).toBe("open");
    expect(r.state.resolvedAt).toBeUndefined();
    const again = reopenInteraction(r.state, "you", "human");
    expect(again.reopened && !again.changed).toBe(true);
  });

  test("terminal states stay terminal — dropped and superseded refuse", () => {
    const dropped = setChangeState(changeInt(), "dropped", T0 + 1).state;
    const rd = reopenInteraction(dropped, "you", "human");
    expect(rd.reopened).toBe(false);
    if (rd.reopened) throw new Error("unreachable");
    expect(rd.reason).toBe("terminal");
    const superseded = supersedeAsk(askInt(), T0 + 1);
    expect(reopenInteraction(superseded, "you", "human").reopened).toBe(false);
  });

  test("waitingOn restores per kind: unanswered addressees / route / nobody", () => {
    // Ask with one answer in: only the unanswered addressee is re-waited.
    const multi = askInt({ waitingOn: ["you", "sara"], resolvesWhen: "everyone" });
    const answered = answerAsk(multi, { actorId: "you", optionIds: ["yes"] }, [], T0 + 1);
    if (!answered.ok) throw new Error("answer failed");
    const ra = reopenInteraction(resolved(answered.state), "you", "human");
    if (!ra.reopened) throw new Error("refused");
    expect(ra.state.waitingOn).toEqual(["sara"]);
    // Change: back to open, re-waiting on its route.
    const rc = reopenInteraction(resolved(changeInt()), "you", "human");
    if (!rc.reopened) throw new Error("refused");
    expect(rc.state.state).toBe("open");
    expect(rc.state.waitingOn).toEqual(["agent"]);
    // Comment: waits on nobody until spoken to.
    const rm = reopenInteraction(resolved(comment()), "you", "human");
    if (!rm.reopened) throw new Error("refused");
    expect(rm.state.waitingOn).toEqual([]);
  });

  test("a reopened change starts a NEW pass: spent set + method unlink, history stays", () => {
    const withSet = attachVariantSet(changeInt(), "set-1");
    const withBatch = addBatch(withSet, [
      { op: "setStyle", target: ".cta", props: [{ prop: "color", value: "teal" }] },
    ]);
    const r = reopenInteraction(resolved(withBatch.state), "you", "human");
    if (!r.reopened) throw new Error("refused");
    expect(r.state.change?.variantSetId).toBeUndefined();
    expect(r.state.change?.method).toBeUndefined();
    expect(r.state.change?.intent).toBe("make this warmer");
    expect(r.state.change?.routesTo).toBe("agent");
    expect(r.state.change?.batches.length).toBe(1); // applied history survives
  });

  test("int-reopen replays: resolve then reopen round-trips to a live state", () => {
    const lines = [
      encodeInteractionEntry({
        k: "int-create",
        ts: T0,
        id: "a1",
        kind: "comment",
        url: URL_,
        expectUrlPrefix: URL_,
        anchor: { level: "page" },
        authorId: "sara",
        body: { text: "round trip" },
      }),
      encodeInteractionEntry({
        k: "int-resolve",
        ts: T0 + 1,
        id: "a1",
        actorId: "you",
        actorKind: "human",
      }),
      encodeInteractionEntry({
        k: "int-reopen",
        ts: T0 + 2,
        id: "a1",
        actorId: "you",
        actorKind: "human",
      }),
    ];
    const s = replayInteractions(lines, MAX).get("a1");
    expect(s?.state).toBe("open");
    expect(s?.resolvedAt).toBeUndefined();
  });
});

describe("journal codec + replay", () => {
  test("round-trip; garbage → null; truncated tail tolerated", () => {
    const e: InteractionJournalEntry = {
      k: "int-msg",
      ts: T0,
      id: "i1",
      msg: { msgId: "m2", authorId: "you", body: { text: "hi" }, ts: T0 },
    };
    expect(decodeInteractionEntry(encodeInteractionEntry(e))).toEqual(e);
    expect(decodeInteractionEntry("{nope")).toBeNull();
    expect(decodeInteractionEntry('{"k":"int-msg"}')).toBeNull();
  });

  test("replay reconstructs the full life through live reducers", () => {
    const lines: string[] = [
      encodeInteractionEntry({
        k: "int-create",
        ts: T0,
        id: "a1",
        kind: "ask",
        url: URL_,
        expectUrlPrefix: URL_,
        anchor: { level: "page" },
        authorId: "archsmith",
        ask: ask(),
      }),
      encodeInteractionEntry({
        k: "int-msg",
        ts: T0 + 1,
        id: "a1",
        msg: { msgId: "m1", authorId: "sara", body: { text: "who owns sync?" }, ts: T0 + 1 },
      }),
      encodeInteractionEntry({
        k: "int-answer",
        ts: T0 + 2,
        id: "a1",
        answer: { actorId: "you", optionIds: ["yes"], ts: T0 + 2 },
      }),
      encodeInteractionEntry({
        k: "int-resolve",
        ts: T0 + 3,
        id: "a1",
        actorId: "archsmith",
        actorKind: "agent",
      }),
      "",
      '{"k":"int-msg","ts":1,"id":"ghost","msg"', // truncated line
    ];
    const map = replayInteractions(lines, MAX);
    const s = map.get("a1");
    expect(s?.state).toBe("resolved");
    expect(s?.ask?.answers[0]?.optionIds).toEqual(["yes"]);
    expect(s?.thread.length).toBe(1);
    expect(s?.msgSeq).toBe(1);
    expect(map.size).toBe(1); // husk events never birth state
  });
});

describe("replyTo — the reply-target's author is an implicit mention (ADR-0018 §1)", () => {
  test("a valid target stores replyTo and joins the target author as participant", () => {
    let s = comment();
    s = addMessage(s, { authorId: "helper-agent", body: { text: "done" } }, MAX, T0 + 1).state;
    const r = addMessage(
      s,
      { authorId: "sara", body: { text: "thanks — one nit" }, replyTo: { msgId: "m2" } },
      MAX,
      T0 + 2,
    );
    if (!r.added) throw new Error("reply refused");
    expect(r.msg.replyTo).toEqual({ msgId: "m2" });
    // the target's author was already a participant via authorship; a THIRD
    // actor replying to them must not depend on that — assert directly with
    // a fresh replier whose reply targets the agent's message
    const r2 = addMessage(
      comment(),
      { authorId: "moh", body: { text: "hi" }, replyTo: { msgId: "m1" } },
      MAX,
      T0 + 3,
    );
    if (!r2.added) throw new Error("reply refused");
    expect(r2.state.participants).toContain("sara"); // m1's author, implicitly mentioned
    expect(r2.state.participants).toContain("moh");
  });

  test("a dangling target stores the message WITHOUT replyTo (never rejects)", () => {
    const r = addMessage(
      comment(),
      { authorId: "moh", body: { text: "re: nothing" }, replyTo: { msgId: "m99" } },
      MAX,
      T0 + 1,
    );
    if (!r.added) throw new Error("reply refused");
    expect(r.msg.replyTo).toBeUndefined();
    expect(r.state.participants).toEqual(expect.arrayContaining(["sara", "moh"]));
  });

  test("a deleted target keeps replyTo (renders as removed) and still mentions its author", () => {
    let s = comment();
    s = addMessage(s, { authorId: "helper-agent", body: { text: "v1" } }, MAX, T0 + 1).state;
    s = deleteMessage(s, { msgId: "m2", actorId: "helper-agent" }, T0 + 2).state;
    const r = addMessage(
      s,
      { authorId: "moh", body: { text: "what was that?" }, replyTo: { msgId: "m2" } },
      MAX,
      T0 + 3,
    );
    if (!r.added) throw new Error("reply refused");
    expect(r.msg.replyTo).toEqual({ msgId: "m2" });
    expect(r.state.participants).toContain("helper-agent");
  });

  test("replying to a system note never mints a 'system' participant", () => {
    let s = comment();
    s = addSystemMessage(s, "Resolved-ish note", MAX, T0 + 1).state;
    const r = addMessage(
      s,
      { authorId: "moh", body: { text: "re: note" }, replyTo: { msgId: "m2" } },
      MAX,
      T0 + 2,
    );
    if (!r.added) throw new Error("reply refused");
    expect(r.msg.replyTo).toEqual({ msgId: "m2" }); // reference kept
    expect(r.state.participants).not.toContain("system");
  });

  test("replay adds the reply-target author to participants exactly like enqueue", () => {
    const lines = [
      encodeInteractionEntry({
        k: "int-create",
        ts: T0,
        id: "c9",
        kind: "comment",
        url: URL_,
        expectUrlPrefix: URL_,
        anchor: { level: "page" },
        authorId: "sara",
        body: { text: "root" },
      } as InteractionJournalEntry),
      encodeInteractionEntry({
        k: "int-msg",
        ts: T0 + 1,
        id: "c9",
        msg: {
          msgId: "m2",
          authorId: "moh",
          body: { text: "answering the root" },
          ts: T0 + 1,
          replyTo: { msgId: "m1" },
        },
      }),
    ];
    const s = replayInteractions(lines, MAX).get("c9");
    expect(s?.thread[1]?.replyTo).toEqual({ msgId: "m1" });
    expect(s?.participants).toEqual(expect.arrayContaining(["sara", "moh"]));
  });
});

describe("resnap — request/fulfill a fresh look (ADR-0022 §7, Stage 2 / §6 test 1)", () => {
  const hasResnap = (s: InteractionState) =>
    Object.hasOwn(s, "resnapRequestedBy") || Object.hasOwn(s, "resnapRequestedAt");

  test("requestResnap sets both fields on a live interaction", () => {
    const r = requestResnap(comment(), "moh", T0 + 5);
    expect(r.requested).toBe(true);
    expect(r.state.resnapRequestedBy).toBe("moh");
    expect(r.state.resnapRequestedAt).toBe(T0 + 5);
  });

  test("a second request is idempotent 'pending' — no stack, no timestamp reset", () => {
    const first = requestResnap(comment(), "moh", T0 + 5);
    const second = requestResnap(first.state, "sara", T0 + 99);
    expect(second.requested).toBe(false);
    if (second.requested === false) expect(second.reason).toBe("pending");
    // The duty stays the FIRST requester's, at the FIRST timestamp.
    expect(second.state.resnapRequestedBy).toBe("moh");
    expect(second.state.resnapRequestedAt).toBe(T0 + 5);
  });

  test("requestResnap refuses a closed interaction", () => {
    const resolved = resolveInteraction(comment(), "sara", "human", T0 + 1).state;
    const r = requestResnap(resolved, "moh", T0 + 5);
    expect(r.requested).toBe(false);
    if (r.requested === false) expect(r.reason).toBe("closed");
    expect(hasResnap(r.state)).toBe(false);
  });

  test("requestResnap refuses a place a Full client can't re-capture (page/unanchored → not-capturable, GPT-3)", () => {
    // A fresh-look duty is dischargeable only by re-capturing an element/selection
    // anchor; page-level and unanchored have no capture path, so a duty lit there
    // could never clear. `requestResnap` refuses them structurally.
    for (const s of [askInt() /* page */, unanchoredAsk() /* unanchored */]) {
      const r = requestResnap(s, "moh", T0 + 5);
      expect(r.requested).toBe(false);
      if (r.requested === false) expect(r.reason).toBe("not-capturable");
      expect(hasResnap(r.state)).toBe(false);
    }
    // element/selection remain capturable (positive control).
    expect(requestResnap(comment(), "moh", T0 + 5).requested).toBe(true);
    expect(requestResnap(changeInt(), "moh", T0 + 5).requested).toBe(true);
  });

  test("fulfillResnap clears both keys; no-op when nothing is pending", () => {
    const pending = requestResnap(comment(), "moh", T0 + 5).state;
    const cleared = fulfillResnap(pending, "cap-1");
    expect(hasResnap(cleared)).toBe(false);
    // Idempotent: fulfilling a state with no duty returns it untouched.
    const none = fulfillResnap(comment(), "cap-2");
    expect(hasResnap(none)).toBe(false);
  });

  describe("closing a place discharges the pending duty (finding 1)", () => {
    test("resolveInteraction strips both keys", () => {
      const pending = requestResnap(comment(), "moh", T0 + 5).state;
      const closed = resolveInteraction(pending, "sara", "human", T0 + 6).state;
      expect(closed.state).toBe("resolved");
      expect(hasResnap(closed)).toBe(false);
    });

    test("setChangeState → resolved strips both keys", () => {
      const pending = requestResnap(changeInt(), "moh", T0 + 5).state;
      const closed = setChangeState(pending, "resolved", T0 + 6).state;
      expect(closed.state).toBe("resolved");
      expect(hasResnap(closed)).toBe(false);
    });

    test("setChangeState → dropped strips both keys", () => {
      const pending = requestResnap(changeInt(), "moh", T0 + 5).state;
      const dropped = setChangeState(pending, "dropped", T0 + 6).state;
      expect(dropped.state).toBe("dropped");
      expect(hasResnap(dropped)).toBe(false);
    });

    test("supersedeAsk strips both keys", () => {
      const pending = requestResnap(askInt(), "moh", T0 + 5).state;
      const superseded = supersedeAsk(pending, T0 + 6);
      expect(superseded.state).toBe("superseded");
      expect(hasResnap(superseded)).toBe(false);
    });

    test("a mid-flow change advance (working) KEEPS the duty — only closing clears it", () => {
      const pending = requestResnap(changeInt(), "moh", T0 + 5).state;
      const working = setChangeState(pending, "working", T0 + 6).state;
      expect(working.state).toBe("working");
      expect(working.resnapRequestedBy).toBe("moh");
    });
  });

  test("codec round-trips int-resnap-request / int-resnap-fulfill", () => {
    const entries: InteractionJournalEntry[] = [
      { k: "int-resnap-request", ts: T0 + 1, id: "i1", actorId: "moh" },
      { k: "int-resnap-fulfill", ts: T0 + 2, id: "i1", captureId: "cap-xyz" },
    ];
    for (const e of entries) {
      expect(decodeInteractionEntry(encodeInteractionEntry(e))).toEqual(e);
    }
  });

  const createLine = () =>
    encodeInteractionEntry({
      k: "int-create",
      ts: T0,
      id: "r9",
      kind: "comment",
      url: URL_,
      expectUrlPrefix: URL_,
      anchor: { level: "element", selector: "#b2", blockId: "b2" },
      authorId: "sara",
      body: { text: "root" },
    } as InteractionJournalEntry);

  test("replay oracle: a request with no later fulfill reconstructs the pending duty", () => {
    const lines = [
      createLine(),
      encodeInteractionEntry({ k: "int-resnap-request", ts: T0 + 1, id: "r9", actorId: "moh" }),
    ];
    const s = replayInteractions(lines, MAX).get("r9");
    expect(s?.resnapRequestedBy).toBe("moh");
    expect(s?.resnapRequestedAt).toBe(T0 + 1);
  });

  test("replay oracle: request then fulfill reconstructs a discharged duty", () => {
    const lines = [
      createLine(),
      encodeInteractionEntry({ k: "int-resnap-request", ts: T0 + 1, id: "r9", actorId: "moh" }),
      encodeInteractionEntry({
        k: "int-resnap-fulfill",
        ts: T0 + 2,
        id: "r9",
        captureId: "cap-xyz",
      }),
    ];
    const s = replayInteractions(lines, MAX).get("r9");
    expect(s && hasResnap(s)).toBe(false);
  });

  test("replay oracle: request then resolve folds to NO pending duty (closing-clear is replay-safe)", () => {
    const lines = [
      createLine(),
      encodeInteractionEntry({ k: "int-resnap-request", ts: T0 + 1, id: "r9", actorId: "moh" }),
      encodeInteractionEntry({
        k: "int-resolve",
        ts: T0 + 2,
        id: "r9",
        actorId: "sara",
        actorKind: "human",
      } as InteractionJournalEntry),
    ];
    const s = replayInteractions(lines, MAX).get("r9");
    expect(s?.state).toBe("resolved");
    expect(s && hasResnap(s)).toBe(false);
  });
});
