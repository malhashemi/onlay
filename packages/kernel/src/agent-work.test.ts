import { describe, expect, test } from "bun:test";
import { LIMITS, type RawRichText } from "@onlay/protocol";
import { computeAttention, needsActor } from "./attention";
import {
  addMessage,
  agentSetEditState,
  answerAgentWork,
  createInteraction,
  editMessage,
  effectiveAgentWork,
  encodeInteractionEntry,
  heldByOther,
  type InteractionCreateInput,
  type InteractionJournalEntry,
  type InteractionState,
  pickEdit,
  react,
  releaseAgentWork,
  renewAgentLease,
  reopenInteraction,
  replayInteractions,
  requestAgentWork,
  resolveInteraction,
  setChangeState,
  shareWith,
  takeAgentWork,
  unshare,
} from "./interaction";

const T0 = 1_750_000_000_000;
const URL_ = "https://example.com/pricing";
const MAX = 500;
const LEASE = LIMITS.AGENT_LEASE_MS;
const WINDOW = LIMITS.RECENT_RESOLVED_MS;
const ADA = "p_adaadaadaadaadaadaad";
const BEN = "p_benbenbenbenbenbenbe";

const agentAsk: RawRichText = { text: "@agent tighten this", tokens: [{ t: "agent" }] };

function make(over: Partial<InteractionCreateInput> = {}): InteractionState {
  const r = createInteraction(
    {
      id: "i1",
      kind: "comment",
      url: URL_,
      expectUrlPrefix: URL_,
      anchor: { level: "page" },
      authorId: ADA,
      ...(over.kind === "change" ? {} : { body: { text: "root" } }),
      member: true,
      ...over,
    },
    T0,
  );
  if (!r.ok) throw new Error("create");
  return r.state;
}

/** A comment with agent work pending, requested by Ada. */
const pending = () => make({ body: agentAsk });

describe("requesting agent work", () => {
  test("a member's @agent at creation or in a reply asks for an agent", () => {
    expect(pending().agentWork).toEqual({ status: "pending", requestedBy: ADA, requestedAt: T0 });
    const r = addMessage(make(), { authorId: BEN, body: agentAsk, member: true }, MAX, T0 + 1);
    expect(r.state.agentWork).toEqual({ status: "pending", requestedBy: BEN, requestedAt: T0 + 1 });
  });

  test("a guest's @agent never asks; plain text never asks", () => {
    expect(make({ body: agentAsk, member: false }).agentWork).toBeUndefined();
    const r = addMessage(make(), { authorId: BEN, body: agentAsk }, MAX, T0 + 1);
    expect(r.state.agentWork).toBeUndefined();
    expect(
      addMessage(make(), { authorId: ADA, body: { text: "@agent" }, member: true }, MAX, T0).state
        .agentWork,
    ).toBeUndefined();
  });

  test("a member's Direct or Variants Edit asks; a manual batch on an unowned page does not", () => {
    const edit = (method?: "direct" | "variant-set" | "manual-batch", ownsSource?: boolean) =>
      make({
        kind: "change",
        change: {
          intent: "warmer",
          ...(method ? { method } : {}),
          ...(ownsSource !== undefined ? { ownsSource } : {}),
        },
      }).agentWork?.status;
    expect(edit()).toBe("pending");
    expect(edit("direct")).toBe("pending");
    expect(edit("variant-set")).toBe("pending");
    expect(edit("manual-batch", false)).toBeUndefined();
    expect(edit("manual-batch", true)).toBe("pending");
  });

  test("requestAgent overrides the derived default", () => {
    const manualSet = make({
      kind: "change",
      change: { intent: "x", method: "variant-set" },
      requestAgent: false,
    });
    expect(manualSet.agentWork).toBeUndefined();
  });

  test("a new request replaces an answer; a closed interaction refuses one", () => {
    const answered = answerAgentWork(pending(), ADA, T0 + 5).state;
    expect(requestAgentWork(answered, BEN, T0 + 9).state.agentWork).toEqual({
      status: "pending",
      requestedBy: BEN,
      requestedAt: T0 + 9,
    });
    const closed = resolveInteraction(make(), ADA, "human", T0 + 1).state;
    expect(requestAgentWork(closed, ADA, T0 + 2)).toMatchObject({
      requested: false,
      reason: "closed",
    });
  });
});

