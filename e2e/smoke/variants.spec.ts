// Journey 5: an Edit with variants, kept (spec §8, §10). Ada asks for an Edit
// on a block with Variants; her agent posts two variants through MCP; she
// cycles them on the page and picks one. The page has no source an agent
// could change, so the pick is kept: after a reload the picked change is
// still applied, the launcher says edits are shown, and switching the edit
// off in the command bar brings the original back.
//
// The page stays on one exact URL: kept programs apply only where the page
// URL equals the Edit's. The person who makes the Edit is the one whose
// browser takes its looks.
import { expect, test } from "../harness/fixtures";
import { composerWindow, expectConnected, overlay, runCommand } from "../harness/overlay";

const ORIGINAL = "Twelve dollars a month, billed yearly.";
const CALM = "Twelve dollars a month.";
const BOLD = "Only twelve dollars a month, billed yearly.";

test("variants from an agent, picked and kept, can be switched off", async ({
  article,
  extensionPerson,
  mcp,
}) => {
  const ada = await extensionPerson("ada");
  const page = await ada.newPage();
  await page.goto(article);
  await expectConnected(page);
  const price = page.locator("#price");

  // Edit block → Variants.
  await runCommand(page, "Edit block");
  await price.click();
  const win = composerWindow(page);
  await expect(win).toBeVisible();
  await win.getByRole("button", { name: "Variants" }).click();
  await win.getByRole("textbox").click();
  await page.keyboard.type("Make the price line shorter");
  await win.getByRole("button", { name: "Generate variants" }).click();
  const panel = overlay(page).locator(".variant-panel");
  await expect(panel).toBeVisible();

  // Ada's agent: the Edit is hers to take; it posts two programs.
  const agent = mcp(ada.person);
  const inbox = await agent.call("inbox", { url: article });
  expect(inbox.text).toContain("Yours, handed to an agent by your person (1,");
  const ref = /^- (s_[a-z0-9]+\/\S+) · /m.exec(inbox.text)?.[1];
  expect(ref, inbox.text).toBeTruthy();
  expect((await agent.call("take", { ref })).isError).toBe(false);
  const posted = await agent.call("post_variants", {
    ref,
    variants: [
      { label: "Calm", program: [{ op: "setText", target: ":scope", text: CALM }] },
      { label: "Bold", program: [{ op: "setText", target: ":scope", text: BOLD }] },
    ],
  });
  expect(posted.isError, posted.text).toBe(false);

  // Cycle the previews on the page, settle on the second, pick it.
  await expect(price).toHaveText(CALM);
  await panel.getByRole("button", { name: "›" }).click();
  await expect(price).toHaveText(BOLD);
  await panel.getByRole("button", { name: "Pick active" }).click();
  await expect(price).toHaveText(BOLD);

  // Kept: the change is still applied after a reload, and the launcher says so.
  await page.reload();
  await expectConnected(page);
  await expect(price).toHaveText(BOLD);
  await expect(overlay(page).getByText(/1 edit shown/i)).toBeVisible();

  // Switched off in the command bar: the original is back, the marker gone.
  await runCommand(page, "Kept edits");
  const kept = overlay(page).locator(".command-bar").getByRole("switch");
  await expect(kept).toHaveAttribute("aria-checked", "true");
  await kept.click();
  await expect(price).toHaveText(ORIGINAL);
  await page.keyboard.press("Escape");
  await expect(overlay(page).getByText(/edits? shown/i)).toBeHidden();
});
