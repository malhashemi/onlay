// Shared screen chrome: the brand header (mark + wordmark, the one mark
// everywhere), a back affordance, and the honest empty/error/generic states the
// screens reuse. Flat tinted neutrals + hairline borders — precise
// instrumentation, not a SaaS card stack (design-language §7).

import { mark } from "./components/glyphs";
import { add, button, el } from "./dom";

export interface HeaderOpts {
  /** A back link's target hash (renders a ‹ back chevron when present). */
  back?: string;
  /** Trailing action nodes (e.g. the quiet "Ask" affordance, settings link). */
  actions?: HTMLElement[];
  onNav?: (hash: string) => void;
}

export function header(title: string, opts: HeaderOpts = {}): HTMLElement {
  const bar = el("header", "app-header");
  const left = el("div", "app-header-left");
  if (opts.back !== undefined) {
    const back = button("icon-btn back-btn", "‹", () => opts.onNav?.(opts.back as string));
    back.setAttribute("aria-label", "Back to your Inbox");
    left.append(back);
  } else {
    const brand = el("span", "brand-mark");
    brand.append(mark(22));
    left.append(brand);
  }
  left.append(el("h1", "app-title", title));
  bar.append(left);
  if (opts.actions?.length) {
    const right = el("div", "app-header-actions");
    add(right, ...opts.actions);
    bar.append(right);
  }
  return bar;
}

/** A calm empty state — product-grounded copy, no illustration. */
export function emptyState(text: string, sub?: string): HTMLElement {
  const wrap = el("div", "empty-state");
  wrap.append(el("p", "empty-title", text));
  if (sub) wrap.append(el("p", "empty-sub", sub));
  return wrap;
}

/** An inline error with a next action (support register). */
export function errorState(text: string, retry?: () => void): HTMLElement {
  const wrap = el("div", "error-state");
  wrap.append(el("p", "error-title", text));
  if (retry) wrap.append(button("btn btn-secondary", "Retry", retry));
  return wrap;
}

/** The ONE generic screen a collapsed-404 (not-yours) OR a truly-absent id both
 *  render — byte-identical copy, so the next-action affordance reveals nothing
 *  about existence (§6.3, participant isolation). */
export function notHere(onInbox: () => void): HTMLElement {
  const wrap = el("div", "empty-state");
  wrap.append(el("p", "empty-title", "This isn't here."));
  wrap.append(button("btn btn-secondary", "Back to your Inbox", onInbox));
  return wrap;
}

/** In place of the app once its session ended: the server's own sentence, and one way back in. */
export function signedOutState(onSignIn: () => void): HTMLElement {
  const wrap = el("div", "empty-state signed-out");
  wrap.append(el("p", "empty-title", "You were signed out."));
  wrap.append(el("p", "empty-sub", "Sign in again."));
  wrap.append(button("btn btn-primary", "Sign in", onSignIn));
  return wrap;
}

/** The scroll region a screen fills; the shell owns the header. */
export function screenBody(): HTMLElement {
  return el("main", "screen-body");
}
