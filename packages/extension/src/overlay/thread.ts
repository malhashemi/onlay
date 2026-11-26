// The per-interaction thread panel (spec §11): messages with people's avatars
// (an agent-marked message wears its person's, plus an "agent" tag), the
// space and agent-work state in the header, a share section for members,
// reply box, edit/delete of own messages
// (two-step confirm), an emoji reaction bar, system messages as centered rule
// lines, Enter sends / Shift+Enter newline. For an ask it embeds the arriving
// control (the control answers, never the thread); for a change it shows the
// implementation state. The panel is a pure view — it re-renders from the
// latest snapshot.
import { previewFirstLine, type RawThreadMsg } from "@onlay/protocol";
import { sameRevision } from "@onlay/render/mentions";
import { applyLocalReaction, REACTIONS } from "@onlay/render/reactions";
import { getPrefs, patchPrefs } from "../prefs";
import { anchorLabel } from "./anchors";
import type { App, InteractionSnap as Snapshot } from "./app";
import { buildAskCard, isAsk } from "./ask-card";
import { focusEnd } from "./caret";
import { richInput } from "./composers";
import {
  CHANGED_SINCE_COPIED,
  COPY_COPY,
  changedSince,
  copiedStore,
  copyAndRemember,
  itemText,
} from "./copy-agent";
import { agentTag, avatar, el, icon, microLabel, scaled } from "./dom";
import {
  clearDraftIfUnchanged,
  draftRevision,
  readDraft,
  replyQuote,
  setReplyQuote,
  writeRichDraft,
} from "./drafts";
import { routePointerDrag } from "./drag-router";
import {
  AGENT_WORK_LABEL,
  agentWorkStatus,
  CHIP_STATES,
  canFollowThrough,
  chipFor,
  isLiveState,
  KINDS,
} from "./kinds";
import { isCaptureDue } from "./resnap-model";
import { clientIdFor, confirmSend } from "./send-ids";

/** Beside a reply the socket dropped before the server answered (3b-C10). */
export const REPLY_NOT_SENT = "Your reply wasn't sent. Check your connection, then send it again.";

import { chromeShareDeps, type ShareDeps, shareSection } from "./share";
import type { AnchorToken } from "./token-input";
import { renderRichText } from "./token-text";

/** First line of a quoted reply target, bounded (ADR-0018 §1). */
const QUOTE_CHARS = 80;
/** Reader counts as "at the bottom" within this many px of it. */
const STICK_PX = 40;
/** Resize floor, 1×-authored — mirrors the sheet's .thread-panel min sizes. */
const MIN_W = 300;
const MIN_H = 260;
/** Kept clear below the panel (1×): the sheet's `100vh - 66px` for a panel 54px down. */
const BOTTOM_GAP = 12;
/** How much of a moved panel stays on screen at the least (1×): its head. */
const HEAD_ROOM = 48;

export interface ThreadPanel {
  element: HTMLElement;
  open(id: string): void;
  close(): void;
  isOpen(): boolean;
  currentId(): string | null;
  render(): void;
}

export interface ThreadPanelDeps {
  /**
   * A person opened this thread: read it by id so the server knows it was
   * opened (it clears a "shared with you" debt only on an explicit open).
   */
  onOpened?(interactionId: string): void;
  renderVariantSet?(setId: string, mount: HTMLElement): void;
  /** Enter element-pick mode to re-anchor a demoted interaction (ADR-0017). */
  onReanchor?(interactionId: string): void;
  /** Fulfill a "Capture due" duty: resolve the anchor + capture a fresh look (§3). */
  onFreshLook?(interactionId: string): void;
  /** Reveal/flash a #anchor token's spot on the page (token-text chips). */
  onAnchorClick?(token: AnchorToken): void;
  /** The share calls (tests stub them; default: the service worker + clipboard). */
  share?: ShareDeps;
  /** A kept Edit's standing on this page (the kept layer). */
  keptStatus?(interactionId: string): { unresolved: boolean } | null;
}