describe("taking and releasing", () => {
  test("the requester's agent takes its own item under a ten-minute lease", () => {
    const r = takeAgentWork(pending(), { personId: ADA }, T0 + 10);
    expect(r.taken).toBe(true);
    expect(r.state.agentWork).toEqual({
      status: "taken",
      requestedBy: ADA,
      requestedAt: T0,
      takenBy: ADA,
      takenAt: T0 + 10,
      leaseUntil: T0 + 10 + LEASE,
    });
  });

  test("a teammate's agent needs onBehalf", () => {
    expect(takeAgentWork(pending(), { personId: BEN }, T0)).toMatchObject({
      taken: false,
      reason: "not-yours",
    });
    expect(takeAgentWork(pending(), { personId: BEN, onBehalf: true }, T0).taken).toBe(true);
  });

  test("refused while another person's lease holds; allowed once it expires", () => {
    const held = takeAgentWork(pending(), { personId: ADA }, T0).state;
    expect(takeAgentWork(held, { personId: BEN, onBehalf: true }, T0 + LEASE - 1)).toMatchObject({
      taken: false,
      reason: "held",
    });
    const later = takeAgentWork(held, { personId: BEN, onBehalf: true }, T0 + LEASE);
    expect(later.taken).toBe(true);
    expect(later.state.agentWork?.takenBy).toBe(BEN);
  });

  test("the holder taking again renews the lease and keeps takenAt", () => {
    const held = takeAgentWork(pending(), { personId: ADA }, T0).state;
    const again = takeAgentWork(held, { personId: ADA }, T0 + 60_000).state.agentWork;
    expect(again?.takenAt).toBe(T0);
    expect(again?.leaseUntil).toBe(T0 + 60_000 + LEASE);
  });

  test("nothing to take without pending work", () => {
    expect(takeAgentWork(make(), { personId: ADA }, T0)).toMatchObject({ reason: "not-pending" });
    const answered = answerAgentWork(pending(), ADA, T0).state;
    expect(takeAgentWork(answered, { personId: ADA }, T0)).toMatchObject({ reason: "not-pending" });
  });

  test("an expired lease reads as pending", () => {
    const held = takeAgentWork(pending(), { personId: ADA }, T0).state;
    expect(effectiveAgentWork(held, T0 + LEASE - 1)?.status).toBe("taken");
    expect(effectiveAgentWork(held, T0 + LEASE)).toEqual({
      status: "pending",
      requestedBy: ADA,
      requestedAt: T0,
    });
  });

  test("only the holder releases, back to pending", () => {
    const held = takeAgentWork(pending(), { personId: ADA }, T0).state;
    expect(releaseAgentWork(held, BEN, T0)).toMatchObject({
      released: false,
      reason: "not-holder",
    });
    const r = releaseAgentWork(held, ADA, T0 + 1);
    expect(r.released).toBe(true);
    expect(r.state.agentWork).toEqual({ status: "pending", requestedBy: ADA, requestedAt: T0 });
  });

  test("renewal extends only the live holder's lease", () => {
    const held = takeAgentWork(pending(), { personId: ADA }, T0).state;
    expect(renewAgentLease(held, ADA, T0 + 5).agentWork?.leaseUntil).toBe(T0 + 5 + LEASE);
    expect(renewAgentLease(held, BEN, T0 + 5)).toBe(held);
    expect(renewAgentLease(held, ADA, T0 + LEASE)).toBe(held);
  });
});

describe("answering", () => {
  test("an agent-marked message answers pending work and is stored marked", () => {
    const r = addMessage(
      pending(),
      { authorId: ADA, body: { text: "done" }, agent: true },
      MAX,
      T0 + 3,
    );
    expect(r.added && r.msg.agent).toBe(true);
    expect(r.state.agentWork).toMatchObject({ status: "answered", answeredAt: T0 + 3 });
  });

  test("an agent-marked @agent never asks for another agent", () => {
    const r = addMessage(
      make(),
      { authorId: ADA, body: agentAsk, agent: true, member: true },
      MAX,
      T0,
    );
    expect(r.state.agentWork).toBeUndefined();
  });

  test("the holder's answer keeps the take and renews its lease", () => {
    const held = takeAgentWork(pending(), { personId: ADA }, T0).state;
    const r = answerAgentWork(held, ADA, T0 + 7);
    expect(r.state.agentWork).toEqual({
      status: "answered",
      requestedBy: ADA,
      requestedAt: T0,
      answeredAt: T0 + 7,
      takenBy: ADA,
      takenAt: T0,
      leaseUntil: T0 + 7 + LEASE,
    });
    // a later write by the holder renews again
    const later = answerAgentWork(r.state, ADA, T0 + 100);
    expect(later).toMatchObject({ answered: false, reason: "already-answered" });
    expect(later.state.agentWork?.leaseUntil).toBe(T0 + 100 + LEASE);
  });

  test("another person's live lease keeps the item theirs", () => {
    const held = takeAgentWork(pending(), { personId: ADA }, T0).state;
    expect(answerAgentWork(held, BEN, T0 + 1)).toMatchObject({ answered: false, reason: "held" });
    expect(answerAgentWork(held, BEN, T0 + LEASE).answered).toBe(true);
  });

  test("an agent's Edit state answers its work", () => {
    const edit = make({ kind: "change", change: { intent: "warmer" } });
    const r = agentSetEditState(edit, "working", ADA, T0 + 2);
    expect(r.changed && r.state.state).toBe("working");
    expect(r.state.agentWork?.status).toBe("answered");
  });
});

