// The thread panel: the sidecar that opens from a pin. Built after the
// extension's (overlay/thread.ts and the variant panel in overlay/variants.ts):
// the same head, meta row, messages, reactions, reply box and, for an Edit,
// the request and the Variants it produced. It draws an `Item` and reports
// every act through `ThreadActions`; it keeps no truth of its own.
import { ageLabel, agentTag, avatar, clear, el, GLYPHS, icon, microLabel } from "./dom";
import { createEditor, type Editor } from "./editor";
import {
  chipFor,
  type Directory,
  type Item,
  isLive,
  type Msg,
  personOf,
  placeLabel,
} from "./model";
import { type RichDeps, richBody } from "./rich";
import { AGENT_WORK_LABEL, KIND_LABEL, REACTIONS, THREAD, VARIANTS as V } from "./strings";

const CHIP_CLASS = {
  "needs-you": "chip-needs",
  waiting: "chip-waiting",
  resolved: "chip-resolved",
} as const;

/** How many characters of a message a quote chip shows. */
const QUOTE_CHARS = 80;
/** A reader this close to the bottom follows new messages. */
const STICK_PX = 24;

export interface ThreadActions {
  reply(id: string, text: string, replyTo: string | null): void;
  react(id: string, msgId: string, emoji: string, on: boolean): void;
  editMsg(id: string, msgId: string, text: string): void;
  deleteMsg(id: string, msgId: string): void;
  resolve(id: string): void;
  reopen(id: string): void;
  cycle(id: string, delta: 1 | -1): void;
  pick(id: string): void;
  discard(id: string): void;
  more(id: string): void;
  commentVariant(id: string, text: string): void;
  /** A control the product has and this page cannot run (Copy for agent, Share). */
  away(): void;
  close?(): void;
}

export interface ThreadDeps {
  people: Directory;
  selfId: string;
  now(): number;
  rich: RichDeps;
  get(id: string): Item | undefined;
  actions: ThreadActions;
  /** Floating beside the page (the demo) or set in it (a section fragment). */
  floating: boolean;
  /** More variants can still be asked for. */
  canAskMore?(item: Item): boolean;
}

export interface ThreadPanel {
  element: HTMLElement;
  open(id: string): void;
  close(): void;
  isOpen(): boolean;
  currentId(): string | null;
  render(): void;
  /** Put the caret in the reply box. */
  focusReply(): void;
  /** Forget everything typed and not sent. */
  clearDrafts(): void;
}

