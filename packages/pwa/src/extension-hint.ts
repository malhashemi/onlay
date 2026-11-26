// Telling people without the extension about it (round 4, S-3). The hosted
// sign-in page can't carry a link, so the web app asks: on a desktop Chromium
// browser only, it pings each extension id `/api/me` names
// (`{type: "onlay-ping"}`, answered `{ok: true, version}` by the extension's
// service worker for the server origin alone), and when none answers the Inbox
// shows one quiet line that links to /install. Dismissing it is remembered in
// this browser.
//
// Desktop Chromium is read from User-Agent Client Hints
// (`navigator.userAgentData`), which only Chromium browsers expose: a
// "Chromium" brand and not mobile, and not Android (whose tablets report not
// mobile and take no extensions). No hints (Firefox, Safari, Chrome on iOS)
// means no line, never a guess from the window size or the UA string.

/** The localStorage key that remembers the line was dismissed in this browser. */
export const HINT_DISMISSED_KEY = "onlay.extensionHintDismissed";
/** How long each ping may take before its extension counts as absent. */
const PING_TIMEOUT_MS = 1_500;

interface UaData {
  brands?: ReadonlyArray<{ brand?: unknown }>;
  mobile?: unknown;
  platform?: unknown;
}

/** True only on a desktop Chromium browser, from its client hints. */
export function isDesktopChromium(nav: object | undefined): boolean {
  const ua = (nav as { userAgentData?: UaData } | undefined)?.userAgentData;
  if (!ua || !Array.isArray(ua.brands)) return false;
  if (ua.mobile !== false) return false;
  if (ua.platform === "Android") return false;
  return ua.brands.some((b) => b?.brand === "Chromium");
}

/** What a page sees of `chrome.runtime` (present only when some extension lets this origin message it). */
export interface PageRuntime {
  sendMessage(id: string, message: unknown, callback: (response: unknown) => void): void;
  lastError?: unknown;
}

/** The page's `chrome.runtime`, when the browser exposes one. */
function pageRuntime(): PageRuntime | undefined {
  const rt = (globalThis as { chrome?: { runtime?: Partial<PageRuntime> } }).chrome?.runtime;
  return typeof rt?.sendMessage === "function" ? (rt as PageRuntime) : undefined;
}

/** One extension id, asked whether it is installed: true when it answers `{ok: true}`. */
function ping(rt: PageRuntime, id: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    const done = (yes: boolean): void => {
      clearTimeout(timer);
      resolve(yes);
    };
    try {
      rt.sendMessage(id, { type: "onlay-ping" }, (response) => {
        // Reading lastError keeps Chrome from logging an unchecked one.
        if (rt.lastError) return done(false);
        done((response as { ok?: unknown } | undefined)?.ok === true);
      });
    } catch {
      done(false);
    }
  });
}

/** True when one of `ids` answers the ping (none answers without a runtime). */
export async function extensionInstalled(
  ids: readonly string[],
  rt: PageRuntime | undefined = pageRuntime(),
  timeoutMs = PING_TIMEOUT_MS,
): Promise<boolean> {
  if (!rt) return false;
  const answers = await Promise.all(ids.map((id) => ping(rt, id, timeoutMs)));
  return answers.some(Boolean);
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function hintDismissed(): boolean {
  try {
    return storage()?.getItem(HINT_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissHint(): void {
  try {
    storage()?.setItem(HINT_DISMISSED_KEY, "1");
  } catch {
    // Not remembered: it shows again on the next load, nothing worse.
  }
}

/**
 * Whether the Inbox should show the line: a desktop Chromium browser, not
 * dismissed here, given extension ids, none of which answers.
 */
export async function shouldShowExtensionHint(
  ids: readonly string[] | undefined,
  nav: object | undefined = globalThis.navigator,
  rt: PageRuntime | undefined = pageRuntime(),
  timeoutMs = PING_TIMEOUT_MS,
): Promise<boolean> {
  if (!ids || ids.length === 0) return false;
  if (!isDesktopChromium(nav) || hintDismissed()) return false;
  return !(await extensionInstalled(ids, rt, timeoutMs));
}
