// The extension's service worker dies often under MV3. Its identity lives in
// chrome.storage, never in worker memory: after three forced deaths the
// person is still signed in, each space resumes the same durable session, and
// the page still shows what the space holds.
import type { BrowserContext, Worker } from "@playwright/test";
import { expect, test } from "../harness/fixtures";
import { commentOnBlock, expectConnected, pins } from "../harness/overlay";

test.describe.configure({ retries: process.platform === "darwin" ? 2 : 0 });

// It reads the overlay's pins, which only an open-root test build exposes.
test.skip(process.env.E2E_SHADOW_MODE === "closed", "needs an open-root build");

interface Stored {
  sessions?: Record<string, { sessionId: string; connects: number }>;
  swRestarts?: number | undefined;
}

/** Each space's durable session lives under its own `session:<spaceId>` key. */
function stored(sw: Worker): Promise<Stored> {
  return sw.evaluate(async () => {
    const all = (await (
      globalThis as unknown as {
        chrome: { storage: { local: { get(k: null): Promise<Record<string, unknown>> } } };
      }
    ).chrome.storage.local.get(null)) as Record<string, unknown>;
    const sessions: Record<string, { sessionId: string; connects: number }> = {};
    for (const [k, v] of Object.entries(all))
      if (k.startsWith("session:"))
        sessions[k.slice(8)] = v as { sessionId: string; connects: number };
    return { sessions, swRestarts: all.swRestarts as number | undefined };
  });
}

/** Stops the extension's service worker, as devtools' "Stop" does. */
async function killServiceWorker(context: BrowserContext, extensionId: string): Promise<void> {
  const browser = context.browser();
  if (browser) {
    const cdp = await browser.newBrowserCDPSession();
    try {
      const { targetInfos } = (await cdp.send("Target.getTargets")) as {
        targetInfos: Array<{ targetId: string; type: string; url: string }>;
      };
      const target = targetInfos.find(
        (t) => t.type === "service_worker" && t.url.includes(extensionId),
      );
      if (target) {
        await cdp.send("Target.closeTarget", { targetId: target.targetId });
        return;
      }
    } finally {
      await cdp.detach().catch(() => {});
    }
  }
  const page = context.pages()[0] ?? (await context.newPage());
  const cdp = await context.newCDPSession(page);
  try {
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.stopAllWorkers");
  } finally {
    await cdp.detach().catch(() => {});
  }
}

test("the same sessions survive three forced service-worker deaths", async ({
  article,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  const page = await ada.newPage();
  await page.goto(article);
  await expectConnected(page);
  await commentOnBlock(page, "#lede", null, ["Still here after a restart?"]);
  await expect(pins(page)).toHaveCount(1);

  const initial = await stored(await ada.serviceWorker());
  const [spaceId, session] = Object.entries(initial.sessions ?? {})[0] ?? [];
  expect(spaceId, "a space session").toBeTruthy();
  let restarts = initial.swRestarts ?? 0;

  for (let round = 1; round <= 3; round++) {
    await killServiceWorker(ada.context, ada.extensionId);
    // A page load wakes the worker, as it does for a person.
    await page.reload();
    await expectConnected(page);
    await expect(pins(page)).toHaveCount(1);

    const now = await stored(await ada.serviceWorker());
    expect(now.swRestarts ?? 0, `restart counted (round ${round})`).toBeGreaterThan(restarts);
    restarts = now.swRestarts ?? 0;
    const resumed = now.sessions?.[spaceId as string];
    expect(resumed?.sessionId).toBe(session?.sessionId);
    expect(resumed?.connects ?? 0).toBeGreaterThan(session?.connects ?? 0);
  }
});
