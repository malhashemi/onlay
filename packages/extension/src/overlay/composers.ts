// Composers (spec §10, §11): the authoring surfaces. Comment = rich text +
// send. Edit = intent + method (Direct / Variants ×N), where Variants hands
// off to the existing variant engine (which creates the owning Edit
// server-side, ADR-0004). Both post to the space the person picks; an Edit
// goes to an agent on its own, so there is no one to route it to. Ask is
// hidden (spec §10): existing Asks render and answer, none are composed.

import { type Anchor, LIMITS, type RawRichText } from "@onlay/protocol";
import { sameRevision } from "@onlay/render/mentions";
import { HOSTED_COPY } from "../hosted-copy";
import { documentProvenance } from "./anchors";
import type { App, CreateResult } from "./app";
import { COPY_COPY, copyAndRemember, itemText } from "./copy-agent";
import { el } from "./dom";
import { clearDraftIfUnchanged, draftRevision } from "./drafts";
import { pageKey } from "./page-url";
import { clientIdFor, confirmSend } from "./send-ids";
import { SPACE_PICKER_COPY, spacePicker } from "./space-picker";
import { type TokenInput, tokenInput } from "./token-input";
import { isTrustedEvent } from "./trusted";

/* ── shared rich-token input (token-input.ts): @ actors · # anchors · :emoji ── */

/** The historical richInput surface — now a token editor (F-028). */
export type RichInput = TokenInput;

export interface RichInputOpts {
  /** The space whose people the @ menu offers (with `@agent`). */
  spaceId?: () => string | null;
  /**
   * Stable id that survives view rebuilds. When set, unsent text is persisted
   * to the draft store so an incoming `interactions-state` frame (which tears
   * the composer down and rebuilds it) doesn't vaporize the draft. A
   * function is read at every save (a composer keyed by its chosen space).
   */
  draftKey?: string | (() => string);
}

export function richInput(
  app: App,
  placeholder: string,
  onSend?: () => void,
  opts: RichInputOpts = {},
): RichInput {
  return tokenInput(app, placeholder, {
    multiline: true,
    ...(onSend ? { onSend } : {}),
    ...(opts.draftKey !== undefined ? { draftKey: opts.draftKey } : {}),
    ...(opts.spaceId ? { spaceId: opts.spaceId } : {}),
  });
}

/* ── small controls ─────────────────────────────────────────────────── */

function labeled(label: string, control: HTMLElement): HTMLElement {
  const f = el("div", "field");
  f.append(el("span", "micro", label), control);
  return f;
}

function segment<T extends string>(
  options: Array<{ id: T; label: string; tone?: "amber" | "red" }>,
  initial: T,
  onChange: (v: T) => void,
): HTMLElement {
  const wrap = el("div", "seg");
  let current = initial;
  const btns = new Map<T, HTMLElement>();
  const paint = (): void => {
    for (const [id, b] of btns) {
      const opt = options.find((o) => o.id === id);
      b.className = current === id ? `on${opt?.tone ? ` ${opt.tone}` : ""}` : "";
    }
  };
  for (const o of options) {
    const b = el("button", undefined, o.label);
    b.addEventListener("click", (e) => {
      if (!isTrustedEvent(e)) return;
      current = o.id;
      paint();
      onChange(o.id);
    });
    btns.set(o.id, b);
    wrap.appendChild(b);
  }
  paint();
  return wrap;
}

/* ── composer drafts and sends (M-2, M-3) ───────────────────────────── */

/** Beside a composer whose create didn't land: its text stays for another try. */
export const COMPOSER_NOT_SENT = {
  comment: "Your comment wasn't sent. Check your connection, then send it again.",
  edit: "Your Edit wasn't sent. Check your connection, then send it again.",
} as const;

/** What an anchor names, as a draft key part: the same target gives the same key. */
function anchorKey(anchor: Anchor): string {
  // A block inside frames of the page (A-3) is another block than one with
  // the same selector in the page itself.
  const frames =
    "framePath" in anchor && anchor.framePath ? `${JSON.stringify(anchor.framePath)}:` : "";
  switch (anchor.level) {
    case "element":
      return `element:${frames}${anchor.blockId ?? ""}:${anchor.selector}`;
    case "selection":
      return `selection:${frames}${anchor.selector}:${anchor.text}`;
    default:
      return anchor.level;
  }
}

/**
 * The draft store key for a composer: its kind, the space it writes to, the
 * page and what it is anchored to. Reopening the composer on the same target
 * finds its unsent text again, after a remount too.
 */
function composerDraftKey(
  kind: "comment" | "change",
  spaceId: string | null,
  url: string,
  anchor: Anchor,
): string {
  return `composer:${kind}:${spaceId ?? ""}:${pageKey(url) ?? url}:${anchorKey(anchor)}`;
}

