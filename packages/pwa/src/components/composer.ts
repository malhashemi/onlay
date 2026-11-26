// The web app's token composer — the mobile-first twin of the extension's
// token-input BEHAVIOR: `@` opens the mention list (the composing space's
// people plus `@agent`, re-pulled each open), `:xx` suggests emoji, a toolbar
// offers both as buttons, and the screen mounts its own primary Send in
// `actions`. The field is a plain textarea whose value IS the wire text
// (mobile contenteditable is hostile; recognition happens at serialization):
// `value()` resolves every `@<handle>` run the mention list knows into a
// token — `{t:"actor"}` for a person, `{t:"agent"}` for `@agent` — so a
// tapped mention, a typed one, and a restored draft all route identically
// (tokens route, never text). Emoji are NEVER tokens.
import { LIMITS, type PillSpan, type RawRichText, type Token } from "@onlay/protocol";
import { searchEmojis } from "@onlay/render/emoji";
import { AGENT_MENTION_TEXT, findMention, personMentionText } from "@onlay/render/mentions";
import { foldForSearch, searchPeople } from "@onlay/render/people-search";
import { REACTIONS } from "@onlay/render/reactions";
import { button, clear as clearNode, el } from "../dom";
import { AGENT_HANDLE, type Mentionable } from "../mentions";
import { avatar } from "./avatar";

/* ── serialization — the output contract ─────────────────────────────── */

/** Handles are slugs (mentions.ts) — one charset for the trigger and the
 *  resolution scan. */
const MENTION_RE = /@([a-z0-9-]+)/gi;
const ACTOR_TRIGGER = /@([a-z0-9-]*)$/i;
const EMOJI_TRIGGER = /:([a-z0-9_+-]{2,})$/i;
const WORD_BEFORE = /[\p{L}\p{N}_]/u;

/**
 * Wire text → RawRichText: trim, then resolve every known `@<handle>` run to a
 * token and rewrite its text to the shared convention (`@<display name>`,
 * `@agent`; @onlay/render/mentions), so the message reads the same in the
 * extension, in plain text and to an agent. Tokens are deduped and capped at
 * `LIMITS.MAX_TOKENS_PER_MSG`; the text is capped at `cap`. A mention whose
 * rewritten text would cross the cap is not resolved: it and everything after
 * it ship as plain text, cut at the cap (`@alice` cut to `@al` must not reach
 * a real `al`). Pure — unit-tested directly.
 */
export function serializeWire(
  raw: string,
  resolve: (handle: string) => Mentionable | undefined,
  cap: number = LIMITS.MAX_COMMENT_TEXT,
): RawRichText {
  const trimmed = raw.trim();
  const tokens: Token[] = [];
  // Each token says where its mentions sit in the sent text (M-4), one span per mention.
  const spansOf = new Map<string, PillSpan[]>();
  let out = "";
  let last = 0;
  for (const m of trimmed.matchAll(MENTION_RE)) {
    const start = m.index ?? 0;
    // Glued to a word on its left (`a@bea.example`) it is not a mention.
    if (start > 0 && WORD_BEFORE.test(trimmed.charAt(start - 1))) continue;
    const who = resolve((m[1] ?? "").toLowerCase());
    if (!who) continue;
    const wire = who.agent ? AGENT_MENTION_TEXT : personMentionText(who.name);
    const before = out + trimmed.slice(last, start);
    const next = before + wire;
    if (next.length > cap) break;
    out = next;
    last = start + (m[0]?.length ?? 0);
    const span = { start: before.length, length: wire.length };
    const spans = spansOf.get(who.id);
    if (spans) {
      if (spans.length < LIMITS.MAX_TOKENS_PER_MSG) spans.push(span);
      continue;
    }
    if (tokens.length >= LIMITS.MAX_TOKENS_PER_MSG) continue;
    const own = [span];
    spansOf.set(who.id, own);
    tokens.push(
      who.agent ? { t: "agent", spans: own } : { t: "actor", actorId: who.id, spans: own },
    );
  }
  const text = (out + trimmed.slice(last)).slice(0, cap);
  return tokens.length > 0 ? { text, tokens } : { text };
}

/**
 * The reverse, for editing a sent message in the plain field: each token's
 * `@<display name>` run back to the `@<handle>` the field resolves, so the
 * mentions survive the edit. Runs the directory can't place stay as written.
 */
