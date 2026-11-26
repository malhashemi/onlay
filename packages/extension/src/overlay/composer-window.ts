// The composer window (ADR-0019 §2): executing a creation command graduates
// into that interaction's OWN properly-labeled window — kind glyph + kind
// title + the anchor context chip — instead of a generic "Add interaction"
// card. The body IS the existing composer builder, unchanged; this module
// only owns the frame: title, close, placement and moving.
//
// Placement (`@onlay/render/floating-card`): the card opens near the picked
// block (centered for page scope) and always stays inside the viewport, 8px
// clear of each edge. Its editor grows with the text up to the least of 320px,
// 40% of the viewport's height and the room the card's controls leave, then
// scrolls inside itself. When growing would cross the bottom edge the card
// grows upward instead. It is laid out again whenever its contents change
// size, the window resizes (browser zoom too) and, while it follows its
// block, the page scrolls, or a frame of the page that holds the block and
// has no address of its own scrolls (`blockMoved`, from content.ts). A block
// in a frame with an address of its own opens it centred, following nothing.
//
// Moving: the header drags it (pointer and touch; never from its buttons),
// and the grip moves it with the arrow keys (Shift for bigger steps). A moved
// card stays where it was put (clamped to the viewport) and stops following
// its block until it closes. The position is not remembered: the next
// composer opens beside its own block.
import type { Anchor } from "@onlay/protocol";
import { attachMover, layoutCard, type Point } from "@onlay/render/floating-card";
import { anchorLabel } from "./anchors";
import type { App, CreateResult } from "./app";
import { type ComposerVia, changeComposer, commentComposer } from "./composers";
import { el, icon, scaled } from "./dom";
import { routeDrag } from "./drag-router";
import { type Glyph, KINDS } from "./kinds";
import { closeAnySpaceMenu, dropDetachedSpaceMenus, placeAnySpaceMenu } from "./space-picker";
import { closeAnyOpenTokenMenu } from "./token-input";
import { isTrustedEvent } from "./trusted";
import { onRouted } from "./typing-router";

export type ComposerKind = "comment" | "change";

export interface ComposerWindowDeps {
  /** Variants hand off to the engine (it creates the owning Edit); null target = the whole page. */
  startVariants(
    target: Element | null,
    command: string,
    count: number,
    intent: "change" | "insert-after",
    spaceId: string,
  ): Promise<CreateResult>;
  /** Fired on EVERY close (sent, Escape, Close) — page cleanup lives here. */
  onClosed?(): void;
  /**
   * Where a picked block is in this document's viewport (a block inside a
   * frame of the page included). Default: its own bounding box.
   */
  blockRect?(target: Element): { left: number; top: number };
}

export interface ComposerWindow {
  element: HTMLElement;
  /**
   * Open the kind's window. With `at`, it sits near the picked block
   * (viewport-clamped) and follows it as the page scrolls; without, it
   * centers (page-scope commands).
   */
  open(
    kind: ComposerKind,
    anchor: Anchor,
    target: Element | null,
    at?: { x: number; y: number },
    /** The block is in a child frame (`target` is null): create through it. */
    via?: ComposerVia,
  ): void;
  close(): void;
  isOpen(): boolean;
  /**
   * The block it follows may have moved without a scroll of this window: a
   * frame of the page that this document took in (no address of its own)
   * scrolled. Laid out again while it still follows.
   */
  blockMoved(): void;
}

/** The composer's words that are not the composer's own (a copy pass reads them here). */
export const COMPOSER_WINDOW_COPY = {
  move: "Move",
  moveTitle: "Drag to move, or use arrow keys.",
} as const;

/** 1×-authored; layout scales by the overlay zoom. */
const WIDTH: Record<ComposerKind, number> = { comment: 320, change: 320 };
/** Kept clear between the card and each viewport edge (1×). */
const MARGIN = 8;
/** The editor's least height and its own cap (1×; the sheet's min-height is 54px). */
const EDITOR_MIN = 54;
const EDITOR_CAP = 320;
/** An arrow key's step when moving by the grip (1×). */
const STEP = 16;

/** Six dots in two rows: the grip. */
const GRIP_GLYPH: Glyph = {
  paths: ["M7 9h.01", "M12 9h.01", "M17 9h.01", "M7 15h.01", "M12 15h.01", "M17 15h.01"],
};

