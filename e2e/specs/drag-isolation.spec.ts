// Drag isolation: a visited page listens on window and document, in both
// phases, for every pointer, capture, mouse, touch and click event, whatever
// its target. A person drags the launcher, the thread panel by its header and
// by its resize grip, and a composer card by its header, with a mouse and
// with a finger (real input through the browser). Each surface moves, and the
// page records nothing from the press until well after the release. The
// launcher's markers keep their own click: "edits shown" opens Kept edits,
// "for agent" copies the round, and neither opens the Inbox.
//
// The first two read inside the overlay's root, so they run against the open
// test build only; the launcher's drag by coordinates runs on the closed
// (production-shaped) build too, from the page's own point of view.
import type { CDPSession, Page } from "@playwright/test";
import { expect, test } from "../harness/fixtures";
import { composerWindow, expectConnected, overlay, pins, runCommand } from "../harness/overlay";

const CLOSED = process.env.E2E_SHADOW_MODE === "closed";

/** Every event of a gesture a page can listen for (drag-router.ts `GESTURE_EVENTS`, and a drag of its own). */
const TYPES = [
  "pointerdown",
  "pointermove",
  "pointerrawupdate",
  "pointerup",
  "pointercancel",
  "gotpointercapture",
  "lostpointercapture",
  "pointerover",
  "pointerout",
  "pointerenter",
  "pointerleave",
  "mousedown",
  "mousemove",
  "mouseup",
  "mouseover",
  "mouseout",
  "mouseenter",
  "mouseleave",
  "touchstart",
  "touchmove",
  "touchend",
  "touchcancel",
  "click",
  "auxclick",
  "dblclick",
  "contextmenu",
  "dragstart",
];

/** The page's own listeners, added the way any page script adds them: every target counts. */
async function listen(page: Page): Promise<void> {
  await page.evaluate((types) => {
    const w = window as unknown as { __drag: string[] };
    w.__drag = [];
    for (const type of types)
      for (const where of [window, document])
        for (const capture of [true, false])
          where.addEventListener(
            type,
            (e) => {
              const t = e.target as Element | null;
              w.__drag.push(`${type}@${t?.localName ?? t?.nodeName ?? "window"}`);
            },
            { capture, passive: true },
          );
  }, TYPES);
}

const seen = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __drag: string[] }).__drag.splice(0));

/** The gesture's trailing events (compatibility, capture lost, click) are in by then. */
const settle = (page: Page) => page.waitForTimeout(300);

/** Press at the middle of `box`, move by (dx, dy) in steps, release; what the page heard. */
async function drag(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
  dx: number,
  dy: number,
): Promise<string[]> {
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await settle(page);
  await seen(page); // hovering onto it is not part of the drag
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 6 });
  await page.mouse.up();
  await settle(page);
  return seen(page);
}

/** The same with a finger: real touch input through the browser (CDP). */
async function touchDrag(
  page: Page,
  cdp: CDPSession,
  box: { x: number; y: number; width: number; height: number },
  dx: number,
  dy: number,
): Promise<string[]> {
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  // The mouse rests far from the drag, so its own hover (the surface moving
  // out from under it) is not mistaken for the finger's gesture.
  await page.mouse.move(2, 2);
  await settle(page);
  await seen(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 6; i += 1)
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x + (dx * i) / 6, y: y + (dy * i) / 6 }],
    });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await settle(page);
  return seen(page);
}

async function boxOf(page: Page, selector: string) {
  const b = await overlay(page).locator(selector).first().boundingBox();
  if (!b) throw new Error(`no box for ${selector}`);
  return b;
}

