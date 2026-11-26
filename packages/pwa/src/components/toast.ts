// Calm confirmations (support register: no jokes, no blame). A single live
// region announces a short line and fades; never a modal, never blocking.
import type { Fail } from "../api";
import { clear, el } from "../dom";

let host: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function ensureHost(): HTMLElement {
  if (host) return host;
  host = el("div", "toast-host");
  host.setAttribute("role", "status");
  host.setAttribute("aria-live", "polite");
  document.body.appendChild(host);
  return host;
}

export function toast(message: string): void {
  const h = ensureHost();
  clear(h);
  const t = el("div", "toast", message);
  h.appendChild(t);
  if (timer) clearTimeout(timer);
  requestAnimationFrame(() => t.classList.add("show"));
  timer = setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => clear(h), 220);
  }, 2600);
}

/** What to say when a write fails: the server's own sentence when it refused
 *  with one, otherwise a calm cause that keeps the person's work in place. */
export function failureToast(res: Fail): string {
  if (res.verdict === "refused" && res.message) return res.message;
  if (res.verdict === "offline") return "You're offline. Your work is still here.";
  if (res.verdict === "hidden") return "This isn't here anymore.";
  return "Couldn't reach the server. Your work is still here.";
}