export function createComposerWindow(app: App, deps: ComposerWindowDeps): ComposerWindow {
  const card = el("div", "card composer-window");
  const head = el("div", "card-head");
  const grip = el("button", "card-grip") as HTMLButtonElement;
  grip.type = "button";
  grip.setAttribute("aria-label", COMPOSER_WINDOW_COPY.move);
  grip.title = COMPOSER_WINDOW_COPY.moveTitle;
  grip.appendChild(icon(GRIP_GLYPH));
  const glyphSlot = el("span", "composer-glyph");
  const title = el("span", "title");
  const chip = el("span", "anchor-chip");
  // The frame a picked block is in, by the host the browser reported (2-F3):
  // the block label is the page's own words; this is not.
  const hostChip = el("span", "anchor-chip");
  hostChip.style.display = "none";
  const close = el("button", "btn ghost sm", "Close");
  close.title = "Esc";
  head.append(grip, glyphSlot, title, chip, hostChip, close);
  const body = el("div", "card-body");
  card.append(head, body);
  close.addEventListener("click", () => setOpen(false));
  /** Bumped by every `open`: which composer is the one on screen. */
  let openings = 0;

  /** Where the card would like its top-left: beside its block, or where it was moved to. */
  let want: Point = { x: 0, y: 0 };
  let width1x = WIDTH.comment;
  /** Set once the person moves the card: it stops following its block. */
  let moved = false;
  /** While following: where the block's corner is now, or null when it is gone. */
  let follow: (() => Point | null) | null = null;
  /** The pointer's offset from the block's corner when the composer opened. */
  let offset: Point = { x: 0, y: 0 };

  const isOpen = (): boolean => card.style.display === "flex";

  function setOpen(on: boolean): void {
    const was = isOpen();
    card.style.display = on ? "flex" : "none";
    // The space this composer writes to keeps its socket while it is open.
    app.holdSpace?.("composer", on ? app.currentSpaceId() : null);
    if (on && !was) watch(true);
    if (!on) {
      mover.cancel();
      watch(false);
      follow = null;
      while (body.firstChild) body.removeChild(body.firstChild);
      // Its space menu, if open, went with the body.
      dropDetachedSpaceMenus();
      if (was) deps.onClosed?.();
    }
  }

  /** The composer's editor: the token editor, when the body has one (the Edit's confirmation has none). */
  const editorEl = (): HTMLElement | null =>
    body.querySelector<HTMLElement>(".composer > .field > .token-editor");

  /** Lay the card out from what it holds now (the floating card's rules). */
  function layout(): void {
    if (!isOpen()) return;
    if (follow && !moved) {
      const corner = follow();
      if (corner) want = { x: corner.x + offset.x, y: corner.y + offset.y };
    }
    const editor = editorEl();
    const borders = card.offsetHeight - card.clientHeight;
    const editorBox = editor ? editor.offsetHeight : 0;
    const chrome = head.offsetHeight + body.scrollHeight - editorBox + borders;
    const l = layoutCard({
      view: { w: window.innerWidth, h: window.innerHeight },
      margin: scaled(MARGIN),
      want,
      width: scaled(width1x),
      chrome,
      ...(editor
        ? {
            editor: {
              content: editor.scrollHeight + (editor.offsetHeight - editor.clientHeight),
              min: scaled(EDITOR_MIN),
              cap: scaled(EDITOR_CAP),
            },
          }
        : {}),
    });
    card.style.width = `${l.width}px`;
    card.style.maxHeight = `${l.maxHeight}px`;
    card.style.left = `${l.left}px`;
    card.style.top = `${l.top}px`;
    if (editor) editor.style.maxHeight = `${l.editorMax}px`;
    // The card is where it goes now: an open space menu follows its field.
    placeAnySpaceMenu();
  }

  // Laid out again when anything in it changes size (text, a status line,
  // the Variants count), when the window resizes and, while following its
  // block, when the page scrolls. One frame at most per burst.
  let queued = 0;
  const relayout = (): void => {
    if (queued) return;
    queued = requestAnimationFrame(() => {
      queued = 0;
      layout();
    });
  };
  const onScroll = (): void => {
    if (follow && !moved) relayout();
  };
  const resizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => layout());
  function watch(on: boolean): void {
    if (on) {
      window.addEventListener("resize", relayout);
      window.addEventListener("scroll", onScroll, { capture: true, passive: true });
      resizes?.observe(head);
      resizes?.observe(body);
    } else {
      window.removeEventListener("resize", relayout);
      window.removeEventListener("scroll", onScroll, { capture: true });
      resizes?.disconnect();
      if (queued) cancelAnimationFrame(queued);
      queued = 0;
    }
  }
  function watchContent(): void {
    // The body's own box is capped by the card; its contents are not.
    for (const child of body.children) resizes?.observe(child);
    const editor = editorEl();
    if (editor) resizes?.observe(editor);
  }

  const mover = attachMover({
    handle: head,
    grip,
    position: () => {
      const r = card.getBoundingClientRect();
      return { x: r.left, y: r.top };
    },
    moveTo: (p) => {
      moved = true;
      want = p;
      layout();
      // Kept as placed (clamped), so a later shrink or resize starts from there.
      const r = card.getBoundingClientRect();
      want = { x: r.left, y: r.top };
    },
    onStart: () => {
      // Menus that hang off the card would be left behind.
      closeAnySpaceMenu();
      closeAnyOpenTokenMenu();
    },
    step: () => scaled(STEP),
    trusted: isTrustedEvent,
    listen: (target, type, fn) => onRouted(target, type, fn),
    pointer: routeDrag,
  });

  function open(
    kind: ComposerKind,
    anchor: Anchor,
    target: Element | null,
    at?: { x: number; y: number },
    via?: ComposerVia,
  ): void {
    const spec = KINDS[kind];
    while (glyphSlot.firstChild) glyphSlot.removeChild(glyphSlot.firstChild);
    glyphSlot.className = `composer-glyph ${spec.cls}`;
    glyphSlot.appendChild(icon(spec.glyph));
    title.textContent = spec.label;
    chip.textContent = anchor.level === "page" ? "page" : anchorLabel(anchor);
    hostChip.textContent = via?.host ?? "";
    hostChip.title = via ? `In a frame from ${via.host}` : "";
    hostChip.style.display = via?.host ? "" : "none";
    while (body.firstChild) body.removeChild(body.firstChild);
    // A fresh composer: beside its block (or centered), following it.
    moved = false;
    width1x = WIDTH[kind];
    const w = scaled(width1x);
    want = at
      ? { x: at.x, y: at.y }
      : { x: Math.round(window.innerWidth / 2 - w / 2), y: Math.round(window.innerHeight * 0.2) };
    follow = null;
    if (at && target) {
      const rectOf = (): { left: number; top: number } =>
        deps.blockRect ? deps.blockRect(target) : target.getBoundingClientRect();
      const r0 = rectOf();
      offset = { x: at.x - r0.left, y: at.y - r0.top };
      follow = () => {
        if (!target.isConnected) return null;
        const r = rectOf();
        return { x: r.left, y: r.top };
      };
    }
    setOpen(true);

    // A send that lands later closes only the composer it was sent from, and
    // only while that one is still on screen (2-M2): not a newer one opened
    // in its place, not this window after a remount replaced it.
    const opened = ++openings;
    const done = (): void => {
      if (opened === openings && isOpen()) setOpen(false);
    };
    if (kind === "comment") body.appendChild(commentComposer(app, anchor, done, via));
    else
      body.appendChild(
        changeComposer(
          app,
          anchor,
          done,
          {
            // No picked block: the variants' root is the whole page (spec §8).
            // The composer closes itself once the set lands (M-2).
            startVariants: (command, count, intent, spaceId) =>
              deps.startVariants(target, command, count, intent, spaceId),
          },
          // A page Edit through a frame is for that frame's page (E-3).
          {
            pageScope: target === null && (!via || anchor.level === "page"),
            ...(via ? { via } : {}),
          },
        ),
      );
    // Its height is known only once the body is in: lay it out now, whole
    // card on screen, and again whenever what it holds changes size.
    layout();
    watchContent();
  }

  return {
    element: card,
    open,
    close: () => setOpen(false),
    isOpen,
    blockMoved: onScroll,
  };
}