test("the page never sees a drag of the launcher, the thread panel or a composer card, by mouse or by finger", async ({
  pages,
  extensionPerson,
}) => {
  test.skip(CLOSED, "reads inside the overlay's root");
  const ada = await extensionPerson("ada");
  const page = await ada.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${pages.base}/listeners.html`);
  await expectConnected(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await listen(page);

  // The page's listeners hear what the browser sends them: a click of its own is heard.
  await page.locator("#headline").click();
  await settle(page);
  expect(await seen(page)).toContain("click@h1");

  // The launcher, by mouse and by finger.
  const orb = await boxOf(page, ".orb");
  expect(await drag(page, orb, -300, -200)).toEqual([]);
  const orbNow = await boxOf(page, ".orb");
  expect(Math.round(orb.y - orbNow.y)).toBeGreaterThan(100);
  expect(await touchDrag(page, cdp, orbNow, 200, 100)).toEqual([]);
  const orbTouched = await boxOf(page, ".orb");
  expect(Math.round(orbTouched.y - orbNow.y)).toBeGreaterThan(50);
  // The drags never opened the Inbox: the command bar stays shut.
  await expect(overlay(page).locator(".command-bar")).toBeHidden();

  // A composer card, by its header.
  await runCommand(page, "Edit block");
  await page.locator("#price").click();
  const win = composerWindow(page);
  await expect(win).toBeVisible();
  const winHead = await boxOf(page, ".composer-window .card-head .title");
  const winBefore = await win.boundingBox();
  expect(await drag(page, winHead, 60, 40)).toEqual([]);
  expect((await win.boundingBox())?.x).not.toBe(winBefore?.x);
  await win.getByRole("textbox").click();
  await page.keyboard.type("Say it monthly");
  await win.getByRole("button", { name: "Request edit" }).click();
  await expect(win).toContainText("Edit sent.");
  await win.getByRole("button", { name: "Done" }).click();

  // The thread panel: an Edit's pin opens it beside the page.
  await pins(page).first().click();
  const panel = overlay(page).locator(".thread-panel");
  await expect(panel).toBeVisible();
  const before = await panel.boundingBox();
  const head = await boxOf(page, ".thread-panel .card-head .title");
  expect(await drag(page, head, -200, 80)).toEqual([]);
  const moved = await panel.boundingBox();
  expect(Math.abs((moved?.y ?? 0) - (before?.y ?? 0) - 80)).toBeLessThanOrEqual(1);
  // By finger.
  const headNow = await boxOf(page, ".thread-panel .card-head .title");
  expect(await touchDrag(page, cdp, headNow, -40, 30)).toEqual([]);
  const touched = await panel.boundingBox();
  // A finger moves it the whole way (its header takes the touch: no pan cancels the drag).
  expect(Math.abs((touched?.y ?? 0) - (moved?.y ?? 0) - 30)).toBeLessThanOrEqual(2);
  // Its resize grip.
  const grip = await boxOf(page, ".thread-panel .panel-grip");
  expect(await drag(page, grip, -60, 50)).toEqual([]);
  const resized = await panel.boundingBox();
  expect(Math.abs((resized?.width ?? 0) - (touched?.width ?? 0) - 60)).toBeLessThanOrEqual(1);
});

const ORIGINAL = "Twelve dollars a month, billed yearly.";

test("a click on a launcher marker is the marker's: Kept edits, or the round copied, never the Inbox", async ({
  article,
  extensionPerson,
  mcp,
}) => {
  test.skip(CLOSED, "reads inside the overlay's root");
  const ada = await extensionPerson("ada");
  await ada.context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(article).origin,
  });
  const page = await ada.newPage();
  await page.goto(article);
  await expectConnected(page);
  const price = page.locator("#price");
  await expect(price).toHaveText(ORIGINAL);

  // An Edit with variants, picked: kept on this page, so the launcher says "1 edit shown".
  await runCommand(page, "Edit block");
  await price.click();
  const win = composerWindow(page);
  await win.getByRole("button", { name: "Variants" }).click();
  await win.getByRole("textbox").click();
  await page.keyboard.type("Make the price line shorter");
  await win.getByRole("button", { name: "Generate variants" }).click();
  const variantPanel = overlay(page).locator(".variant-panel");
  await expect(variantPanel).toBeVisible();
  const agent = mcp(ada.person);
  const inbox = await agent.call("inbox", { url: article });
  const ref = /^- (s_[a-z0-9]+\/\S+) · /m.exec(inbox.text)?.[1];
  expect(ref, inbox.text).toBeTruthy();
  expect((await agent.call("take", { ref })).isError).toBe(false);
  const posted = await agent.call("post_variants", {
    ref,
    variants: [
      { label: "Calm", program: [{ op: "setText", target: ":scope", text: "Twelve a month." }] },
    ],
  });
  expect(posted.isError, posted.text).toBe(false);
  await expect(price).toHaveText("Twelve a month.");
  await variantPanel.getByRole("button", { name: "Pick active" }).click();
  await page.reload();
  await expectConnected(page);
  const keptNote = overlay(page)
    .locator(".orb-note")
    .filter({ hasText: /edit shown/ });
  await expect(keptNote).toBeVisible();

  // Its click opens Kept edits, not the Inbox.
  await keptNote.click();
  const bar = overlay(page).locator(".command-bar");
  await expect(bar.getByRole("switch")).toBeVisible();
  // Escape pops the bar's mode, then closes it.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(bar).toBeHidden();

  // A Direct Edit waits for an agent: "1 for agent" on the launcher.
  await runCommand(page, "Edit block");
  await page.locator("#lede").click();
  await win.getByRole("textbox").click();
  await page.keyboard.type("Say it monthly");
  await win.getByRole("button", { name: "Request edit" }).click();
  await win.getByRole("button", { name: "Done" }).click();
  const agentNote = overlay(page).locator(".orb-note.agent");
  await expect(agentNote).toBeVisible();
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await agentNote.click();
  // The round is on the clipboard, and the Inbox never opened.
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("round");
  await expect(bar).toBeHidden();
});

/** Whether the page's own hit test at a point lands on the overlay's host (open or closed). */
const onHost = (page: Page, x: number, y: number): Promise<boolean> =>
  page.evaluate(
    ([px, py]) =>
      document.elementFromPoint(px as number, py as number)?.hasAttribute("data-onlay-root") ??
      false,
    [x, y],
  );

test("the page never sees the launcher's drag or its click, by coordinates, under either root", async ({
  pages,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  const page = await ada.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${pages.base}/listeners.html`);
  // The orb sits 18px in from the bottom right, 46px across: the page sees only its host there.
  const orb = { x: 1280 - 18 - 23, y: 900 - 18 - 23 };
  await expect.poll(() => onHost(page, orb.x, orb.y), { timeout: 15_000 }).toBe(true);
  await listen(page);

  const to = { x: orb.x - 400, y: orb.y - 300 };
  await page.mouse.move(orb.x, orb.y);
  await settle(page);
  await seen(page);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  await settle(page);
  // Nothing of the drag, nor its click, reached the page's listeners.
  expect(await seen(page)).toEqual([]);
  // The orb moved where it was dragged, and the drag opened nothing over the page.
  await expect.poll(() => onHost(page, to.x, to.y)).toBe(true);
  expect(await onHost(page, orb.x, orb.y)).toBe(false);
  expect(await onHost(page, 640, 150)).toBe(false);
});
