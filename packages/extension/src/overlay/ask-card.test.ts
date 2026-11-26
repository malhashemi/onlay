/// <reference types="chrome" />
// The arriving/answered ask card (F-043): the open multi-recipient status
// line (who's waited on · resolves rule · running count), the frozen
// DECISION ARTIFACT (picked options as real rows with description +
// recommendation, non-picked collapsed but present, one row per answer with
// comment and relative time), the closing-line derivations for all three
// resolves rules plus asker-resolve, the compact one-line summary, and the
// composer-preview flag that defuses sends.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AskAnswer } from "@onlay/protocol";
import { Window } from "happy-dom";
import { type AppInternals, createApp } from "./app";
import { type AskSnapshot, aggregateMet, ago, buildAskCard, closingLine } from "./ask-card";
import type { PersonView } from "./people";

let win: Window | null = null;

function installDom(): void {
  win = new Window({ url: "http://127.0.0.1:8124/page.html" });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = win;
  g.document = win.document;
  g.Element = win.Element;
  g.HTMLElement = win.HTMLElement;
  g.HTMLTextAreaElement = win.HTMLTextAreaElement;
  g.HTMLInputElement = win.HTMLInputElement;
  g.Node = win.Node;
  g.Event = win.Event;
  g.KeyboardEvent = win.KeyboardEvent;
  g.location = win.location;
  g.crypto = win.crypto ?? globalThis.crypto;
}

beforeEach(installDom);
afterEach(() => {
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
});

const DIRECTORY: PersonView[] = [
  { id: "adel", name: "Adel", tint: "#0ea5e9", initials: "AD" },
  { id: "sara", name: "Sara", tint: "#ec4899", initials: "SA" },
  { id: "kim", name: "Kim", tint: "#10b981", initials: "KI" },
  { id: "scout", name: "Scout Agent", tint: "#8b5cf6", initials: "SC" },
];

function makeApp(selfId?: string): ReturnType<typeof createApp> & AppInternals {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const app = createApp({ shadow, host, isTopFrame: true, toast: () => {} }) as ReturnType<
    typeof createApp
  > &
    AppInternals;
  app._setDirectory("s_aaaaaaaaaaaaaaaaaaaa", DIRECTORY);
  if (selfId) {
    const self = DIRECTORY.find((a) => a.id === selfId);
    if (self) app._setSelf(self);
  }
  return app;
}

const ID = "3ebdb414-d0e7-48c0-8528-dd78afb073b5";

interface SnapOver {
  state?: string;
  waitingOn?: string[];
  resolvesWhen?: "any-one" | "majority" | "everyone";
  answers?: AskAnswer[];
  options?: AskSnapshot["ask"]["options"];
  selection?: AskSnapshot["ask"]["selection"];
  answerComment?: "off" | "optional" | "required";
}

function snap(over: SnapOver = {}): AskSnapshot {
  const waitingOn = over.waitingOn ?? ["adel"];
  return {
    spaceId: "s_aaaaaaaaaaaaaaaaaaaa",
    id: ID,
    kind: "ask",
    url: "http://127.0.0.1:8124/page.html",
    anchor: { level: "page" },
    authorId: "scout",
    participants: [],
    waitingOn,
    state: over.state ?? "open",
    thread: [],
    createdAt: 0,
    ask: {
      question: "Keep sky as the hue?",
      context: "taste decision",
      waitingOn,
      ...(over.resolvesWhen ? { resolvesWhen: over.resolvesWhen } : {}),
      selection: over.selection ?? { min: 1, max: 1, submit: "immediate" },
      ...(over.answerComment ? { answerComment: over.answerComment } : {}),
      options: over.options ?? [
        { id: "keep-sky", label: "Keep sky", description: "no churn", recommended: true },
        { id: "move-neutral", label: "Move neutral" },
      ],
      answers: over.answers ?? [],
    },
  } as AskSnapshot;
}

const answer = (actorId: string, optionIds: string[], ts = 1): AskAnswer => ({
  actorId,
  optionIds,
  ts,
});

/* ── the open state ────────────────────────────────────────────────── */

describe("open multi-recipient status line", () => {
  test("waiting-on avatars · rule chip · running count", () => {
    const card = buildAskCard(
      makeApp(),
      snap({
        waitingOn: ["adel", "sara", "kim"],
        resolvesWhen: "majority",
        answers: [answer("adel", ["keep-sky"])],
      }),
    );
    const status = card.querySelector(".ask-status");
    expect(status).not.toBeNull();
    expect(status?.textContent).toContain("resolves: majority");
    expect(status?.textContent).toContain("1/3 answered");
    expect(status?.querySelectorAll(".avatar")).toHaveLength(3);
    // the control is still live for me
    expect(card.querySelectorAll(".opt-btn").length).toBe(2);
  });

  test("rule chip absent when resolvesWhen unset; no status line for one recipient", () => {
    const multi = buildAskCard(makeApp(), snap({ waitingOn: ["adel", "sara"] }));
    expect(multi.querySelector(".ask-status")).not.toBeNull();
    expect(multi.querySelector(".chip-rule")).toBeNull();
    const single = buildAskCard(makeApp(), snap());
    expect(single.querySelector(".ask-status")).toBeNull();
  });
});

/* ── the decision artifact (frozen readback) ───────────────────────── */

