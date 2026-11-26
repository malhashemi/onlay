// The overlay's text editor, for the demo: a plain textarea dressed as the
// product's editor. Enter sends and Shift+Enter breaks the line, as there;
// typing `@` opens the mention menu, which here offers the one actor the demo
// has: `@agent`. As in the product, `@agent` wears its pill while it is being
// typed: a layer behind the text draws the pill's shape under the word.
import { clear, el, microLabel } from "./dom";
import { MENTION } from "./strings";

export interface Editor {
  wrap: HTMLElement;
  input: HTMLTextAreaElement;
  value(): string;
  set(text: string): void;
  clear(): void;
  focus(): void;
}

export interface EditorOpts {
  placeholder: string;
  label: string;
  onSend?(): void;
  /** Called with the text on every change (drafts). */
  onInput?(text: string): void;
  /** Offer `@agent` in the mention menu (off where there is no one to hand to). */
  mentions?: boolean;
}

/** The `@word` being typed just before the caret, if any. */
export function mentionTrigger(before: string): { query: string; length: number } | null {
  const m = /(^|\s)@([a-z]*)$/i.exec(before);
  if (!m) return null;
  const query = (m[2] ?? "").toLowerCase();
  return { query, length: query.length + 1 };
}

/** Where each `@agent` that hands work over sits: a word of its own (the product's rule). */
export function agentSpans(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (const m of text.matchAll(/(^|\s)(@agent)\b/gi)) {
    const start = (m.index ?? 0) + (m[1]?.length ?? 0);
    out.push({ start, end: start + (m[2]?.length ?? 0) });
  }
  return out;
}

export function createEditor(opts: EditorOpts): Editor {
  const wrap = el("div", "editor-wrap");
  const input = el("textarea", "token-editor");
  input.rows = 2;
  input.placeholder = opts.placeholder;
  input.setAttribute("aria-label", opts.label);
  const box = el("div", "editor-box");
  const mirror = el("div", "editor-mirror");
  mirror.setAttribute("aria-hidden", "true");
  box.append(mirror, input);
  const menu = el("div", "mention-menu");
  menu.hidden = true;
  wrap.append(box, menu);

  /** Draw a pill's shape behind each `@agent` (where one is a hand-off). */
  const paintPills = (): void => {
    clear(mirror);
    const text = input.value;
    if (opts.mentions === false || !text.includes(MENTION.agent)) return;
    let at = 0;
    for (const span of agentSpans(text)) {
      if (span.start > at) mirror.append(text.slice(at, span.start));
      mirror.append(el("span", "mirror-pill", text.slice(span.start, span.end)));
      at = span.end;
    }
    // A last, empty line still takes a line's height.
    mirror.append(`${text.slice(at)}\u200b`);
    mirror.scrollTop = input.scrollTop;
  };

  let menuOn = false;
  const hideMenu = (): void => {
    menuOn = false;
    menu.hidden = true;
  };
  const accept = (): void => {
    const at = input.selectionStart ?? input.value.length;
    const trig = mentionTrigger(input.value.slice(0, at));
    if (!trig) {
      hideMenu();
      return;
    }
    const start = at - trig.length;
    input.value = `${input.value.slice(0, start)}${MENTION.agent} ${input.value.slice(at)}`;
    const caret = start + MENTION.agent.length + 1;
    input.setSelectionRange(caret, caret);
    hideMenu();
    opts.onInput?.(input.value);
    paintPills();
  };
  const refreshMenu = (): void => {
    if (opts.mentions === false) return;
    const at = input.selectionStart ?? input.value.length;
    const trig = mentionTrigger(input.value.slice(0, at));
    if (!trig || !"agent".startsWith(trig.query) || trig.query === "agent") {
      hideMenu();
      return;
    }
    clear(menu);
    const head = microLabel(MENTION.head);
    head.classList.add("menu-head");
    const row = el("div", "pick-item on");
    row.append(el("span", undefined, MENTION.agent), el("span", "hint", MENTION.agentTitle));
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      accept();
    });
    menu.append(head, row);
    menu.hidden = false;
    menuOn = true;
  };

  input.addEventListener("input", () => {
    opts.onInput?.(input.value);
    paintPills();
    refreshMenu();
  });
  input.addEventListener("scroll", () => {
    mirror.scrollTop = input.scrollTop;
  });
  input.addEventListener("blur", hideMenu);
  input.addEventListener("keydown", (e) => {
    // Esc and the bar's accelerator are the layer's; nothing else typed here leaves.
    const forLayer = e.key === "Escape" || (e.ctrlKey && e.key === ".");
    if (!forLayer || menuOn) e.stopPropagation();
    if (menuOn && (e.key === "Enter" || e.key === "Tab")) {
      e.preventDefault();
      accept();
      return;
    }
    if (menuOn && e.key === "Escape") {
      e.preventDefault();
      hideMenu();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      opts.onSend?.();
    }
  });

  return {
    wrap,
    input,
    value: () => input.value.trim(),
    set: (text) => {
      input.value = text;
      paintPills();
    },
    clear: () => {
      input.value = "";
      opts.onInput?.("");
      paintPills();
    },
    focus: () => {
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
    },
  };
}
