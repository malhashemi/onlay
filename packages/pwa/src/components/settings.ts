// The settings building blocks every settings screen shares, all on the
// existing grammar: `settings-section` cards with mono micro-label heads,
// `attention-row` navigation rows, `field` inputs, `btn` actions, and a
// copyable code block for the Agent screen. No new visual language.
import { button, el } from "../dom";
import { webCodeBlock } from "./code-block";

export function section(title: string, variant?: "danger"): HTMLElement {
  const sec = el("section", variant ? `settings-section ${variant}` : "settings-section");
  sec.append(el("h2", "section-head", title));
  return sec;
}

export function note(text: string): HTMLElement {
  return el("p", "settings-note", text);
}

/** A row that opens a sub-screen — the Inbox row grammar. */
export function navRow(title: string, meta: string, onClick: () => void): HTMLButtonElement {
  const row = button("attention-row settings-nav", "", onClick);
  row.textContent = "";
  const main = el("div", "row-main");
  main.append(el("p", "row-title", title));
  if (meta) main.append(el("p", "row-meta", meta));
  row.append(main, el("span", "row-chevron", "›"));
  return row;
}

/** A static row: a lead node (an avatar, say), a title, a meta line, actions. */
export function itemRow(
  title: string,
  meta: string,
  actions: HTMLElement[] = [],
  lead?: HTMLElement,
): HTMLElement {
  const row = el("div", "settings-row");
  if (lead) row.append(lead);
  const main = el("div", "settings-row-main");
  main.append(el("span", "settings-row-title", title));
  if (meta) main.append(el("span", "settings-row-meta", meta));
  row.append(main);
  if (actions.length) {
    const acts = el("div", "settings-row-actions");
    acts.append(...actions);
    row.append(acts);
  }
  return row;
}

/** A labelled input with its own hint line below. */
export function labelledField(
  label: string,
  opts: { type?: string; value?: string; placeholder?: string } = {},
): { wrap: HTMLElement; input: HTMLInputElement; hint: HTMLElement } {
  const wrap = el("label", "settings-field");
  wrap.append(el("span", "field-label", label));
  const input = el("input", "field") as HTMLInputElement;
  input.type = opts.type ?? "text";
  input.value = opts.value ?? "";
  input.autocomplete = "off";
  input.spellcheck = false;
  if (opts.placeholder) input.placeholder = opts.placeholder;
  const hint = el("span", "settings-hint");
  hint.setAttribute("aria-live", "polite");
  wrap.append(input, hint);
  return { wrap, input, hint };
}

/** Two taps to confirm a destructive action, no modal: the first tap asks. */
export function confirmButton(
  cls: string,
  label: string,
  confirmLabel: string,
  onConfirm: () => void,
): HTMLButtonElement {
  let armed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const b = button(cls, label, () => {
    if (!armed) {
      armed = true;
      b.textContent = confirmLabel;
      timer = setTimeout(() => {
        armed = false;
        b.textContent = label;
      }, 3000);
      return;
    }
    if (timer) clearTimeout(timer);
    armed = false;
    b.textContent = label;
    onConfirm();
  });
  return b;
}

/** A read-only code block with a Copy button, colored as `lang` if given. */
export function copyBlock(text: string, ariaLabel: string, lang?: "json" | "bash"): HTMLElement {
  return webCodeBlock(text, { lang: lang ?? null, label: lang ?? null, copyLabel: ariaLabel });
}
