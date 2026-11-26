// The service worker's last check before an upload leaves (R3-C4): the
// message comes from a tab, from that frame's live document, on the page it
// claims, under the account generation the service worker holds now. A page
// that moved on, a document going away (back/forward cache, prerender) or a
// message composed under another account uploads nothing.
import { samePage } from "../overlay/page-url";

export interface SenderPorts {
  /** The account generation the service worker holds now. */
  generation(): number;
  /** The tab as the browser reports it now, or null when it is gone. */
  tab(tabId: number): Promise<{ url?: string | undefined } | null>;
}

export async function senderMayUpload(
  m: Record<string, unknown>,
  sender: chrome.runtime.MessageSender | undefined,
  ports: SenderPorts,
): Promise<boolean> {
  const tabId = sender?.tab?.id;
  if (tabId === undefined || tabId < 0) return false;
  const lifecycle = (sender as { documentLifecycle?: string } | undefined)?.documentLifecycle;
  if (lifecycle !== undefined && lifecycle !== "active") return false;
  const claimed = typeof m.pageUrl === "string" ? m.pageUrl : undefined;
  if (!samePage(sender?.url, claimed)) return false;
  if (m.generation !== ports.generation()) return false;
  const tab = await ports.tab(tabId);
  if (!tab) return false;
  // The top frame's page is the tab's page; a subframe's is its own (sender.url).
  if (sender?.frameId === 0 && !samePage(tab.url, claimed)) return false;
  return m.generation === ports.generation();
}
