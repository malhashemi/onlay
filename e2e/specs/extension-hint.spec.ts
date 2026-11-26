// People without the extension are told about it in the web app (S-3). In a
// Chromium browser with no extension the Inbox shows one quiet line linking to
// /install; dismissing it is remembered across reloads. With the extension
// installed the line never shows: the extension answers the web app's ping
// with its version, and answers nothing to a page on another site.
import type { Page } from "@playwright/test";
import { expect, test } from "../harness/fixtures";

const HINT = "Comment on and edit live pages with the extension.";

interface PageChrome {
  chrome?: {
    runtime?: {
      sendMessage?: (id: string, m: unknown, cb: (r: unknown) => void) => void;
      lastError?: unknown;
    };
  };
}

/** What `id` answers this page's ping, or "no runtime" when the page has none to ask with. */
const pingFrom = (page: Page, id: string): Promise<unknown> =>
  page.evaluate(
    (extId) =>
      new Promise((resolve) => {
        const rt = (globalThis as unknown as PageChrome).chrome?.runtime;
        if (typeof rt?.sendMessage !== "function") return resolve("no runtime");
        rt.sendMessage(extId, { type: "onlay-ping" }, (r) => {
          resolve(rt.lastError ? "refused" : r);
        });
      }),
    id,
  );

test("without the extension the Inbox says how to get it, until dismissed", async ({
  origin,
  webPerson,
}) => {
  const { page } = await webPerson("noor");
  await expect(page.locator(".app-title")).toHaveText("Inbox");
  const hint = page.locator('.banner[data-banner="extension"]');
  await expect(hint).toContainText(HINT);
  const link = hint.getByRole("link", { name: "Install the extension" });
  // The site's /install (one origin in e2e, so the service's own).
  await expect(link).toHaveAttribute("href", `${origin}/install`);
  expect(new URL((await link.evaluate((a) => (a as HTMLAnchorElement).href)) ?? "").origin).toBe(
    origin,
  );

  await hint.getByRole("button", { name: "Dismiss" }).click();
  await expect(hint).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".app-title")).toHaveText("Inbox");
  // The ping has had its time (1.5 s); the line stays dismissed in this browser.
  await page.waitForTimeout(2_500);
  await expect(hint).toHaveCount(0);
});

test("with the extension the line never shows, and only the server origin gets an answer", async ({
  origin,
  article,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  const page = await ada.newPage();
  await page.goto(`${origin}/app/`);
  await expect(page.locator(".app-title")).toHaveText("Inbox");
  const answer = (await pingFrom(page, ada.extensionId)) as { ok?: boolean; version?: string };
  expect(answer.ok).toBe(true);
  expect(Object.keys(answer).sort()).toEqual(["ok", "version"]);
  await page.waitForTimeout(2_500);
  await expect(page.locator('.banner[data-banner="extension"]')).toHaveCount(0);

  // Another site: the browser gives it no way to ask (externally_connectable),
  // and nothing it could send would be answered.
  const other = await ada.newPage();
  await other.goto(article);
  expect(await pingFrom(other, ada.extensionId)).toBe("no runtime");
});
