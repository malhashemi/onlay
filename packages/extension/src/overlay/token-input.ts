// The universal rich-token input (F-028) — a contenteditable editor with the
// whole trigger grammar: `@` mentions a person in the composing space, or
// `@agent` to hand the thread to an agent (live pills), `#` drops an
// anchor (live interactions on this page, or the element picker), `:xx`
// inserts an emoji GLYPH (an emoji is plain text, never a token). Built for
// the overlay: vanilla TS, shadow DOM, no innerHTML, one constructed sheet
// (dom.ts).
//
// The serialization rule: the editor's textContent IS
// the wire format. Pills are `<span contenteditable=false data-token>` whose
// text is exactly `@Name` / `@agent` / `#label`; value() walks child nodes, emitting pill
// text into `text` and pill tokens into `tokens[]` — recognition is data,
// never re-discovery.
import {
  type Anchor,
  LIMITS,
  type PillSpan,
  type RawInteractionSnapshot,
  type RawRichText,
  type Token,
} from "@onlay/protocol";
import { searchEmojis } from "@onlay/render/emoji";
import { personMentionText } from "@onlay/render/mentions";
import { foldForSearch, searchPeople } from "@onlay/render/people-search";
import { anchorLabel } from "./anchors";
import { breakLength, focusEnd, isLineBreak, selectionIn } from "./caret";
import { avatar, el, icon, scaled } from "./dom";
import { clearDraft, readRichDraft, writeRichDraft } from "./drafts";
import { type Glyph, isLiveState, KINDS } from "./kinds";
import { AGENT_WIRE, findWire, type PersonView } from "./people";
import { isTrustedEvent } from "./trusted";
import { onRouted } from "./typing-router";

export type AnchorToken = Extract<Token, { t: "anchor" }>;

/** Lucide MousePointer2 — the element-picker row glyph. */
const POINTER_GLYPH: Glyph = { paths: ["m4 4 7.07 17 2.51-7.39L21 11.07z"] };

/* ── element-pick hook — content.ts wires the page-side machinery ────── */

export interface ElementPickRequest {
  /** A picked element lands as its anchor + human label. */
  onPick(anchor: Anchor, label: string): void;
  /** Pick aborted (Escape) — the editor takes focus back. */
  onCancel(): void;
}

let elementPickHandler: ((req: ElementPickRequest) => void) | null = null;

/**
 * Register the overlay's element-pick mode (mirrors how launcher/batch modes
 * ride content.ts's mode machinery). The `#` menu's "pick on page…" row calls
 * through here; without a handler the row is hidden.
 */
export function setElementPickHandler(handler: (req: ElementPickRequest) => void): void {
  elementPickHandler = handler;
}

/* ── pills — textContent IS the wire format ──────────────────────────── */

/** Token payloads ride a WeakMap, not attributes: structured, CSP-quiet. */
const PILL_TOKENS = new WeakMap<Element, Token>();

function personPill(person: PersonView): HTMLElement {
  const pill = el("span", "token-pill token-actor", personMentionText(person.name));
  if (person.tint) pill.style.setProperty("--pill", person.tint);
  pill.setAttribute("contenteditable", "false");
  pill.setAttribute("data-token", "actor");
  pill.title = person.name;
  PILL_TOKENS.set(pill, { t: "actor", actorId: person.id });
  return pill;
}

/** `@agent`: the existing pill, in the primary hue. Hands the thread to an agent. */
function agentPill(): HTMLElement {
  const pill = el("span", "token-pill token-actor", AGENT_WIRE);
  pill.setAttribute("contenteditable", "false");
  pill.setAttribute("data-token", "agent");
  pill.title = "Hand this to an agent";
  PILL_TOKENS.set(pill, { t: "agent" });
  return pill;
}

function anchorPillEl(token: AnchorToken): HTMLElement {
  const pill = el("span", "token-pill token-anchor", `#${token.label}`);
  pill.setAttribute("contenteditable", "false");
  pill.setAttribute("data-token", "anchor");
  pill.title = `anchor — ${token.label}`;
  PILL_TOKENS.set(pill, token);
  return pill;
}

function tokenOf(node: Element): Token | null {
  const known = PILL_TOKENS.get(node);
  if (known) return known;
  // a pill we didn't mint (defensive): only @agent reconstructs from its text
  if (node.getAttribute("data-token") === "agent") return { t: "agent" };
  return null;
}

/**
 * Walk an editor's children: pill text and plain text concatenate into the
 * wire text. `at` holds, for each token, where its pill's text sits in `text`.
 */