export function createThreadPanel(deps: ThreadDeps): ThreadPanel {
  const { actions } = deps;
  const panel = el("div", "card thread-panel");
  panel.setAttribute("role", deps.floating ? "dialog" : "group");
  panel.hidden = deps.floating;
  const head = el("div", "card-head");
  const title = el("span", "title");
  const copyAgent = headButton(THREAD.copyForAgent, () => actions.away());
  const share = headButton(THREAD.share, () => actions.away());
  const close = headButton(THREAD.close, () => actions.close?.());
  head.append(title, copyAgent, share, close);
  const body = el("div", "card-body thread-body");
  panel.append(head, body);

  let currentId: string | null = null;
  let editingMsgId: string | null = null;
  let replyTo: string | null = null;
  let pendingPop: string | null = null;
  let lastPaint = "";
  let lastLen = 0;
  let lastId: string | null = null;
  const drafts = new Map<string, string>();
  let editors = new Map<string, Editor>();
  let focusKey: string | null = null;
  let wantFocus: string | null = null;

  function headButton(text: string, run: () => void): HTMLButtonElement {
    const b = el("button", "btn ghost sm", text);
    b.type = "button";
    b.addEventListener("click", run);
    return b;
  }

  function editor(key: string, placeholder: string, onSend: () => void): Editor {
    const ed = createEditor({
      placeholder,
      label: placeholder,
      onSend,
      onInput: (text) => {
        if (text) drafts.set(key, text);
        else drafts.delete(key);
      },
    });
    ed.set(drafts.get(key) ?? "");
    ed.input.addEventListener("focus", () => {
      focusKey = key;
    });
    ed.input.addEventListener("blur", () => {
      if (focusKey === key) focusKey = null;
    });
    editors.set(key, ed);
    return ed;
  }

  /**
   * A button of the thread. `key` names the control across repaints: a state
   * change redraws the body, and focus goes back to the control that had it
   * (the same key), so stepping variants from the keyboard never drops focus.
   */
  function button(cls: string, text: string, run: () => void, key?: string): HTMLButtonElement {
    const b = el("button", cls, text);
    b.type = "button";
    if (key) b.dataset.fk = key;
    b.addEventListener("click", run);
    return b;
  }

  /* ── messages ── */

  function firstLine(m: Msg): string {
    const line = m.text.split("\n").find((l) => l.trim().length > 0 && !l.startsWith("```")) ?? "";
    return line.length > QUOTE_CHARS ? `${line.slice(0, QUOTE_CHARS)}…` : line;
  }

  function reveal(msgId: string): void {
    for (const n of body.querySelectorAll("[data-msg-id]")) {
      if ((n as HTMLElement).dataset.msgId !== msgId) continue;
      n.scrollIntoView?.({ block: "center" });
      n.classList.remove("flash");
      void (n as HTMLElement).offsetWidth;
      n.classList.add("flash");
      return;
    }
  }

  function quoteChip(item: Item, msgId: string, onCancel?: () => void): HTMLElement {
    const target = item.thread.find((t) => t.id === msgId);
    const cancel = (): HTMLElement => {
      const x = button("quote-cancel", "×", () => onCancel?.(), "quote-cancel");
      x.title = THREAD.cancelReply;
      x.setAttribute("aria-label", THREAD.cancelReply);
      x.addEventListener("click", (e) => e.stopPropagation());
      return x;
    };
    if (!target || target.deleted) {
      const gone = el("div", "quote-chip missing", THREAD.quoteGone);
      if (onCancel) gone.appendChild(cancel());
      return gone;
    }
    const author = personOf(deps.people, target.authorId);
    const chip = el("div", "quote-chip");
    chip.append(
      avatar(author, "sm"),
      el("span", "quote-text", `${author.name}: ${firstLine(target)}`),
    );
    chip.addEventListener("click", () => reveal(msgId));
    if (onCancel) chip.appendChild(cancel());
    return chip;
  }

  function reactions(item: Item, m: Msg): HTMLElement {
    const wrap = el("div", "reactions");
    const toggle = (emoji: string, on: boolean): void => {
      pendingPop = `${m.id}:${emoji}`;
      actions.react(item.id, m.id, emoji, on);
    };
    for (const [emoji, who] of Object.entries(m.reactions)) {
      if (who.length === 0) continue;
      const on = who.includes(deps.selfId);
      const chip = button(
        `react${on ? " on" : ""}`,
        "",
        () => toggle(emoji, !on),
        `react:${m.id}:${emoji}`,
      );
      chip.title = who.map((id) => personOf(deps.people, id).name).join(", ");
      chip.setAttribute("aria-pressed", String(on));
      chip.append(el("span", undefined, emoji), el("span", undefined, String(who.length)));
      if (pendingPop === `${m.id}:${emoji}`) chip.classList.add("pop");
      wrap.appendChild(chip);
    }
    // Quick-add offers only what has no chip yet: an existing reaction is
    // joined or left by its own chip.
    const bar = el("div", "react-bar");
    for (const emoji of REACTIONS) {
      if ((m.reactions[emoji]?.length ?? 0) > 0) continue;
      const b = button("react", emoji, () => toggle(emoji, true), `react:${m.id}:${emoji}`);
      b.title = THREAD.reactTitle;
      bar.appendChild(b);
    }
    wrap.appendChild(bar);
    return wrap;
  }

  function message(item: Item, m: Msg): HTMLElement {
    const author = personOf(deps.people, m.authorId);
    const wrap = el("div", "msg");
    wrap.dataset.msgId = m.id;
    const headRow = el("div", "msg-head");
    headRow.append(avatar(author, "sm"), el("span", "msg-author", author.name));
    if (m.agent) headRow.append(agentTag(THREAD.agentTag, THREAD.agentTagTitle));
    headRow.append(microLabel(ageLabel(m.ts, deps.now())));
    if (m.editedAt !== undefined) headRow.append(el("span", "dim", THREAD.edited));
    wrap.appendChild(headRow);
    if (m.deleted) {
      wrap.appendChild(el("div", "msg-body dim", THREAD.deleted));
      return wrap;
    }
    if (m.replyTo) wrap.appendChild(quoteChip(item, m.replyTo));
    const bodyEl = el("div", "msg-body");
    bodyEl.appendChild(richBody(m.text, deps.rich));
    wrap.appendChild(bodyEl);
    wrap.appendChild(reactions(item, m));

    const own = m.authorId === deps.selfId && !m.agent;
    if (own && editingMsgId === m.id) {
      const key = `edit:${item.id}:${m.id}`;
      const save = (): void => {
        const text = ed.value();
        if (text) actions.editMsg(item.id, m.id, text);
        drafts.delete(key);
        editingMsgId = null;
        render();
      };
      const ed = editor(key, THREAD.revise, save);
      const row = el("div", "row");
      row.append(
        button("btn sm primary", THREAD.save, save),
        button("btn ghost sm", THREAD.cancel, () => {
          drafts.delete(key);
          editingMsgId = null;
          render();
        }),
      );
      ed.wrap.appendChild(row);
      wrap.appendChild(ed.wrap);
      return wrap;
    }
    const acts = el("div", "msg-acts");
    acts.appendChild(
      button(
        "msg-act",
        THREAD.reply,
        () => {
          replyTo = m.id;
          wantFocus = `reply:${item.id}`;
          render();
        },
        `act:${m.id}:reply`,
      ),
    );
    if (own) {
      const key = `edit:${item.id}:${m.id}`;
      acts.appendChild(
        button("msg-act", THREAD.edit, () => {
          editingMsgId = m.id;
          drafts.set(key, m.text);
          wantFocus = key;
          render();
        }),
      );
      const del = button("msg-act", THREAD.del, () => {
        if (del.textContent === THREAD.del) {
          del.textContent = THREAD.confirm;
          setTimeout(() => {
            del.textContent = THREAD.del;
          }, 2500);
        } else {
          actions.deleteMsg(item.id, m.id);
        }
      });
      acts.appendChild(del);
    }
    wrap.appendChild(acts);
    return wrap;
  }

  /* ── the Variants an Edit produced ── */

  function variantPanel(item: Item): HTMLElement {
    const set = item.variants;
    const mount = el("div", "variant-inline-mount");
    if (!set) return mount;
    const card = el("div", "card variant-panel inline");
    const cardBody = el("div", "card-body");
    card.appendChild(cardBody);
    mount.appendChild(card);

    cardBody.appendChild(el("div", "variant-target", item.anchor?.target ?? ""));
    const line = microLabel(V.editLine(item.id, item.state));
    cardBody.appendChild(line);

    const n = set.variants.length;
    const shown = set.shown;
    const previewing = set.status === "previewing";
    const active = previewing && shown !== null && shown >= 0 ? set.variants[shown] : undefined;

    if (previewing && n > 0) {
      const cycleRow = el("div", "row");
      const prev = button("btn sm", V.prev, () => actions.cycle(item.id, -1), "variant-prev");
      prev.setAttribute("aria-label", "Previous variant");
      const next = button("btn sm", V.next, () => actions.cycle(item.id, 1), "variant-next");
      next.setAttribute("aria-label", "Next variant");
      const more = button("btn sm", V.more, () => actions.more(item.id), "variant-more");
      more.title = V.moreTitle;
      more.setAttribute("aria-label", V.moreTitle);
      more.disabled = !(deps.canAskMore?.(item) ?? false);
      const current = el(
        "span",
        "variant-current",
        active ? V.current((shown as number) + 1, n, active.label) : V.original,
      );
      current.setAttribute("role", "status");
      cycleRow.append(prev, current, next, more);
      cardBody.appendChild(cycleRow);
    }

    if (previewing) {
      const terminal = el("div", "row");
      const pick = button(
        "btn primary k-change",
        V.pick,
        () => actions.pick(item.id),
        "variant-pick",
      );
      pick.disabled = !active;
      const discard = button(
        "btn danger",
        V.discard,
        () => actions.discard(item.id),
        "variant-discard",
      );
      terminal.append(pick, discard);
      cardBody.appendChild(terminal);
    }

    if (active) {
      const key = `variant-comment:${item.id}`;
      const send = (): void => {
        const text = ed.value();
        if (!text) return;
        drafts.delete(key);
        actions.commentVariant(item.id, text);
      };
      const ed = editor(key, V.commentPlaceholder, send);
      const row = el("div", "row");
      row.appendChild(button("btn sm", V.commentSend, send, "variant-comment"));
      ed.wrap.appendChild(row);
      cardBody.appendChild(ed.wrap);
    }

    const status =
      set.status === "generating"
        ? V.generating
        : set.status === "resolved"
          ? V.outcome(set.status, set.outcome ?? "")
          : active
            ? V.previewing((shown as number) + 1, n, active.label)
            : V.ready(n);
    cardBody.appendChild(el("div", "variant-status", status));
    return mount;
  }

  /* ── render ── */

  function render(): void {
    if (currentId === null) return;
    const item = deps.get(currentId);
    if (!item) {
      close_();
      return;
    }
    const sameThread = lastId === currentId;
    const paint = `${JSON.stringify(item)}|${editingMsgId}|${replyTo}|${deps.now() - (deps.now() % 60_000)}`;
    if (sameThread && paint === lastPaint && wantFocus === null && pendingPop === null) return;
    lastPaint = paint;
    lastId = currentId;
    const keepScroll = sameThread ? body.scrollTop : 0;
    const atBottom =
      sameThread && body.scrollHeight - body.scrollTop - body.clientHeight <= STICK_PX;
    // The control that has focus now, by its key: it gets focus back below.
    const scope = body.getRootNode() as Document | ShadowRoot;
    const focused = scope.activeElement as HTMLElement | null;
    const hadFocus = focused !== null && body.contains(focused);
    const heldKey = hadFocus ? (focused.dataset?.fk ?? null) : null;
    const refocus = wantFocus ?? focusKey;
    const caret = refocus ? editors.get(refocus)?.input.selectionStart : undefined;
    wantFocus = null;
    editors = new Map();
    clear(body);

    const label = KIND_LABEL[item.kind];
    const cls = item.kind === "comment" ? "k-comment" : "k-change";
    title.textContent = label;
    panel.setAttribute("aria-label", label);

    const meta = el("div", "row-wrap");
    const kindChip = el("span", `chip chip-kind ${cls}`);
    kindChip.append(icon(GLYPHS[item.kind], "icon-sm"), el("span", undefined, label));
    meta.append(
      kindChip,
      el("span", `chip ${CHIP_CLASS[chipFor(item)]}`, item.state),
      microLabel(placeLabel(item, THREAD.pageLevel)),
    );
    if (item.agentWork) meta.append(el("span", "dim", `· ${AGENT_WORK_LABEL[item.agentWork]}`));
    if (item.space) meta.append(el("span", "dim", `· ${item.space}`));
    body.appendChild(meta);

    if (item.kind === "change" && item.change) {
      const intent = el("div", "edit-intent");
      intent.appendChild(richBody(item.change.intent, deps.rich));
      body.appendChild(intent);
      body.appendChild(el("div", "dim", THREAD.method(item.change.method, item.state)));
      if (item.variants) body.appendChild(variantPanel(item));
    }

    for (const m of item.thread) body.appendChild(message(item, m));

    const live = isLive(item.state);
    const replyKey = `reply:${item.id}`;
    if (replyTo !== null) {
      body.appendChild(
        quoteChip(item, replyTo, () => {
          replyTo = null;
          render();
        }),
      );
    }
    const send = (): void => {
      const text = reply.value();
      if (!text) return;
      const to = replyTo;
      replyTo = null;
      drafts.delete(replyKey);
      wantFocus = replyKey;
      actions.reply(item.id, text, to);
    };
    const reply = editor(replyKey, live ? THREAD.replyPlaceholder : THREAD.followPlaceholder, send);
    const row = el("div", "row");
    row.appendChild(
      button("btn primary sm", live ? THREAD.replySend : THREAD.followSend, send, "reply-send"),
    );
    if (live)
      row.appendChild(
        button("btn ghost sm", THREAD.resolve, () => actions.resolve(item.id), "thread-state"),
      );
    else
      row.appendChild(
        button("btn ghost sm", THREAD.reopen, () => actions.reopen(item.id), "thread-state"),
      );
    reply.wrap.appendChild(row);
    body.appendChild(reply.wrap);

    pendingPop = null;
    const grew = sameThread && item.thread.length > lastLen;
    lastLen = item.thread.length;
    body.scrollTop = grew && atBottom ? body.scrollHeight : keepScroll;
    if (refocus) {
      const ed = editors.get(refocus);
      if (ed) {
        ed.input.focus({ preventScroll: true });
        const at = Math.min(caret ?? ed.input.value.length, ed.input.value.length);
        ed.input.setSelectionRange(at, at);
      }
    } else if (hadFocus) {
      // The body was redrawn under the control that had focus: the control
      // of the same key takes it, or, when that control is gone (a pick ends
      // the stepping), the reply box.
      let next: HTMLElement | null = null;
      if (heldKey !== null) {
        for (const n of body.querySelectorAll<HTMLElement>("[data-fk]")) {
          if (n.dataset.fk !== heldKey || (n as HTMLButtonElement).disabled) continue;
          next = n;
          break;
        }
      }
      next ??= editors.get(replyKey)?.input ?? null;
      next?.focus({ preventScroll: true });
    }
  }

  function close_(): void {
    panel.hidden = true;
    currentId = null;
    editingMsgId = null;
    replyTo = null;
    lastPaint = "";
  }

  if (deps.floating) {
    head.title = THREAD.dragTitle;
    wireDrag(panel, head);
    const grip = el("div", "panel-grip");
    grip.title = THREAD.gripTitle;
    panel.appendChild(grip);
    wireResize(panel, grip);
  }

  return {
    element: panel,
    open(id) {
      if (currentId !== id) {
        editingMsgId = null;
        replyTo = null;
        lastPaint = "";
      }
      currentId = id;
      panel.hidden = false;
      render();
    },
    close: close_,
    isOpen: () => !panel.hidden,
    currentId: () => currentId,
    render,
    focusReply() {
      if (currentId === null) return;
      editors.get(`reply:${currentId}`)?.focus();
    },
    clearDrafts() {
      drafts.clear();
      focusKey = null;
      wantFocus = null;
    },
  };
}

