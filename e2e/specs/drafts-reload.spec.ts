// Unsent text survives a page reload (D-1). Ada starts a Comment on a block
// and reloads the page before sending it: the Comment on the same block opens
// with her words. Closing the composer (Esc) keeps them across another
// reload; Cancel discards them. The copy lives only in the service worker's
// session storage, never in chrome.storage.local. Signing out wipes it: after
// she signs back in and reloads, the composer opens empty.
//
// A send whose answer is lost keeps its id across a reload too (2-D1): Ada
// sends a Comment, its receipt never reaches the page, she reloads and sends
// the restored text again. The space answers the retry with the first
// Comment: the page holds one pin, not two.
//
// The same holds for a reply that quotes a message (S-1): the quote is kept
// with the reply's draft, so the retry after a reload is the same reply and
// the thread holds it once.
import type { Page, Worker } from "@playwright/test";
import { expect, signInFromPopup, test } from "../harness/fixtures";
import {
  commentOnBlock,
  composerWindow,
  expectConnected,
  overlay,
  pins,
  runCommand,
  threadMessages,
  threadView,
} from "../harness/overlay";

test.skip(process.env.E2E_SHADOW_MODE === "closed", "needs an open-root build");

const WORDS = "Ada's unsent thought about the price";

async function openComment(page: Page) {
  await runCommand(page, "Comment on block");
  await page.locator("#price").click();
  const win = composerWindow(page);
  await expect(win).toBeVisible();
  return win;
}

interface ChromeStorage {
  chrome: {
    storage: {
      session: { get(k: string | null): Promise<Record<string, unknown>> };
      local: { get(k: null): Promise<Record<string, unknown>> };
    };
  };
}

/** Everything the service worker keeps in session storage under `drafts`, as text. */
const storedDrafts = (sw: Worker): Promise<string> =>
  sw.evaluate(async () => {
    const got = await (globalThis as unknown as ChromeStorage).chrome.storage.session.get("drafts");
    return JSON.stringify(got.drafts ?? null);
  });

const localStorageText = (sw: Worker): Promise<string> =>
  sw.evaluate(async () =>
    JSON.stringify(await (globalThis as unknown as ChromeStorage).chrome.storage.local.get(null)),
  );

