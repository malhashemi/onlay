// The interaction modal (ADR-0020): the Inbox's centered reading surface —
// same family as the command bar (same width, surface, radius, shadow). An
// Inbox row opens here; the human reads who asked, who's needed, the state,
// and the context, then answers, replies, resolves, or Anchors — without
// leaving the page they're on.
//
// Transport is ROUTED, never assumed (UX-3): rows on this page and unanchored
// rows mutate over WS (the involvement-scoped unanchored exception admits
// them); rows bound to OTHER urls act through the SW's HTTP proxy. The modal
// receives one `send`/`load` pair from content.ts and never knows which road
// a frame took. Snapshots for rows that live on no page (or a dead one) are
// fetched by id — participant-scoped server truth.

import { previewFirstLine } from "@onlay/protocol";
import { shownUrl } from "@onlay/render/interaction-view";
import { sameRevision } from "@onlay/render/mentions";
import { applyLocalReaction, REACTIONS } from "@onlay/render/reactions";
import { HOSTED_COPY } from "../hosted-copy";
import { anchorLabel } from "./anchors";
import type { App, InteractionSnap as Snapshot } from "./app";
import { buildAskCard, isAsk } from "./ask-card";
import { richInput } from "./composers";
import {
  CHANGED_SINCE_COPIED,
  COPY_COPY,
  changedSince,
  copiedStore,
  copyAndRemember,
  itemText,
} from "./copy-agent";
import { agentTag, avatar, el, icon, microLabel } from "./dom";
import {
  clearDraft,
  clearDraftIfUnchanged,
  draftRevision,
  replyQuote,
  setReplyQuote,
  writeRichDraft,
} from "./drafts";
import { whenShown } from "./host";
import {
  AGENT_WORK_LABEL,
  agentWorkStatus,
  CHIP_STATES,
  canFollowThrough,
  chipFor,
  isLiveState,
  KINDS,
} from "./kinds";
import { clientIdFor, confirmSend } from "./send-ids";
import { chromeShareDeps, type ShareDeps, shareSection } from "./share";
import { REPLY_NOT_SENT } from "./thread";
import { renderRichText } from "./token-text";
import { isTrustedEvent } from "./trusted";
import { onRouted } from "./typing-router";

/** The row identity the modal needs — a QueueRow subset, or a bare id. */
export interface ModalRef {
  interactionId: string;
  /** The space it lives in: off-page reads and writes go through it. */
  spaceId: string;
  url?: string;
  local?: boolean;
  unanchored?: boolean;
  anchorLost?: boolean;
  /**
   * The child document a thread bound to a frame was opened from: its
   * controls act on that document only (2-E4).
   */
  frameDocumentId?: string;
}

export interface InteractionModalDeps {
  /**
   * Local page snapshot, or SW by-id fetch for page-less/off-page rows;
   * `"not_found"` when the read says the thread is gone for this person.
   */
  load(ref: ModalRef): Promise<Snapshot | null | "not_found">;
  /** Routed transport (WS on-page/unanchored · SW-HTTP elsewhere). */
  send(ref: ModalRef, frame: Record<string, unknown>): Promise<{ ok: boolean }>;
  /** Anchor an unanchored Ask / re-anchor a lost one (closes the modal). */
  onAnchor?(ref: ModalRef): void;
  /** Re-anchor a thread whose anchor was lost: a pick on the page (closes the modal). */
  onReanchor?(ref: ModalRef): void;
  /** The thread is bound to this page or a frame of it, where a pick can place it again. */
  reanchorable?(interactionId: string): boolean;
  /** The full-page view — the reliable page-less path (Ctrl+Enter). */
  onFullView?(interactionId: string): void;
  /** Open the row's page in a NEW tab — reading never navigates this page away. */
  navigate?(url: string): void;
  /** The share list's transport (service worker; tests stub it). */
  share?: ShareDeps;
  /** A person opened this thread: read it by id (an explicit open, for the server). */
  onOpened?(ref: ModalRef): void;
  /**
   * An Edit's variant set, docked under its request (E-1): an Edit bound to a
   * child frame opens here, and its set's panel drives that frame.
   */
  renderVariantSet?(setId: string, mount: HTMLElement, interactionId: string, ref: ModalRef): void;
}