/* The sidecar sits beside the page it discusses: drag it by its head when it
   is in the way. Right-anchored, as in the extension, so the grip's math
   holds; the place is for this visit only. */
function wireDrag(panel: HTMLElement, head: HTMLElement): void {
  head.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest?.("button")) return;
    if (e.button !== 0 || window.matchMedia("(max-width: 40em)").matches) return;
    e.preventDefault();
    head.setPointerCapture(e.pointerId);
    const r = panel.getBoundingClientRect();
    const startRight = window.innerWidth - r.right;
    const startTop = r.top;
    const sx = e.clientX;
    const sy = e.clientY;
    const onMove = (ev: PointerEvent): void => {
      const right = Math.min(
        Math.max(0, startRight - (ev.clientX - sx)),
        Math.max(0, window.innerWidth - r.width),
      );
      const top = Math.min(
        Math.max(0, startTop + (ev.clientY - sy)),
        Math.max(0, window.innerHeight - 48),
      );
      panel.style.right = `${Math.round(right)}px`;
      panel.style.top = `${Math.round(top)}px`;
    };
    const onUp = (): void => {
      head.removeEventListener("pointermove", onMove);
      head.removeEventListener("pointerup", onUp);
      head.removeEventListener("pointercancel", onUp);
    };
    head.addEventListener("pointermove", onMove);
    head.addEventListener("pointerup", onUp);
    head.addEventListener("pointercancel", onUp);
  });
}

/* The grip is on the bottom-left: the panel is right-anchored, so dragging
   the free corner grows it toward the page. */
function wireResize(panel: HTMLElement, grip: HTMLElement): void {
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const r = panel.getBoundingClientRect();
    const onMove = (ev: PointerEvent): void => {
      const w = Math.min(Math.max(375, r.width + (startX - ev.clientX)), window.innerWidth * 0.92);
      const h = Math.min(
        Math.max(325, r.height + (ev.clientY - startY)),
        window.innerHeight * 0.88,
      );
      panel.style.width = `${Math.round(w)}px`;
      panel.style.height = `${Math.round(h)}px`;
    };
    const onUp = (): void => {
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onUp);
    };
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onUp);
  });
}
