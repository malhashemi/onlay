// Journey 1: a person signs in from the extension's popup, the overlay's
// launcher appears on the page they open, and signing out returns the popup
// to its signed-out view.
import { expect, signInFromPopup, test } from "../harness/fixtures";

test("sign in from the popup, see the launcher on a page, sign out", async ({
  person,
  launchExtension,
  article,
}) => {
  const ext = await launchExtension(person("ada"));

  const signedOut = await ext.popup();
  await expect(signedOut.getByText("Sign in to Onlay")).toBeVisible();
  await signedOut.close();

  const popup = await signInFromPopup(ext);

  const page = await ext.newPage();
  await page.goto(article);
  const orb = page
    .locator("[data-onlay-root]")
    .getByRole("button", { name: "Onlay — open your Inbox" });
  await expect(orb).toBeVisible();
  await expect(page.locator("[data-onlay-root] .orb-status.connected")).toBeAttached();

  await popup.bringToFront();
  await popup.getByRole("button", { name: "Sign out" }).click();
  await expect(popup.getByText("Sign in to Onlay")).toBeVisible();
  await expect(popup.getByRole("button", { name: "Sign in" })).toBeVisible();
});