test("an unsent Comment comes back after a reload, and is gone after sign-out", async ({
  article,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  const sw = await ada.serviceWorker();
  const page = await ada.newPage();
  await page.goto(article);
  await expectConnected(page);

  const win = await openComment(page);
  await win.getByRole("textbox").click();
  await page.keyboard.type(WORDS);
  await expect.poll(() => storedDrafts(sw)).toContain(WORDS);
  expect(await localStorageText(sw)).not.toContain(WORDS);

  // A reload: the Comment on the same block opens with her words.
  await page.reload();
  await expectConnected(page);
  const back = await openComment(page);
  await expect(back.getByRole("textbox")).toHaveText(WORDS);

  // Esc closes the composer and keeps the draft, across another reload too.
  await back.getByRole("textbox").click();
  await page.keyboard.press("Escape");
  await expect(composerWindow(page)).toBeHidden();
  await page.reload();
  await expectConnected(page);
  const again = await openComment(page);
  await expect(again.getByRole("textbox")).toHaveText(WORDS);

  // Cancel discards it: gone from storage, and from the next page load.
  await again.getByRole("button", { name: "Cancel" }).click();
  await expect(composerWindow(page)).toBeHidden();
  await expect.poll(() => storedDrafts(sw)).not.toContain(WORDS);
  await page.reload();
  await expectConnected(page);
  const empty = await openComment(page);
  await expect(empty.getByRole("textbox")).toHaveText("");

  // Typed again, then Ada signs out: the stored copy goes with her account.
  await empty.getByRole("textbox").click();
  await page.keyboard.type(WORDS);
  await expect.poll(() => storedDrafts(sw)).toContain(WORDS);
  const popup = await ada.popup();
  await popup.getByRole("button", { name: "Sign out" }).click();
  await expect(popup.getByText("Sign in to Onlay")).toBeVisible();
  await popup.close();
  await expect.poll(() => storedDrafts(sw)).toBe("null");

  // She signs back in and reloads: nothing of the old draft comes back.
  await ada.context.clearCookies();
  const signedIn = await signInFromPopup(ada);
  await signedIn.close();
  await page.reload();
  await expectConnected(page);
  const fresh = await openComment(page);
  await expect(fresh.getByRole("textbox")).toHaveText("");
});

interface ChromeTabs {
  chrome: { tabs: { sendMessage: (...args: unknown[]) => Promise<unknown> } };
  __onlayHoldReceipts?: string | null;
  __onlayHeld?: number;
}

/** From now on the service worker drops every receipt of `kind` on its way to a tab (null: none). */
const holdReceipts = (sw: Worker, kind: string | null): Promise<void> =>
  sw.evaluate((hold) => {
    const g = globalThis as unknown as ChromeTabs & { __onlaySend?: (...a: unknown[]) => unknown };
    if (!g.__onlaySend) {
      const real = g.chrome.tabs.sendMessage.bind(g.chrome.tabs);
      g.__onlaySend = real;
      g.__onlayHeld = 0;
      g.chrome.tabs.sendMessage = (...args: unknown[]) => {
        const m = args[1] as { type?: string; kind?: string } | undefined;
        if (m?.type === "interaction-receipt" && m.kind === g.__onlayHoldReceipts) {
          g.__onlayHeld = (g.__onlayHeld ?? 0) + 1;
          return Promise.resolve(undefined);
        }
        return real(...args);
      };
    }
    g.__onlayHoldReceipts = hold;
  }, kind);

const heldReceipts = (sw: Worker): Promise<number> =>
  sw.evaluate(() => (globalThis as unknown as ChromeTabs).__onlayHeld ?? 0);

test("a Comment whose receipt was lost, sent again after a reload, is posted once", async ({
  article,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  const sw = await ada.serviceWorker();
  const page = await ada.newPage();
  await page.goto(article);
  await expectConnected(page);
  await expect(pins(page)).toHaveCount(0);

  await holdReceipts(sw, "create");
  const win = await openComment(page);
  await win.getByRole("textbox").click();
  await page.keyboard.type(WORDS);
  await win.getByRole("button", { name: "Comment", exact: true }).click();
  // The Comment reached the space; its receipt did not reach the page.
  await expect.poll(() => heldReceipts(sw)).toBeGreaterThan(0);
  await expect(pins(page)).toHaveCount(1);
  await expect(overlay(page).getByText("comment posted")).toBeHidden();
  await expect(composerWindow(page)).toBeVisible();

  // Ada reloads and sends the restored text again; receipts flow once more.
  await page.reload();
  await expectConnected(page);
  await holdReceipts(sw, null);
  const again = await openComment(page);
  await expect(again.getByRole("textbox")).toHaveText(WORDS);
  await again.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(overlay(page).getByText("comment posted")).toBeVisible();
  await expect(composerWindow(page)).toBeHidden();

  // One Comment, not two: on this page and on the next load of it. (Two on
  // one block would share the pin and wear a count.)
  const counts = overlay(page).locator(".pin-layer .pin-count");
  await expect(pins(page)).toHaveCount(1);
  await page.reload();
  await expectConnected(page);
  await expect(pins(page)).toHaveCount(1);
  await expect(counts).toHaveCount(0);
});

test("a quoted reply whose receipt was lost, sent again after a reload, is posted once", async ({
  article,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  const sw = await ada.serviceWorker();
  const page = await ada.newPage();
  await page.goto(article);
  await expectConnected(page);
  await commentOnBlock(page, "#price", null, ["Is this the launch price?"]);
  await pins(page).first().click();
  await expect(threadMessages(page)).toHaveCount(1);

  // Ada replies to that message, quoting it; the receipt never reaches the page.
  await threadMessages(page).first().getByRole("button", { name: "reply", exact: true }).click();
  const view = threadView(page);
  await expect(view.locator(".quote-chip")).toHaveCount(1);
  await view.getByRole("textbox").last().click();
  await page.keyboard.type("It is, until Friday.");
  await holdReceipts(sw, "reply");
  await view.getByRole("button", { name: "Reply", exact: true }).click();
  await expect.poll(() => heldReceipts(sw)).toBeGreaterThan(0);

  // A reload: the reply came back with its quote, and the space has it once.
  await page.reload();
  await expectConnected(page);
  await holdReceipts(sw, null);
  await pins(page).first().click();
  await expect(threadMessages(page)).toHaveCount(2);
  const back = threadView(page);
  await expect(back.getByRole("textbox").last()).toHaveText("It is, until Friday.");
  // One chip on the reply that landed, one above the box for the reply being written.
  await expect(back.locator(".quote-chip")).toHaveCount(2);

  // Sent again: the same reply, answered as the first was. Still two messages.
  await back.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(back.getByRole("textbox").last()).toHaveText("");
  await expect(back.locator(".quote-chip")).toHaveCount(1);
  await expect(threadMessages(page)).toHaveCount(2);
  await page.reload();
  await expectConnected(page);
  await pins(page).first().click();
  await expect(threadMessages(page)).toHaveCount(2);
});
