// The arriving Ask control (ADR-0003): options are data, one card renders
// every recipe. Immediate submit = click answers; explicit = stage picks then
// Send; ordered = pick-order badges; min/max enforced; answer-comment gated;
// stakes tune loudness (routine quiet, careful amber, dangerous red + explicit
// submit). Multi-recipient asks wear a quiet status line (who's waited on,
// the resolves rule, the running count). Once closed, the control freezes
// into a DECISION ARTIFACT (F-043): the picked option(s) as real rows,
// non-picked options collapsed but present, one row per answer (who · what ·
// words · when), and a closing line derived from the resolves rule. The
// control answers — never the thread.
import type { AskAnswer, AskPayload, ResolvesWhen } from "@onlay/protocol";
import type { App, InteractionSnap as Snapshot } from "./app";
import { avatar, el, icon } from "./dom";
import { KINDS } from "./kinds";
import { tokenInput } from "./token-input";
import { renderRichText } from "./token-text";

const STAR: string[] = ["M12 2l3 6.5 7 .9-5 4.7 1.3 7L12 18l-6.6 3.1 1.3-7-5-4.7 7-.9z"];
const CHECK: string[] = ["M20 6 9 17l-5-5"];

export type AskSnapshot = Snapshot & { ask: AskPayload & { answers: AskAnswer[] } };

export function isAsk(s: Snapshot): s is AskSnapshot {
  return s.kind === "ask" && s.ask !== undefined;
}

function selfAnswer(app: App, s: AskSnapshot): AskAnswer | undefined {
  const self = app.selfId();
  if (!self) return undefined;
  return s.ask.answers.find((a) => a.actorId === self);
}

/* ── shared derivations (client mirror of kernel answerAsk) ─────────── */

const RULE_LABEL: Record<ResolvesWhen, string> = {
  "any-one": "any one",
  majority: "majority",
  everyone: "everyone",
};

