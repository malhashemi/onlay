// Cross-screen status banners: offline, insecure-context, and the reload
// prompt when the server needs a newer web app. Each states a calm cause +
// next action, never a bare error. Rendered above a screen's content; the
// screen stays readable underneath.
import { age } from "@onlay/render/interaction-view";
import { button, el } from "../dom";

/** Offline — the read cache is serving the last synced copy. */
export function offlineBanner(syncedAt?: number): HTMLElement {
  const when = syncedAt ? `last synced ${age(syncedAt)} ago` : "showing your last sync";
  return banner("offline", `Offline — ${when}.`);
}

/** No secure context, so no service worker and no offline reading. */
export function insecureBanner(): HTMLElement {
  return banner("insecure", "Offline reading needs a secure connection. Running online-only.");
}

let upgradeShown = false;

/** The server answered `upgrade_required`: this web app is older than it
 *  accepts. One prompt per page life, pinned above everything, with Reload. */
export function showUpgradePrompt(): void {
  if (upgradeShown) return;
  upgradeShown = true;
  const b = banner("upgrade", "A newer version of Onlay is ready. Reload to keep going.");
  b.classList.add("banner-pinned");
  b.append(button("btn btn-primary btn-sm", "Reload", () => window.location.reload()));
  document.body.prepend(b);
}

function banner(kind: string, text: string): HTMLElement {
  const b = el("div", "banner");
  b.append(el("span", "banner-text", text));
  b.setAttribute("data-banner", kind);
  b.setAttribute("role", "status");
  return b;
}

/** No extension answered on this desktop Chromium browser (S-3): one quiet
 *  line with the way to install it, and × to dismiss it for good here. */
export function extensionHintBanner(installUrl: string, onDismiss: () => void): HTMLElement {
  const b = banner("extension", "Comment on and edit live pages with the extension.");
  const link = el("a", "banner-link", "Install the extension");
  link.href = installUrl;
  const close = button("banner-dismiss", "×", () => {
    b.remove();
    onDismiss();
  });
  close.setAttribute("aria-label", "Dismiss");
  b.append(link, close);
  return b;
}