describe("attention", () => {
  test("the requester waits on pending and taken items, under waiting", () => {
    const sets = computeAttention([pending()], ADA, T0, WINDOW);
    expect(sets.needsYou).toHaveLength(0);
    expect(sets.waiting.map((r) => r.because)).toEqual(["waiting-on-agent"]);
    const held = takeAgentWork(pending(), { personId: ADA }, T0).state;
    expect(computeAttention([held], ADA, T0, WINDOW).waiting[0]?.because).toBe("waiting-on-agent");
  });

  test("an answer whose last message is the agent's needs the requester", () => {
    const answered = addMessage(
      pending(),
      { authorId: ADA, body: { text: "done" }, agent: true },
      MAX,
      T0 + 1,
    ).state;
    expect(needsActor(answered, ADA)).toBe("agent-answered");
    expect(computeAttention([answered], ADA, T0, WINDOW).needsYou[0]?.because).toBe(
      "agent-answered",
    );
    // the requester's own reply or reaction acknowledges it
    const replied = addMessage(
      answered,
      { authorId: ADA, body: { text: "thanks" } },
      MAX,
      T0 + 2,
    ).state;
    expect(needsActor(replied, ADA)).toBeNull();
    const reacted = react(answered, { msgId: "m2", actorId: ADA, emoji: "👍", on: true });
    expect(needsActor(reacted, ADA)).toBeNull();
  });

  test("an answer by state alone (no agent message) does not need the requester", () => {
    const answered = answerAgentWork(pending(), ADA, T0 + 1).state;
    expect(needsActor(answered, ADA)).toBeNull();
  });

  test("a teammate's request is not the actor's wait", () => {
    const r = addMessage(make(), { authorId: BEN, body: agentAsk, member: true }, MAX, T0).state;
    expect(computeAttention([r], ADA, T0, WINDOW).waiting.map((x) => x.because)).not.toContain(
      "waiting-on-agent",
    );
  });
});

describe("journal replay", () => {
  test("replay rebuilds agent work and marks exactly as the reducers did", () => {
    const lines: string[] = [];
    const log = (e: InteractionJournalEntry) => lines.push(encodeInteractionEntry(e));
    const input: InteractionCreateInput = {
      id: "i1",
      kind: "comment",
      url: URL_,
      expectUrlPrefix: URL_,
      anchor: { level: "page" },
      authorId: ADA,
      body: { text: "root" },
      member: true,
    };
    let s = make();
    log({ k: "int-create", ts: T0, ...input });

    const asked = addMessage(s, { authorId: BEN, body: agentAsk, member: true }, MAX, T0 + 1);
    if (!asked.added) throw new Error("add");
    s = asked.state;
    log({ k: "int-msg", ts: T0 + 1, id: "i1", msg: asked.msg, member: true });

    s = takeAgentWork(s, { personId: ADA, onBehalf: true }, T0 + 2).state;
    log({ k: "int-agent-take", ts: T0 + 2, id: "i1", actorId: ADA, onBehalf: true });

    s = releaseAgentWork(s, ADA, T0 + 3).state;
    log({ k: "int-agent-release", ts: T0 + 3, id: "i1", actorId: ADA });

    s = takeAgentWork(s, { personId: BEN }, T0 + 4).state;
    log({ k: "int-agent-take", ts: T0 + 4, id: "i1", actorId: BEN });

    const reply = addMessage(
      s,
      { authorId: BEN, body: { text: "done" }, agent: true },
      MAX,
      T0 + 5,
    );
    if (!reply.added) throw new Error("add");
    s = reply.state;
    log({ k: "int-msg", ts: T0 + 5, id: "i1", msg: reply.msg });

    s = requestAgentWork(s, ADA, T0 + 6).state;
    log({ k: "int-agent-request", ts: T0 + 6, id: "i1", actorId: ADA });

    s = answerAgentWork(s, ADA, T0 + 7).state;
    log({ k: "int-agent-answer", ts: T0 + 7, id: "i1", actorId: ADA });

    expect(replayInteractions(lines, MAX).get("i1")).toEqual(s);
  });

  test("an agent-set Edit state replays as an answer", () => {
    const input: InteractionCreateInput = {
      id: "e1",
      kind: "change",
      url: URL_,
      expectUrlPrefix: URL_,
      anchor: { level: "page" },
      authorId: ADA,
      change: { intent: "warmer" },
      member: true,
    };
    const r = createInteraction(input, T0);
    if (!r.ok) throw new Error("create");
    const s = agentSetEditState(r.state, "working", BEN, T0 + 1).state;
    const lines = [
      encodeInteractionEntry({ k: "int-create", ts: T0, ...input }),
      encodeInteractionEntry({
        k: "int-state",
        ts: T0 + 1,
        id: "e1",
        state: "working",
        agent: true,
        actorId: BEN,
      }),
    ];
    expect(replayInteractions(lines, MAX).get("e1")).toEqual(s);
  });
});