export function serializeEditor(editor: HTMLElement): {
  text: string;
  tokens: Token[];
  at: PillSpan[];
} {
  let text = "";
  const tokens: Token[] = [];
  const at: PillSpan[] = [];
  const visit = (n: Node): void => {
    if (n.nodeType === 3) {
      text += (n as Text).data.replace(/\u00a0/g, " ");
      return;
    }
    if (n.nodeType !== 1) return;
    const node = n as Element;
    if (node.getAttribute("data-token") !== null) {
      const pill = node.textContent ?? "";
      const tok = tokenOf(node);
      if (tok) {
        tokens.push(tok);
        at.push({ start: text.length, length: pill.length });
      }
      text += pill;
      return;
    }
    // One "\n" per break, none for the placeholder <br> that ends the editor
    // (`insertLineBreak` keeps one after a break at the end). The caret
    // counts breaks the same way (caret.ts `breakLength`).
    if (isLineBreak(node)) {
      text += "\n".repeat(breakLength(node, editor));
      return;
    }
    for (const c of Array.from(node.childNodes)) visit(c);
  };
  for (const c of Array.from(editor.childNodes)) visit(c);
  return { text, tokens, at };
}

/**
 * The pills a rich value's spans place, in text order: each inside the text,
 * starting with its token's `@`/`#`, none overlapping. Empty when the value
 * carries no usable span.
 */
function placedPills(
  text: string,
  tokens: readonly Token[],
): Array<{ start: number; length: number; tok: Token }> {
  const placed: Array<{ start: number; length: number; tok: Token }> = [];
  for (const tok of tokens) {
    const { spans, ...bare } = tok;
    const sigil = tok.t === "anchor" ? "#" : "@";
    for (const sp of spans ?? []) {
      if (sp.length < 2 || sp.start + sp.length > text.length) continue;
      if (text.charAt(sp.start) !== sigil) continue;
      placed.push({ start: sp.start, length: sp.length, tok: bare as Token });
    }
  }
  placed.sort((a, b) => a.start - b.start);
  const kept: typeof placed = [];
  let end = 0;
  for (const p of placed) {
    if (p.start < end) continue;
    kept.push(p);
    end = p.start + p.length;
  }
  return kept;
}

/** `at` moved left by `by` code units (the text was trimmed on its left). */
function shifted(at: readonly PillSpan[], by: number): PillSpan[] {
  return at.map((p) => ({ start: p.start - by, length: p.length }));
}

/**
 * The tokens that ship with `text` (already trimmed and capped). A pill whose
 * wire text spilled past the cap is no longer visible, so it must NOT ship —
 * an out-of-view @agent would still hand the thread over. Walk the tokens in
 * document order against the text: the first whose wire no longer fits ends
 * the run (every later one sits further right). A person and @agent each ship
 * once. A typed `@agent` that never became a pill still counts.
 */
export function tokensFor(
  text: string,
  pills: readonly Token[],
  person: (id: string) => PersonView,
  /**
   * Where each pill sits in `text`, from the editor. With it every shipped
   * token carries `spans`, one per pill (a person mentioned twice has two),
   * so the agent rendering frames exactly the pills (M-4).
   */
  placed?: readonly PillSpan[],
): RawRichText {
  const tokens: Token[] = [];
  const shipped = new Map<string, Token & { spans?: PillSpan[] }>();
  let agent = false;
  let cursor = 0;
  for (const [i, tok] of pills.entries()) {
    const known = placed?.[i];
    const at = known
      ? known.start >= cursor && known.start + known.length <= text.length
        ? { index: known.start, length: known.length }
        : null
      : findWire(text, tok, person, cursor);
    if (!at) break;
    cursor = at.index + at.length;
    const span = { start: at.index, length: at.length };
    const key = tok.t === "actor" ? `actor:${tok.actorId}` : tok.t === "agent" ? "agent" : null;
    const prior = key !== null ? shipped.get(key) : undefined;
    if (prior) {
      // A person (or @agent) ships once; each further pill adds its span.
      if (placed && prior.spans && prior.spans.length < LIMITS.MAX_TOKENS_PER_MSG)
        prior.spans.push(span);
      continue;
    }
    if (tokens.length >= LIMITS.MAX_TOKENS_PER_MSG) break;
    if (tok.t === "agent") agent = true;
    const { spans: _stale, ...bare } = tok;
    const out = (placed ? { ...bare, spans: [span] } : bare) as Token & { spans?: PillSpan[] };
    if (key !== null) shipped.set(key, out);
    tokens.push(out);
  }
  if (!agent && tokens.length < LIMITS.MAX_TOKENS_PER_MSG && /(^|\s)@agent\b/i.test(text)) {
    tokens.push({ t: "agent" });
  }
  return tokens.length > 0 ? { text, tokens } : { text };
}

/* ── trigger detection at the caret ──────────────────────────────────── */

export type TriggerKind = "actor" | "anchor" | "emoji";
export interface Trigger {
  kind: TriggerKind;
  query: string;
  /** Chars to replace before the caret (the trigger char + the query). */
  length: number;
}

