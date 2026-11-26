// The composer window: picking a block for a command opens that interaction's
// own window beside the block. Built after the extension's (overlay/
// composer-window.ts, composers.ts): kind glyph, kind title, the block's
// chip, then the composer itself. Comment: text and send. Edit: action,
// delivery (Direct, or Variants with a count), the intent, and send.
//
// Placement and moving follow the product's (`@onlay/render/floating-card`):
// the card stays inside the viewport, its text area grows with the text up to
// a cap taken from the viewport and then scrolls, the card grows upward when
// it reaches the bottom edge, and its header (or the grip's arrow keys) moves
// it.
import { attachMover, layoutCard, type Point } from "@onlay/render/floating-card";
import { clear, el, GLYPHS, icon } from "./dom";
import { createEditor, type Editor } from "./editor";
import type { Kind } from "./model";
import { COMPOSER, KIND_LABEL } from "./strings";

export interface EditRequest {
  intent: string;
  method: "direct" | "variant-set";
  count: number;
}

export interface ComposerDeps {
  onComment(text: string): void;
  onEdit(req: EditRequest): void;
  /** Every close: sent, Cancel, Close, Esc. */
  onClosed(): void;
  /** The overlay's px for a 1× size (the sheet is zoomed). */
  scaled(n: number): number;
}

export interface ComposerWindow {
  element: HTMLElement;
  /** Open for a block (`chip` is its label), near `at`; without `at`, centered for the page. */
  open(kind: Kind, chip: string, at?: { x: number; y: number }): void;
  close(): void;
  isOpen(): boolean;
  /** Forget every draft (Start over). */
  clearDrafts(): void;
}

function segment<T extends string>(
  options: ReadonlyArray<{ id: T; label: string }>,
  initial: T,
  onChange: (v: T) => void,
): HTMLElement {
  const wrap = el("div", "seg");
  wrap.setAttribute("role", "group");
  const buttons = new Map<T, HTMLButtonElement>();
  let current = initial;
  const paint = (): void => {
    for (const [id, b] of buttons) {
      b.className = current === id ? "on" : "";
      b.setAttribute("aria-pressed", String(current === id));
    }
  };
  for (const o of options) {
    const b = el("button", undefined, o.label);
    b.type = "button";
    b.addEventListener("click", () => {
      current = o.id;
      paint();
      onChange(o.id);
    });
    buttons.set(o.id, b);
    wrap.appendChild(b);
  }
  paint();
  return wrap;
}

function labeled(label: string, control: HTMLElement): HTMLElement {
  const f = el("div", "field");
  f.append(el("span", "micro", label), control);
  return f;
}