/** Count of answerers whose exact pick is the most common one (the vote). */
function topPickCount(answers: AskAnswer[]): number {
  const tally = new Map<string, number>();
  for (const a of answers) {
    const key = [...a.optionIds].sort().join("|");
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  return Math.max(0, ...tally.values());
}

/** Client mirror of the kernel's aggregate rule (kernel/interaction.ts). */
export function aggregateMet(ask: AskSnapshot["ask"]): boolean {
  const answers = ask.answers;
  if (answers.length === 0) return false;
  const rule = ask.resolvesWhen ?? "any-one";
  if (rule === "any-one") return true;
  if (rule === "everyone") return ask.waitingOn.every((a) => answers.some((x) => x.actorId === a));
  return topPickCount(answers) * 2 > ask.waitingOn.length;
}

/** Small relative-time readout for answer rows ("just now" · "2h ago"). */
export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** How the ask closed — derived from rule + answers vs addressees + state. */
export function closingLine(app: App, s: AskSnapshot): string {
  const ask = s.ask;
  const answers = ask.answers;
  const of = ask.waitingOn.length;
  const rule = ask.resolvesWhen ?? "any-one";
  if (aggregateMet(ask)) {
    if (of <= 1) {
      const first = answers[0];
      return first
        ? `closed: answered by ${app.person(first.actorId, s.spaceId).name}`
        : "closed: answered";
    }
    if (rule === "any-one") return "closed: first answer (any one)";
    if (rule === "everyone") return `closed: everyone answered (${of}/${of})`;
    return `closed: majority met (${topPickCount(answers)}/${of})`;
  }
  // Closed without the rule being met — the asker exercised resolve.
  return `resolved by ${app.person(s.authorId, s.spaceId).name}`;
}

export interface AskCardOpts {
  /** Compact = no context block, one-line frozen summary (rail/pin popover). */
  compact?: boolean;
  /** Composer live preview: the real control renders but can never answer. */
  preview?: boolean;
}

/* ── the open-state status line (multi-recipient) ───────────────────── */

function statusLine(app: App, s: AskSnapshot): HTMLElement {
  const ask = s.ask;
  const line = el("div", "ask-status");
  line.appendChild(el("span", "micro", "waiting on"));
  const stack = el("span", "avatar-stack");
  for (const id of ask.waitingOn.slice(0, 8))
    stack.appendChild(avatar(app.person(id, s.spaceId), "sm"));
  line.appendChild(stack);
  if (ask.resolvesWhen) {
    line.appendChild(el("span", "chip chip-rule", `resolves: ${RULE_LABEL[ask.resolvesWhen]}`));
  }
  const answered = new Set(ask.answers.map((a) => a.actorId)).size;
  line.appendChild(el("span", "dim", `${answered}/${ask.waitingOn.length} answered`));
  return line;
}

/* ── the decision artifact (frozen readback — F-043) ────────────────── */

/**
 * Everything the protocol carries must be visible here: descriptions,
 * the recommendation, every answerer with their comment and timestamp,
 * the resolves rule. Compact contexts get one line: check + picked labels
 * + ALL answerer avatars.
 */
function decisionView(
  app: App,
  s: AskSnapshot,
  mine: AskAnswer | undefined,
  opts: AskCardOpts,
): HTMLElement {
  const ask = s.ask;
  const answers = ask.answers;
  const pickedIds = new Set(answers.flatMap((a) => a.optionIds));
  const labelOf = (id: string): string => ask.options.find((o) => o.id === id)?.label ?? id;

  if (opts.compact) {
    const wrap = el("div", "ask-frozen");
    wrap.appendChild(icon({ paths: CHECK }, "icon-sm"));
    const picked = ask.options
      .filter((o) => pickedIds.has(o.id))
      .map((o) => o.label)
      .join(", ");
    wrap.appendChild(el("span", undefined, picked ? `Answered: ${picked}` : `Ask ${s.state}`));
    if (answers.length > 0) {
      const stack = el("span", "avatar-stack");
      for (const a of answers) stack.appendChild(avatar(app.person(a.actorId, s.spaceId), "sm"));
      wrap.appendChild(stack);
    }
    return wrap;
  }

  const wrap = el("div", "ask-decision");

  // The choice, preserved: picked options as real rows; the rest collapse
  // to quiet single lines so the context of the decision survives.
  for (const o of ask.options) {
    if (pickedIds.has(o.id)) {
      const row = el("div", "opt-frozen picked");
      const head = el("div", "row");
      head.appendChild(icon({ paths: CHECK }, "icon-sm"));
      head.appendChild(el("span", "opt-label", o.label));
      if (o.recommended) {
        const star = icon({ paths: STAR }, "icon-sm");
        star.style.color = "var(--amber)";
        star.setAttribute("aria-label", "was recommended");
        head.appendChild(star);
      }
      row.appendChild(head);
      if (o.description) row.appendChild(el("div", "opt-desc", o.description));
      wrap.appendChild(row);
    } else {
      wrap.appendChild(el("div", "opt-frozen quiet", o.label));
    }
  }

  // One row per answer: who · what they picked · their words · when.
  for (const a of answers) {
    const row = el("div", "ans-row");
    row.appendChild(avatar(app.person(a.actorId, s.spaceId), "sm"));
    const body = el("div");
    body.style.flex = "1";
    body.style.minWidth = "0";
    const head = el("div", "row-wrap");
    head.appendChild(el("span", "who", app.person(a.actorId, s.spaceId).name));
    head.appendChild(el("span", "dim", `→ ${a.optionIds.map(labelOf).join(", ") || "(no pick)"}`));
    body.appendChild(head);
    if (a.comment?.text) {
      const c = el("div", "ans-comment");
      c.appendChild(renderRichText(app, a.comment, { spaceId: s.spaceId }));
      body.appendChild(c);
    }
    row.appendChild(body);
    row.appendChild(el("span", "when", ago(a.ts)));
    wrap.appendChild(row);
  }

  // Answered-by-you-but-open: the group still owes answers.
  if (s.state === "open") {
    if (mine) {
      const answered = new Set(answers.map((a) => a.actorId)).size;
      wrap.appendChild(
        el(
          "div",
          "ask-closing",
          `you answered — waiting for others (${answered}/${ask.waitingOn.length})`,
        ),
      );
    }
  } else {
    wrap.appendChild(el("div", "ask-closing", closingLine(app, s)));
  }
  return wrap;
}

/** Build the arriving ask control for a snapshot. */
export function buildAskCard(app: App, s: AskSnapshot, opts: AskCardOpts = {}): HTMLElement {
  const preview = opts.preview === true;
  const stakes = s.ask.stakes ?? "routine";
  const card = el("div", `ask-card ${stakes}`);
  const header = el("div", "row-wrap");
  header.append(kindChip(), el("span", "ask-q", s.ask.question));
  card.appendChild(header);
  if (!opts.compact && s.ask.context) card.appendChild(el("div", "ask-ctx", s.ask.context));

  const mine = preview ? undefined : selfAnswer(app, s);
  const frozen = mine !== undefined || s.state === "resolved" || s.state === "answered";
  if (frozen) {
    card.appendChild(decisionView(app, s, mine, opts));
    return card;
  }

  if (!opts.compact && s.ask.waitingOn.length > 1) card.appendChild(statusLine(app, s));

  const explicit = s.ask.selection.submit === "explicit" || stakes === "dangerous";
  const ordered = s.ask.selection.ordered === true;
  const max = s.ask.selection.max;
  const min = s.ask.selection.min;
  const hasDesc = s.ask.options.some((o) => o.description);
  const staged: string[] = [];

  const optsWrap = el("div", `ask-opts${hasDesc ? "" : " bare"}`);
  const btns = new Map<string, HTMLButtonElement>();

  const commentReq = s.ask.answerComment ?? "off";
  let commentInput: ReturnType<typeof tokenInput> | null = null;
  if (commentReq !== "off") {
    commentInput = tokenInput(
      app,
      commentReq === "required" ? "Comment (required)…" : "Comment (optional)…",
      preview ? {} : { draftKey: `ask-comment:${s.id}` },
    );
  }
  const status = el("div", "dim");

  function repaint(): void {
    for (const [id, b] of btns) {
      const idx = staged.indexOf(id);
      b.classList.toggle("staged", idx >= 0);
      const rank = b.querySelector(".opt-rank");
      if (rank) rank.textContent = ordered && idx >= 0 ? String(idx + 1) : "";
      if (rank) (rank as HTMLElement).style.display = ordered && idx >= 0 ? "block" : "none";
    }
  }

  async function answer(ids: string[]): Promise<void> {
    if (preview) return; // the composer's mirror never answers
    if (ids.length < min) {
      status.textContent = `pick at least ${min}`;
      return;
    }
    const commentVal = commentInput?.value();
    if (commentReq === "required" && !commentVal?.text) {
      status.textContent = "comment required";
      return;
    }
    status.textContent = "sending…";
    const r = await app.send({
      type: "ask-answer",
      interactionId: s.id,
      optionIds: ids,
      ...(commentVal?.text ? { comment: commentVal } : {}),
    });
    if (r.ok) {
      app.toast("answer recorded");
      commentInput?.clear();
    } else status.textContent = `not sent: ${r.error ?? "unknown"}`;
  }

  for (const o of s.ask.options) {
    const b = document.createElement("button");
    b.className = `opt-btn${hasDesc ? "" : " bare"}${o.recommended ? " primary" : ""}`;
    if (ordered) {
      const rank = el("span", "opt-rank");
      rank.style.display = "none";
      b.appendChild(rank);
    }
    const body = el("span");
    body.style.flex = "1";
    body.appendChild(el("span", "opt-label", o.label));
    if (o.description) body.appendChild(el("div", "opt-desc", o.description));
    b.appendChild(body);
    if (o.recommended) {
      const star = icon({ paths: STAR }, "icon-sm opt-rec");
      (star as unknown as HTMLElement).style.color = "var(--amber)";
      b.appendChild(star);
    }
    b.addEventListener("click", (e) => {
      if (!e.isTrusted && !preview) return; // page JS must not answer through the open shadow root
      if (!explicit && max === 1) {
        void answer([o.id]);
        return;
      }
      const idx = staged.indexOf(o.id);
      if (idx >= 0) staged.splice(idx, 1);
      else {
        if (staged.length >= max) {
          if (max === 1) staged.length = 0;
          else return;
        }
        staged.push(o.id);
      }
      repaint();
    });
    btns.set(o.id, b);
    optsWrap.appendChild(b);
  }
  card.appendChild(optsWrap);
  if (commentInput) card.appendChild(commentInput.wrap);
  card.appendChild(status);

  if (explicit || max > 1 || min === 0) {
    const sendRow = el("div", "row");
    const send = el("button", "btn primary k-ask", "Send answer") as HTMLButtonElement;
    send.prepend(icon({ paths: CHECK }, "icon-sm"));
    if (preview) {
      send.disabled = true;
      send.title = "preview — the recipient's Send";
    }
    send.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      void answer([...staged]);
    });
    sendRow.appendChild(send);
    card.appendChild(sendRow);
  }

  return card;

  function kindChip(): HTMLElement {
    const chip = el("span", `chip chip-kind ${KINDS.ask.cls}`);
    chip.append(icon(KINDS.ask.glyph, "icon-sm"), el("span", undefined, "Ask"));
    return chip;
  }
}
