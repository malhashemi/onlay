// Journey 2: two people in one workspace. Ada makes the workspace and invites
// Bea from the web app's settings; Ada comments on a block from the extension
// and mentions Bea; Bea's extension shows the pin and the thread on that page,
// her badge and her web app Inbox show it; Bea replies from the web app and
// Ada sees the reply arrive in the thread she has open.
import { expect, test } from "../harness/fixtures";
import { commentOnBlock, expectConnected, pins, threadMessages } from "../harness/overlay";
import { createWorkspace, inboxRow, invite, replyInThread, workspaceName } from "../harness/web";

test("a mention travels between two people in a workspace, and the reply comes back live", async ({
  origin,
  article,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  const bea = await extensionPerson("bea");

  const adaWeb = await ada.newPage();
  const space = workspaceName("acme");
  await createWorkspace(adaWeb, origin, space);
  await invite(adaWeb, bea.person.email);
  await expect(adaWeb.getByText(`${bea.person.email} · member`)).toBeVisible();

  const adaPage = await ada.newPage();
  await adaPage.goto(article);
  await expectConnected(adaPage);
  await commentOnBlock(adaPage, "#price", space, [
    { mention: "bea" },
    " is this the right yearly price?",
  ]);
  await expect(pins(adaPage)).toHaveCount(1);
  await pins(adaPage).click();
  await expect(threadMessages(adaPage)).toHaveCount(1);

  // Bea's extension: the pin and the thread on the page, and the badge.
  const beaPage = await bea.newPage();
  await beaPage.goto(article);
  await expectConnected(beaPage);
  await expect(pins(beaPage)).toHaveCount(1);
  await pins(beaPage).click();
  await expect(threadMessages(beaPage).first()).toContainText("is this the right yearly price?");
  await expect(threadMessages(beaPage).first().locator(".msg-author")).toHaveText("ada");
  // Her face is named by her name (initials here: she chose no picture).
  await expect(threadMessages(beaPage).first().getByRole("img", { name: "ada" })).toHaveText("A");
  await expect.poll(() => bea.badge()).toBe("1");

  // Bea's web app Inbox, then the thread, then her reply.
  const beaWeb = await bea.newPage();
  await beaWeb.goto(`${origin}/app/`);
  const row = inboxRow(beaWeb, "is this the right yearly price?");
  await expect(row).toBeVisible();
  // On the narrowest phone the row fits the screen and its text gets the
  // width: nothing scrolls sideways, and the title is not squeezed beside the chips.
  await beaWeb.setViewportSize({ width: 320, height: 800 });
  await expect
    .poll(() =>
      beaWeb.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBe(0);
  // Polled: the Inbox may build its rows again between the two measurements,
  // and a row taken out of the page has no box.
  await expect
    .poll(async () => {
      const rowBox = await row.boundingBox();
      const titleBox = await row.locator(".row-title").boundingBox();
      return titleBox && rowBox ? titleBox.width / rowBox.width : 0;
    })
    .toBeGreaterThan(0.6);
  await beaWeb.setViewportSize({ width: 1280, height: 1000 });
  await row.click();
  await replyInThread(beaWeb, "Yes, twelve is right.");

  // Ada sees it arrive in the thread she has open.
  await expect(threadMessages(adaPage)).toHaveCount(2);
  await expect(threadMessages(adaPage).nth(1)).toContainText("Yes, twelve is right.");
  await expect(threadMessages(adaPage).nth(1).locator(".msg-author")).toHaveText("bea");
});