export function createComposerWindow(deps: ComposerDeps): ComposerWindow {
  const card = el("div", "card composer-window");
  card.setAttribute("role", "dialog");
  card.hidden = true;
  const head = el("div", "card-head");
  const glyph = el("span", "composer-glyph");
  const title = el("span", "title");
  const chip = el("span", "anchor-chip");
  const close = el("button", "btn ghost sm", COMPOSER.close);
  close.type = "button";
  close.title = "Esc";
  const grip = el("button", "card-grip");
  grip.type = "button";
  grip.setAttribute("aria-label", COMPOSER.move);
  grip.title = COMPOSER.moveTitle;
  grip.appendChild(icon(GLYPHS.grip));
  head.append(grip, glyph, title, chip, close);
  const body = el("div", "card-body");
  card.append(head, body);
  // A draft survives Close and Esc; Cancel discards it (as in the product).
  const drafts = new Map<string, string>();
  /** Where the card would like its top-left; the open editor. */
  let want: Point = { x: 0, y: 0 };
  let editor: Editor | null = null;

  function setOpen(on: boolean): void {
    const was = !card.hidden;
    card.hidden = !on;
    if (!on) {
      editor = null;
      clear(body);
      if (was) deps.onClosed();
    }
  }
  close.addEventListener("click", () => setOpen(false));

  /** The product's layout: on screen, the text area capped, growing upward at the bottom edge. */
  function layout(): void {
    if (card.hidden) return;
    const box = editor?.input ?? null;
    if (box) box.style.height = "auto";
    const borders = card.offsetHeight - card.clientHeight;
    const boxH = box ? box.offsetHeight : 0;
    const chrome = head.offsetHeight + body.scrollHeight - boxH + borders;
    const l = layoutCard({
      view: { w: window.innerWidth, h: window.innerHeight },
      margin: 8,
      want,
      width: deps.scaled(320),
      chrome,
      ...(box
        ? {
            editor: {
              content: box.scrollHeight + (box.offsetHeight - box.clientHeight),
              min: deps.scaled(54),
              cap: deps.scaled(320),
            },
          }
        : {}),
    });
    card.style.width = `${l.width}px`;
    // As in the product: never taller than the viewport less its margins. Past
    // that the Edit's body scrolls (the Comment's editor is capped already, and
    // its mention menu hangs outside the card), so the Edit's buttons stay
    // within reach on a short window too.
    card.style.maxHeight = card.classList.contains("is-edit") ? `${l.maxHeight}px` : "";
    card.style.left = `${l.left}px`;
    card.style.top = `${l.top}px`;
    if (box) {
      box.style.maxHeight = `${l.editorMax}px`;
      // A textarea keeps its rows: it grows to its text here, up to the cap.
      box.style.height = `${Math.min(l.editorMax, box.scrollHeight + (box.offsetHeight - box.clientHeight))}px`;
    }
  }
  window.addEventListener("resize", () => layout());
  // A status line or the Variants count appearing changes the card's height too.
  let queued = 0;
  const grown =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          if (queued) return;
          queued = requestAnimationFrame(() => {
            queued = 0;
            layout();
          });
        });
  grown?.observe(body);
  attachMover({
    handle: head,
    grip,
    position: () => {
      const r = card.getBoundingClientRect();
      return { x: r.left, y: r.top };
    },
    moveTo: (p) => {
      want = p;
      layout();
      const r = card.getBoundingClientRect();
      want = { x: r.left, y: r.top };
    },
    step: () => deps.scaled(16),
  });

  function commentBody(key: string): Editor {
    const wrap = el("div", "composer");
    const submit = (): void => {
      const text = input.value();
      if (!text) return;
      drafts.delete(key);
      deps.onComment(text);
      setOpen(false);
    };
    const input = createEditor({
      placeholder: COMPOSER.commentPlaceholder,
      label: COMPOSER.commentPlaceholder,
      onSend: submit,
      onInput: (t) => (t ? drafts.set(key, t) : drafts.delete(key)),
    });
    input.set(drafts.get(key) ?? "");
    const row = el("div", "row");
    const send = el("button", "btn primary", COMPOSER.commentSend);
    send.type = "button";
    send.addEventListener("click", submit);
    const cancel = el("button", "btn ghost", COMPOSER.cancel);
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      drafts.delete(key);
      setOpen(false);
    });
    row.append(send, cancel);
    wrap.append(input.wrap, row);
    body.appendChild(wrap);
    return input;
  }

  function editBody(key: string, pageScope: boolean): Editor {
    const wrap = el("div", "composer k-change");
    let action: "change" | "insert-after" = "change";
    let method: "direct" | "variant-set" = "direct";
    let count = 3;
    const status = el("div", "dim");
    const submit = (): void => {
      const text = intent.value();
      if (!text) {
        status.textContent = COMPOSER.describeFirst;
        return;
      }
      drafts.delete(key);
      deps.onEdit({
        intent: action === "insert-after" ? `${COMPOSER.insertPrefix}${text}` : text,
        method,
        count,
      });
      setOpen(false);
    };
    const intent = createEditor({
      placeholder: COMPOSER.editPlaceholder,
      label: COMPOSER.editPlaceholder,
      onSend: submit,
      mentions: false,
      onInput: (t) => (t ? drafts.set(key, t) : drafts.delete(key)),
    });
    intent.set(drafts.get(key) ?? "");
    const send = el("button", "btn primary k-change", COMPOSER.requestEdit);
    send.type = "button";
    send.addEventListener("click", submit);
    const cancel = el("button", "btn ghost", COMPOSER.cancel);
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      drafts.delete(key);
      setOpen(false);
    });
    const countSeg = el("div", "seg");
    const countField = labeled(COMPOSER.count, countSeg);
    countField.hidden = true;
    for (const n of [1, 3, 5]) {
      const b = el("button", n === count ? "on" : undefined, `×${n}`);
      b.type = "button";
      b.addEventListener("click", () => {
        count = n;
        for (const c of countSeg.children) c.className = "";
        b.className = "on";
      });
      countSeg.appendChild(b);
    }
    const repaint = (): void => {
      intent.input.placeholder =
        action === "insert-after" ? COMPOSER.insertPlaceholder : COMPOSER.editPlaceholder;
      send.textContent =
        method === "variant-set"
          ? COMPOSER.generate
          : action === "insert-after"
            ? COMPOSER.requestInsert
            : COMPOSER.requestEdit;
      countField.hidden = method !== "variant-set";
    };
    if (!pageScope)
      wrap.appendChild(
        labeled(
          COMPOSER.action,
          segment(
            [
              { id: "change", label: COMPOSER.actionEdit },
              { id: "insert-after", label: COMPOSER.actionInsert },
            ],
            "change",
            (v) => {
              action = v;
              repaint();
            },
          ),
        ),
      );
    wrap.appendChild(
      labeled(
        COMPOSER.delivery,
        segment(
          [
            { id: "direct", label: COMPOSER.direct },
            { id: "variant-set", label: COMPOSER.variants },
          ],
          "direct",
          (v) => {
            method = v;
            repaint();
          },
        ),
      ),
    );
    const row = el("div", "row");
    row.append(send, cancel);
    wrap.append(intent.wrap, countField, status, row);
    body.appendChild(wrap);
    return intent;
  }

  return {
    element: card,
    open(kind, chipText, at) {
      clear(glyph);
      glyph.className = `composer-glyph ${kind === "comment" ? "k-comment" : "k-change"}`;
      glyph.appendChild(icon(GLYPHS[kind]));
      title.textContent = KIND_LABEL[kind];
      card.setAttribute("aria-label", KIND_LABEL[kind]);
      // The Edit's body scrolls inside the card's capped height (overlay.css).
      card.classList.toggle("is-edit", kind === "change");
      chip.textContent = chipText;
      clear(body);
      card.hidden = false;
      const key = `${kind}:${at ? chipText : "page"}`;
      const input = kind === "comment" ? commentBody(key) : editBody(key, at === undefined);
      editor = input;
      input.input.addEventListener("input", () => layout());
      const w = deps.scaled(320);
      want = at
        ? { x: at.x, y: at.y }
        : { x: Math.round(window.innerWidth / 2 - w / 2), y: Math.round(window.innerHeight * 0.2) };
      layout();
      input.focus();
    },
    close: () => setOpen(false),
    isOpen: () => !card.hidden,
    clearDrafts: () => drafts.clear(),
  };
}
