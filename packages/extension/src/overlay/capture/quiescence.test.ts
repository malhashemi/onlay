import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { quiesce } from "./quiescence";

let win: Window | null = null;

function install(): void {
  win = new Window({ url: "http://127.0.0.1:8124/page.html" });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = win;
  g.document = win.document;
  g.Element = win.Element;
}

beforeEach(() => install());
afterEach(() => {
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
});

test("hides overlay chrome for the frame, then restores it on the caller's cue", async () => {
  const host = document.createElement("onlay-root");
  document.body.append(host);
  const handle = await quiesce({
    scope: document.body,
    chrome: [host],
    deadlineMs: 50,
    raf: (cb) => cb(),
    fontsReady: () => Promise.resolve(),
  });
  expect(handle.outcome).toBe("settled");
  // chrome stays hidden until the witness completes (caller calls restore)
  expect((host as HTMLElement).style.visibility).toBe("hidden");
  handle.restore();
  expect((host as HTMLElement).style.visibility).toBe("");
  // restore is idempotent
  handle.restore();
  expect((host as HTMLElement).style.visibility).toBe("");
});

test("times out (never blocking) when the frame will not settle, metering the outcome", async () => {
  const handle = await quiesce({
    scope: document.body,
    chrome: [],
    deadlineMs: 5,
    raf: (cb) => setTimeout(cb, 0),
    fontsReady: () => new Promise<void>(() => {}), // never resolves
  });
  expect(handle.outcome).toBe("timeout");
});

test("fail-soft: a throwing fonts.ready degrades to a settled/timeout outcome, never throws", async () => {
  const handle = await quiesce({
    scope: document.body,
    chrome: [],
    deadlineMs: 50,
    raf: (cb) => cb(),
    fontsReady: () => Promise.reject(new Error("boom")),
  });
  expect(["settled", "timeout"]).toContain(handle.outcome);
});

/* ── Real-browser cases → the Playwright fidelity harness (capture spec §9),
   NOT unit tests: a shimmed getComputedStyle cannot prove pixel fidelity. Marked
   as pending so the Stage-1 gate tracks them. ── */
test.todo("HARNESS: font swap + document.fonts.ready quiescence timing (real webfonts)", () => {});
test.todo("HARNESS: img.decode() settle + two-frame layout flush before reads", () => {});
test.todo("HARNESS: captureVisibleTab + scroll-and-stitch seam correctness + DPR", () => {});
test.todo("HARNESS: overlay-chrome-hidden witness frame matches the walked document", () => {});
test.todo("HARNESS: chrome.permissions.request/contains grant flow + privileged SW fetch", () => {});
test.todo("HARNESS: fidelity diff (capture → sandbox='' reconstruct → SSIM+pixelmatch)", () => {});
test.todo("HARNESS: web-components fixture reconstructs; class-variant renders OR honest note", () => {});
test.todo("HARNESS: adversarial canvas/JS fixture lowers the grade / raises residue", () => {});
test.todo("HARNESS: rendered frame runs no script and makes zero network requests (CSP)", () => {});

test("by default it hides the host this script mounted, whatever its tag (R3-C2)", async () => {
  const { mountHost } = await import("../host");
  const m = mountHost(document, "closed");
  const handle = await quiesce({
    scope: document.body,
    deadlineMs: 50,
    raf: (cb) => cb(),
    fontsReady: () => Promise.resolve(),
  });
  expect(m.host.style.visibility).toBe("hidden");
  handle.restore();
});

test("a host mounted while a capture is in flight starts hidden, and the capture sees the host changed (3b-C1)", async () => {
  const { mountHost } = await import("../host");
  mountHost(document, "closed");
  const handle = await quiesce({
    scope: document.body,
    deadlineMs: 50,
    raf: (cb) => cb(),
    fontsReady: () => Promise.resolve(),
  });
  const { hostMounts } = await import("../host");
  // The page moved the host; the overlay remounted mid-capture.
  const fresh = mountHost(document, "closed");
  expect(fresh.host.style.visibility).toBe("hidden");
  expect(hostMounts()).not.toBe(handle.hostMounts);
  handle.restore();
  // The last release shows whatever host is current.
  expect(fresh.host.style.visibility).toBe("visible");
});

test("the overlay in a same-origin child frame is hidden through that frame's own hider (3b-C1)", async () => {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const child = frame.contentWindow as unknown as Window;
  let hidden = 0;
  let shown = 0;
  Object.defineProperty(child, Symbol.for("onlay.overlay.hideForCapture"), {
    value: () => {
      hidden += 1;
      return () => {
        shown += 1;
      };
    },
  });
  const handle = await quiesce({
    scope: document.body,
    deadlineMs: 50,
    raf: (cb) => cb(),
    fontsReady: () => Promise.resolve(),
  });
  expect(hidden).toBe(1);
  expect(shown).toBe(0);
  handle.restore();
  expect(shown).toBe(1);
});