const AT_TRIGGER = /@([a-z0-9_-]*)$/i;
const HASH_TRIGGER = /#([\w./:§-]*)$/;
const EMOJI_TRIGGER = /:([a-z0-9_+-]{2,})$/i;

/** Detect a live trigger in the text before the caret (pure — unit-tested). */
export function detectTrigger(before: string): Trigger | null {
  const at = AT_TRIGGER.exec(before);
  if (at) return { kind: "actor", query: (at[1] ?? "").toLowerCase(), length: at[0].length };
  const hash = HASH_TRIGGER.exec(before);
  if (hash) return { kind: "anchor", query: (hash[1] ?? "").toLowerCase(), length: hash[0].length };
  const colon = EMOJI_TRIGGER.exec(before);
  if (colon)
    return { kind: "emoji", query: (colon[1] ?? "").toLowerCase(), length: colon[0].length };
  return null;
}

/* ── backspace-at-a-pill: pills delete whole ─────────────────────────── */

/** The pill immediately before a collapsed caret, if the caret sits on its boundary. */
export function pillBeforeCaret(editor: HTMLElement): Element | null {
  const sel = selectionIn(editor);
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const node = sel.focusNode;
  const off = sel.focusOffset;
  if (!node || !editor.contains(node)) return null;
  let prev: Node | null = null;
  if (node.nodeType === 3) {
    if (off > 0) return null;
    prev = node.previousSibling;
  } else if (off > 0) {
    prev = node.childNodes[off - 1] ?? null;
  }
  while (prev && prev.nodeType === 3 && (prev as Text).data === "") prev = prev.previousSibling;
  if (prev && prev.nodeType === 1 && (prev as Element).getAttribute("data-token") !== null) {
    return prev as Element;
  }
  return null;
}

/* ── the editor ──────────────────────────────────────────────────────── */

/** Every open trigger menu's hide(), module-wide. The Escape ladder (ADR-0019,
 *  content.ts) runs at WINDOW CAPTURE — before any editor-level handler can
 *  eat the key — so without a rung for the menus, Escape-with-a-menu-open
 *  closes the whole modal/panel instead (F19's second face). The ladder calls
 *  {@link closeAnyOpenTokenMenu} as its most-transient rung. */
const openMenuHiders = new Set<() => void>();

/** Close every open trigger menu; true if any was open (the ladder's rung-0
 *  verdict: consume the Escape, close nothing else). */
export function closeAnyOpenTokenMenu(): boolean {
  if (openMenuHiders.size === 0) return false;
  for (const hide of [...openMenuHiders]) hide();
  return true;
}

export interface TokenInput {
  /** Positioned wrapper carrying the editor + its trigger menu. */
  wrap: HTMLElement;
  /** The contenteditable itself (carries data-draft-key / data-placeholder). */
  input: HTMLElement;
  value(): RawRichText;
  /** Seed plain text (drafts, edits); a typed `@agent` still becomes the token. */
  setText(text: string): void;
  clear(): void;
  focus(): void;
  /** Save the draft under the key as it is now (after the composer's space changed). */
  saveDraft(): void;
}

export interface TokenInputOpts {
  /** Multi-line (replies, context) vs one-line (question, option labels). */
  multiline?: boolean;
  /** Text cap — protocol limit for the field this editor feeds. */
  cap?: number;
  /** Enter sends (isTrusted-gated); Shift+Enter stays a newline. */
  onSend?: () => void;
  /**
   * Stable id: unsent text survives `interactions-state` rebuilds. A function
   * is read at every save, so a composer whose key follows a choice (its
   * space) keeps one draft under the current key (`saveDraft` moves it).
   */
  draftKey?: string | (() => string);
  /**
   * Off-page surfaces (the full-page interaction view) have no live page to
   * anchor to: the `#` trigger stays inert and "pick on page…" never offers.
   * @ mentions and : emoji are unaffected.
   */
  noAnchors?: boolean;
  /** The space whose people `@` offers; absent = everyone the client knows. */
  spaceId?: () => string | null;
}

/**
 * The slice of App the editor reads. Narrowing it (rather than requiring the
 * whole overlay App) lets a page-less surface feed the editor a small adapter
 * without standing up the overlay runtime.
 */
export interface TokenInputApp {
  person(id: string): PersonView;
  people(spaceId?: string): PersonView[];
  interactions(): RawInteractionSnapshot[];
}

interface MenuRow {
  node: HTMLElement;
  accept(): void;
}

