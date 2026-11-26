// Is the visitor's own Onlay here? The same check the web app runs
// (packages/pwa/src/extension-hint.ts): ask each known extension id with the
// `onlay-ping` message, which the extension's service worker answers
// `{ok: true, version}` for the origins its manifest lets message it. When one
// answers, the real Onlay works on this page and the demo stands down.

/** How long each ping may take before its extension counts as absent. */
const PING_TIMEOUT_MS = 1_500;

/** What a page sees of `chrome.runtime` (present only when some extension lets this origin message it). */
export interface PageRuntime {
  sendMessage(id: string, message: unknown, callback: (response: unknown) => void): void;
  lastError?: unknown;
}

/** The page's `chrome.runtime`, when the browser exposes one. */
export function pageRuntime(scope: unknown = globalThis): PageRuntime | undefined {
  const rt = (scope as { chrome?: { runtime?: Partial<PageRuntime> } }).chrome?.runtime;
  return typeof rt?.sendMessage === "function" ? (rt as PageRuntime) : undefined;
}

/** One extension id, asked: resolves true when it answers `{ok: true}`, false when it cannot. A silent one never resolves. */
function ping(rt: PageRuntime, id: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      rt.sendMessage(id, { type: "onlay-ping" }, (response) => {
        // Reading lastError keeps Chrome from logging an unchecked one.
        if (rt.lastError) return resolve(false);
        resolve((response as { ok?: unknown } | undefined)?.ok === true);
      });
    } catch {
      resolve(false);
    }
  });
}

/** Resolves true as soon as one of `ids` answers, false once every one has failed. */
function anyAnswer(rt: PageRuntime, ids: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let open = ids.length;
    if (open === 0) resolve(false);
    for (const id of ids) {
      void ping(rt, id).then((ok) => {
        if (ok) resolve(true);
        else if (--open === 0) resolve(false);
      });
    }
  });
}

/** True when one of `ids` answers the ping within the wait. Without a runtime, none does, at once. */
export async function extensionInstalled(
  ids: readonly string[],
  rt: PageRuntime | undefined = pageRuntime(),
  timeoutMs = PING_TIMEOUT_MS,
): Promise<boolean> {
  return (await watchDemo(ids, rt, timeoutMs).mode) === "own";
}

/** What the page does about the demo. */
export type DemoMode = "sim" | "own";

export interface DemoWatch {
  /** The decision after the wait: the extension answered ("own"), or the page simulates it ("sim"). */
  mode: Promise<DemoMode>;
  /** What is known right now: "own" from the moment any answer arrives, however late. */
  current(): DemoMode;
  /**
   * Resolves if the extension answers after the wait ran out. The page was
   * told "sim" and may have started simulating: it must stand down then.
   */
  late: Promise<void>;
}

/**
 * Ask the known extensions, wait a little, and keep listening: an answer that
 * comes after the wait still counts, so the page never runs a second Onlay
 * beside the visitor's own.
 */
export function watchDemo(
  ids: readonly string[],
  rt: PageRuntime | undefined = pageRuntime(),
  timeoutMs = PING_TIMEOUT_MS,
): DemoWatch {
  if (!rt) {
    return { mode: Promise.resolve("sim"), current: () => "sim", late: new Promise(() => {}) };
  }
  let now: DemoMode = "sim";
  let waited = false;
  const answer = anyAnswer(rt, ids).then((ok) => {
    if (ok) now = "own";
    return ok;
  });
  const mode = new Promise<DemoMode>((resolve) => {
    const timer = setTimeout(() => {
      waited = true;
      resolve("sim");
    }, timeoutMs);
    void answer.then((ok) => {
      if (waited) return;
      clearTimeout(timer);
      resolve(ok ? "own" : "sim");
    });
  });
  const late = new Promise<void>((resolve) => {
    void answer.then((ok) => {
      if (ok && waited) resolve();
    });
  });
  return { mode, current: () => now, late };
}

/** The extension answers: stand down, completely. Otherwise the page simulates it. */
export function demoMode(
  ids: readonly string[],
  rt: PageRuntime | undefined = pageRuntime(),
  timeoutMs = PING_TIMEOUT_MS,
): Promise<DemoMode> {
  return watchDemo(ids, rt, timeoutMs).mode;
}
