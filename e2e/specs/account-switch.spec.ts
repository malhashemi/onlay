// A draft belongs to an account (2-M1). Ada starts a Comment in a workspace
// she shares with Bea and leaves it unsent with the composer open; she signs
// out and leaves the tab open. The composer closes as she signs out. Bea signs
// in on the same browser and opens a Comment on the same block in the same
// workspace: she finds an empty composer, never Ada's words.
import { expect, signInFromPopup, test } from "../harness/fixtures";
import { composerWindow, expectConnected, overlay, runCommand } from "../harness/overlay";
import { createWorkspace, invite, workspaceName } from "../harness/web";

test.skip(process.env.E2E_SHADOW_MODE === "closed", "needs an open-root build");

async function useSpace(page: import("@playwright/test").Page, name: string): Promise<void> {
  await runCommand(page, "Switch space");
  const bar = overlay(page).locator(".command-bar");
  await bar
    .locator(".bar-row")
    .filter({ has: page.locator(".label", { hasText: new RegExp(`^${name}$`) }) })
    .click();
  if (await bar.isVisible()) await page.keyboard.press("Escape");
  await expect(bar).toBeHidden();
}

async function openComment(page: import("@playwright/test").Page, space: string) {
  await useSpace(page, space);
  await runCommand(page, "Comment on block");
  await page.locator("#price").click();
  const win = composerWindow(page);
  await expect(win).toBeVisible();
  return win;
}

test("the next person on a tab finds no draft of the last one, and nothing of theirs open", async ({
  origin,
  article,
  person,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  const bea = person("bea");
  const space = workspaceName("shared");
  const adaWeb = await ada.newPage();
  await createWorkspace(adaWeb, origin, space);
  await invite(adaWeb, bea.email);
  await adaWeb.close();

  const page = await ada.newPage();
  await page.goto(article);
  await expectConnected(page);
  const adaWin = await openComment(page, space);
  await adaWin.getByRole("textbox").click();
  await page.keyboard.type("Ada's unsent thought about the price");
  await expect(adaWin.getByRole("textbox")).toHaveText("Ada's unsent thought about the price");

  // Ada signs out from the popup; the page stays open, and her composer closes.
  const popup = await ada.popup();
  await popup.getByRole("button", { name: "Sign out" }).click();
  await expect(popup.getByText("Sign in to Onlay")).toBeVisible();
  await expect(composerWindow(page)).toBeHidden();
  await popup.close();

  // Bea signs in on the same browser (Ada's web session gone with her).
  await ada.context.clearCookies();
  const beaPopup = await signInFromPopup({ ...ada, person: bea });
  await beaPopup.close();
  await expectConnected(page);
  const beaWin = await openComment(page, space);
  await expect(beaWin.getByRole("textbox")).toHaveText("");
});