describe("decision artifact", () => {
  test("picked options are real rows (desc + recommendation); non-picked collapse quiet", () => {
    const card = buildAskCard(
      makeApp(),
      snap({ state: "answered", answers: [answer("adel", ["keep-sky"])] }),
    );
    const picked = card.querySelector(".opt-frozen.picked");
    expect(picked?.textContent).toContain("Keep sky");
    expect(picked?.textContent).toContain("no churn"); // description survives
    expect(picked?.querySelector("[aria-label='was recommended']")).not.toBeNull();
    const quiet = card.querySelector(".opt-frozen.quiet");
    expect(quiet?.textContent).toBe("Move neutral");
  });

  test("one row per answer: who · picked labels · comment tokens · relative time", () => {
    const twoHoursAgo = Date.now() - 2 * 3600_000 - 1000;
    const card = buildAskCard(
      makeApp(),
      snap({
        state: "answered",
        waitingOn: ["adel", "sara"],
        resolvesWhen: "any-one",
        answers: [
          {
            actorId: "adel",
            optionIds: ["keep-sky"],
            comment: { text: "ship it @scout", tokens: [{ t: "actor", actorId: "scout" }] },
            ts: twoHoursAgo,
          },
        ],
      }),
    );
    const row = card.querySelector(".ans-row");
    expect(row?.textContent).toContain("Adel");
    expect(row?.textContent).toContain("→ Keep sky");
    expect(row?.textContent).toContain("ship it");
    expect(row?.querySelector(".token-actor")).not.toBeNull(); // comment renders tokens
    expect(row?.textContent).toContain("2h ago");
  });

  test("answered-by-you-but-open: your pick shows, plus the group wait", () => {
    const card = buildAskCard(
      makeApp("adel"),
      snap({
        state: "open",
        waitingOn: ["adel", "sara", "kim"],
        resolvesWhen: "everyone",
        answers: [answer("adel", ["keep-sky"])],
      }),
    );
    expect(card.textContent).toContain("you answered — waiting for others (1/3)");
    expect(card.querySelector(".opt-btn")).toBeNull(); // control froze for me
  });

  test("compact keeps one line: check + picked labels + ALL answerer avatars", () => {
    const card = buildAskCard(
      makeApp(),
      snap({
        state: "answered",
        waitingOn: ["adel", "sara"],
        answers: [answer("adel", ["keep-sky"]), answer("sara", ["keep-sky"])],
      }),
      { compact: true },
    );
    const line = card.querySelector(".ask-frozen");
    expect(line?.textContent).toContain("Answered: Keep sky");
    expect(line?.querySelectorAll(".avatar")).toHaveLength(2);
    expect(card.querySelector(".ask-decision")).toBeNull();
  });
});

/* ── closing-line derivations ──────────────────────────────────────── */

describe("closing line", () => {
  test("any one: the first answer settles it", () => {
    const s = snap({
      state: "answered",
      waitingOn: ["adel", "sara", "kim"],
      resolvesWhen: "any-one",
      answers: [answer("adel", ["keep-sky"])],
    });
    expect(closingLine(makeApp(), s)).toBe("closed: first answer (any one)");
  });

  test("majority: counts the agreeing answers", () => {
    const s = snap({
      state: "answered",
      waitingOn: ["adel", "sara", "kim"],
      resolvesWhen: "majority",
      answers: [
        answer("adel", ["keep-sky"]),
        answer("sara", ["keep-sky"]),
        answer("kim", ["move-neutral"]),
      ],
    });
    expect(aggregateMet(s.ask)).toBe(true);
    expect(closingLine(makeApp(), s)).toBe("closed: majority met (2/3)");
  });

  test("everyone: sign-off grade", () => {
    const s = snap({
      state: "answered",
      waitingOn: ["adel", "sara", "kim"],
      resolvesWhen: "everyone",
      answers: [
        answer("adel", ["keep-sky"]),
        answer("sara", ["move-neutral"]),
        answer("kim", ["keep-sky"]),
      ],
    });
    expect(closingLine(makeApp(), s)).toBe("closed: everyone answered (3/3)");
  });

  test("resolved before the rule was met: the asker exercised resolve", () => {
    const s = snap({
      state: "resolved",
      waitingOn: ["adel", "sara", "kim"],
      resolvesWhen: "everyone",
      answers: [answer("adel", ["keep-sky"])],
    });
    expect(aggregateMet(s.ask)).toBe(false);
    expect(closingLine(makeApp(), s)).toBe("resolved by Scout Agent");
    const card = buildAskCard(makeApp(), s);
    expect(card.textContent).toContain("resolved by Scout Agent");
  });

  test("single recipient reads plainly: answered by name", () => {
    const s = snap({ state: "answered", answers: [answer("adel", ["keep-sky"])] });
    expect(closingLine(makeApp(), s)).toBe("closed: answered by Adel");
  });
});

/* ── ago ───────────────────────────────────────────────────────────── */

describe("ago", () => {
  test("relative buckets", () => {
    const now = 10_000_000_000;
    expect(ago(now - 5_000, now)).toBe("just now");
    expect(ago(now - 3 * 60_000, now)).toBe("3m ago");
    expect(ago(now - 2 * 3600_000, now)).toBe("2h ago");
    expect(ago(now - 5 * 86_400_000, now)).toBe("5d ago");
  });
});

/* ── preview flag ──────────────────────────────────────────────────── */

describe("preview flag", () => {
  test("send disabled; the mirror can never answer", () => {
    const card = buildAskCard(
      makeApp("adel"),
      snap({ selection: { min: 1, max: 1, submit: "explicit" } }),
      { preview: true },
    );
    const send = card.querySelector(".btn.primary") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });
});