export function wireForEditing(body: RawRichText, mentionables: Iterable<Mentionable>): string {
  const byId = new Map<string, Mentionable>();
  for (const m of mentionables) byId.set(m.id, m);
  const nameOf = (id: string): string => byId.get(id)?.name ?? id;
  let out = "";
  let cursor = 0;
  for (const tok of body.tokens ?? []) {
    if (tok.t === "anchor") continue;
    const at = findMention(body.text, tok, nameOf, cursor);
    const handle = byId.get(tok.t === "agent" ? AGENT_HANDLE : tok.actorId)?.handle;
    if (!at || !handle) continue;
    out += `${body.text.slice(cursor, at.index)}@${handle}`;
    cursor = at.index + at.length;
  }
  return out + body.text.slice(cursor);
}

/* ── the component ───────────────────────────────────────────────────── */

/** What the composer reads — tests feed a stub without standing up main.ts. */
export interface ComposerCtx {
  /** handle → mentionable for the composing space; `value()` resolves only
   *  handles this map knows. Read live: a screen may swap its contents. */
  directory: Map<string, Mentionable>;
  /** Re-pull the space's people; called when the mention list opens. */
  loadDirectory(): Promise<unknown>;
  store: {
    getDraft(personId: string, key: string): Promise<string | null>;
    putDraft(personId: string, key: string, value: string): Promise<void>;
    deleteDraft(personId: string, key: string): Promise<void>;
  };
  /** Keys the draft partition. */
  personId: string;
}

export interface ComposerOpts {
  placeholder: string;
  /** Draft key (view-model `draftKey`) — WIRE TEXT persists, 300ms-debounced. */
  draftKey?: string;
  /** `value()`'s text cap. A screen that prefixes the sent text MUST subtract
   *  its prefix length here, so no mention's wire text is cut after the
   *  composer's token-position accounting already ran. */
  cap?: number;
  /** Fired when a saved draft repopulated the field. */
  onDraftRestored?: () => void;
  /** Enter-to-send (the extension's contract, token-input.ts): a trusted Enter
   *  with no Shift and NO open trigger popover fires this; Shift+Enter stays a
   *  newline. The screen owns Send, so it passes the same handler its button
   *  calls. Absent → Enter is a plain newline (back-compat). */
  onSubmit?: () => void;
}

export interface Composer {
  /** The composer root: field, in-flow popover, toolbar. Mount as-is. */
  node: HTMLElement;
  /** Serialize the field per the output contract (see `serializeWire`). */
  value(): RawRichText;
  /** Empty the field, cancel the pending draft save, drop the draft. */
  clear(): void;
  /** Write any pending draft NOW (the 300ms debounce may be in flight) — call
   *  before tearing the composer down for an intent repaint, or text typed in
   *  the last 300ms dies with the node. */
  flush(): void;
  focus(): void;
  /** Left toolbar cluster — screens may add controls (e.g. attach). */
  tools: HTMLElement;
  /** Right toolbar cluster — the screen mounts its primary Send here. */
  actions: HTMLElement;
  /** Field + built-in toolbar buttons, for the screen's offline sweep. */
  controls: (HTMLButtonElement | HTMLTextAreaElement)[];
}

type PopoverMode = "closed" | "actor" | "emoji" | "browse";

interface PickRow {
  node: HTMLButtonElement;
  accept(): void;
}