/* ── second review: findings 1–4 and the guest pick ─────────────────── */

describe("leases, closing and release (findings 1 and 2)", () => {
  test("heldByOther is true only for another person's unexpired lease", () => {
    const taken = takeAgentWork(pending(), { personId: ADA }, T0 + 1).state;
    expect(heldByOther(taken, BEN, T0 + 2)).toBe(true);
    expect(heldByOther(taken, ADA, T0 + 2)).toBe(false);
    expect(heldByOther(taken, BEN, T0 + 1 + LEASE + 1)).toBe(false);
    expect(heldByOther(pending(), BEN, T0)).toBe(false);
  });

  test("resolving or dropping clears agent work; reopening doesn't bring it back", () => {
    const taken = takeAgentWork(pending(), { personId: ADA }, T0 + 1).state;
    const resolved = resolveInteraction(taken, ADA, "human", T0 + 2).state;
    expect(resolved.agentWork).toBeUndefined();
    const reopened = reopenInteraction(resolved, ADA, "human");
    expect(reopened.reopened && reopened.state.agentWork).toBeUndefined();
    const edit = requestAgentWork(make({ kind: "change", change: { intent: "x" } }), ADA, T0).state;
    expect(setChangeState(edit, "dropped", T0 + 1).state.agentWork).toBeUndefined();
    // Replay agrees.
    const replayed = replayInteractions(
      [
        {
          k: "int-create",
          ts: T0,
          id: "i1",
          kind: "comment",
          url: URL_,
          expectUrlPrefix: URL_,
          anchor: { level: "page" },
          authorId: ADA,
          body: agentAsk,
          member: true,
        },
        { k: "int-agent-take", ts: T0 + 1, id: "i1", actorId: ADA },
        { k: "int-resolve", ts: T0 + 2, id: "i1", actorId: ADA, actorKind: "human" },
        { k: "int-reopen", ts: T0 + 3, id: "i1", actorId: ADA, actorKind: "human" },
      ].map((e) => encodeInteractionEntry(e as InteractionJournalEntry)),
      MAX,
    ).get("i1");
    expect(replayed?.agentWork).toBeUndefined();
  });

  test("releasing a claim whose lease ran out succeeds and changes nothing", () => {
    const taken = takeAgentWork(pending(), { personId: ADA }, T0 + 1).state;
    const late = releaseAgentWork(taken, ADA, T0 + 1 + LEASE + 1);
    expect(late).toMatchObject({ released: true, changed: false });
    expect(late.state).toBe(taken);
    expect(releaseAgentWork(taken, ADA, T0 + 2)).toMatchObject({ released: true, changed: true });
    expect(releaseAgentWork(taken, BEN, T0 + 2)).toMatchObject({ released: false });
  });
});

describe("@agent added by an edit (finding 3)", () => {
  test("a member's edit that newly carries @agent asks for an agent; replay agrees", () => {
    const s = make();
    const r = editMessage(s, { msgId: "m1", actorId: ADA, body: agentAsk, member: true }, T0 + 5);
    expect(r.edited && r.state.agentWork).toEqual({
      status: "pending",
      requestedBy: ADA,
      requestedAt: T0 + 5,
    });
    const replayed = replayInteractions(
      [
        {
          k: "int-create",
          ts: T0,
          id: "i1",
          kind: "comment",
          url: URL_,
          expectUrlPrefix: URL_,
          anchor: { level: "page" },
          authorId: ADA,
          body: { text: "root" },
          member: true,
        },
        {
          k: "int-msg-edit",
          ts: T0 + 5,
          id: "i1",
          msgId: "m1",
          actorId: ADA,
          body: agentAsk,
          member: true,
        },
      ].map((e) => encodeInteractionEntry(e as InteractionJournalEntry)),
      MAX,
    ).get("i1");
    expect(replayed?.agentWork?.status).toBe("pending");
  });

  test("a guest's edit never asks, and an edit that already carried @agent doesn't ask again", () => {
    const guestEdit = editMessage(
      make({ member: false }),
      { msgId: "m1", actorId: ADA, body: agentAsk },
      T0 + 1,
    );
    expect(guestEdit.state.agentWork).toBeUndefined();
    const answered = answerAgentWork(pending(), ADA, T0 + 1).state;
    const again = editMessage(
      answered,
      { msgId: "m1", actorId: ADA, body: { ...agentAsk, text: "@agent tighten it" }, member: true },
      T0 + 2,
    );
    expect(again.state.agentWork?.status).toBe("answered");
  });
});