/** Reasons that mean the create never reached the space, or its answer never came back. */
const UNSENT = new Set([
  "timeout",
  "closed",
  "not-connected",
  "not-ready",
  "no-response",
  "sw-unreachable",
  "membrane-updated",
]);

/**
 * A create that didn't land keeps its text and says so beside it: the
 * "wasn't sent" note for a lost connection, the refusal's reason otherwise.
 */
function notSent(note: HTMLElement, text: string, refused: string, r: CreateResult): void {
  const reason = r.reason ?? "unknown";
  note.textContent =
    // The frame's page or account changed, or its document is gone (3-F3).
    reason === "page-changed" || reason === "no-frame"
      ? FRAME_PAGE_CHANGED
      : UNSENT.has(reason)
        ? text
        : `${refused}: ${reason}`;
  note.style.display = "";
}

/**
 * Ask the space to create. `target` is the composer's draft key (kind, space,
 * page and anchor): an unconfirmed try from that target with the same payload
 * is retried with its own nonce, whatever else was sent since (2-M3).
 */
async function createOnce(
  app: App,
  payload: Record<string, unknown>,
  spaceId: string,
  target: string,
  via?: ComposerVia,
): Promise<CreateResult> {
  const place = `create:${target}`;
  const nonce = clientIdFor(place, payload);
  const r = via
    ? await via.create(payload, spaceId, nonce)
    : await app.createInteraction(payload, spaceId, nonce);
  if (r.ok) confirmSend(place, nonce);
  return r;
}

/**
 * A send landed: its stored draft goes only if nothing was written to it
 * since the send (2-M2), and this editor empties only if it is still on
 * screen holding what was sent.
 */
function finishSend(input: TokenInput, key: string, revision: number, sent: RawRichText): void {
  if (!clearDraftIfUnchanged(key, revision)) return;
  if (input.input.isConnected && sameRevision(input.value(), sent)) input.clear();
}

/**
 * A block picked inside a child frame (F-2): the composer stays in the top
 * frame, but the interaction is bound to the frame's own address and created
 * by the frame that owns the block, through the service worker.
 */
export interface ComposerVia {
  /** The frame document's own URL: what the interaction is bound to. */
  pageUrl: string;
  /** The frame's host, from the address the browser reported for it (2-F3). */
  host: string;
  /** Create through the owning frame; it adds the anchor it picked. */
  create(payload: Record<string, unknown>, spaceId: string, nonce: string): Promise<CreateResult>;
  /**
   * Ask for variants through the owning frame (E-1): the set's root is the
   * block (or the page) that frame picked, and the set lives with its address.
   */
  startVariants?(
    command: string,
    count: number,
    intent: "change" | "insert-after",
    spaceId: string,
  ): Promise<CreateResult>;
}

/**
 * The frame that holds the picked block went to another page, or the account
 * changed, after the pick (2-F3): nothing was sent.
 */
export const FRAME_PAGE_CHANGED =
  "The page in this frame changed after you picked the block. Pick the block again.";

/**
 * Variants are not offered for a block inside a frame without an address of
 * its own (its anchor has a `framePath`): a block in a frame that owns its
 * address has them (E-1).
 */
export const FRAME_VARIANTS_NOTE =
  "Variants aren't available for a block inside this frame. Choose Direct instead.";

/* ── comment composer ───────────────────────────────────────────────── */

export function commentComposer(
  app: App,
  anchor: Anchor,
  onDone: () => void,
  via?: ComposerVia,
): HTMLElement {
  const wrap = el("div", "composer");
  const url = via?.pageUrl ?? app.frameUrl();
  const space = spacePicker(app, () => input.saveDraft());
  const keyNow = (): string => composerDraftKey("comment", space.value(), url, anchor);
  const input = richInput(app, "Comment on this spot… @mention to notify", () => submit(), {
    spaceId: () => space.value(),
    draftKey: keyNow,
  });
  const note = el("div", "empty-note");
  note.style.display = "none";
  const row = el("div", "row");
  const send = el("button", "btn primary", "Comment");
  const cancel = el("button", "btn ghost", "Cancel");
  row.append(send, cancel);
  if (space.element) wrap.append(space.element);
  wrap.append(input.wrap, note, row);

  async function submit(): Promise<void> {
    const body = input.value();
    if (!body.text || (send as HTMLButtonElement).disabled) return;
    const spaceId = space.value();
    if (!spaceId) {
      app.toast(`Comment not posted. ${HOSTED_COPY.noSpace}`);
      return;
    }
    // Lost since it was chosen: nothing goes, the text stays.
    if (!space.usable()) {
      note.textContent = SPACE_PICKER_COPY.lost;
      note.style.display = "";
      return;
    }
    (send as HTMLButtonElement).disabled = true;
    note.style.display = "none";
    app.setCurrentSpace(spaceId);
    // The composer and its text stay until the create's receipt (M-2).
    const key = keyNow();
    const revision = draftRevision(key);
    const r = await createOnce(app, { kind: "comment", anchor, body }, spaceId, key, via);
    if (r.ok) {
      finishSend(input, key, revision, body);
      app.toast("comment posted");
      onDone();
    } else {
      (send as HTMLButtonElement).disabled = false;
      notSent(note, COMPOSER_NOT_SENT.comment, "comment not posted", r);
    }
  }
  send.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    void submit();
  });
  // Cancel drops the draft; closing the window (or a remount) keeps it.
  cancel.addEventListener("click", () => {
    input.clear();
    onDone();
  });
  input.focus();
  return wrap;
}

