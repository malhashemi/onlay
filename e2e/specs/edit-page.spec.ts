// Edit page mode on a plain page: a selected block is removed with Delete
// (Backspace removes nothing), and Close puts the page back exactly, onto the
// page's own nodes: a removed block returns after the block around it was
// opened for text, nested rewrites both come off, and a listener the page put
// on a block still hears its clicks.
import type { Page } from "@playwright/test";
import { expect, test } from "../harness/fixtures";
import { expectConnected, overlay, runCommand } from "../harness/overlay";

test.skip(process.env.E2E_SHADOW_MODE === "closed", "needs an open-root build");

const markup = (page: Page) => page.evaluate(() => document.querySelector("main")?.outerHTML);

interface Marked {
  price: Element;
  clicks: number;
}

/** The page keeps its own #price node and counts the clicks it hears. */
const mark = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as Marked;
    w.price = document.querySelector("#price") as Element;
    w.clicks = 0;
    w.price.addEventListener("click", () => {
      w.clicks += 1;
    });
  });

test("Delete removes the selected block, Backspace does not, and Close puts the page back as it was", async ({
  article,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  const page = await ada.newPage();
  await page.goto(article);
  await expectConnected(page);
  const before = await markup(page);
  await mark(page);
  const tray = overlay(page).locator(".batch-tray");
  const price = page.locator("#price");

  await runCommand(page, "Edit page");
  await expect(tray).toBeVisible();
  await price.click();
  await page.keyboard.press("Backspace");
  await expect(price).toBeVisible();
  await expect(tray).toContainText("Edit set · 0");
  await page.keyboard.press("Delete");
  await expect(price).toBeHidden();
  await page.locator("#studio-price").click();
  await page.keyboard.press("Delete");
  await expect(page.locator("#studio-price")).toBeHidden();
  await expect(tray).toContainText("Edit set · 2");

  // The block around a removed one, opened for text and left alone.
  await page.locator("#plan-team").dblclick({ position: { x: 5, y: 5 } });
  await expect(page.locator("#plan-team")).toHaveAttribute("contenteditable", "true");
  await page.locator("#headline").click();
  await expect(tray).toContainText("Edit set · 2");

  await tray.getByRole("button", { name: "Close" }).click();
  await expect(tray).toBeHidden();
  await expect(price).toBeVisible();
  expect(await markup(page)).toBe(before);
  expect(await page.evaluate(() => (window as unknown as Marked).price.isConnected)).toBe(true);
});

test("a rewrite of a block and of the block around it both come off on Close, and the page's listeners stay", async ({
  article,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  const page = await ada.newPage();
  await page.goto(article);
  await expectConnected(page);
  const before = await markup(page);
  await mark(page);
  const tray = overlay(page).locator(".batch-tray");
  const price = page.locator("#price");

  await runCommand(page, "Edit page");
  await expect(tray).toBeVisible();
  await price.dblclick();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Nine dollars.");
  await page.keyboard.press("Enter");
  await expect(tray).toContainText("Edit set · 1");
  await page.locator("#plan-team").dblclick({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" More.");
  await page.keyboard.press("Enter");
  await expect(tray).toContainText("Edit set · 2");
  await tray.getByRole("button", { name: "Close" }).click();
  await expect(tray).toBeHidden();
  await expect(price).toHaveText("Twelve dollars a month, billed yearly.");
  expect(await markup(page)).toBe(before);

  // Out of Edit page mode, the page's own listener on its own node hears a click.
  await page.keyboard.press("Escape");
  await price.click();
  expect(await page.evaluate(() => (window as unknown as Marked).clicks)).toBe(1);
});
