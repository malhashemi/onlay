// A partly applied variant comes off without taking the page's own inline
// style with it (audit 4). Chromium, not happy-dom: a shorthand has no value of
// its own when only some of its longhands are set, and only a real browser
// serialises that faithfully. The block starts with `padding-left: 11px`; the
// variant sets `padding` and misses a second step; back on the Original, the
// page's `padding-left` is still there.
import { expect, test } from "../harness/fixtures";
import { composerWindow, expectConnected, overlay, runCommand } from "../harness/overlay";

test("the Original after a partly applied variant keeps the page's own longhand style", async ({
  article,
  extensionPerson,
  mcp,
}) => {
  const ada = await extensionPerson("ada");
  const page = await ada.newPage();
  await page.goto(article);
  await expectConnected(page);
  const price = page.locator("#price");
  await price.evaluate((el) => {
    (el as HTMLElement).style.setProperty("padding-left", "11px");
  });

  await runCommand(page, "Edit block");
  await price.click();
  const win = composerWindow(page);
  await expect(win).toBeVisible();
  await win.getByRole("button", { name: "Variants" }).click();
  await win.getByRole("textbox").click();
  await page.keyboard.type("More room around the price");
  await win.getByRole("button", { name: "Generate variants" }).click();
  const panel = overlay(page).locator(".variant-panel");
  await expect(panel).toBeVisible();

  const agent = mcp(ada.person);
  const inbox = await agent.call("inbox", { url: article });
  const ref = /^- (s_[a-z0-9]+\/\S+) · /m.exec(inbox.text)?.[1];
  expect(ref, inbox.text).toBeTruthy();
  const posted = await agent.call("post_variants", {
    ref,
    variants: [
      {
        label: "Roomy",
        program: [
          { op: "setStyle", target: ":scope", props: [{ prop: "padding", value: "30px" }] },
          { op: "setText", target: ".not-on-this-page", text: "never" },
        ],
      },
    ],
  });
  expect(posted.isError, posted.text).toBe(false);

  // The variant is on, in part: its shorthand overrode the page's longhand.
  await expect(panel.getByText("1 of 2 steps couldn't be applied")).toBeVisible();
  await expect
    .poll(() => price.evaluate((el) => (el as HTMLElement).style.paddingTop))
    .toBe("30px");

  // Back to the Original: exactly the page's own inline style again.
  await panel.getByRole("button", { name: "‹" }).click();
  await expect
    .poll(() => price.evaluate((el) => (el as HTMLElement).style.paddingLeft))
    .toBe("11px");
  expect(await price.evaluate((el) => (el as HTMLElement).style.paddingTop)).toBe("");
});
