// The overlay under the strictest useful page policy (`script-src 'self';
// style-src 'self'; connect-src 'self'`): it mounts, copies a block's HTML,
// posts a comment, shows a reply's fenced block colored and copyable, and
// the page records no violation attributed to the extension. The page's own inline canary proves the policy is enforced.
import { expect, test } from "../harness/fixtures";
import {
  commentOnBlock,
  expectConnected,
  overlay,
  pins,
  runCommand,
  threadView,
} from "../harness/overlay";

// It drives and reads the overlay, which only an open-root test build exposes.
test.skip(process.env.E2E_SHADOW_MODE === "closed", "needs an open-root build");

test("the overlay works on a strict-CSP page without a single violation of its own", async ({
  pages,
  extensionPerson,
  mcp,
}) => {
  const ada = await extensionPerson("ada");
  await ada.context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: pages.base,
  });
  const page = await ada.newPage();
  await page.goto(`${pages.base}/strict.html`);

  await expect(page.locator("#canary-status")).toHaveText(/did NOT run/);
  await expect(page.locator("#counter-btn")).toHaveText("Clicked 0 times");
  await expectConnected(page);

  await runCommand(page, "Copy block HTML");
  await page.locator("#title").click();
  await expect(overlay(page).locator(".toast")).toHaveText(/block HTML copied \(\d+ chars\)/);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('id="title"');

  await commentOnBlock(page, "#card-alpha h2", null, [
    { mention: "agent" },
    " Works under a strict policy.",
  ]);
  await expect(pins(page)).toHaveCount(1);

  // A reply with a fenced block: colored and copyable under the page's policy.
  const agent = mcp(ada.person);
  await agent.initialize();
  const inbox = await agent.call("inbox", { url: `${pages.base}/strict.html` });
  const ref = /^- (s_[a-z0-9]+\/\S+) · /m.exec(inbox.text)?.[1];
  expect(ref, inbox.text).toBeTruthy();
  await agent.call("reply", { ref, text: "Try:\n```bash\necho strict\n```" });
  await pins(page).click();
  const block = threadView(page).locator(".code-block");
  await expect(block.locator(".code-text span").first()).toBeVisible();
  await block.getByRole("button", { name: "Copy code" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("echo strict");

  const violations = await page.evaluate(
    () => (window as unknown as { __cspViolations: Array<{ sourceFile: string }> }).__cspViolations,
  );
  expect(violations.filter((v) => v.sourceFile?.includes("chrome-extension"))).toEqual([]);
});
