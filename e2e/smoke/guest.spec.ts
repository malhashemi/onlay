// Journey 3: a guest. Ada shares one thread with an outside email from the
// extension; the guest signs in to the web app and sees exactly that thread,
// none of the workspace's people or settings, and replies; a second thread
// in the same space stays invisible to them, even by direct link.
import { expect, test } from "../harness/fixtures";
import { commentOnBlock, expectConnected, openPopupRow, threadView } from "../harness/overlay";
import { createWorkspace, inboxRow, replyInThread, workspaceName } from "../harness/web";

test("a guest sees exactly the one thread shared with them", async ({
  origin,
  article,
  person,
  extensionPerson,
  webPerson,
}) => {
  const ada = await extensionPerson("ada");
  const space = workspaceName("studio");
  const adaWeb = await ada.newPage();
  await createWorkspace(adaWeb, origin, space);

  const page = await ada.newPage();
  await page.goto(article);
  await expectConnected(page);
  await commentOnBlock(page, "#price", space, ["Can you confirm this price?"]);
  await commentOnBlock(page, "#studio-price", space, ["Internal: the margin here is thin."]);

  // Share the first thread from the extension: the popup's row opens the
  // thread beside the page, where Share lives.
  const cal = person("cal");
  const popup = await ada.popup();
  await openPopupRow(popup, "Can you confirm this price?");
  const panel = threadView(page);
  await expect(panel).toContainText("Can you confirm this price?");
  await panel.getByRole("button", { name: "Share", exact: true }).click();
  await panel.getByLabel("Email to share this thread with").fill(cal.email);
  await panel.locator(".share-section").getByRole("button", { name: "Share" }).click();
  await expect(panel.locator(".share-section .pick-item")).toHaveText([`${cal.email}Remove`]);

  // Each thread's link, as Ada's web app shows it. onlay sends no email: Ada
  // hands the shared link to the guest herself.
  const linkOf = async (text: string): Promise<string> => {
    await adaWeb.goto(`${origin}/app/`);
    await inboxRow(adaWeb, text).click();
    await expect(adaWeb.locator(".thread")).toContainText(text);
    return adaWeb.url();
  };
  const sharedLink = await linkOf("Can you confirm this price?");
  const hiddenLink = await linkOf("Internal: the margin here is thin.");

  // The guest opens the link they were given: that thread, and they reply.
  const guest = await webPerson(cal);
  const g = guest.page;
  await g.goto(sharedLink);
  await expect(g.locator(".thread")).toContainText("Can you confirm this price?");
  await expect(g.getByRole("button", { name: "Resolve" })).toHaveCount(0);
  await replyInThread(g, "Confirmed, that's the price.");

  // Their Inbox holds that thread and nothing else of the workspace.
  await g.goto(`${origin}/app/`);
  await expect(inboxRow(g, "Can you confirm this price?")).toBeVisible();
  await expect(inboxRow(g, "Internal: the margin here is thin.")).toHaveCount(0);
  await g.goto(`${origin}/app/#/settings/spaces`);
  await expect(g.getByText(space)).toHaveCount(0);

  // The other thread, even by direct link, is not there for them.
  await g.goto(hiddenLink);
  await expect(g.getByText("This isn't here.")).toBeVisible();
  await expect(g.getByText("Internal: the margin here is thin.")).toHaveCount(0);

  // Ada sees the guest's reply in the thread beside the page.
  await expect(panel).toContainText("Confirmed, that's the price.");
});
