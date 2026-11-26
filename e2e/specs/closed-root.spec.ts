// The default build's overlay lives in a CLOSED shadow root: the page it sits
// on can neither read it nor drive it with made-up events. Playwright cannot
// reach inside a closed root either, so this spec only runs against a closed
// build (`E2E_SHADOW_MODE=closed bun run test:e2e:extra`) and checks from the
// page's own point of view. The smoke set runs on the open test build.
import { expect, signInFromPopup, test } from "../harness/fixtures";

const SHOTS = process.env.E2E_SHOTS_DIR;

test.skip(process.env.E2E_SHADOW_MODE !== "closed", "needs a closed-root build");

test("the page cannot reach into the overlay or open it with a made-up key press", async ({
  person,
  launchExtension,
  article,
}) => {
  const ext = await launchExtension(person("ada"));
  const popup = await signInFromPopup(ext);
  await popup.close();

  const page = await ext.newPage();
  await page.goto(article);
  await expect(page.locator("[data-onlay-root]")).toBeAttached();

  // What the page itself can see of the overlay: a host with no reachable root.
  const seen = await page.evaluate(() => {
    const host = document.querySelector("[data-onlay-root]");
    return {
      host: host !== null,
      root: host?.shadowRoot ?? null,
      lightChildren: host?.childElementCount ?? -1,
      lightText: host?.textContent ?? "",
    };
  });
  expect(seen).toEqual({ host: true, root: null, lightChildren: 0, lightText: "" });

  // A key press the page makes up does not open the command bar: the page
  // looks exactly as it did, byte for byte...
  await page.waitForTimeout(1500);
  const before = await page.screenshot();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/closed-root-1-launcher.png` });
  await page.evaluate(() => {
    for (const type of ["keydown", "keyup"]) {
      document.dispatchEvent(
        new KeyboardEvent(type, {
          key: ".",
          code: "Period",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  });
  await page.waitForTimeout(500);
  const afterFake = await page.screenshot();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/closed-root-2-after-fake-key.png` });
  expect(afterFake.equals(before)).toBe(true);

  // ...while a real one does, and still none of its text reaches the page.
  await page.locator("body").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Control+.");
  await page.waitForTimeout(500);
  const afterReal = await page.screenshot();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/closed-root-3-after-real-key.png` });
  // ...while the real one visibly opened it.
  expect(afterReal.equals(before)).toBe(false);
  const text = await page.evaluate(() => document.documentElement.innerText);
  expect(text).not.toContain("Copy block HTML");
  expect(text).not.toContain("Inbox");
});
