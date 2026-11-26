// Nothing of the overlay is in a look (C-1), and a remount rebuilds the
// private surfaces instead of carrying them (C-2).
//
// The first test is keyboard only and reads nothing inside the overlay, so it
// runs against the open test build and the closed default build
// (`E2E_SHADOW_MODE=closed`). The second looks inside the root, so it needs
// the open build.
import type { Page } from "@playwright/test";
import { expect, test } from "../harness/fixtures";

interface HideRecord {
  label: string;
  opacity: string;
  opacityPriority: string;
  visibility: string;
}

async function waitConnected(sw: {
  evaluate<R>(fn: () => R | Promise<R>): Promise<R>;
}): Promise<void> {
  await expect
    .poll(() =>
      sw.evaluate(async () => {
        const r = await new Promise<{ connected?: boolean }>((res) =>
          (
            globalThis as unknown as {
              chrome: { runtime: { sendMessage(m: unknown, cb: (r: never) => void): void } };
            }
          ).chrome.runtime.sendMessage({ type: "getStatus" }, res),
        ).catch(() => ({ connected: false }));
        return r?.connected === true;
      }),
    )
    .toBe(true)
    .catch(() => {});
}

const hides = (page: Page): Promise<HideRecord[]> =>
  page.evaluate(() => (window as unknown as { __hides: HideRecord[] }).__hides);

const LABELS = ["top", "light", "shadow"];

test("a look of a block hides the overlay in this frame and in every same-origin frame in it, closed shadow roots included", async ({
  pages,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  const page = await ada.newPage();
  await page.goto(`${pages.base}/frames.html`);
  await expect(page.locator(":root > [data-onlay-root]")).toBeAttached();
  // Every frame's content script mounted its own host, and the page watches each.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __ready(): boolean }).__ready()))
    .toBe(true);
  await waitConnected(await ada.serviceWorker());
  await page.waitForTimeout(800);

  // Comment on the block itself (its padding, outside both frames): the
  // comment's look is taken once the space has it.
  await page.locator("body").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Control+.");
  await page.waitForTimeout(300);
  await page.keyboard.type("Comment on block");
  await page.keyboard.press("Enter");
  await page.locator("#block").click({ position: { x: 12, y: 12 } });
  await page.waitForTimeout(400);
  await page.keyboard.type("frames look");
  await page.keyboard.press("Enter");

  // While the look was taken, every host was hidden as a whole: opacity 0 (no
  // descendant can show through it) and visibility hidden, both important.
  const hiddenIn = async (): Promise<string[]> =>
    [
      ...new Set(
        (await hides(page))
          .filter(
            (r) =>
              r.opacity === "0" && r.opacityPriority === "important" && r.visibility === "hidden",
          )
          .map((r) => r.label),
      ),
    ].sort();
  await expect.poll(hiddenIn, { timeout: 20_000 }).toEqual([...LABELS].sort());

  // And afterwards every one of them shows again.
  await expect
    .poll(
      async () => {
        const all = await hides(page);
        return LABELS.map((l) => {
          const last = all.filter((r) => r.label === l).at(-1);
          return last ? `${l}:${last.visibility}:${last.opacity || "-"}` : `${l}:none`;
        });
      },
      { timeout: 20_000 },
    )
    .toEqual(LABELS.map((l) => `${l}:visible:-`));
});

test("a host the page moves comes back with fresh private surfaces, not the old nodes", async ({
  pages,
  extensionPerson,
}) => {
  test.skip(process.env.E2E_SHADOW_MODE === "closed", "reads inside the overlay's root");
  const ada = await extensionPerson("ada");
  const page = await ada.newPage();
  await page.goto(`${pages.base}/listeners.html`);
  await expect(page.locator(":root > [data-onlay-root]")).toBeAttached();
  await waitConnected(await ada.serviceWorker());
  await page.waitForTimeout(800);

  // The command bar is open with words in it when the page moves the host.
  await page.locator("body").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Control+.");
  await page.waitForTimeout(300);
  await page.keyboard.type("guava");
  const SURFACES = [".command-bar", ".composer-window", ".interaction-modal", ".thread-panel"];
  const marked = await page.evaluate((selectors) => {
    const root = document.querySelector(":root > [data-onlay-root]")?.shadowRoot;
    const old = selectors.map((s) => root?.querySelector(s) ?? null);
    (window as unknown as { __old: Array<Element | null> }).__old = old;
    return old.map((n) => n !== null);
  }, SURFACES);
  expect(marked).toEqual(SURFACES.map(() => true));

  expect(
    await page.evaluate(() =>
      (window as unknown as { __moveHost(m: string): boolean }).__moveHost("open"),
    ),
  ).toBe(true);
  await page.waitForTimeout(300);

  const after = await page.evaluate((selectors) => {
    const hosts = document.querySelectorAll("[data-onlay-root]");
    const root = document.querySelector(":root > [data-onlay-root]")?.shadowRoot;
    const old = (window as unknown as { __old: Array<Element | null> }).__old;
    const input = root?.querySelector<HTMLInputElement>(".command-bar .bar-input");
    return {
      hosts: hosts.length,
      present: selectors.map((s) => !!root?.querySelector(s)),
      // None of the old nodes is anywhere in the page, the new root included.
      carried: old.map((n) => !!n?.isConnected),
      fresh: selectors.map((s, i) => root?.querySelector(s) !== old[i]),
      text: input?.value ?? "",
      shownText: root?.textContent?.includes("guava") ?? false,
    };
  }, SURFACES);
  expect(after).toEqual({
    hosts: 1,
    present: SURFACES.map(() => true),
    carried: SURFACES.map(() => false),
    fresh: SURFACES.map(() => true),
    text: "",
    shownText: false,
  });

  // The fresh command bar works as before.
  await page.locator("body").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Control+.");
  await expect(page.locator(":root > [data-onlay-root]").locator(".command-bar")).toBeVisible();
  await page.keyboard.press("Escape");
});