/** What a kept Edit's sidecar says when its program can't be applied here. */
export const KEPT_UNRESOLVED = "can't be shown on this page";

export function createThreadPanel(app: App, deps: ThreadPanelDeps = {}): ThreadPanel {
  const panel = el("div", "card thread-panel");
  const head = el("div", "card-head");
  head.style.cursor = "grab";
  head.title = "drag to move";
  const title = el("span", "title", "Thread");
  // Re-anchor affordance for a demoted (anchor-lost) interaction; shown per render.
  const reanchor = el("button", "btn ghost sm", "Re-anchor");
  reanchor.style.display = "none";
  // "Capture a fresh look" — a quiet duty, not an alarm: same muted styling as
  // Re-anchor, shown only when a fresh look is due on this page (§3, S2-D13).
  const freshLook = el("button", "btn ghost sm", "Capture a fresh look");
  freshLook.style.display = "none";
  // Members share a thread with an outside email (spec §10); guests never can.
  const share = el("button", "btn ghost sm", "Share");
  share.style.display = "none";
  // A pointer an agent reads current state from (spec §9) — never thread text.
  const copyAgent = el("button", "btn ghost sm", COPY_COPY.action);
  copyAgent.style.display = "none";
  const close = el("button", "btn ghost sm", "Close");
  head.append(title, reanchor, freshLook, copyAgent, share, close);
  copyAgent.addEventListener("click", (e) => {
    if (!e.isTrusted || currentId === null) return;
    const s = app.byId(currentId);
    if (s) void copyAndRemember(app, itemText(app, s), [s]);
  });
  share.addEventListener("click", (e) => {
    if (!e.isTrusted || currentId === null) return;
    shareOpen = !shareOpen;
    render();
  });
  reanchor.addEventListener("click", (e) => {
    if (!e.isTrusted || currentId === null) return;
    deps.onReanchor?.(currentId);
  });
  freshLook.addEventListener("click", (e) => {
    if (!e.isTrusted || currentId === null) return;
    deps.onFreshLook?.(currentId);
  });
  const body = el("div", "card-body thread-body");
  panel.append(head, body);

  // The sidecar sits beside the page it discusses — draggable by its header
  // when it obstructs the content. Coordinates stay RIGHT-anchored so the
  // resize grip's right-edge-pinned math keeps holding; position is
  // session-only (a fresh open returns to the default corner).
  let headDrag: { r: DOMRect; right: number; top: number; x: number; y: number } | null = null;
  const headMover = routePointerDrag(head, {
    accept: (e) => !(e.target as HTMLElement).closest?.("button"), // buttons stay buttons
    begin(e) {
      head.style.cursor = "grabbing";
      const r = panel.getBoundingClientRect();
      headDrag = { r, right: window.innerWidth - r.right, top: r.top, x: e.clientX, y: e.clientY };
    },
    move(ev) {
      if (!headDrag) return;
      const { r } = headDrag;
      const right = Math.min(
        Math.max(0, headDrag.right - (ev.clientX - headDrag.x)),
        Math.max(0, window.innerWidth - r.width),
      );
      const top = Math.min(
        Math.max(0, headDrag.top + (ev.clientY - headDrag.y)),
        Math.max(0, window.innerHeight - 48),
      );
      panel.style.right = `${Math.round(right)}px`;
      panel.style.top = `${Math.round(top)}px`;
      fit();
    },
    end() {
      headDrag = null;
      head.style.cursor = "grab";
    },
  });

  /**
   * The panel's least and greatest height, from the room below its top: on a
   * short window the least gives way, so its controls stay on screen. A panel
   * moved low on a window that shrank comes back up far enough to show its
   * head. Run on open, on a move and whenever the window resizes.
   */
  function fit(): void {
    if (panel.style.display !== "flex") return;
    const vh = window.innerHeight;
    let top = panel.getBoundingClientRect().top;
    const lowest = Math.max(0, vh - scaled(HEAD_ROOM));
    if (top > lowest) {
      panel.style.top = `${Math.round(lowest)}px`;
      top = lowest;
    }
    const room = Math.max(0, Math.floor(vh - top - scaled(BOTTOM_GAP)));
    const max = Math.min(Math.floor(vh * 0.88), room);
    panel.style.maxHeight = `${max}px`;
    panel.style.minHeight = `${Math.min(scaled(MIN_H), max)}px`;
  }
  window.addEventListener("resize", () => fit());

  // Drag-to-resize (F-051): the panel is right-anchored, so the grip lives on
  // the bottom-LEFT — dragging the free corner grows it toward the page.
  // The chosen size persists in prefs.threadPanelSize (ADR-0019 §4) and
  // restores clamped to the viewport. Fail-soft: environments without
  // chrome.storage (unit tests) just skip persistence.
  void getPrefs().then(
    (p) => {
      const v = p.threadPanelSize;
      if (!v) return;
      if (v.w >= scaled(MIN_W))
        panel.style.width = `${Math.min(v.w, Math.floor(window.innerWidth * 0.92))}px`;
      if (v.h >= scaled(MIN_H))
        panel.style.height = `${Math.min(v.h, Math.floor(window.innerHeight * 0.88))}px`;
    },
    () => {},
  );
  const grip = el("div", "panel-grip");
  grip.title = "drag to resize";
  panel.appendChild(grip);
  let gripDrag: { r: DOMRect; x: number; y: number } | null = null;
  const gripMover = routePointerDrag(grip, {
    begin(e) {
      gripDrag = { r: panel.getBoundingClientRect(), x: e.clientX, y: e.clientY };
    },
    move(ev) {
      if (!gripDrag) return;
      const { r } = gripDrag;
      // Right edge is pinned: moving the pointer LEFT grows the width.
      const w = Math.min(
        Math.max(scaled(MIN_W), r.width + (gripDrag.x - ev.clientX)),
        window.innerWidth * 0.92,
      );
      const h = Math.min(
        Math.max(scaled(MIN_H), r.height + (ev.clientY - gripDrag.y)),
        window.innerHeight * 0.88,
      );
      panel.style.width = `${Math.round(w)}px`;
      panel.style.height = `${Math.round(h)}px`;
    },
    end() {
      if (!gripDrag) return;
      gripDrag = null;
      // A panel already gone (its host torn down) or hidden has no size to keep.
      const rect = panel.getBoundingClientRect();
      if (!panel.isConnected || rect.width <= 0 || rect.height <= 0) return;
      void patchPrefs({
        threadPanelSize: { w: Math.round(rect.width), h: Math.round(rect.height) },
      }).then(undefined, () => {});
    },
  });

  let currentId: string | null = null;
  // Which own-message is being inline-edited, tracked here (not in the message
  // DOM) so the editor re-materializes across `interactions-state` rebuilds
  // instead of vanishing mid-edit.
  let editingMsgId: string | null = null;
  // The message the next reply answers (ADR-0018 §1) — a quote chip rides
  // above the reply box until sent or cancelled. Kept with the reply's draft
  // (`replyQuote`), so it outlives a rebuild, a close and a reload (S-1).
  // A composer to focus after the next render — set by user intent (clicking
  // edit), never by a plain state-frame re-render, so focus is not stolen.
  let pendingFocusKey: string | null = null;
  // One reaction chip to "pop" on the next render (optimistic toggle feedback).
  let pendingPop: string | null = null;
  // Scroll continuity across re-renders (F-051): which interaction the body
  // currently shows, so same-thread rebuilds restore the reader's position.
  let lastRenderedId: string | null = null;
  // Thread length at the last render — a grown thread means new messages,
  // which stick-to-bottom follows for a reader already at the bottom.
  let lastThreadLen = 0;
  // What the panel last painted (snapshot + panel intent). A state frame that
  // changes NOTHING about this thread must leave the DOM alone — the rebuild
  // was the flicker, and it stole focus from a mid-typing reply (F8).
  let lastPaintKey = "";
  // A reply keeps its draft until the server's receipt (3b-C10): these
  // threads have one on its way, or one that the socket dropped before it.
  const replySending = new Set<string>();
  const replyNotSent = new Set<string>();
  let liveReply: { id: string; input: ReturnType<typeof richInput> } | null = null;
  // The share section is open for the current thread (reset on a new open).
  let shareOpen = false;
  const shareDeps = deps.share ?? chromeShareDeps();
  close.addEventListener("click", () => setOpen(false));

  function setOpen(on: boolean): void {
    // A drag of a panel that closes ends with it, while the panel still has
    // its size: a resize ending now saves the size it reached, never 0 × 0.
    if (!on) {
      headMover.cancel();
      gripMover.cancel();
    }
    panel.style.display = on ? "flex" : "none";
    if (on) fit();
    // The thread's space keeps its socket while its reply box is open.
    const held = on && currentId !== null ? (app.byId(currentId)?.spaceId ?? null) : null;
    app.holdSpace?.("thread", held);
    if (!on) {
      currentId = null;
      editingMsgId = null;
      shareOpen = false;
    }
  }

  function focusAfterRender(key: string): void {
    for (const n of body.querySelectorAll("[data-draft-key]")) {
      if ((n as HTMLElement).dataset.draftKey !== key) continue;
      focusEnd(n as HTMLElement);
      return;
    }
  }

  function timeLabel(ts: number): string {
    const d = Date.now() - ts;
    if (d < 60_000) return "now";
    if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
    if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
    return `${Math.floor(d / 86_400_000)}d`;
  }

  function renderReactions(s: Snapshot, m: RawThreadMsg): HTMLElement {
    const self = app.selfId();
    const wrap = el("div", "reactions");
    // Optimistic toggle (ADR-0018 §4): paint the local snapshot copy NOW; the
    // next `interactions-state` frame reconciles to server truth. A failed
    // send reverts + toasts.
    const toggle = (emoji: string, on: boolean): void => {
      const undo = self !== null ? applyLocalReaction(m, emoji, self, on) : (): void => {};
      pendingPop = `${m.msgId}:${emoji}`;
      render();
      void app
        .send({ type: "interaction-react", interactionId: s.id, msgId: m.msgId, emoji, on })
        .then((res) => {
          if (res.ok) return;
          undo();
          render();
          app.toast("reaction not sent");
        });
    };
    const popIfPending = (node: HTMLElement, emoji: string): void => {
      if (pendingPop === `${m.msgId}:${emoji}`) node.classList.add("pop");
    };
    const entries = Object.entries(m.reactions ?? {});
    for (const [emoji, actors] of entries) {
      if (actors.length === 0) continue;
      const on = self !== null && actors.includes(self);
      const chip = el("button", `react${on ? " on" : ""}`);
      // Hover names the reactors — the chip is the social signal (F-050).
      chip.title = actors.map((id) => app.person(id, s.spaceId).name).join(", ");
      chip.append(el("span", undefined, emoji), el("span", undefined, String(actors.length)));
      popIfPending(chip, emoji);
      chip.addEventListener("click", (e) => {
        if (!e.isTrusted) return;
        toggle(emoji, !on);
      });
      wrap.appendChild(chip);
    }
    // Quick-add offers only emojis that don't have a chip yet: an existing
    // reaction is joined/left by clicking ITS chip (highlight, never a
    // duplicate affordance — F-050).
    const bar = el("div", "react-bar");
    for (const emoji of REACTIONS) {
      if ((m.reactions?.[emoji]?.length ?? 0) > 0) continue;
      const b = el("button", "react", emoji);
      b.title = "react — counts as seen";
      popIfPending(b, emoji);
      b.addEventListener("click", (e) => {
        if (!e.isTrusted) return;
        toggle(emoji, true);
      });
      bar.appendChild(b);
    }
    wrap.appendChild(bar);
    return wrap;
  }

  /** First line of a message body, bounded for quote chips. */
  function firstLine(m: RawThreadMsg): string {
    const line = previewFirstLine(m.body.text);
    return line.length > QUOTE_CHARS ? `${line.slice(0, QUOTE_CHARS)}…` : line;
  }

  /** Scroll to + flash a message row in this panel. */
  function revealMessage(msgId: string): void {
    for (const n of body.querySelectorAll("[data-msg-id]")) {
      const node = n as HTMLElement;
      if (node.dataset.msgId !== msgId) continue;
      node.scrollIntoView?.({ block: "center", behavior: "smooth" });
      node.classList.remove("flash");
      void node.offsetWidth; // restart the animation on repeat clicks
      node.classList.add("flash");
      return;
    }
  }

  /**
   * The quote chip (ADR-0018 §1): author + first line of the reply target,
   * DERIVED from the thread at render time. Click reveals the target; a
   * deleted/missing target renders as "original message removed" — never
   * dropped. `onCancel` adds the × that dismisses a pending reply-to.
   */
  function quoteChip(s: Snapshot, msgId: string, onCancel?: () => void): HTMLElement {
    const target = s.thread.find((t) => t.msgId === msgId);
    if (!target || target.deleted || target.system) {
      const gone = el("div", "quote-chip missing", "original message removed");
      if (onCancel) gone.appendChild(cancelX(onCancel));
      return gone;
    }
    const author = app.person(target.authorId, s.spaceId);
    const chip = el("div", "quote-chip");
    chip.append(
      avatar(author, "sm"),
      el("span", "quote-text", `${author.name}: ${firstLine(target)}`),
    );
    chip.addEventListener("click", () => revealMessage(msgId));
    if (onCancel) chip.appendChild(cancelX(onCancel));
    return chip;
  }

  function cancelX(onCancel: () => void): HTMLElement {
    const x = el("button", "quote-cancel", "×");
    x.title = "cancel reply";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      onCancel();
    });
    return x;
  }

  function renderMessage(s: Snapshot, m: RawThreadMsg): HTMLElement {
    if (m.system) {
      return el("div", "msg-system", m.deleted ? "(removed)" : m.body.text);
    }
    const author = app.person(m.authorId, s.spaceId);
    const wrap = el("div", "msg");
    wrap.dataset.msgId = m.msgId; // quote chips scroll-and-flash by this
    const headRow = el("div", "msg-head");
    headRow.append(avatar(author, "sm"), el("span", "msg-author", author.name));
    if (m.agent) headRow.append(agentTag());
    headRow.append(microLabel(timeLabel(m.ts)));
    if (m.editedAt !== undefined) headRow.append(el("span", "dim", "· edited"));
    wrap.appendChild(headRow);
    if (m.deleted) {
      const gone = el("div", "msg-body dim", "(deleted)");
      gone.style.fontStyle = "italic";
      wrap.appendChild(gone);
      return wrap;
    }
    // This message answers another: compact derived quote above the body.
    if (m.replyTo) wrap.appendChild(quoteChip(s, m.replyTo.msgId));
    const bodyEl = el("div", "msg-body");
    bodyEl.appendChild(
      renderRichText(app, m.body, {
        spaceId: s.spaceId,
        ...(deps.onAnchorClick ? { onAnchorClick: deps.onAnchorClick } : {}),
      }),
    );
    wrap.appendChild(bodyEl);
    wrap.appendChild(renderReactions(s, m));

    const self = app.selfId();
    const own = self !== null && m.authorId === self;
    if (own && editingMsgId === m.msgId && canFollowThrough(s.state)) {
      const editKey = `edit:${s.id}:${m.msgId}`;
      const editor = richInput(app, "revise…", () => doEdit(), {
        draftKey: editKey,
        spaceId: () => s.spaceId,
      });
      const doEdit = (): void => {
        const v = editor.value();
        if (v.text)
          app.send({ type: "interaction-edit", interactionId: s.id, msgId: m.msgId, body: v });
        editor.clear();
        editingMsgId = null;
        render();
      };
      const editRow = el("div", "row");
      const save = el("button", "btn sm primary", "Save");
      save.addEventListener("click", (e) => {
        if (!e.isTrusted) return;
        doEdit();
      });
      const cancel = el("button", "btn ghost sm", "Cancel");
      cancel.addEventListener("click", () => {
        editor.clear();
        editingMsgId = null;
        render();
      });
      editRow.append(save, cancel);
      editor.wrap.appendChild(editRow);
      wrap.appendChild(editor.wrap);
      return wrap;
    }
    if (canFollowThrough(s.state)) {
      const acts = el("div", "msg-acts");
      // Quiet reply affordance on EVERY message row (ADR-0018 §1): starting a
      // reply pins a dismissible quote chip above the reply box.
      const replyAct = el("button", "msg-act", "reply");
      replyAct.addEventListener("click", () => {
        setReplyQuote(`reply:${s.id}`, m.msgId);
        pendingFocusKey = `reply:${s.id}`;
        render();
      });
      acts.appendChild(replyAct);
      if (own) {
        const editKey = `edit:${s.id}:${m.msgId}`;
        const edit = el("button", "msg-act", "edit");
        edit.addEventListener("click", () => {
          editingMsgId = m.msgId;
          // Seed the FULL body (tokens included) so pills rehydrate in the editor.
          writeRichDraft(editKey, m.body);
          pendingFocusKey = editKey;
          render();
        });
        const del = el("button", "msg-act", "delete");
        del.addEventListener("click", (e) => {
          if (!e.isTrusted) return;
          if (del.textContent === "delete") {
            del.textContent = "confirm?";
            setTimeout(() => {
              del.textContent = "delete";
            }, 2500);
          } else {
            app.send({ type: "interaction-delete", interactionId: s.id, msgId: m.msgId });
          }
        });
        acts.append(edit, del);
      }
      wrap.appendChild(acts);
    }
    return wrap;
  }

  // Show an unsent draft read-only with a notice, rather than vaporizing it,
  // when the thread it belonged to is gone or no longer accepts replies.
  function showStrandedDraft(key: string, notice: string): void {
    const draft = readDraft(key);
    if (!draft) return;
    body.appendChild(el("div", "micro", notice));
    const keep = document.createElement("textarea");
    keep.className = "input";
    keep.value = draft;
    keep.readOnly = true;
    body.appendChild(keep);
  }

  function render(): void {
    if (currentId === null) return;
    // Re-renders (reaction toggles, state frames) must not teleport the
    // reader: keep the scroll position for the SAME interaction, start at
    // the top only on a fresh open (F-051). One exception — a reader AT the
    // bottom follows newly arrived messages (stick-to-bottom); a reader
    // scrolled up into history is never yanked.
    const sameThread = lastRenderedId === currentId;
    const keepScroll = sameThread ? body.scrollTop : 0;
    const wasAtBottom =
      sameThread && body.scrollHeight - body.scrollTop - body.clientHeight <= STICK_PX;
    lastRenderedId = currentId;
    const replyKey = `reply:${currentId}`;
    const s = app.byId(currentId);
    // Identical truth + identical panel intent → skip the rebuild entirely.
    // Intent renders (edit/reply-to/pop/focus) always repaint: they ride the
    // key or the pending fields, so only the no-op frame is skipped.
    const changed = s ? changedSince(copiedStore(), app, s) : false;
    const kept = s ? (deps.keptStatus?.(s.id) ?? null) : null;
    const replyingToMsgId = replyQuote(replyKey, s?.thread);
    const paintKey = `${JSON.stringify(s ?? null)}|${editingMsgId}|${replyingToMsgId}|${shareOpen}|${app.presentationRev()}|${changed}|${kept?.unresolved}|${replySending.has(currentId ?? "")}|${replyNotSent.has(currentId ?? "")}`;
    if (
      sameThread &&
      paintKey === lastPaintKey &&
      pendingFocusKey === null &&
      pendingPop === null
    ) {
      return;
    }
    lastPaintKey = paintKey;
    while (body.firstChild) body.removeChild(body.firstChild);
    reanchor.style.display = "none";
    freshLook.style.display = "none";
    share.style.display = "none";
    copyAgent.style.display = "none";
    if (!s) {
      lastThreadLen = 0;
      body.appendChild(el("div", "empty-note", "This interaction is no longer on the page."));
      showStrandedDraft(replyKey, "Your unsent reply");
      return;
    }
    const spec = KINDS[s.kind];
    title.textContent = spec.label;
    // A guest replies, reacts and picks — nothing that moves the thread itself.
    const guest = app.isGuest(s.spaceId);
    reanchor.style.display =
      !guest && s.anchorLost && isLiveState(s.state) && deps.onReanchor ? "inline-flex" : "none";
    // The place's snapshots are on this page (app.byId is page-scoped), so a
    // present `s.resnap` on a live element/selection anchor is a capture-due duty.
    const captureDue = !guest && isCaptureDue(s, app.selfId()) && !!deps.onFreshLook;
    freshLook.style.display = captureDue ? "inline-flex" : "none";
    share.style.display = guest ? "none" : "inline-flex";
    copyAgent.style.display = "inline-flex";
    share.classList.toggle("active", shareOpen);

    const meta = el("div", "row-wrap");
    const kindChip = el("span", `chip chip-kind ${spec.cls}`);
    kindChip.append(icon(spec.glyph, "icon-sm"), el("span", undefined, spec.label));
    const self = app.selfId();
    const chip = chipFor(s.state, self !== null && s.waitingOn.includes(self));
    const stateChip = el("span", `chip ${CHIP_STATES[chip].cls}`, s.state);
    meta.append(kindChip, stateChip, microLabel(anchorLabel(s.anchor)));
    if (s.anchorLost) meta.append(el("span", "dim", "· anchor lost"));
    const work = agentWorkStatus(s.agentWork);
    if (work) meta.append(el("span", "dim", `· ${AGENT_WORK_LABEL[work]}`));
    if (app.multiSpace()) meta.append(el("span", "dim", `· ${app.space(s.spaceId)?.name ?? ""}`));
    if (changed) meta.append(el("span", "dim", `· ${CHANGED_SINCE_COPIED}`));
    if (kept?.unresolved) meta.append(el("span", "dim", `· ${KEPT_UNRESOLVED}`));
    // A muted "Capture due" chip — a duty, never an attention adornment (§3).
    if (captureDue) meta.append(el("span", "chip capture-due", "Capture due"));
    body.appendChild(meta);
    if (shareOpen && !guest) body.appendChild(shareSection(app, s.spaceId, s.id, shareDeps));

    if (isAsk(s)) body.appendChild(buildAskCard(app, s, { compact: false }));
    if (s.kind === "change" && s.change) {
      // The request leads: the sidecar reads as ONE edit lifecycle — intent,
      // method/state, then the variants it produced (inline mount below).
      const intent = el("div", "edit-intent");
      intent.appendChild(renderRichText(app, { text: s.change.intent }));
      body.appendChild(intent);
      const cinfo = el("div", "dim", `method: ${s.change.method ?? "direct"} · ${s.state}`);
      body.appendChild(cinfo);
      if (s.change.variantSetId && deps.renderVariantSet) {
        const mount = el("div", "variant-inline-mount");
        body.appendChild(mount);
        deps.renderVariantSet(s.change.variantSetId, mount);
      }
    }

    for (const m of s.thread) body.appendChild(renderMessage(s, m));

    if (canFollowThrough(s.state)) {
      const live = isLiveState(s.state);
      const reply = richInput(
        app,
        live ? "Reply… @mention to notify" : "Follow up — the thread outlives the resolution",
        () => doReply(),
        { draftKey: replyKey, spaceId: () => s.spaceId },
      );
      liveReply = { id: s.id, input: reply };
      if (replyNotSent.has(s.id)) reply.wrap.appendChild(el("div", "empty-note", REPLY_NOT_SENT));
      // A pending reply-to wears its quote chip above the box; × dismisses.
      if (replyingToMsgId !== null) {
        body.appendChild(
          quoteChip(s, replyingToMsgId, () => {
            setReplyQuote(replyKey, null);
            render();
          }),
        );
      }
      const row = el("div", "row");
      const send = el(
        "button",
        "btn primary sm",
        live ? "Reply" : "Follow up",
      ) as HTMLButtonElement;
      row.appendChild(send);
      // Resolving is a live-state act; a resolved thread only speaks — and
      // may REOPEN (F26): resolution is not a one-way door. Same authority
      // as resolve; terminal states (dropped/superseded) never reach here.
      const resolve = el("button", "btn ghost sm", "Resolve");
      if (live && !guest) row.appendChild(resolve);
      if (!live && !guest && s.state === "resolved") {
        const reopen = el("button", "btn ghost sm", "Reopen");
        reopen.addEventListener("click", (e) => {
          if (!e.isTrusted) return;
          void app.send({ type: "interaction-reopen", interactionId: s.id });
        });
        row.appendChild(reopen);
      }
      send.disabled = replySending.has(s.id);
      const doReply = (): void => {
        const v = reply.value();
        if (!v.text || replySending.has(s.id)) return;
        const id = s.id;
        const replyTo = replyQuote(`reply:${id}`);
        const payload = { body: v, ...(replyTo !== null ? { replyTo: { msgId: replyTo } } : {}) };
        // A retry of an unconfirmed send reuses its id: the server answers it once (M-1).
        const place = `reply:${id}`;
        const clientId = clientIdFor(place, payload);
        // The reply box's draft key is the same place: its revision now is what was sent.
        const revision = draftRevision(place);
        replySending.add(id);
        replyNotSent.delete(id);
        send.disabled = true;
        void app
          .sendForReceipt(
            { type: "interaction-reply", interactionId: id, ...payload, clientId },
            "reply",
            id,
          )
          .then((r) => {
            replySending.delete(id);
            if (r.ok) {
              confirmSend(place, clientId);
              // Cleared only now, and only if nothing was written to the draft
              // since the send (3-M3): more typing, or a box rebuilt or
              // remounted since and edited there, keeps its newer text.
              if (
                clearDraftIfUnchanged(place, revision) &&
                liveReply?.id === id &&
                liveReply.input.input.isConnected &&
                sameRevision(liveReply.input.value(), v)
              )
                liveReply.input.clear();
              if (replyQuote(place) === replyTo) setReplyQuote(place, null);
            } else {
              replyNotSent.add(id);
            }
            if (currentId === id) render();
          });
      };
      send.addEventListener("click", (e) => {
        if (!e.isTrusted) return;
        doReply();
      });
      resolve.addEventListener("click", (e) => {
        if (!e.isTrusted) return;
        void app.send({ type: "interaction-resolve", interactionId: s.id });
      });
      reply.wrap.appendChild(row);
      body.appendChild(reply.wrap);
    } else {
      // Dropped/superseded out from under an in-progress reply: keep the text.
      showStrandedDraft(replyKey, "This thread was closed — your unsent reply");
    }

    if (pendingFocusKey !== null) {
      const key = pendingFocusKey;
      pendingFocusKey = null;
      focusAfterRender(key);
    }
    pendingPop = null; // the pop animation ran on this render only
    const grew = sameThread && s.thread.length > lastThreadLen;
    lastThreadLen = s.thread.length;
    body.scrollTop = grew && wasAtBottom ? body.scrollHeight : keepScroll;
  }

  return {
    element: panel,
    open(id) {
      deps.onOpened?.(id);
      if (currentId !== id) {
        editingMsgId = null;
        shareOpen = false;
      }
      currentId = id;
      setOpen(true);
      render();
    },
    close: () => setOpen(false),
    isOpen: () => panel.style.display === "flex",
    currentId: () => currentId,
    render: () => {
      if (currentId !== null) render();
    },
  };
}