export function tokenInput(
  app: TokenInputApp,
  placeholder: string,
  opts: TokenInputOpts = {},
): TokenInput {
  const multiline = opts.multiline !== false;
  const cap = opts.cap ?? LIMITS.MAX_COMMENT_TEXT;
  const keyOpt = opts.draftKey;
  const keyNow = (): string | undefined => (typeof keyOpt === "function" ? keyOpt() : keyOpt);
  let draftKey = keyNow();
  const noAnchors = opts.noAnchors === true;
  const mentionable = (): PersonView[] => app.people(opts.spaceId?.() ?? undefined);
  const pillFor = (tok: Token): HTMLElement =>
    tok.t === "agent"
      ? agentPill()
      : tok.t === "actor"
        ? personPill(app.person(tok.actorId))
        : anchorPillEl(tok);

  const wrap = el("div", "field");
  wrap.style.position = "relative";
  const input = el("div", `token-editor${multiline ? "" : " single"}`);
  input.setAttribute("contenteditable", "true");
  input.setAttribute("role", "textbox");
  input.setAttribute("aria-multiline", multiline ? "true" : "false");
  input.setAttribute("data-placeholder", placeholder);
  input.tabIndex = 0;
  if (draftKey !== undefined) input.dataset.draftKey = draftKey;
  wrap.appendChild(input);

  const menu = el("div", "mention-menu");
  menu.style.display = "none";
  wrap.appendChild(menu);

  let menuRows: MenuRow[] = [];
  let active = 0;

  const doc = (): Document => input.ownerDocument ?? document;

  /* ── DOM building from a rich value (draft restore / edits) ── */

  function setValue(v: RawRichText): void {
    while (input.firstChild) input.removeChild(input.firstChild);
    const text = v.text;
    // A draft (or a message being edited) that says where its pills sit is
    // rebuilt from those spans; text matching is only for one that doesn't
    // (2-M4), so a copy of a name elsewhere in the text never steals the pill.
    const placed = placedPills(text, v.tokens ?? []);
    if (placed.length > 0) {
      let at = 0;
      for (const p of placed) {
        if (p.start > at) input.appendChild(doc().createTextNode(text.slice(at, p.start)));
        // The pill reads what was there (3-M5): not a stand-in name while the
        // space's people are still loading.
        const pill = pillFor(p.tok);
        const shown = text.slice(p.start, p.start + p.length);
        pill.textContent = shown;
        if (p.tok.t === "actor") pill.title = shown.slice(1);
        input.appendChild(pill);
        at = p.start + p.length;
      }
      if (at < text.length) input.appendChild(doc().createTextNode(text.slice(at)));
      return;
    }
    let cursor = 0;
    for (const tok of v.tokens ?? []) {
      const at = findWire(text, tok, app.person, cursor);
      if (!at) continue;
      if (at.index > cursor) input.appendChild(doc().createTextNode(text.slice(cursor, at.index)));
      input.appendChild(pillFor(tok));
      cursor = at.index + at.length;
    }
    if (cursor < text.length) input.appendChild(doc().createTextNode(text.slice(cursor)));
  }

  if (draftKey !== undefined) {
    const saved = readRichDraft(draftKey);
    if (saved !== undefined) setValue(saved);
  }

  /* ── serialization + persistence ── */

  function persist(): void {
    const key = keyNow();
    if (key !== draftKey && draftKey !== undefined) clearDraft(draftKey);
    draftKey = key;
    if (draftKey === undefined) return;
    input.dataset.draftKey = draftKey;
    const raw = serializeEditor(input);
    // One token per pill, each with where it sits: a restore rebuilds exactly these (2-M4).
    const tokens = raw.tokens.map((tok, i): Token => {
      const { spans: _stale, ...bare } = tok;
      const span = raw.at[i];
      return (span ? { ...bare, spans: [span] } : bare) as Token;
    });
    writeRichDraft(draftKey, tokens.length > 0 ? { text: raw.text, tokens } : { text: raw.text });
  }

  function value(): RawRichText {
    const raw = serializeEditor(input);
    const lead = raw.text.length - raw.text.trimStart().length;
    const text = raw.text.trim().slice(0, cap);
    return tokensFor(text, raw.tokens, app.person, shifted(raw.at, lead));
  }

  /* ── caret-local editing primitives ── */

  /**
   * Chrome leaves a lone <br> behind when the last char is deleted. Two are a
   * line break and its placeholder (`insertLineBreak`): kept.
   */
  function normalizeEmpty(): void {
    if ((input.textContent ?? "") !== "") return;
    if (input.querySelectorAll("br").length > 1) return;
    while (input.firstChild) input.removeChild(input.firstChild);
  }

  function beforeCaretText(): string {
    const sel = selectionIn(input);
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return "";
    const node = sel.focusNode;
    if (node?.nodeType !== 3 || !input.contains(node)) return "";
    return (node as Text).data.slice(0, sel.focusOffset);
  }

  /** Replace `length` chars before the caret with a pill or plain text (+ a space). */
  function replaceTrigger(length: number, replacement: string | HTMLElement): boolean {
    const sel = selectionIn(input);
    if (!sel || sel.rangeCount === 0) return false;
    const node = sel.focusNode;
    const off = sel.focusOffset;
    if (node?.nodeType !== 3 || !input.contains(node)) return false;
    const textNode = node as Text;
    const start = off - length;
    if (start < 0) return false;
    const rest = textNode.data.slice(off);
    textNode.data = textNode.data.slice(0, start);
    const parent = textNode.parentNode ?? input;
    const after = textNode.nextSibling;
    let caretNode: Text;
    if (typeof replacement === "string") {
      caretNode = doc().createTextNode(`${replacement} `);
      parent.insertBefore(caretNode, after);
    } else {
      parent.insertBefore(replacement, after);
      caretNode = doc().createTextNode(" ");
      parent.insertBefore(caretNode, after);
    }
    if (rest) parent.insertBefore(doc().createTextNode(rest), after);
    const range = doc().createRange();
    range.setStart(caretNode, caretNode.data.length);
    range.collapse(true);
    try {
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {
      // selection restore is best-effort — the content edit already landed
    }
    input.focus();
    return true;
  }

  /**
   * A line break at the caret, as a <br>. Chrome draws no line for a break
   * that ends the editor and moves the caret back before it, so the next
   * character would land above the break and the one after would eat it
   * (every other Shift+Enter lost). A break with nothing after it therefore
   * gets a placeholder <br> after it, which serialization leaves out, and the
   * caret goes between the two.
   */
  function insertLineBreak(): void {
    const sel = selectionIn(input);
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    const br = doc().createElement("br");
    if (range && input.contains(range.startContainer)) {
      range.deleteContents();
      range.insertNode(br);
    } else {
      input.appendChild(br);
    }
    const rest = doc().createRange();
    rest.setStartAfter(br);
    rest.setEnd(input, input.childNodes.length);
    const fragment = rest.cloneContents();
    const nothingAfter =
      (fragment.textContent ?? "") === "" && fragment.querySelector("br, [data-token]") === null;
    if (nothingAfter) input.appendChild(doc().createElement("br"));
    const caret = doc().createRange();
    caret.setStartAfter(br);
    caret.collapse(true);
    try {
      sel?.removeAllRanges();
      sel?.addRange(caret);
    } catch {
      // best-effort caret placement
    }
    handleInput();
  }

  function insertPlainText(s: string): void {
    const sel = selectionIn(input);
    const tn = doc().createTextNode(s);
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    if (range && input.contains(range.startContainer)) {
      range.deleteContents();
      range.insertNode(tn);
      range.setStartAfter(tn);
      range.collapse(true);
      try {
        sel?.removeAllRanges();
        sel?.addRange(range);
      } catch {
        // best-effort caret placement
      }
    } else {
      input.appendChild(tn);
    }
    handleInput();
  }

  /* ── the trigger menu ── */

  function menuOpen(): boolean {
    return menu.style.display === "block";
  }

  // The menu escapes its card via fixed positioning (placeMenu), so a scroll
  // anywhere would leave it stranded mid-air — close it instead. Capture
  // phase catches non-bubbling element scrolls; scrolling the menu itself
  // (it has its own overflow) stays allowed.
  const onAnyScroll = (e: Event): void => {
    if (e.target instanceof Node && menu.contains(e.target)) return;
    hideMenu();
  };

  // A space's people can arrive after `@name` was typed (a space joined or
  // switched to a moment ago). While an `@` trigger with no match is live,
  // look again for a few seconds and open the menu when they land.
  let peopleWatch: ReturnType<typeof setInterval> | null = null;
  function stopPeopleWatch(): void {
    if (peopleWatch !== null) clearInterval(peopleWatch);
    peopleWatch = null;
  }
  function watchForPeople(): void {
    stopPeopleWatch();
    const seen = mentionable().length;
    let tries = 0;
    peopleWatch = setInterval(() => {
      tries += 1;
      if (tries > 20 || !input.isConnected) return stopPeopleWatch();
      if (mentionable().length !== seen) {
        stopPeopleWatch();
        refreshMenu();
      }
    }, 150);
  }

  // The composer card lays itself out after the keystroke that grew it
  // (it rises at the bottom edge), so the menu, placed at that keystroke,
  // would sit off by the growth. While it is open it follows the field: each
  // animation frame, a field that moved re-places it.
  let followFrame = 0;
  let followed = "";
  const fieldBox = (): string => {
    const r = wrap.getBoundingClientRect();
    return `${r.left},${r.top},${r.width},${r.height}`;
  };
  function followField(): void {
    if (typeof requestAnimationFrame === "undefined" || followFrame !== 0) return;
    followed = fieldBox();
    const tick = (): void => {
      followFrame = 0;
      if (!menuOpen() || !wrap.isConnected) return;
      const now = fieldBox();
      if (now !== followed) {
        followed = now;
        placeMenu();
      }
      followFrame = requestAnimationFrame(tick);
    };
    followFrame = requestAnimationFrame(tick);
  }
  function stopFollowing(): void {
    if (followFrame !== 0 && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(followFrame);
    }
    followFrame = 0;
  }

  function hideMenu(): void {
    stopFollowing();
    menu.style.display = "none";
    menuRows = [];
    active = 0;
    openMenuHiders.delete(hideMenu);
    if (typeof window !== "undefined") {
      window.removeEventListener("scroll", onAnyScroll, { capture: true });
      window.removeEventListener("resize", onAnyScroll);
    }
  }

  function paintActive(): void {
    menuRows.forEach((row, i) => {
      row.node.classList.toggle("on", i === active);
    });
  }

  function moveActive(delta: number): void {
    if (menuRows.length === 0) return;
    active = (active + delta + menuRows.length) % menuRows.length;
    paintActive();
  }

  /** The nearest transformed ancestor's rect, if any. A transform makes that
   *  ancestor the FIXED containing block — and (F19) when it also clips
   *  (`overflow: hidden`, the interaction modal), the menu is subject to its
   *  clip too, so every placement decision must stay inside ITS box, not the
   *  viewport's. Null when the containing block is the viewport (identity). */
  function fixedContainingBlockRect(): DOMRect | null {
    let n: HTMLElement | null = wrap.parentElement;
    while (n) {
      try {
        const cs = getComputedStyle(n);
        if (
          cs.transform !== "none" ||
          (cs.translate && cs.translate !== "none") ||
          cs.filter !== "none" ||
          cs.willChange === "transform"
        ) {
          return n.getBoundingClientRect();
        }
      } catch {
        return null;
      }
      n = n.parentElement;
    }
    return null;
  }

  function placeMenu(): void {
    const wrapRect = wrap.getBoundingClientRect();
    // Caret-derived horizontal offset within the field (falls back to its edge).
    let caretLeft = 0;
    const sel = selectionIn(input);
    if (sel && sel.rangeCount > 0 && wrapRect.width > 0) {
      try {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        if (r && (r.left !== 0 || r.top !== 0)) {
          caretLeft = Math.min(
            Math.max(0, r.left - wrapRect.left),
            Math.max(0, wrapRect.width - scaled(200)),
          );
        }
      } catch {
        // environments without range rects fall back to the field edge
      }
    }
    // Everywhere else: escape the card's overflow clip entirely (F-049 — a
    // menu taller than a short launcher card slid under the title bar).
    // Fixed viewport coords, side chosen by real room, height capped to fit.
    const viewH = typeof window === "undefined" ? 600 : window.innerHeight;
    const viewW = typeof window === "undefined" ? 800 : window.innerWidth;
    // Inside a transformed clipper (the modal) the usable box is ITS rect ∩ the
    // viewport (F19): deciding by viewport room placed the menu below a
    // bottom-seated composer — outside the modal's edge, swallowed by its
    // `overflow: hidden`. Identity on every untransformed surface.
    const cb = fixedContainingBlockRect();
    const boundTop = cb ? Math.max(0, cb.top) : 0;
    const boundBottom = cb ? Math.min(viewH, cb.bottom) : viewH;
    const boundLeft = cb ? Math.max(0, cb.left) : 0;
    const boundRight = cb ? Math.min(viewW, cb.right) : viewW;
    const roomAbove = wrapRect.top - boundTop;
    const roomBelow = boundBottom - wrapRect.bottom;
    const below = roomBelow >= 240 || roomBelow >= roomAbove;
    menu.style.position = "fixed";
    // 96/220 mirror the sheet's .mention-menu heights, 300 its max-width —
    // scaled so the clamps track the overlay zoom.
    menu.style.maxHeight = `${Math.max(scaled(96), Math.min(scaled(220), (below ? roomBelow : roomAbove) - 10))}px`;
    // A transformed ancestor (the centered modal wears translateX) re-bases
    // fixed positioning onto itself, shoving viewport coords far off target.
    // Park the menu at its containing block's origin, measure where that
    // LANDS in the viewport, and offset by the difference — correct under
    // any ancestor, identity when the containing block IS the viewport.
    menu.style.left = "0px";
    menu.style.top = "0px";
    menu.style.bottom = "auto";
    const origin = menu.getBoundingClientRect();
    const targetLeft = Math.min(
      Math.max(boundLeft + 8, wrapRect.left + caretLeft),
      Math.max(boundLeft + 8, boundRight - scaled(300) - 8),
    );
    const targetTop = below
      ? wrapRect.bottom + 2
      : Math.max(boundTop + 8, wrapRect.top - 2 - origin.height);
    menu.style.left = `${targetLeft - origin.left}px`;
    menu.style.top = `${targetTop - origin.top}px`;
  }

  function actorRows(trig: Trigger): MenuRow[] {
    const q = trig.query;
    const rows: MenuRow[] = [];
    if ("agent".startsWith(q)) {
      const node = el("div", "pick-item");
      node.append(el("span", undefined, AGENT_WIRE), el("span", "hint", "Hand this to an agent"));
      rows.push({
        node,
        accept: () => {
          if (replaceTrigger(trig.length, agentPill())) handleInput();
          else hideMenu();
        },
      });
    }
    // By any word of the name, or the alias a member is given (the email's local part).
    for (const p of searchPeople(q, mentionable(), 7 - rows.length)) {
      const node = el("div", "pick-item");
      node.append(avatar(p, "sm"), el("span", undefined, p.name));
      // The alias beside the name, unless it is the name.
      if (p.alias && foldForSearch(p.alias) !== foldForSearch(p.name)) {
        node.append(el("span", "hint", p.alias));
      }
      rows.push({
        node,
        accept: () => {
          if (replaceTrigger(trig.length, personPill(p))) handleInput();
          else hideMenu();
        },
      });
    }
    return rows;
  }

  function anchorRows(trig: Trigger): MenuRow[] {
    const q = trig.query;
    const rows: MenuRow[] = [];
    for (const s of app.interactions()) {
      if (!isLiveState(s.state)) continue;
      if (rows.length >= 6) break;
      const label = anchorLabel(s.anchor);
      const spec = KINDS[s.kind];
      if (q && !label.toLowerCase().includes(q) && !spec.label.toLowerCase().includes(q)) continue;
      const node = el("div", `pick-item ${spec.cls}`);
      node.append(
        icon(spec.glyph, "icon-sm"),
        el("span", "mono", label),
        el("span", "hint", spec.label),
      );
      const token: AnchorToken = {
        t: "anchor",
        anchor: s.anchor,
        label: label.slice(0, LIMITS.MAX_ANCHOR_LABEL),
        interactionId: s.id,
      };
      rows.push({
        node,
        accept: () => {
          if (replaceTrigger(trig.length, anchorPillEl(token))) handleInput();
          else hideMenu();
        },
      });
    }
    if (elementPickHandler) {
      const node = el("div", "pick-item");
      node.append(
        icon(POINTER_GLYPH, "icon-sm pick-pointer"),
        el("span", undefined, "pick on page…"),
        el("span", "hint", "block picker"),
      );
      rows.push({ node, accept: () => startElementPick(trig) });
    }
    return rows;
  }

  function emojiRows(trig: Trigger): MenuRow[] {
    return searchEmojis(trig.query, 7).map((m) => {
      const node = el("div", "pick-item");
      node.append(el("span", "emoji-glyph", m.glyph), el("span", "mono", `:${m.name}:`));
      return {
        node,
        accept: () => {
          if (replaceTrigger(trig.length, m.glyph)) handleInput();
          else hideMenu();
        },
      };
    });
  }

  function refreshMenu(): void {
    stopPeopleWatch();
    const trig = detectTrigger(beforeCaretText());
    if (!trig || (trig.kind === "anchor" && noAnchors)) {
      hideMenu();
      return;
    }
    const rows =
      trig.kind === "actor"
        ? actorRows(trig)
        : trig.kind === "anchor"
          ? anchorRows(trig)
          : emojiRows(trig);
    if (rows.length === 0) {
      hideMenu();
      if (trig.kind === "actor") watchForPeople();
      return;
    }
    while (menu.firstChild) menu.removeChild(menu.firstChild);
    const head =
      trig.kind === "actor"
        ? "@ actors"
        : trig.kind === "anchor"
          ? "# anchors — this page"
          : ": emoji — plain text, never a token";
    menu.appendChild(el("div", "micro menu-head", head));
    rows.forEach((row, i) => {
      row.node.addEventListener("mousedown", (e) => {
        e.preventDefault();
        if (!isTrustedEvent(e)) return;
        row.accept();
      });
      row.node.addEventListener("mouseenter", () => {
        active = i;
        paintActive();
      });
      menu.appendChild(row.node);
    });
    menuRows = rows;
    active = 0;
    paintActive();
    menu.style.display = "block";
    openMenuHiders.add(hideMenu);
    placeMenu();
    followField();
    if (typeof window !== "undefined") {
      window.addEventListener("scroll", onAnyScroll, { capture: true, passive: true });
      window.addEventListener("resize", onAnyScroll, { passive: true });
    }
  }

  function handleInput(): void {
    normalizeEmpty();
    persist();
    refreshMenu();
  }

  /* ── the element picker (`#` → "pick on page…") ── */

  function startElementPick(trig: Trigger): void {
    hideMenu();
    const handler = elementPickHandler;
    if (!handler) return;
    const sel = selectionIn(input);
    const saved = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
    input.blur();
    handler({
      onPick: (anchor, label) => {
        const token: AnchorToken = {
          t: "anchor",
          anchor,
          label: (label || "block").slice(0, LIMITS.MAX_ANCHOR_LABEL),
        };
        if (input.isConnected) {
          input.focus();
          let inserted = false;
          if (saved?.startContainer.isConnected && input.contains(saved.startContainer)) {
            const s2 = selectionIn(input);
            if (s2) {
              try {
                s2.removeAllRanges();
                s2.addRange(saved);
                inserted = replaceTrigger(trig.length, anchorPillEl(token));
              } catch {
                inserted = false;
              }
            }
          }
          if (!inserted) {
            input.appendChild(anchorPillEl(token));
            input.appendChild(doc().createTextNode(" "));
            focusEnd(input);
          }
          handleInput();
        } else if (draftKey !== undefined) {
          // the composer was rebuilt mid-pick — land the token in the draft
          // so the next rebuild carries it (pill + wire text)
          const prior = readRichDraft(draftKey) ?? { text: "" };
          const sep = prior.text === "" || prior.text.endsWith(" ") ? "" : " ";
          const span = { start: prior.text.length + sep.length, length: token.label.length + 1 };
          writeRichDraft(draftKey, {
            text: `${prior.text}${sep}#${token.label} `,
            tokens: [...(prior.tokens ?? []), { ...token, spans: [span] }],
          });
        }
      },
      onCancel: () => {
        if (input.isConnected) input.focus();
      },
    });
  }

  /* ── events ── */

  // Keyboard isolation (F-056): keys typed in an overlay editor must never
  // reach the page. Shadow events retarget to the host element, so a page's
  // global shortcuts (YouTube: space = play/pause + preventDefault) see a
  // non-input target and eat the keystroke. Our own window listeners run in
  // CAPTURE phase (before target), so chords/Escape-ladder are unaffected;
  // cutting the BUBBLE path only silences the page.
  for (const type of ["keypress", "keyup"] as const) {
    onRouted(input, type, (e) => e.stopPropagation());
  }

  onRouted<KeyboardEvent>(input, "keydown", (e) => {
    e.stopPropagation();
    if (menuOpen()) {
      if (e.key === "Escape") {
        // the menu eats Escape — panels above must not close
        e.stopPropagation();
        hideMenu();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveActive(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        moveActive(-1);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        menuRows[Math.min(active, menuRows.length - 1)]?.accept();
        return;
      }
    }
    if (e.key === "Backspace") {
      const pill = pillBeforeCaret(input);
      if (pill) {
        e.preventDefault();
        const parent = pill.parentNode;
        const idx = parent ? Array.prototype.indexOf.call(parent.childNodes, pill) : -1;
        pill.remove();
        if (parent && idx >= 0) {
          try {
            const sel = selectionIn(input);
            const range = doc().createRange();
            range.setStart(parent, idx);
            range.collapse(true);
            sel?.removeAllRanges();
            sel?.addRange(range);
          } catch {
            // caret restore is cosmetic
          }
        }
        handleInput();
      }
      return;
    }
    if (e.key === "Enter") {
      if (e.isComposing) return;
      if (multiline && e.shiftKey) {
        e.preventDefault();
        insertLineBreak();
        return;
      }
      if (opts.onSend && !e.shiftKey) {
        if (!e.isTrusted) return; // synthetic Enter must never send
        e.preventDefault();
        e.stopPropagation();
        opts.onSend();
        return;
      }
      e.preventDefault(); // contenteditable's default <div> soup never lands
      if (multiline) insertLineBreak();
    }
  });

  onRouted(input, "input", () => handleInput());
  input.addEventListener("mouseup", () => refreshMenu());
  input.addEventListener("blur", () => setTimeout(hideMenu, 120));
  onRouted<ClipboardEvent>(input, "paste", (e) => {
    // plain text only — formatting never enters through the side door
    e.preventDefault();
    let s = e.clipboardData?.getData("text/plain") ?? "";
    if (!multiline) s = s.replace(/\s*\n+\s*/g, " ");
    if (s) insertPlainText(s);
  });

  return {
    wrap,
    input,
    value,
    setText: (text) => {
      setValue({ text });
      persist();
    },
    clear: () => {
      while (input.firstChild) input.removeChild(input.firstChild);
      hideMenu();
      if (draftKey !== undefined) clearDraft(draftKey);
    },
    focus: () => {
      setTimeout(() => focusEnd(input), 0);
    },
    saveDraft: persist,
  };
}