describe("attention precedence for the requester (finding 4)", () => {
  test("someone else's reply leaves the requester waiting on the agent", () => {
    const replied = addMessage(
      pending(),
      { authorId: BEN, body: { text: "looks fine" } },
      MAX,
      T0 + 1,
    ).state;
    const sets = computeAttention([replied], ADA, T0 + 2, WINDOW);
    expect(sets.needsYou).toEqual([]);
    expect(sets.waiting).toEqual([{ interaction: replied, because: "waiting-on-agent" }]);
  });

  test("an unanswered @mention of the requester still needs them", () => {
    const mentioned = addMessage(
      pending(),
      { authorId: BEN, body: { text: "@Ada?", tokens: [{ t: "actor", actorId: ADA }] } },
      MAX,
      T0 + 1,
    ).state;
    const sets = computeAttention([mentioned], ADA, T0 + 2, WINDOW);
    expect(sets.needsYou).toEqual([{ interaction: mentioned, because: "mentioned" }]);
  });
});

describe("a guest's pick on an owned Edit (admission table)", () => {
  test("the agent work is requested by the Edit's author, and replay agrees", () => {
    const owned = make({
      kind: "change",
      change: { intent: "x", method: "variant-set", ownsSource: true },
      requestAgent: false,
    });
    const picked = pickEdit(owned, BEN, T0 + 1, ADA);
    expect(picked.changed && picked.state.agentWork?.requestedBy).toBe(ADA);
    expect(picked.state.change?.keptBy).toBe(BEN);
    const replayed = replayInteractions(
      [
        {
          k: "int-create",
          ts: T0,
          id: "i1",
          kind: "change",
          url: URL_,
          expectUrlPrefix: URL_,
          anchor: { level: "page" },
          authorId: ADA,
          member: true,
          change: { intent: "x", method: "variant-set", ownsSource: true },
          requestAgent: false,
        },
        { k: "int-pick", ts: T0 + 1, id: "i1", actorId: BEN, requestedBy: ADA },
        { k: "int-variants", ts: T0 + 2, id: "i1", setId: "s1", actorId: ADA },
      ].map((e) => encodeInteractionEntry(e as InteractionJournalEntry)),
      MAX,
    ).get("i1");
    expect(replayed?.agentWork?.requestedBy).toBe(ADA);
    expect(replayed?.state).toBe("working");
  });
});

describe("the share debt is its own record (round 2, S10)", () => {
  test("sharing with someone already in the thread still owes them a look; unsharing keeps them", () => {
    const mentioned = addMessage(
      make(),
      {
        authorId: ADA,
        body: { text: "@Ben", tokens: [{ t: "actor", actorId: BEN }] },
        member: true,
      },
      MAX,
      T0 + 1,
    ).state;
    expect(mentioned.participants).toContain(BEN);
    const shared = shareWith(mentioned, BEN);
    expect(shared.shareUnseen).toEqual([BEN]);
    expect(shared.sharedWith).toEqual([BEN]);
    const unshared = unshare(shared, BEN);
    expect(unshared.participants).toContain(BEN);
    expect(unshared.shareUnseen).toBeUndefined();
    // A newcomer the share added leaves with it.
    const added = shareWith(make(), BEN);
    expect(unshare(added, BEN).participants).not.toContain(BEN);
  });

  test("only the person's own reply pays the debt, never their agent's", () => {
    const shared = shareWith(make(), BEN);
    const byAgent = addMessage(
      shared,
      { authorId: BEN, body: { text: "on it" }, agent: true },
      MAX,
      T0 + 1,
    );
    expect(byAgent.state.shareUnseen).toEqual([BEN]);
    const byPerson = addMessage(shared, { authorId: BEN, body: { text: "thanks" } }, MAX, T0 + 1);
    expect(byPerson.state.shareUnseen).toBeUndefined();
  });
});
