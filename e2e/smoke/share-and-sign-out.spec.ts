// Journey 6: two server behaviours nothing else drives end to end. Ada
// shares a thread with an outside email; that person signs in to the web app
// for the first time and finds the thread in their Inbox, marked "Shared with
// you", without being handed any link. Then Ada signs out everywhere from the
// web app, and her still-open extension stops hearing the space: its
// launcher shows signed out within seconds, the web app shows the landing
// page, and her other web app tab stays where it is and says she was signed
// out, with one way back in.
import { expect, test } from "../harness/fixtures";
import {
  commentOnBlock,
  expectConnected,
  openPopupRow,
  overlay,
  threadView,
} from "../harness/overlay";
import { createWorkspace, inboxRow, workspaceName } from "../harness/web";

test("a share reaches the guest's Inbox unprompted; signing out everywhere cuts the open extension", async ({
  origin,
  article,
  person,
  extensionPerson,
  webPerson,
}) => {
  const ada = await extensionPerson("ada");
  const space = workspaceName("atelier");
  const adaWeb = await ada.newPage();
  await createWorkspace(adaWeb, origin, space);

  const page = await ada.newPage();
  await page.goto(article);
  await expectConnected(page);
  await commentOnBlock(page, "#price", space, ["Is this the launch price?"]);

  // Share it with someone who has never signed in.
  const dee = person("dee");
  const popup = await ada.popup();
  await openPopupRow(popup, "Is this the launch price?");
  const panel = threadView(page);
  await expect(panel).toContainText("Is this the launch price?");
  await panel.getByRole("button", { name: "Share", exact: true }).click();
  await panel.getByLabel("Email to share this thread with").fill(dee.email);
  await panel.locator(".share-section").getByRole("button", { name: "Share" }).click();
  await expect(panel.locator(".share-section .pick-item")).toHaveText([`${dee.email}Remove`]);

  // Dee signs in to the web app and, with no link, finds it waiting for her.
  const guest = await webPerson(dee);
  const row = inboxRow(guest.page, "Is this the launch price?");
  await expect(row).toBeVisible();
  await expect(row.getByText("Shared with you")).toBeVisible();

  // Ada signs out everywhere from the web app; her extension, still open on
  // the page, is cut off and its launcher says so.
  await popup.close();
  const adaOther = await ada.newPage();
  await adaOther.goto(`${origin}/app/`);
  await expect(inboxRow(adaOther, "Is this the launch price?")).toBeVisible();
  await adaWeb.goto(`${origin}/app/#/settings/account`);
  await adaWeb.getByRole("button", { name: "Sign out everywhere" }).click();
  await adaWeb.getByRole("button", { name: "Tap again to sign out everywhere" }).click();
  await expect(overlay(page).locator(".orb-status.offline")).toBeAttached({ timeout: 8_000 });
  // The web app lands on the landing page, with its way back in.
  await expect(adaWeb).toHaveURL(`${origin}/`);
  await expect(
    adaWeb.locator("header").getByRole("link", { name: "Open web app" }),
  ).toHaveAttribute("href", `${origin}/app/`);
  // Her other tab never goes anywhere by itself: it says so, and offers sign-in.
  await expect(adaOther.getByText("You were signed out.")).toBeVisible();
  await expect(adaOther.getByRole("button", { name: "Sign in" })).toBeVisible();
  expect(new URL(adaOther.url()).pathname).toBe("/app/");
});
