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

/** Ask for Variants on #price and have the agent post `variants`; the panel opens. */
async function variantsOnPrice(
  page: import("@playwright/test").Page,
  article: string,
  agent: {
    call: (
      tool: string,
      args: Record<string, unknown>,
    ) => Promise<{ text: string; isError: boolean }>;
  },
  variants: Array<{ label: string; program: unknown[] }>,
) {
  await runCommand(page, "Edit block");
  // On the price's own text, at its start: the block picked is #price itself.
  await page.locator("#price").click({ position: { x: 6, y: 8 } });
  const win = composerWindow(page);
  await expect(win).toBeVisible();
  await win.getByRole("button", { name: "Variants" }).click();
  await win.getByRole("textbox").click();
  await page.keyboard.type("Variants for the price");
  await win.getByRole("button", { name: "Generate variants" }).click();
  const panel = overlay(page).locator(".variant-panel");
  await expect(panel).toBeVisible();
  const inbox = await agent.call("inbox", { url: article });
  const ref = /^- (s_[a-z0-9]+\/\S+) · /m.exec(inbox.text)?.[1];
  expect(ref, inbox.text).toBeTruthy();
  const posted = await agent.call("post_variants", { ref, variants });
  expect(posted.isError, posted.text).toBe(false);
  return panel;
}

test("a var() shorthand, a longhand over it and overlapping ops all come off exactly (audit 4)", async ({
  article,
  extensionPerson,
  mcp,
}) => {
  const ada = await extensionPerson("ada");
  const page = await ada.newPage();
  await page.goto(article);
  await expectConnected(page);
  const price = page.locator("#price");
  const ORIGINAL = "--gap: 11px; padding: var(--gap) !important;";
  await price.evaluate((el, style) => el.setAttribute("style", style), ORIGINAL);
  const paddingLeft = () => price.evaluate((el) => getComputedStyle(el).paddingLeft);
  expect(await paddingLeft()).toBe("11px");

  const panel = await variantsOnPrice(page, article, mcp(ada.person), [
    {
      label: "Shorthand",
      program: [
        { op: "setStyle", target: ":scope", props: [{ prop: "padding", value: "30px" }] },
        { op: "setText", target: ".not-on-this-page", text: "never" },
      ],
    },
    {
      label: "Longhand",
      program: [
        { op: "setStyle", target: ":scope", props: [{ prop: "padding-left", value: "2px" }] },
      ],
    },
    {
      label: "Overlapping",
      program: [
        { op: "setStyle", target: ":scope", props: [{ prop: "padding-left", value: "3px" }] },
        { op: "setStyle", target: ":scope", props: [{ prop: "padding", value: "40px" }] },
        { op: "setStyle", target: ":scope", props: [{ prop: "color", value: "red" }] },
      ],
    },
  ]);
  const next = panel.getByRole("button", { name: "›" });
  // Variant 1 is on, then each next stop restores before it applies.
  await expect.poll(paddingLeft).not.toBe("11px");
  await next.click();
  await expect(panel).toContainText("2/3");
  await next.click();
  await expect(panel).toContainText("3/3");
  await expect.poll(paddingLeft).toBe("40px");
  // Past the last: the Original, exactly the page's own style again.
  await next.click();
  await expect(panel).toContainText("Original");
  await expect.poll(() => price.getAttribute("style")).toBe(ORIGINAL);
  expect(await paddingLeft()).toBe("11px");
});

test("a variant on a block that keeps re-rendering can be picked (audit, round 3)", async ({
  article,
  extensionPerson,
  mcp,
}) => {
  const ada = await extensionPerson("ada");
  const page = await ada.newPage();
  await page.goto(article);
  await expectConnected(page);
  // A ticker inside the block re-renders it every 50 ms; it changes no step's target.
  await page.locator("#price").evaluate((el) => {
    const tick = document.createElement("span");
    tick.className = "tick";
    el.append(tick);
    setInterval(() => {
      tick.textContent = String(Date.now());
    }, 50);
  });
  const panel = await variantsOnPrice(page, article, mcp(ada.person), [
    {
      label: "Red",
      program: [
        { op: "setStyle", target: ":scope", props: [{ prop: "color", value: "rgb(200, 0, 0)" }] },
      ],
    },
  ]);
  await expect(panel).toContainText("1/1");
  await expect
    .poll(() => page.locator("#price").evaluate((el) => getComputedStyle(el).color))
    .toBe("rgb(200, 0, 0)");
  await page.waitForTimeout(300); // several re-renders while the preview holds
  await panel.getByRole("button", { name: "Pick active" }).click();
  await expect(overlay(page).getByText("variant pick ✓")).toBeVisible();
});