export function composer(ctx: ComposerCtx, opts: ComposerOpts): Composer {
  const cap = opts.cap ?? LIMITS.MAX_COMMENT_TEXT;
  const key = opts.draftKey;

  const node = el("div", "composer");
  const ta = el("textarea", "field composer-field") as HTMLTextAreaElement;
  ta.placeholder = opts.placeholder;
  ta.rows = 2;
  // Tint parity with the extension's pills (token-input.ts): a textarea can't
  // style inline runs, so a backdrop mirrors the text pixel-for-pixel behind a
  // transparent-background field and paints a tinted rectangle under each
  // directory-known @mention. The field's own glyphs stay opaque on top —
  // selection and caret read normally; only the pill color comes from below.
  const inputWrap = el("div", "composer-input-wrap");
  const highlight = el("div", "composer-highlight");
  highlight.setAttribute("aria-hidden", "true");
  inputWrap.append(highlight, ta);
  // The popover is a caret-anchored FLOATING menu (position:fixed, placed by
  // placePopover) — DOM order here is irrelevant to its position; it stays a
  // child of the composer only for tab order and lifecycle.
  const popover = el("div", "composer-popover");
  popover.hidden = true;
  const toolbar = el("div", "composer-toolbar");
  const tools = el("div", "composer-tools");
  const actions = el("div", "composer-actions");
  toolbar.append(tools, actions);
  node.append(popover, inputWrap, toolbar);

  let mode: PopoverMode = "closed";
  let rows: PickRow[] = [];
  let active = 0;

  /* ── field editing ── */

  function grow(): void {
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
    paintHighlight();
  }

  /** Rebuild the tint backdrop from the field's current text: plain text as
   *  text nodes, every known `@<handle>` run as a tinted `.mention-hl`
   *  span (no innerHTML — the extension's discipline). The backdrop is absolutely
   *  sized by the field, so only the tinted rectangles need to line up. */
  function paintHighlight(): void {
    clearNode(highlight);
    const text = ta.value;
    let last = 0;
    for (const m of text.matchAll(MENTION_RE)) {
      const id = (m[1] ?? "").toLowerCase();
      if (!ctx.directory.has(id)) continue;
      const start = m.index ?? 0;
      const end = start + (m[0]?.length ?? 0);
      if (start > last) highlight.append(document.createTextNode(text.slice(last, start)));
      const span = el("span", "mention-hl");
      const tint = ctx.directory.get(id)?.tint;
      if (tint) span.style.setProperty("--tint", tint);
      span.textContent = text.slice(start, end);
      highlight.append(span);
      last = end;
    }
    if (last < text.length) highlight.append(document.createTextNode(text.slice(last)));
    // When a tall draft (past the field's max-height) shows a classic
    // scrollbar, it steals width from the field's text but not the full-width
    // backdrop — the two would wrap differently and the pills would drift. Grow
    // the backdrop's right padding by the live scrollbar width so both text
    // columns stay identical. `offsetWidth - clientWidth` is the two 1px `.field`
    // borders + the scrollbar; subtract the borders. Overlay scrollbars (mobile)
    // measure 0, so this is a no-op there.
    const scrollbar = Math.max(0, ta.offsetWidth - ta.clientWidth - 2);
    highlight.style.paddingRight = `${13 + scrollbar}px`;
    highlight.scrollTop = ta.scrollTop;
    highlight.scrollLeft = ta.scrollLeft;
  }

  function caretPos(): number {
    return ta.selectionStart ?? ta.value.length;
  }

  /** Replace `replaceLen` chars before the caret with `s`; caret lands after. */
  function insertAtCaret(s: string, replaceLen = 0): void {
    const at = caretPos();
    const start = Math.max(0, at - replaceLen);
    ta.value = ta.value.slice(0, start) + s + ta.value.slice(at);
    const caret = start + s.length;
    ta.focus();
    ta.setSelectionRange(caret, caret);
    grow();
    persistSoon();
    refreshPopover();
  }

  /* ── drafts (§7.2) — wire text, 300ms debounce, restore re-promotes ── */

  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  function persistSoon(): void {
    if (key === undefined) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void ctx.store.putDraft(ctx.personId, key, ta.value), 300);
  }

  if (key !== undefined) {
    void ctx.store.getDraft(ctx.personId, key).then((d) => {
      if (d && !ta.value) {
        // The draft is wire text; `value()` re-resolves its `@<handle>` runs
        // against the live list, so a restored mention still routes.
        ta.value = d;
        grow();
        opts.onDraftRestored?.();
      }
    });
  }

  /* ── the popover: a caret-anchored FLOATING menu ────────────────────── */
  // Parity with the extension's placeMenu (token-input.ts): the menu escapes the
  // field with `position: fixed` at the caret, flipping above/below by real room
  // — so it never reflows the page or hides behind the keyboard. A textarea has
  // no caret Range, so a hidden mirror div (same text metrics) locates the caret.

  /** The caret's viewport point + its line height, via a text-metric mirror. */
  function caretPoint(): { left: number; top: number; lineHeight: number } {
    const rect = ta.getBoundingClientRect();
    const cs = window.getComputedStyle(ta);
    const mirror = document.createElement("div");
    const s = mirror.style;
    // Copy every metric that drives text geometry so the mirror wraps
    // identically (kebab-case — get/setProperty ignore camelCase names).
    const props = [
      "box-sizing",
      "padding-top",
      "padding-right",
      "padding-bottom",
      "padding-left",
      "border-top-width",
      "border-right-width",
      "border-bottom-width",
      "border-left-width",
      "font-family",
      "font-size",
      "font-weight",
      "font-style",
      "letter-spacing",
      "line-height",
      "text-transform",
      "text-indent",
      "tab-size",
    ] as const;
    for (const p of props) s.setProperty(p, cs.getPropertyValue(p));
    s.position = "fixed";
    s.visibility = "hidden";
    s.pointerEvents = "none";
    s.left = "0";
    s.top = "0";
    s.whiteSpace = "pre-wrap";
    s.overflowWrap = "break-word";
    s.wordBreak = "break-word";
    s.overflow = "hidden";
    // Border-box width (box-sizing copied) → the mirror's text column matches the
    // field's, so a wrapped caret lands on the right line.
    s.width = `${rect.width}px`;
    mirror.textContent = ta.value.slice(0, caretPos());
    const marker = document.createElement("span");
    marker.textContent = "​";
    mirror.appendChild(marker);
    document.body.appendChild(mirror);
    const mRect = mirror.getBoundingClientRect();
    const markRect = marker.getBoundingClientRect();
    const lineHeight = markRect.height || Number.parseFloat(cs.lineHeight) || rect.height;
    // The marker's offset from the mirror's border-box origin equals the caret's
    // offset from the field's — both share border+padding — minus scroll.
    const left = rect.left + (markRect.left - mRect.left) - ta.scrollLeft;
    const top = rect.top + (markRect.top - mRect.top) - ta.scrollTop;
    document.body.removeChild(mirror);
    return { left, top, lineHeight };
  }

  /** Park the (fixed) popover at the caret, flipping above/below by room and
   *  clamping into the viewport. The 0,0-park-then-offset step keeps it correct
   *  even under a transformed ancestor (identity when the CB is the viewport). */
  function placePopover(): void {
    if (popover.hidden) return;
    const pt = caretPoint();
    const vw = window.innerWidth || 800;
    const vh = window.innerHeight || 600;
    popover.style.position = "fixed";
    popover.style.left = "0px";
    popover.style.top = "0px";
    popover.style.maxHeight = "none";
    const natural = popover.getBoundingClientRect();
    const roomBelow = vh - (pt.top + pt.lineHeight);
    const roomAbove = pt.top;
    const below = roomBelow >= natural.height + 8 || roomBelow >= roomAbove;
    const maxH = Math.max(120, Math.min(300, (below ? roomBelow : roomAbove) - 10));
    popover.style.maxHeight = `${maxH}px`;
    const box = popover.getBoundingClientRect(); // capped, still parked at 0,0
    const targetLeft = Math.min(Math.max(8, pt.left), Math.max(8, vw - box.width - 8));
    const targetTop = below ? pt.top + pt.lineHeight + 2 : Math.max(8, pt.top - 2 - box.height);
    popover.style.left = `${targetLeft - box.left}px`;
    popover.style.top = `${targetTop - box.top}px`;
  }

  // A fixed menu would strand mid-air on a scroll/viewport change — re-anchor it
  // (rAF-coalesced), ignoring the menu's own inner scroll. visualViewport covers
  // the mobile soft-keyboard resize.
  let repositionScheduled = false;
  const onReposition = (e?: Event): void => {
    if (e?.target instanceof Node && popover.contains(e.target)) return;
    if (repositionScheduled) return;
    repositionScheduled = true;
    window.requestAnimationFrame(() => {
      repositionScheduled = false;
      if (!popover.hidden) placePopover();
    });
  };
  function attachReposition(): void {
    window.addEventListener("scroll", onReposition, true);
    window.addEventListener("resize", onReposition);
    window.visualViewport?.addEventListener("resize", onReposition);
    window.visualViewport?.addEventListener("scroll", onReposition);
  }
  function detachReposition(): void {
    window.removeEventListener("scroll", onReposition, true);
    window.removeEventListener("resize", onReposition);
    window.visualViewport?.removeEventListener("resize", onReposition);
    window.visualViewport?.removeEventListener("scroll", onReposition);
  }

  /** Reveal the popover at the caret and keep it anchored. */
  function openPopover(): void {
    popover.hidden = false;
    placePopover();
    attachReposition();
  }

  function hidePopover(): void {
    mode = "closed";
    rows = [];
    active = 0;
    popover.hidden = true;
    detachReposition();
    clearNode(popover);
  }

  function paintActive(): void {
    rows.forEach((row, i) => {
      row.node.classList.toggle("on", i === active);
    });
  }

  function pickRow(onAccept: () => void): HTMLButtonElement {
    const b = el("button", "pick-row");
    b.type = "button";
    // mousedown (also the touch compatibility event) runs before the field's
    // blur, so accepting never drops the caret — the extension's pattern.
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      onAccept();
    });
    return b;
  }

  function showRows(head: string, next: PickRow[]): void {
    clearNode(popover);
    if (next.length === 0) {
      hidePopover();
      return;
    }
    popover.append(el("div", "popover-head", head));
    for (const [i, row] of next.entries()) {
      row.node.addEventListener("mouseenter", () => {
        active = i;
        paintActive();
      });
      popover.append(row.node);
    }
    rows = next;
    active = 0;
    paintActive();
    openPopover();
  }

  function actorRows(query: string, triggerLen: number): PickRow[] {
    // `@agent` first when it fits; then people by any word of their name,
    // their alias (members are given it), or else the handle.
    const q = query.toLowerCase();
    const all = [...ctx.directory.values()];
    const agent = all.filter((a) => a.agent === true && a.handle.startsWith(q));
    const people = all.filter((a) => a.agent !== true);
    const found = searchPeople(query, people);
    const byHandle = people.filter((a) => !found.includes(a) && a.handle.includes(q));
    return [...agent, ...found, ...byHandle].slice(0, 6).map((a) => {
      const accept = (): void => insertAtCaret(`@${a.handle} `, triggerLen);
      const b = pickRow(accept);
      b.append(avatar(a, "sm"), el("span", "pick-name", a.agent ? "@agent" : a.name));
      // The alias beside the name (unless it is the name), else the handle.
      const alias =
        a.alias && foldForSearch(a.alias) !== foldForSearch(a.name) ? a.alias : undefined;
      b.append(
        el("span", "pick-hint", a.agent ? "Hand this to an agent" : (alias ?? `@${a.handle}`)),
      );
      return { node: b, accept };
    });
  }

  function emojiRows(query: string, triggerLen: number): PickRow[] {
    return searchEmojis(query, 7).map((m) => {
      const accept = (): void => insertAtCaret(`${m.glyph} `, triggerLen);
      const b = pickRow(accept);
      b.append(el("span", "emoji-glyph", m.glyph), el("span", "pick-hint", `:${m.name}:`));
      return { node: b, accept };
    });
  }

  function openActor(query: string, triggerLen: number): void {
    const opening = mode !== "actor";
    mode = "actor";
    const initial = actorRows(query, triggerLen);
    if (initial.length > 0) {
      showRows("@ people", initial);
    } else {
      // A freshly-mounted screen may not know the space's people yet. Keep the
      // actor mode alive (with no empty chrome) while the first directory pull
      // runs; showRows() intentionally closes other empty result sets.
      rows = [];
      active = 0;
      popover.hidden = true;
      clearNode(popover);
    }
    if (opening) {
      // Re-pull the space's people each open so someone who just joined is
      // mentionable (never throws; api.ts absorbs).
      void ctx.loadDirectory().then(() => {
        // A mention may have been typed before its person was known — the fresh
        // directory can now tint it.
        paintHighlight();
        if (mode !== "actor") return;
        const before = ta.value.slice(0, caretPos());
        const at = ACTOR_TRIGGER.exec(before);
        if (at) showRows("@ people", actorRows((at[1] ?? "").toLowerCase(), at[0].length));
      });
    }
  }

  function refreshPopover(): void {
    if (mode === "browse") return; // the toolbar-opened search owns the popover
    const before = ta.value.slice(0, caretPos());
    const at = ACTOR_TRIGGER.exec(before);
    if (at) {
      openActor((at[1] ?? "").toLowerCase(), at[0].length);
      return;
    }
    const em = EMOJI_TRIGGER.exec(before);
    if (em) {
      mode = "emoji";
      showRows(
        ": emoji — plain text, never a token",
        emojiRows((em[1] ?? "").toLowerCase(), em[0].length),
      );
      return;
    }
    hidePopover();
  }

  /* ── toolbar: emoji browse + mention trigger ── */

  function openBrowse(): void {
    mode = "browse";
    clearNode(popover);
    rows = [];
    active = 0;
    const search = el("input", "field popover-search") as HTMLInputElement;
    search.type = "search";
    search.placeholder = "Search emoji…";
    search.setAttribute("aria-label", "Search emoji");
    const results = el("div", "popover-results");
    const renderResults = (): void => {
      clearNode(results);
      const q = search.value.trim().toLowerCase();
      const matches = searchEmojis(q, 12);
      if (matches.length === 0) {
        // Under the 2-char search gate, offer the shared quick-react set.
        const quick = el("div", "emoji-quick");
        for (const glyph of REACTIONS) {
          const b = pickRow(() => {
            insertAtCaret(glyph);
            hidePopover();
          });
          b.classList.add("emoji-quick-btn");
          b.append(el("span", "emoji-glyph", glyph));
          quick.append(b);
        }
        results.append(quick);
        return;
      }
      for (const m of matches) {
        const b = pickRow(() => {
          insertAtCaret(m.glyph);
          hidePopover();
        });
        b.append(el("span", "emoji-glyph", m.glyph), el("span", "pick-hint", `:${m.name}:`));
        results.append(b);
      }
    };
    search.addEventListener("input", renderResults);
    search.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        hidePopover();
        ta.focus();
      }
    });
    renderResults();
    popover.append(search, results);
    openPopover();
    search.focus();
  }

  const emojiBtn = button("icon-btn tool-btn", "😊", () => {
    if (mode === "browse") {
      hidePopover();
      ta.focus();
    } else openBrowse();
  });
  emojiBtn.setAttribute("aria-label", "Insert emoji");
  const mentionBtn = button("icon-btn tool-btn", "@", () => insertAtCaret("@"));
  mentionBtn.setAttribute("aria-label", "Mention someone");
  // Toolbar taps must never steal the caret: Chromium blurs the field on
  // mousedown BEFORE click runs, so without this the '@' button's insert
  // races the blur grace timer — the pickRow pattern, applied to the tools.
  for (const b of [emojiBtn, mentionBtn]) {
    b.addEventListener("mousedown", (e) => e.preventDefault());
  }
  tools.append(emojiBtn, mentionBtn);

  /* ── events ── */

  ta.addEventListener("input", () => {
    grow();
    persistSoon();
    refreshPopover();
  });
  ta.addEventListener("click", refreshPopover);
  // Keep the tint backdrop aligned when the field scrolls internally (tall
  // drafts past max-height).
  ta.addEventListener("scroll", () => {
    highlight.scrollTop = ta.scrollTop;
    highlight.scrollLeft = ta.scrollLeft;
  });
  ta.addEventListener("keydown", (e) => {
    // Enter sends (the extension's contract) — but only with no open trigger
    // popover to accept into, no Shift (that's a newline), a TRUSTED event (a
    // synthetic Enter must never send), NOT an IME-composition commit (that
    // Enter belongs to the candidate, not the message), and NOT an auto-repeat
    // (holding Enter must fire once). Handled before the popover branch below,
    // which returns early when the popover is closed.
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.isComposing &&
      !e.repeat &&
      e.isTrusted &&
      opts.onSubmit &&
      (mode === "closed" || mode === "browse")
    ) {
      e.preventDefault();
      opts.onSubmit();
      return;
    }
    if (mode === "closed" || mode === "browse") return;
    if (e.key === "Escape") {
      e.preventDefault();
      hidePopover();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length === 0) return;
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
      paintActive();
      return;
    }
    // Enter/Tab accept the highlighted row — but Shift+Enter is always a
    // newline, even with the popover open (it falls through to the default).
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      e.preventDefault();
      rows[Math.min(active, rows.length - 1)]?.accept();
    }
  });
  let blurTimer: ReturnType<typeof setTimeout> | null = null;
  ta.addEventListener("blur", () => {
    // Row taps ride mousedown-preventDefault (no blur); anything else closing
    // the keyboard should also close a trigger popover. Browse mode owns its
    // own focus (the search input) and closes itself. The close is a GRACE
    // TIMER, not a verdict: focus returning inside the window cancels it —
    // otherwise a blur→refocus round-trip would reopen the popover only for
    // the stale timer to kill it ~120ms later.
    if (blurTimer) clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      blurTimer = null;
      if (mode === "actor" || mode === "emoji") hidePopover();
    }, 120);
  });
  ta.addEventListener("focus", () => {
    if (blurTimer) clearTimeout(blurTimer);
    blurTimer = null;
  });

  return {
    node,
    tools,
    actions,
    controls: [ta, emojiBtn, mentionBtn],
    value: () => serializeWire(ta.value, (handle) => ctx.directory.get(handle), cap),
    clear: () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      ta.value = "";
      ta.style.height = "";
      paintHighlight();
      hidePopover();
      if (key !== undefined) void ctx.store.deleteDraft(ctx.personId, key);
    },
    flush: () => {
      if (key === undefined || saveTimer === null) return;
      clearTimeout(saveTimer);
      saveTimer = null;
      void ctx.store.putDraft(ctx.personId, key, ta.value);
    },
    focus: () => ta.focus(),
  };
}
