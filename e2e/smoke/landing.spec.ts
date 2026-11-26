// The landing page, as a visitor without the extension uses it. The page
// says "Simulated in your browser. Nothing is sent or stored.": its demo runs
// in memory only, so it must keep nothing in the browser and ask nothing of
// another origin. The site build's own check (packages/site/scripts/scan.ts)
// matches names in its scripts; this is what a browser actually saw.
import { expect, test } from "../harness/fixtures";

test("the landing page's demo keeps nothing in the browser and asks no other origin", async ({
  origin,
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const elsewhere: string[] = [];
  context.on("request", (r) => {
    const url = r.url();
    if (!url.startsWith("data:") && new URL(url).origin !== origin) elsewhere.push(url);
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  // Signed out, one origin: `/` is the landing page.
  await page.goto(`${origin}/`);
  await expect(page.locator("#headline")).toBeVisible();

  // The page's own first step, "Pick a block", starts a block pick: pick the
  // headline and post a Comment with a fenced block (the highlighter is
  // fetched for it).
  await page.locator("[data-steps] [data-pick-step]").click();
  await page.locator("#headline").click();
  const box = page.getByPlaceholder("Comment on this spot… @mention to notify");
  await box.fill("Shorter, please:\n```js\nconst headline = 'Comments and Edits';\n```");
  await page
    .locator('[aria-label="Comment"]')
    .filter({ has: box })
    .getByRole("button", { name: "Comment", exact: true })
    .click();
  await expect(page.getByText("comment posted")).toBeVisible();

  const kept = await page.evaluate(async () => ({
    localStorage: localStorage.length,
    sessionStorage: sessionStorage.length,
    indexedDB: (await indexedDB.databases()).map((d) => d.name),
    caches: await caches.keys(),
    cookie: document.cookie,
    serviceWorkers: (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope),
  }));
  expect(kept).toEqual({
    localStorage: 0,
    sessionStorage: 0,
    indexedDB: [],
    caches: [],
    cookie: "",
    serviceWorkers: [],
  });
  expect(await context.cookies()).toEqual([]);
  expect(elsewhere).toEqual([]);
  expect(errors).toEqual([]);
  await context.close();
});

test("on a short window the demo's Edit keeps Generate variants and Cancel within reach", async ({
  origin,
  browser,
}) => {
  const height = 320;
  const context = await browser.newContext({ viewport: { width: 420, height } });
  const page = await context.newPage();
  await page.goto(`${origin}/`);
  await expect(page.locator("#headline")).toBeVisible();
  // The simulation starts once the page is idle: keys before that reach nothing.
  await expect(page.locator("html[data-demo='sim']")).toBeAttached();
  // "ee": Edit block, then pick the headline.
  await page.keyboard.press("e");
  await page.keyboard.press("e");
  await page.locator("#headline").click();
  const card = page.locator('.composer-window[role="dialog"][aria-label="Edit"]');
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Variants", exact: true }).click();
  for (const name of ["Generate variants", "Cancel"]) {
    const button = card.getByRole("button", { name, exact: true });
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox();
    expect(box, name).not.toBeNull();
    expect(box?.y ?? -1, name).toBeGreaterThanOrEqual(0);
    expect((box?.y ?? height) + (box?.height ?? 0), name).toBeLessThanOrEqual(height);
  }
  const cardBox = await card.boundingBox();
  expect((cardBox?.y ?? height) + (cardBox?.height ?? 0)).toBeLessThanOrEqual(height);
  await context.close();
});
