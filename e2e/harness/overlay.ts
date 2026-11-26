// Driving the extension's overlay as a person does: the launcher, the command
// bar, block-scoped commands, composers, pins and the thread panel. Real
// Playwright clicks and keystrokes are trusted events, so they pass the
// overlay's gates that keep page scripts out.
import { expect, type Locator, type Page } from "@playwright/test";

export const overlay = (page: Page): Locator => page.locator("[data-onlay-root]");

/** The launcher orb, connected to the person's spaces. */
export async function expectConnected(page: Page): Promise<void> {
  await expect(
    overlay(page).getByRole("button", { name: "Onlay — open your Inbox" }),
  ).toBeVisible();
  await expect(overlay(page).locator(".orb-status.connected")).toBeAttached();
}

/** Opens the command bar in its root mode with the `Ctrl+.` shortcut. */
async function openCommandBar(page: Page): Promise<Locator> {
  const bar = overlay(page).locator(".command-bar");
  if (!(await bar.isVisible())) {
    await page.locator("body").click({ position: { x: 4, y: 4 } });
    await page.keyboard.press("Control+.");
    await expect(bar).toBeVisible();
  }
  return bar;
}

/** Runs a command by its label in the command bar. */
export async function runCommand(page: Page, label: string): Promise<void> {
  const bar = await openCommandBar(page);
  await bar.locator(".bar-input").fill(label);
  await bar
    .locator(".bar-row")
    .filter({ has: page.locator(".label", { hasText: new RegExp(`^${label}$`) }) })
    .first()
    .click();
}

/** The composer window a block command opens. */
export const composerWindow = (page: Page): Locator => overlay(page).locator(".composer-window");

/** A piece of a message: words, or a mention picked from the @ menu. */
export type Part = string | { mention: string };

/** Types parts into a token editor, picking each mention from its menu. */
export async function typeParts(page: Page, editor: Locator, parts: Part[]): Promise<void> {
  await editor.click();
  for (const part of parts) {
    if (typeof part === "string") {
      await page.keyboard.type(part);
      continue;
    }
    await page.keyboard.type(`@${part.mention}`);
    const menu = editor.locator("xpath=..").locator(".mention-menu");
    await menu.locator(".pick-item").filter({ hasText: part.mention }).first().click();
  }
}

/**
 * Switch space in the command bar: where new comments and edits go. Waits for
 * the space to be offered, so it also proves the extension knows the space.
 */
async function switchSpace(page: Page, name: string): Promise<void> {
  const bar = overlay(page).locator(".command-bar");
  const row = bar
    .locator(".bar-row")
    .filter({ has: page.locator(".label", { hasText: new RegExp(`^${name}$`) }) });
  // A space made a moment ago reaches the page with the service worker's next
  // status. Until it does, the page knows one space, and Switch space closes
  // with "Everything you post goes to …" instead of listing them: run it
  // again, as a person would, until the space is offered.
  await expect(async () => {
    if (await bar.isVisible()) await page.keyboard.press("Escape");
    await runCommand(page, "Switch space");
    await expect(row).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await row.click();
  if (await bar.isVisible()) await page.keyboard.press("Escape");
  await expect(bar).toBeHidden();
}

/** The composer's space field, when the person has more than one space: it names the chosen one. */
async function expectComposerSpace(page: Page, name: string): Promise<void> {
  const field = composerWindow(page).getByRole("button", { name: `Space ${name}` });
  await expect(field).toHaveAttribute("aria-haspopup", "listbox");
}

/**
 * Comment on block: pick the block, write, post. With `space`, switch to that
 * space first (people with more than one space); without, the only one.
 */
export async function commentOnBlock(
  page: Page,
  selector: string,
  space: string | null,
  parts: Part[],
): Promise<void> {
  if (space !== null) await switchSpace(page, space);
  await runCommand(page, "Comment on block");
  await page.locator(selector).click();
  const win = composerWindow(page);
  await expect(win).toBeVisible();
  if (space !== null) await expectComposerSpace(page, space);
  await typeParts(page, win.getByRole("textbox"), parts);
  // The whole card stays on screen, whatever the text.
  await expect(win).toBeInViewport({ ratio: 1 });
  await sendComment(page, win);
}

/**
 * Press Comment and wait for its outcome. A space learned a moment ago may
 * still be connecting: the extension refuses the create at once, and the
 * composer keeps the text and says it wasn't sent. The person sends it again
 * (the create's nonce makes a repeat land once).
 */
async function sendComment(page: Page, win: Locator): Promise<void> {
  const send = win.getByRole("button", { name: "Comment", exact: true });
  const posted = overlay(page).getByText("comment posted");
  const notSent = win.getByText("Your comment wasn't sent.", { exact: false });
  for (let attempt = 1; attempt < 5; attempt++) {
    await send.click();
    await expect(posted.or(notSent)).toBeVisible();
    if (await posted.isVisible()) return;
  }
  await expect(posted).toBeVisible();
}

/** The pin on the page for a thread of `kind` ("Comment", "Edit"). */
export const pins = (page: Page): Locator => overlay(page).locator(".pin-layer .pin");

/**
 * The open thread: a comment opens in the interaction modal, an Edit in the
 * side panel. Either way the messages are `.msg` rows.
 */
export const threadView = (page: Page): Locator =>
  overlay(page).locator(".interaction-modal, .thread-panel").filter({ visible: true });

/** The messages in the open thread. */
export const threadMessages = (page: Page): Locator => threadView(page).locator(".msg");

/**
 * Opens a row of the toolbar popup's Inbox. Choosing a row closes the popup
 * (its click handler ends with `window.close()`), which can end the page while
 * Playwright is still settling the click: the popup closing is the outcome the
 * row asks for, not a failure, and it is waited for.
 */
export async function openPopupRow(popup: Page, text: string): Promise<void> {
  const closed = popup.waitForEvent("close");
  await popup
    .locator(".row")
    .filter({ hasText: text })
    .click()
    .catch((error: unknown) => {
      if (!popup.isClosed()) throw error;
    });
  await closed;
}