export interface InteractionModal {
  element: HTMLElement;
  open(ref: ModalRef): void;
  close(): void;
  isOpen(): boolean;
  /** The open thread's id, or null. */
  currentId(): string | null;
  /** Re-render from fresh state when the open row is page-local. */
  refresh(): void;
  /** A server mutation happened somewhere (the SW's attention-tick): re-pull
   *  an open OFF-PAGE row — push-driven freshness, no polling (F23). */
  remoteTick(): void;
}

function ageLabel(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return "now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
  return `${Math.floor(d / 86_400_000)}d`;
}

/** Maximize (lucide maximize-2) — the quiet header route to the full view. */
const MAXIMIZE_GLYPH = {
  paths: ["M15 3h6v6", "M9 21H3v-6", "M21 3l-7 7", "M3 21l7-7"],
};

export function createInteractionModal(app: App, deps: InteractionModalDeps): InteractionModal {
  const backdrop = el("div", "bar-backdrop");
  const modal = el("div", "interaction-modal");
  backdrop.appendChild(modal);

  let ref: ModalRef | null = null;
  let snapshot: Snapshot | null = null;
  // Focus the reading body once per OPEN (never on refresh re-renders, which
  // would steal focus from a reply in progress): arrows then scroll the
  // modal, and Tab walks into the body's controls and on to the reply field.
  let pendingFocus = false;
  // Per-message intent (F20 — the panel's grammar, ported): reply-to pins a
  // quote chip above the reply box; edit swaps the message for an inline
  // editor. Closure state so a refresh re-render reproduces it; reset on
  // close and reconciled against each snapshot in render(). The reply-to is
  // kept with the reply's draft (`replyQuote`), through a reload too (S-1).
  let editingMsgId: string | null = null;
  // Scroll continuity (F22): which interaction the LAST render drew — same id
  // keeps the reader's place, a different one starts at the top (F-051).
  let lastRenderedId: string | null = null;
  // Members share the thread from here too, as from the side panel (spec §10).
  let shareOpen = false;
  let shareJustOpened = false;
  // A reply on its way, or one the server never confirmed (3b-C10).
  let replySending = false;
  let replyFailed = false;
  const shareDeps = deps.share ?? chromeShareDeps();
  // Everyone the modal draws is looked up in the open thread's own space only.
  const personOf = (id: string) => app.person(id, ref?.spaceId ?? snapshot?.spaceId);

  // Every send from inside the modal (ask control included) rides the routed
  // transport: a shimmed App hands buildAskCard/renderRichText the same
  // surface they know, with send/byId pointed at this modal's row.
  const viewApp: App = {
    ...app,
    byId: (id) => (snapshot && snapshot.id === id ? snapshot : app.byId(id)),
    send: (frame) => {
      const r = ref;
      if (!r) return Promise.resolve({ ok: false as const, error: "closed" });
      return deps.send(r, frame as unknown as Record<string, unknown>).then((res) => {
        // fresh truth after any mutation — page state frames won't cover
        // page-less rows, so the modal re-loads itself
        setTimeout(() => void reload(), 150);
        return res as { ok: true } | { ok: false; error: string };
      });
    },
  };

  // Off-page rows get no state frames — they refresh PUSH-driven instead
  // (F23): every accepted server mutation repushes attention, the SW relays
  // it as an `attention-tick`, and content.ts calls remoteTick(). The timer
  // below is only a SLOW safety net for WS gaps (a dead socket ticks
  // nothing), not the delivery path. Page-local rows need neither: every
  // state frame already lands via refresh().
  const POLL_MS = 30_000;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  // Byte-identical truth skips the rebuild entirely — the poll must never
  // flicker avatars or steal the reply caret on a no-op tick.
  let lastLoadKey = "";

  function stopPoll(): void {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function schedulePoll(): void {
    stopPoll();
    if (ref && !ref.local && backdrop.style.display === "block") {
      pollTimer = setTimeout(() => void reload(), POLL_MS);
    }
  }

  function setOpen(on: boolean): void {
    backdrop.style.display = on ? "block" : "none";
    if (!on) {
      ref = null;
      snapshot = null;
      editingMsgId = null;
      lastRenderedId = null; // a re-open reads from the top (F-051)
      lastLoadKey = "";
      shareOpen = false;
      replySending = false;
      replyFailed = false;
      stopPoll();
    }
  }

  async function reload(): Promise<void> {
    const r = ref;
    if (!r) return;
    const next = await deps.load(r);
    if (ref !== r) return; // closed or switched while the fetch was in flight
    // Gone for this person (deleted, or access removed): close with a note (R3-C8).
    if (next === "not_found") {
      setOpen(false);
      app.toast(HOSTED_COPY.threadGone);
      return;
    }
    // A transient miss on a background tick must not blow away a live view
    // (the full page's rule) — keep the last truth and try again.
    if (next === null && snapshot !== null) {
      schedulePoll();
      return;
    }
    const changed = next
      ? changedSince(copiedStore(), app, { ...next, spaceId: r.spaceId })
      : false;
    const key = `${JSON.stringify(next)}|${changed}`;
    if (key !== lastLoadKey) {
      lastLoadKey = key;
      snapshot = next;
      render();
    }
    schedulePoll();
  }

  function contextLine(text: string, glyphText: string): HTMLElement {
    const line = el("div", "ctx-line");
    line.append(el("span", "micro", glyphText), el("span", "ctx-text", text));
    return line;
  }

  /** The panel's reaction grammar (F21): count chips (hover names reactors,
   *  click joins/leaves) + a quick-add row offering only un-chipped emoji.
   *  Optimistic — paint the local copy now, undo + toast on a refused send;
   *  the post-send reload reconciles to server truth. */
  function renderReactions(s: Snapshot, m: Snapshot["thread"][number]): HTMLElement {
    const self = app.selfId();
    const wrap = el("div", "reactions");
    const toggle = (emoji: string, on: boolean): void => {
      const undo = self !== null ? applyLocalReaction(m, emoji, self, on) : (): void => {};
      render();
      void viewApp
        .send({
          type: "interaction-react",
          interactionId: s.id,
          msgId: m.msgId,
          emoji,
          on,
        } as never)
        .then((res) => {
          if (res.ok) return;
          undo();
          render();
          app.toast("reaction not sent");
        });
    };
    for (const [emoji, actors] of Object.entries(m.reactions ?? {})) {
      if (actors.length === 0) continue;
      const on = self !== null && actors.includes(self);
      const chip = el("button", `react${on ? " on" : ""}`);
      chip.title = actors.map((id) => personOf(id).name).join(", ");
      chip.append(el("span", undefined, emoji), el("span", undefined, String(actors.length)));
      chip.addEventListener("click", (e) => {
        if (!e.isTrusted) return;
        toggle(emoji, !on);
      });
      wrap.appendChild(chip);
    }
    // Existing chips stay readable forever; NEW reactions only while the
    // thread follows through (the PWA's split).
    if (canFollowThrough(s.state)) {
      const bar = el("div", "react-bar");
      for (const emoji of REACTIONS) {
        if ((m.reactions?.[emoji]?.length ?? 0) > 0) continue;
        const b = el("button", "react", emoji);
        b.title = "react — counts as seen";
        b.addEventListener("click", (e) => {
          if (!e.isTrusted) return;
          toggle(emoji, true);
        });
        bar.appendChild(b);
      }
      wrap.appendChild(bar);
    }
    return wrap;
  }

  /** The quoted original above a reply (ADR-0018 §1) — the panel's chip. */
  function quoteChip(s: Snapshot, msgId: string, onCancel?: () => void): HTMLElement {
    const target = s.thread.find((t) => t.msgId === msgId);
    const chip = el("div", "quote-chip");
    if (!target || target.deleted || target.system) {
      chip.classList.add("missing");
      chip.appendChild(el("span", "quote-text", "original message removed"));
    } else {
      const author = personOf(target.authorId);
      chip.append(
        avatar(author, "sm"),
        el("span", "quote-text", `${author.name}: ${previewFirstLine(target.body.text)}`),
      );
    }
    if (onCancel) {
      const x = el("button", "quote-cancel", "×");
      x.setAttribute("aria-label", "Cancel the reply target");
      x.addEventListener("click", (e) => {
        if (!e.isTrusted) return;
        onCancel();
      });
      chip.appendChild(x);
    }
    return chip;
  }

  function render(): void {
    // F-051, ported (F22): a rebuild (reaction toggle, reply reload, state
    // frame) must not teleport the reader — keep the body's scroll for the
    // SAME interaction; a reader AT the bottom follows new messages; a fresh
    // open starts at the top.
    const prevBody = modal.querySelector(".im-body") as HTMLElement | null;
    const sameThread = snapshot !== null && lastRenderedId === snapshot.id;
    const keepScroll = sameThread && prevBody ? prevBody.scrollTop : 0;
    const wasAtBottom =
      sameThread && prevBody
        ? prevBody.scrollHeight - prevBody.scrollTop - prevBody.clientHeight <= 48
        : false;
    lastRenderedId = snapshot?.id ?? null;
    while (modal.firstChild) modal.removeChild(modal.firstChild);
    const r = ref;
    if (!r) return;
    const s = snapshot;

    /* ── header: kind · state · who → who · age ── */
    const head = el("div", "im-head");
    if (!s) {
      head.appendChild(el("span", "title", "Interaction"));
      modal.appendChild(head);
      modal.appendChild(
        el(
          "div",
          "empty-note",
          "Couldn't load this interaction — it may not involve you, or the server is unreachable.",
        ),
      );
      return;
    }
    const spec = KINDS[s.kind];
    const kindChip = el("span", `chip chip-kind ${spec.cls}`);
    kindChip.append(icon(spec.glyph, "icon-sm"), el("span", undefined, spec.label));
    const self = app.selfId();
    const chip = chipFor(s.state, self !== null && s.waitingOn.includes(self));
    const stateChip = el("span", `chip ${CHIP_STATES[chip].cls}`, s.state);
    head.append(kindChip, stateChip);
    const work = agentWorkStatus(s.agentWork);
    if (work) head.appendChild(el("span", "dim", AGENT_WORK_LABEL[work]));
    const stakes = isAsk(s) ? s.ask.stakes : undefined;
    if (stakes === "careful" || stakes === "dangerous") {
      head.appendChild(el("span", `chip chip-stakes-${stakes}`, stakes));
    }

    const who = el("div", "im-who");
    const author = personOf(s.authorId);
    who.append(avatar(author, "sm"), el("span", "name", author.name));
    const waited = s.waitingOn.filter((id) => id !== s.authorId);
    if (waited.length > 0 && isLiveState(s.state)) {
      who.appendChild(el("span", "arrow", "→"));
      const stack = el("span", "avatar-stack");
      for (const id of waited.slice(0, 3)) stack.appendChild(avatar(personOf(id), "sm"));
      who.appendChild(stack);
      who.appendChild(el("span", "name dim", waited.map((id) => personOf(id).name).join(", ")));
    }
    head.appendChild(who);
    if (app.multiSpace() && ref) head.appendChild(microLabel(app.space(ref.spaceId)?.name ?? ""));
    head.appendChild(microLabel(ageLabel(s.createdAt)));
    if (deps.onFullView) {
      const max = el("button", "btn ghost sm im-max") as HTMLButtonElement;
      max.type = "button";
      max.title = "Full view (⌃↵)";
      max.appendChild(icon(MAXIMIZE_GLYPH, "icon-sm"));
      max.addEventListener("click", (e) => {
        if (!e.isTrusted) return;
        const id = s.id;
        setOpen(false);
        deps.onFullView?.(id);
      });
      head.appendChild(max);
    }
    // Copy for agent (spec §9): a pointer, never the thread's text.
    if (changedSince(copiedStore(), app, { ...s, spaceId: r.spaceId }))
      head.appendChild(el("span", "dim", CHANGED_SINCE_COPIED));
    const copyAgent = el("button", "btn ghost sm", COPY_COPY.action) as HTMLButtonElement;
    copyAgent.type = "button";
    copyAgent.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      const item = { ...s, spaceId: r.spaceId };
      void copyAndRemember(app, itemText(app, item), [item]);
    });
    head.appendChild(copyAgent);
    // Share (members only; a guest never shares): the same section as the side panel.
    const member = !app.isGuest(r.spaceId);
    if (member) {
      const shareBtn = el("button", "btn ghost sm", "Share") as HTMLButtonElement;
      shareBtn.type = "button";
      shareBtn.classList.toggle("active", shareOpen);
      shareBtn.addEventListener("click", (e) => {
        if (!isTrustedEvent(e)) return;
        shareOpen = !shareOpen;
        shareJustOpened = shareOpen;
        render();
      });
      head.appendChild(shareBtn);
    }
    const closeBtn = el("button", "btn ghost sm", "Close");
    closeBtn.addEventListener("click", () => setOpen(false));
    head.appendChild(closeBtn);
    modal.appendChild(head);

    /* ── context strip: place · page link · full view ── */
    const ctx = el("div", "im-context");
    if (s.anchor.level === "unanchored") {
      ctx.appendChild(contextLine("unanchored — answer here, or Anchor it to a page", "place"));
    } else {
      const lost = s.anchorLost ? " · anchor lost" : "";
      ctx.appendChild(contextLine(`${anchorLabel(s.anchor)}${lost}`, "place"));
    }
    // The page the person shares, when the block is inside a frame of it (F-3).
    const page = shownUrl(s);
    if (page && deps.navigate) {
      const line = el("div", "ctx-line");
      line.appendChild(el("span", "micro", "page"));
      const link = el("span", "ctx-text", page);
      const go = el("span", "ctx-link", "open page ↗");
      go.addEventListener("click", (e) => {
        if (!e.isTrusted) return;
        deps.navigate?.(page);
      });
      line.append(link, go);
      ctx.appendChild(line);
    }
    modal.appendChild(ctx);

    /* ── body: the control answers; the thread speaks ── */
    const body = el("div", "im-body");
    body.tabIndex = 0; // focusable: arrows scroll HERE, Tab continues inward
    if (isAsk(s)) body.appendChild(buildAskCard(viewApp, s, { compact: false }));
    if (s.kind === "change" && s.change) {
      body.appendChild(el("div", "dim", `method: ${s.change.method ?? "direct"} · ${s.state}`));
      if (s.change.variantSetId && deps.renderVariantSet) {
        const mount = el("div", "variant-inline-mount");
        body.appendChild(mount);
        deps.renderVariantSet(s.change.variantSetId, mount, s.id, r);
      }
    }
    // Reconcile edit intent against this truth: a message deleted remotely (or
    // a terminal transition) clears the editor AND its keyed draft.
    if (editingMsgId !== null) {
      const target = s.thread.find((t) => t.msgId === editingMsgId);
      if (!target || target.deleted || target.system || !canFollowThrough(s.state)) {
        clearDraft(`modal-edit:${s.id}:${editingMsgId}`);
        editingMsgId = null;
      }
    }
    const replyPlace = `modal-reply:${s.id}`;
    if (!canFollowThrough(s.state)) setReplyQuote(replyPlace, null);
    const replyingToMsgId = replyQuote(replyPlace, s.thread);

    const selfId = app.selfId();
    for (const m of s.thread) {
      if (m.system) {
        body.appendChild(el("div", "msg-system", m.deleted ? "(removed)" : m.body.text));
        continue;
      }
      const mAuthor = personOf(m.authorId);
      const wrap = el("div", "msg");
      const headRow = el("div", "msg-head");
      headRow.append(avatar(mAuthor, "sm"), el("span", "msg-author", mAuthor.name));
      if (m.agent) headRow.append(agentTag());
      headRow.append(microLabel(ageLabel(m.ts)));
      if (m.editedAt !== undefined) headRow.append(el("span", "dim", "· edited"));
      wrap.appendChild(headRow);
      if (m.replyTo) wrap.appendChild(quoteChip(s, m.replyTo.msgId));
      if (m.deleted) {
        wrap.appendChild(el("div", "msg-body dim", "(deleted)"));
      } else if (editingMsgId === m.msgId) {
        // Inline own-message editor (F20) — the same rich editor the reply box
        // is, draft-seeded so pills rehydrate and text survives a re-render.
        const editKey = `modal-edit:${s.id}:${m.msgId}`;
        let saving = false;
        const editor = richInput(viewApp, "", () => void saveEdit(), {
          draftKey: editKey,
          spaceId: () => ref?.spaceId ?? null,
        });
        const saveEdit = async (): Promise<void> => {
          const next = editor.value();
          if (!next.text || saving) return;
          saving = true;
          save.disabled = true;
          const res = await viewApp.send({
            type: "interaction-edit",
            interactionId: s.id,
            msgId: m.msgId,
            body: next,
          } as never);
          if (res.ok) {
            editingMsgId = null;
            clearDraft(editKey);
          } else {
            saving = false;
            save.disabled = false;
            app.toast("couldn't save the edit");
          }
        };
        const editActs = el("div", "msg-acts");
        const save = el("button", "btn primary sm", "Save") as HTMLButtonElement;
        save.addEventListener("click", (e) => {
          if (!e.isTrusted) return;
          void saveEdit();
        });
        const cancel = el("button", "btn ghost sm", "Cancel");
        cancel.addEventListener("click", (e) => {
          if (!e.isTrusted) return;
          editingMsgId = null;
          clearDraft(editKey);
          render();
        });
        editActs.append(save, cancel);
        wrap.append(editor.wrap, editActs);
      } else {
        const bodyEl = el("div", "msg-body");
        bodyEl.appendChild(renderRichText(viewApp, m.body, { spaceId: s.spaceId }));
        wrap.appendChild(bodyEl);
        wrap.appendChild(renderReactions(s, m));
      }
      // Quiet per-message affordances (F20): reply on every message while the
      // thread follows through; edit/delete only on your own.
      if (!m.deleted && editingMsgId !== m.msgId && canFollowThrough(s.state)) {
        const rowActs = el("div", "msg-acts");
        const replyAct = el("button", "msg-act", "reply");
        replyAct.addEventListener("click", (e) => {
          if (!e.isTrusted) return;
          setReplyQuote(replyPlace, m.msgId);
          render();
        });
        rowActs.appendChild(replyAct);
        if (selfId !== null && m.authorId === selfId) {
          const edit = el("button", "msg-act", "edit");
          edit.addEventListener("click", (e) => {
            if (!e.isTrusted) return;
            editingMsgId = m.msgId;
            writeRichDraft(`modal-edit:${s.id}:${m.msgId}`, m.body);
            render();
          });
          const del = el("button", "msg-act danger", "delete");
          del.addEventListener("click", (e) => {
            if (!e.isTrusted) return;
            if (del.textContent === "delete") {
              del.textContent = "confirm?";
              setTimeout(() => {
                del.textContent = "delete";
              }, 2500);
              return;
            }
            (del as HTMLButtonElement).disabled = true;
            void viewApp
              .send({
                type: "interaction-delete",
                interactionId: s.id,
                msgId: m.msgId,
              } as never)
              .then((res) => {
                if (!res.ok) {
                  (del as HTMLButtonElement).disabled = false;
                  app.toast("couldn't delete that");
                }
              });
          });
          rowActs.append(edit, del);
        }
        wrap.appendChild(rowActs);
      }
      body.appendChild(wrap);
    }
    let shareEl: HTMLElement | null = null;
    if (shareOpen && member) {
      shareEl = shareSection(app, r.spaceId, s.id, shareDeps);
      body.appendChild(shareEl);
    }
    modal.appendChild(body);

    /* ── actions ── */
    const acts = el("div", "im-actions");
    // Follow-through, not liveness (the panel's law): the thread outlives the
    // resolution; only Resolve below keys on the live states.
    const live = isLiveState(s.state);
    if (canFollowThrough(s.state)) {
      // A pending reply-to pins the quoted original above the reply box.
      if (replyingToMsgId !== null) {
        modal.appendChild(
          quoteChip(s, replyingToMsgId, () => {
            setReplyQuote(replyPlace, null);
            render();
          }),
        );
      }
      const reply = richInput(viewApp, "Reply… @mention to notify", () => doReply(), {
        draftKey: `modal-reply:${s.id}`,
        spaceId: () => ref?.spaceId ?? null,
      });
      const doReply = (): void => {
        const v = reply.value();
        const r = ref;
        if (!v.text || !r || replySending) return;
        const replyTo = replyQuote(replyPlace);
        const payload = { body: v, ...(replyTo !== null ? { replyTo: { msgId: replyTo } } : {}) };
        // A retry of an unconfirmed send reuses its id: the server answers it once (M-1).
        const place = `modal-reply:${s.id}`;
        const clientId = clientIdFor(place, payload);
        // The reply box's draft key is the same place: its revision now is what was sent.
        const revision = draftRevision(place);
        const frame = {
          type: "interaction-reply",
          interactionId: s.id,
          ...payload,
          clientId,
        };
        // The draft stays until the server has it (3b-C10): over the socket
        // that is the receipt; off the page, the HTTP answer.
        const onSocket = !(r.url !== undefined && !r.local);
        replySending = true;
        replyFailed = false;
        const result = onSocket
          ? app.sendForReceipt({ ...frame, spaceId: r.spaceId } as never, "reply", s.id)
          : viewApp.send(frame as never);
        void result.then((res) => {
          replySending = false;
          if (ref !== r) return;
          if (res.ok) {
            confirmSend(place, clientId);
            // Cleared only if nothing was written to the draft since the send:
            // more typing, here or in a box rebuilt since, keeps its newer text.
            if (
              clearDraftIfUnchanged(place, revision) &&
              reply.input.isConnected &&
              sameRevision(reply.value(), v)
            )
              reply.clear();
            if (replyQuote(place) === replyTo) setReplyQuote(place, null);
            if (onSocket) setTimeout(() => void reload(), 150);
          } else {
            replyFailed = true;
          }
          render();
        });
      };
      reply.wrap.style.flex = "1";
      if (replyFailed) reply.wrap.appendChild(el("div", "empty-note", REPLY_NOT_SENT));
      acts.appendChild(reply.wrap);
      const send = el("button", "btn primary sm", "Reply");
      send.addEventListener("click", (e) => {
        if (!e.isTrusted) return;
        doReply();
      });
      acts.appendChild(send);
      // A guest replies, reacts and picks — never resolves, reopens or anchors.
      const guest = ref !== null && app.isGuest(ref.spaceId);
      // Resolve keeps the LIVENESS gate — resolving a resolved thread is noise.
      if (!guest && live) {
        const resolve = el("button", "btn ghost sm", "Resolve");
        resolve.addEventListener("click", (e) => {
          if (!e.isTrusted) return;
          void viewApp
            .send({ type: "interaction-resolve", interactionId: s.id } as never)
            .then((res) => {
              if (res.ok) setOpen(false);
              else app.toast("couldn't resolve — try the full view");
            });
        });
        acts.appendChild(resolve);
      } else if (!guest && s.state === "resolved") {
        // Resolution is not a one-way door (F26) — same authority as resolve.
        const reopen = el("button", "btn ghost sm", "Reopen");
        reopen.addEventListener("click", (e) => {
          if (!e.isTrusted) return;
          void viewApp
            .send({ type: "interaction-reopen", interactionId: s.id } as never)
            .then((res) => {
              if (!res.ok) app.toast("couldn't reopen — try the full view");
            });
        });
        acts.appendChild(reopen);
      }
      // A lost anchor on this page (or a frame of it) is placed again by a pick (A-1).
      if (!guest && live && s.anchorLost && deps.onReanchor && deps.reanchorable?.(s.id)) {
        const again = el("button", "btn sm", "Re-anchor");
        again.title = "Re-anchor on this page";
        again.addEventListener("click", (e) => {
          if (!e.isTrusted) return;
          const target = ref;
          setOpen(false);
          if (target) deps.onReanchor?.(target);
        });
        acts.appendChild(again);
      }
      if (!guest && s.anchor.level === "unanchored" && deps.onAnchor) {
        const anchorBtn = el("button", "btn sm", "Anchor");
        anchorBtn.title = "Anchor to this page";
        anchorBtn.addEventListener("click", (e) => {
          if (!e.isTrusted) return;
          const target = ref;
          setOpen(false);
          if (target) deps.onAnchor?.(target);
        });
        acts.appendChild(anchorBtn);
      }
    }
    modal.appendChild(acts);

    // Restore the reader's place (or follow the bottom) now that the new
    // body is in the DOM and has its height.
    body.scrollTop = wasAtBottom ? body.scrollHeight : keepScroll;
    if (shareJustOpened && shareEl) {
      shareJustOpened = false;
      shareEl.scrollIntoView?.({ block: "nearest" });
    }

    if (pendingFocus) {
      pendingFocus = false;
      // Opened while a look holds the overlay hidden (nothing hidden takes
      // focus): the body takes it once the overlay shows, if this thread is
      // still the one open and focus has not gone anywhere since.
      const opened = ref;
      const before = document.activeElement;
      whenShown(() => {
        if (ref !== opened || backdrop.style.display !== "block") return;
        if (document.activeElement !== before) return;
        (backdrop.querySelector(".im-body") as HTMLElement | null)?.focus();
      });
    }
  }

  /* ── events ── */
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) setOpen(false);
  });
  modal.addEventListener("click", (e) => e.stopPropagation());
  onRouted<KeyboardEvent>(modal, "keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  });
  // ⌃↵ full view rides the CAPTURE phase: the reply editor stops keydown
  // propagation for page isolation (F-056), so a bubble listener would never
  // hear the combo while the human is typing.
  onRouted<KeyboardEvent>(
    modal,
    "keydown",
    (e) => {
      if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
      if (!isTrustedEvent(e) || !deps.onFullView || !snapshot) return;
      e.preventDefault();
      e.stopPropagation();
      const id = snapshot.id;
      setOpen(false);
      deps.onFullView(id);
    },
    { capture: true },
  );

  return {
    element: backdrop,
    open(target) {
      deps.onOpened?.(target);
      if (ref?.interactionId !== target.interactionId) shareOpen = false;
      ref = target;
      snapshot = null;
      pendingFocus = true;
      setOpen(true);
      render(); // loading shell
      void reload();
    },
    close: () => setOpen(false),
    isOpen: () => backdrop.style.display === "block",
    currentId: () => ref?.interactionId ?? null,
    refresh() {
      if (ref?.local && ref !== null) void reload();
    },
    remoteTick() {
      if (ref !== null && !ref.local && backdrop.style.display === "block") void reload();
    },
  };
}