/* ── change composer ────────────────────────────────────────────────── */

export interface ChangeHooks {
  /**
   * Variants: hand the intent to the variant engine (creates the Change);
   * resolves when the set landed or with why it didn't.
   */
  startVariants(
    command: string,
    count: number,
    intent: "change" | "insert-after",
    spaceId: string,
  ): Promise<CreateResult>;
}

export interface ChangeComposerOpts {
  /** No picked block: the Edit (and any variants) is for the whole page. */
  pageScope?: boolean;
  /** The block is in a child frame: create through it. */
  via?: ComposerVia;
  /** The block's markup is too large for an agent to read whole (it gets a reduced copy). */
  largeBlock?: boolean;
}

/** Said in the Edit composer for a block too large to send whole (copy pass pending). */
const LARGE_BLOCK_NOTE =
  "This block is too large for an agent to see in full. A smaller block gives better results.";

/** The Edit composer's confirmation (spec §9: it offers Copy for agent). */
export const EDIT_SENT_COPY = {
  sent: "Edit sent. Copy it for your agent, or let a teammate's agent pick it up.",
  done: "Done",
} as const;

export function changeComposer(
  app: App,
  anchor: Anchor,
  onDone: () => void,
  hooks: ChangeHooks,
  opts: ChangeComposerOpts = {},
): HTMLElement {
  const pageScope = opts.pageScope === true;
  const via = opts.via;
  const inFrameOfPage = "framePath" in anchor && anchor.framePath !== undefined;
  const wrap = el("div", "composer");
  const url = via?.pageUrl ?? app.frameUrl();
  const space = spacePicker(app, () => intent.saveDraft());
  const keyNow = (): string => composerDraftKey("change", space.value(), url, anchor);
  const intent = tokenInput(app, "Describe the edit for the agent…", {
    cap: LIMITS.MAX_COMMAND_INTENT,
    spaceId: () => space.value(),
    draftKey: keyNow,
    // Enter sends (mirrors the comment composer): the same submit the primary
    // button runs — Request edit / Request insert / Generate variants per the
    // current action+method state. Shift+Enter stays a newline; the token
    // input already guards synthetic Enter (e.isTrusted). No Ctrl+Enter here —
    // ⌃↵ is reserved for "open full view".
    onSend: () => void submit(),
  });

  let action: "change" | "insert-after" = "change";
  let method: "direct" | "variants" = "direct";
  let count = 3;
  const updatePlaceholder = (): void => {
    intent.input.setAttribute(
      "data-placeholder",
      action === "insert-after"
        ? "Describe what to insert after this anchor…"
        : "Describe the edit for the agent…",
    );
    send.textContent =
      method === "variants"
        ? "Generate variants"
        : action === "insert-after"
          ? "Request insert"
          : "Request edit";
  };
  const actionSeg = segment(
    [
      { id: "change", label: "Edit" },
      { id: "insert-after", label: "Insert after" },
    ],
    "change",
    (v) => {
      action = v;
      updatePlaceholder();
    },
  );
  const methodSeg = segment(
    [
      { id: "direct", label: "Direct" },
      { id: "variants", label: "Variants" },
    ],
    "direct",
    (v) => {
      method = v;
      countWrap.style.display = v === "variants" ? "flex" : "none";
      countField.style.display = v === "variants" ? "flex" : "none";
      updatePlaceholder();
      // A block inside a frame without an address of its own (A-3) has no
      // document of its own to preview in: only Direct is offered there.
      if (inFrameOfPage) {
        status.textContent = v === "variants" ? FRAME_VARIANTS_NOTE : "";
        (send as HTMLButtonElement).disabled = v === "variants";
      }
    },
  );
  const countWrap = el("div", "seg");
  countWrap.style.display = "none";
  for (const n of [1, 3, 5]) {
    const b = el("button", n === 3 ? "on" : undefined, `×${n}`);
    b.addEventListener("click", (e) => {
      if (!isTrustedEvent(e)) return;
      count = n;
      for (const c of countWrap.children) c.className = "";
      b.className = "on";
    });
    countWrap.appendChild(b);
  }
  const countField = labeled("Count", countWrap);
  countField.style.display = "none";

  const status = el("div", "dim");
  const note = el("div", "empty-note");
  note.style.display = "none";
  const row = el("div", "row");
  const send = el("button", "btn primary k-change", "Request edit");
  const cancel = el("button", "btn ghost", "Cancel");
  row.append(send, cancel);
  updatePlaceholder();
  // Insert-after needs a block to insert after; the page edits in place.
  if (!pageScope) wrap.appendChild(labeled("Action", actionSeg));
  wrap.appendChild(labeled("Delivery", methodSeg));
  if (space.element) wrap.appendChild(space.element);
  wrap.append(intent.wrap, countField, status, note, row);
  if (opts.largeBlock) {
    // Said once, beside the request; the Edit still goes as asked.
    const large = el("div", "dim", LARGE_BLOCK_NOTE);
    wrap.insertBefore(large, status);
  }

  async function submit(): Promise<void> {
    const sent = intent.value();
    const text = sent.text;
    const key = keyNow();
    const revision = draftRevision(key);
    if ((send as HTMLButtonElement).disabled) return;
    if (!text) {
      status.textContent = "Describe the edit first.";
      return;
    }
    const spaceId = space.value();
    if (!spaceId) {
      status.textContent = HOSTED_COPY.noSpace;
      return;
    }
    // Lost since it was chosen: nothing goes, the text stays.
    if (!space.usable()) {
      status.textContent = SPACE_PICKER_COPY.lost;
      return;
    }
    app.setCurrentSpace(spaceId);
    (send as HTMLButtonElement).disabled = true;
    status.textContent = "Sending…";
    note.style.display = "none";
    if (method === "variants" && inFrameOfPage) {
      (send as HTMLButtonElement).disabled = false;
      status.textContent = FRAME_VARIANTS_NOTE;
      return;
    }
    if (method === "variants") {
      // The variant engine creates the owning Edit server-side (ADR-0004);
      // the composer and its text stay until the set lands (M-2). A block in
      // a child frame asks through that frame (E-1).
      const start = via ? via.startVariants?.bind(via) : hooks.startVariants;
      const r = start
        ? await start(text, count, action, spaceId)
        : { ok: false, reason: "no-frame" };
      if (r.ok) {
        finishSend(intent, key, revision, sent);
        onDone();
      } else {
        (send as HTMLButtonElement).disabled = false;
        status.textContent = "";
        notSent(note, COMPOSER_NOT_SENT.edit, "not sent", r);
      }
      return;
    }
    const routedIntent = action === "insert-after" ? `Insert after this anchor: ${text}` : text;
    const provenance = anchor.level === "page" ? documentProvenance() : undefined;
    const r = await createOnce(
      app,
      {
        kind: "change",
        anchor,
        change: {
          intent: routedIntent,
          method: "direct",
          ...(provenance ? { provenance } : {}),
        },
      },
      spaceId,
      key,
      via,
    );
    if (r.ok) finishSend(intent, key, revision, sent);
    if (r.ok && r.interactionId) {
      app.toast("Edit sent for an agent.");
      confirmSent(r.interactionId, spaceId);
    } else if (r.ok) {
      app.toast("Edit sent for an agent.");
      onDone();
    } else {
      (send as HTMLButtonElement).disabled = false;
      status.textContent = "";
      notSent(note, COMPOSER_NOT_SENT.edit, "not sent", r);
    }
  }
  /** The sent Edit's confirmation: one way to hand it to an agent, one way out. */
  function confirmSent(interactionId: string, spaceId: string): void {
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
    const note = el("div", "dim", EDIT_SENT_COPY.sent);
    const actions = el("div", "row");
    const copy = el("button", "btn primary k-change", COPY_COPY.action) as HTMLButtonElement;
    const done = el("button", "btn ghost", EDIT_SENT_COPY.done);
    actions.append(copy, done);
    wrap.append(note, actions);
    copy.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      const item = {
        id: interactionId,
        spaceId,
        kind: "change" as const,
        url,
        anchor,
      };
      void copyAndRemember(app, itemText(app, item), [item]).then((ok) => {
        if (ok) onDone();
      });
    });
    done.addEventListener("click", onDone);
    copy.focus();
  }
  send.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    void submit();
  });
  // Cancel drops the draft; closing the window (or a remount) keeps it.
  cancel.addEventListener("click", () => {
    intent.clear();
    onDone();
  });
  intent.focus();
  return wrap;
}
