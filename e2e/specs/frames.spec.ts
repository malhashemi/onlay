// Blocks inside a cross-origin frame (round 3, F-8). The fixture mirrors a
// Dossier page: the top document is only a sandboxed frame that loads the
// real page from another origin. Reads inside the overlay's root, so it runs
// against the open test build only.
import { writeFileSync } from "node:fs";
import type { FrameLocator, Locator, Page } from "@playwright/test";
import { type ExtensionHandle, expect, signInFromPopup, test } from "../harness/fixtures";
import {
  composerWindow,
  expectConnected,
  overlay,
  type Part,
  pins,
  runCommand,
  typeParts,
} from "../harness/overlay";
import { type PageServer, startPageServer } from "../harness/page-server";
import { createWorkspace, invite, workspaceName } from "../harness/web";

test.skip(process.env.E2E_SHADOW_MODE === "closed", "reads inside the overlay's root");

let content: PageServer;
test.beforeAll(async () => {
  // A second origin for the frame's page: `localhost` where the shell is `127.0.0.1`.
  content = await startPageServer({ host: "localhost" });
});
test.afterAll(async () => {
  await content.stop();
});

const shellUrl = (
  base: string,
  foreign?: string,
  opts: {
    notice?: boolean;
    clear?: boolean;
    lead?: boolean;
    transform?: string;
    live?: boolean;
    twin?: boolean;
    tiltblank?: boolean;
  } = {},
): string =>
  `${base}/dossier-shell.html?content=${encodeURIComponent(content.base)}${
    foreign ? `&foreign=${encodeURIComponent(foreign)}` : ""
  }${opts.notice ? "&notice=1" : ""}${opts.clear ? "&clear=1" : ""}${opts.lead ? "&lead=1" : ""}${
    opts.transform ? `&transform=${encodeURIComponent(opts.transform)}` : ""
  }${opts.live ? "&live=1" : ""}${opts.twin ? "&twin=1" : ""}${opts.tiltblank ? "&tiltblank=1" : ""}`;

const inFrame = (page: Page): FrameLocator => page.frameLocator("#dossier-page");
const framePins = (page: Page) =>
  inFrame(page).locator("[data-onlay-root]").locator(".pin-layer .pin");

/**
 * Pick `block`, inside a frame, for the top frame's running pick: the pick
 * reaches each frame through the service worker, so first hover the block
 * until the frame that owns it (`owner`) shows its hover box (the pick is
 * armed there), then click it.
 */
async function pickIn(
  page: Page,
  owner: FrameLocator,
  block: Locator,
  position?: { x: number; y: number },
): Promise<void> {
  await armIn(page, owner, block, position);
  await block.click(position ? { position } : {});
}

/** Hover `block` until the frame that owns it shows its hover box: the pick is armed there. */
async function armIn(
  _page: Page,
  owner: FrameLocator,
  block: Locator,
  position?: { x: number; y: number },
): Promise<void> {
  const box = owner.locator("[data-onlay-root] .box:not(.sel)").first();
  let nudge = 0;
  await expect(async () => {
    // Playwright's own hover brings the block into view; a pixel's nudge each
    // try makes it a move the frame hears.
    nudge = 1 - nudge;
    const b = await block.boundingBox();
    if (!b) throw new Error("no block box");
    const at = position ?? { x: Math.round(b.width / 2), y: Math.round(b.height / 2) };
    await block.hover({ position: { x: at.x + nudge, y: at.y } });
    await expect(box).toBeVisible({ timeout: 250 });
    // A look still grabbing (an earlier comment's) hides every frame's overlay,
    // up to 10 s a hold: the box shows once it lets go.
  }).toPass({ timeout: 30_000 });
}

/** Opens the shell and waits for both overlays: the top frame's and the frame's. */
async function openShell(ext: ExtensionHandle, url: string): Promise<Page> {
  const page = await ext.newPage();
  await page.goto(url);
  await expectConnected(page);
  await expect(inFrame(page).locator(":root > [data-onlay-root]")).toBeAttached();
  await expect(inFrame(page).locator("#goal-text")).toBeVisible();
  return page;
}

/** Comment on block, the block picked inside the frame; the composer is the top frame's. */
async function commentInFrame(page: Page, selector: string, parts: Part[]): Promise<void> {
  await runCommand(page, "Comment on block");
  await pickIn(page, inFrame(page), inFrame(page).locator(selector));
  const win = composerWindow(page);
  await expect(win).toBeVisible();
  await typeParts(page, win.getByRole("textbox"), parts);
  await win.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(overlay(page).getByText("comment posted")).toBeVisible();
}

test("a comment on a block inside another site's frame: pin in the frame, thread in the top frame, the shared page in the Inbox", async ({
  pages,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  const shell = shellUrl(pages.base);
  const page = await openShell(ada, shell);

  await commentInFrame(page, "#goal-text", ["Is this the plan for Q3?"]);

  // The pin is on the block, inside the frame.
  await expect(framePins(page)).toHaveCount(1);
  // The frame's own overlay shows no composer or thread: those are the top frame's.
  await expect(inFrame(page).locator("[data-onlay-root] .composer-window")).toHaveCount(0);
  await framePins(page).click();
  const modal = overlay(page).locator(".interaction-modal");
  await expect(modal).toBeVisible();
  await expect(modal.locator(".msg").first()).toContainText("Is this the plan for Q3?");
  // The thread's page line is the page the person shares, not the frame's own address.
  await expect(modal.locator(".im-context")).toContainText(`${pages.base}/dossier-shell.html`);
  await expect(modal.locator(".im-context")).not.toContainText(content.base);

  // A reply from the top frame's modal is sent by the frame that owns the block.
  const reply = modal.getByRole("textbox").last();
  await reply.click();
  await page.keyboard.type("Yes, with the hiring line.");
  await modal.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(modal.locator(".msg")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();

  // The Inbox row names the page the person shares.
  const popup = await ada.popup();
  const row = popup.locator(".row").filter({ hasText: "Is this the plan for Q3?" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("dossier-shell.html");
  await expect(row).not.toContainText("dossier-content.html");
});

test("a second person in the space sees the frame's comment on reload, and an agent reads it with the shared page", async ({
  origin,
  pages,
  extensionPerson,
  mcp,
}) => {
  const ada = await extensionPerson("ada");
  const bea = await extensionPerson("bea");
  const adaWeb = await ada.newPage();
  const space = workspaceName("dossier");
  await createWorkspace(adaWeb, origin, space);
  await invite(adaWeb, bea.person.email);

  const shell = shellUrl(pages.base);
  const page = await openShell(ada, shell);
  await runCommand(page, "Switch space");
  await overlay(page)
    .locator(".command-bar .bar-row")
    .filter({ has: page.locator(".label", { hasText: new RegExp(`^${space}$`) }) })
    .click();
  // The bar may close by itself or wait in a mode; Escape steps it shut, as many times as it takes.
  const bar = overlay(page).locator(".command-bar");
  await expect(async () => {
    if (await bar.isVisible()) await page.keyboard.press("Escape");
    await expect(bar).toBeHidden({ timeout: 500 });
  }).toPass();
  await commentInFrame(page, "#notes-text", [{ mention: "agent" }, " are these notes current?"]);
  await expect(framePins(page)).toHaveCount(1);

  const beaPage = await openShell(bea, shell);
  await expect(framePins(beaPage)).toHaveCount(1);
  await beaPage.reload();
  await expect(inFrame(beaPage).locator("#notes-text")).toBeVisible();
  await expect(framePins(beaPage)).toHaveCount(1);
  await framePins(beaPage).click();
  await expect(overlay(beaPage).locator(".interaction-modal .msg").first()).toContainText(
    "are these notes current?",
  );

  // Ada's agent reads it: the frame's own address is the page, and the page
  // the person shares is named beside it.
  const agent = mcp(ada.person);
  await agent.initialize();
  const inbox = await agent.call("inbox", {});
  expect(inbox.text).toContain("are these notes current?");
  const ref = /^- (s_[a-z0-9]+\/\S+) · /m.exec(inbox.text)?.[1];
  expect(ref, inbox.text).toBeTruthy();
  const read = await agent.call("read", { ref });
  expect(read.isError, read.text).toBe(false);
  expect(read.text).toContain(`Page: ⟦${content.base}/dossier-content.html⟧`);
  expect(read.text).toContain(`Inside a frame of: ⟦${pages.base}/dossier-shell.html?…⟧`);
});

test("a Direct Edit on a block inside the frame: sent through the frame, handed to an agent, moved by it", async ({
  pages,
  extensionPerson,
  mcp,
}) => {
  const ada = await extensionPerson("ada");
  const page = await openShell(ada, shellUrl(pages.base));

  await runCommand(page, "Edit block");
  await pickIn(page, inFrame(page), inFrame(page).locator("#notes-text"));
  const win = composerWindow(page);
  await expect(win).toBeVisible();
  await win.getByRole("textbox").click();
  await page.keyboard.type("Say which week the notes are from");
  await win.getByRole("button", { name: "Request edit" }).click();
  await expect(win).toContainText("Edit sent.");
  await win.getByRole("button", { name: "Done" }).click();
  await expect(framePins(page)).toHaveCount(1);

  // The agent finds it, takes it, and moves it: the block's source is known (stamped).
  const agent = mcp(ada.person);
  await agent.initialize();
  const inbox = await agent.call("inbox", {});
  expect(inbox.text).toContain("Say which week the notes are from");
  const ref = /^- (s_[a-z0-9]+\/\S+) · /m.exec(inbox.text)?.[1];
  expect(ref, inbox.text).toBeTruthy();
  expect((await agent.call("take", { ref })).isError).toBe(false);
  const working = await agent.call("set_edit_state", { ref, state: "working" });
  expect(working.isError, working.text).toBe(false);

  // The thread opens in the top frame from the frame's pin, and shows the new state.
  await framePins(page).click();
  const modal = overlay(page).locator(".interaction-modal");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("method: direct · working");
});

const GOAL = "Close the quarter with a plan everyone has read.";
const CALM = "Close the quarter with a plan.";
const BOLD = "Close the quarter with a plan everyone has read and signed.";

test("variants for a block inside the frame: previewed there from the top frame's panel, picked, kept across a reload and switched off (E-1, E-2)", async ({
  pages,
  extensionPerson,
  mcp,
}) => {
  const ada = await extensionPerson("ada");
  const page = await openShell(ada, shellUrl(pages.base));
  const goal = inFrame(page).locator("#goal-text");

  await runCommand(page, "Edit block");
  await pickIn(page, inFrame(page), goal);
  const win = composerWindow(page);
  await expect(win).toBeVisible();
  await win.getByRole("button", { name: "Variants" }).click();
  await win.getByRole("textbox").click();
  await page.keyboard.type("Make the goal shorter");
  await win.getByRole("button", { name: "Generate variants" }).click();
  await expect(win).toBeHidden();
  // The Edit opens in the top frame, its set's panel docked under the request.
  const modal = overlay(page).locator(".interaction-modal");
  const panel = modal.locator(".variant-panel");
  await expect(panel).toBeVisible();
  // The thread names the page the person shares; the frame's own overlay shows no panel.
  await expect(modal.locator(".im-context")).toContainText(`${pages.base}/dossier-shell.html`);
  await expect(inFrame(page).locator("[data-onlay-root] .variant-panel")).toBeHidden();

  // Ada's agent finds the Edit with the frame's own address and posts two variants.
  const agent = mcp(ada.person);
  await agent.initialize();
  const inbox = await agent.call("inbox", { url: `${content.base}/dossier-content.html` });
  expect(inbox.text).toContain("Make the goal shorter");
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

  // Previewed inside the frame, driven from the top frame's panel; the top page is untouched.
  await expect(goal).toHaveText(CALM);
  await expect(panel.locator(".variant-current")).toHaveText("1/2 — Calm");
  await panel.getByRole("button", { name: "›" }).click();
  await expect(goal).toHaveText(BOLD);
  await expect(panel.locator(".variant-current")).toHaveText("2/2 — Bold");
  await expect(overlay(page).locator(".preview-label")).toHaveText("Indicative preview — Bold");
  await panel.getByRole("button", { name: "Pick active" }).click();
  await expect(panel.locator(".variant-status")).toContainText("picked");
  await expect(goal).toHaveText(BOLD);
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();

  // Kept: applied inside the frame after a reload, and the launcher says so.
  await page.reload();
  await expectConnected(page);
  await expect(goal).toHaveText(BOLD);
  await expect(overlay(page).getByText(/1 edit shown/i)).toBeVisible();

  // Switched off from the top frame's Kept edits: the frame's original is back.
  await runCommand(page, "Kept edits");
  const kept = overlay(page).locator(".command-bar").getByRole("switch");
  await expect(kept).toHaveAttribute("aria-checked", "true");
  await kept.click();
  await expect(goal).toHaveText(GOAL);
  await expect(kept).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await expect(overlay(page).getByText(/edits? shown/i)).toBeHidden();
});

const REWRITE = "Close the quarter with a plan the whole office signed.";

/** Every interaction in the person's personal space, read through the web app. */
async function personalInteractions(
  web: Page,
): Promise<Array<{ kind: string; url?: string; hostUrl?: string; change?: { method?: string } }>> {
  return web.evaluate(async () => {
    const me = (await (await fetch("/api/me")).json()) as {
      spaces: Array<{ id: string; kind: string }>;
    };
    const personal = me.spaces.find((sp) => sp.kind === "personal");
    const res = await fetch(`/s/${personal?.id}/interaction`);
    return ((await res.json()) as { interactions: never[] }).interactions;
  });
}

test("the Edit page tray rewrites text inside the frame and sends one Edit bound to the frame's address, kept there (E-3)", async ({
  pages,
  extensionPerson,
  webPerson,
}) => {
  const ada = await extensionPerson("ada");
  const web = (await webPerson(ada.person)).page;
  const page = await openShell(ada, shellUrl(pages.base));
  const goal = inFrame(page).locator("#goal-text");

  await runCommand(page, "Edit page");
  const tray = overlay(page).locator(".batch-tray");
  await expect(tray).toBeVisible();
  // Edit page mode runs inside the frame: a double-click there rewrites its text.
  await goal.dblclick();
  await expect(goal).toHaveAttribute("contenteditable", "true");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(REWRITE);
  await page.keyboard.press("Enter");
  await expect(goal).toHaveText(REWRITE);
  // The top frame's tray lists it under the frame's host.
  await expect(tray).toContainText("Edit set · 1");
  await expect(tray).toContainText("localhost");
  await tray.getByRole("button", { name: "Send edits" }).click();
  await expect(overlay(page).getByText("Edits sent.")).toBeVisible();
  await expect(tray).toBeHidden();

  // One Edit, bound to the frame's own address, with the page the person shares beside it.
  await expect
    .poll(async () => (await personalInteractions(web)).filter((s) => s.kind === "change").length)
    .toBe(1);
  const [edit] = (await personalInteractions(web)).filter((s) => s.kind === "change");
  expect(edit?.change?.method).toBe("manual-batch");
  expect(edit?.url).toBe(`${content.base}/dossier-content.html`);
  expect(edit?.hostUrl).toContain(`${pages.base}/dossier-shell.html`);

  // Kept inside the frame: still there after a reload, and the launcher says so.
  await page.reload();
  await expectConnected(page);
  await expect(goal).toHaveText(REWRITE);
  await expect(overlay(page).getByText(/1 edit shown/i)).toBeVisible();
});

test("a page Edit described from the tray is for the frame's page, and its page-root variant applies to the frame's body (E-3)", async ({
  pages,
  extensionPerson,
  mcp,
}) => {
  const ada = await extensionPerson("ada");
  const page = await openShell(ada, shellUrl(pages.base));
  const title = inFrame(page).locator("#title");

  await runCommand(page, "Edit page");
  const tray = overlay(page).locator(".batch-tray");
  await inFrame(page).locator("#notes-text").dblclick();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Notes from the week of the review.");
  await page.keyboard.press("Enter");
  await expect(tray).toContainText("Edit set · 1");
  // The tray's edits are all in the frame: the Edit described is for the frame's page.
  await tray.getByRole("button", { name: "Describe an edit" }).click();
  const win = composerWindow(page);
  await expect(win).toBeVisible();
  await expect(win.locator(".anchor-chip").nth(0)).toHaveText("page");
  await expect(win.locator(".anchor-chip").nth(1)).toHaveText("localhost");
  await expect(win.getByRole("button", { name: "Insert after" })).toHaveCount(0);
  await win.getByRole("button", { name: "Variants" }).click();
  await win.getByRole("textbox").click();
  await page.keyboard.type("A warmer page title");
  await win.getByRole("button", { name: "Generate variants" }).click();
  const panel = overlay(page).locator(".interaction-modal .variant-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".variant-target")).toHaveText("whole page");

  const agent = mcp(ada.person);
  await agent.initialize();
  const ref = await refFor(agent, "A warmer page title");
  expect((await agent.call("take", { ref })).isError).toBe(false);
  const posted = await agent.call("post_variants", {
    ref,
    variants: [
      { label: "Warm", program: [{ op: "setText", target: "#title", text: "The CEO's office" }] },
    ],
  });
  expect(posted.isError, posted.text).toBe(false);
  // The page root is the frame's body: the frame's title changes, the shell's page does not.
  await expect(title).toHaveText("The CEO's office");
  await expect(page.locator("#dossier-page")).toBeVisible();
  await expect(panel.locator(".variant-current")).toHaveText("1/1 — Warm");
});

test("an account change with tray edits made inside the frame leaves nothing for the next account (2-E2)", async ({
  pages,
  person,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  const page = await openShell(ada, shellUrl(pages.base));
  const goal = inFrame(page).locator("#goal-text");
  await runCommand(page, "Edit page");
  const tray = overlay(page).locator(".batch-tray");
  await goal.dblclick();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Ada's unsent rewrite.");
  await page.keyboard.press("Enter");
  await expect(tray).toContainText("Edit set · 1");

  // Ada signs out with the tab open: her edit comes off the frame's page, and the tray goes.
  const popup = await ada.popup();
  await popup.getByRole("button", { name: "Sign out" }).click();
  await expect(popup.getByText("Sign in to Onlay")).toBeVisible();
  await popup.close();
  await expect(goal).toHaveText(GOAL);
  await expect(tray).toBeHidden();

  // Bea signs in on the same browser and opens Edit page: nothing of Ada's.
  await ada.context.clearCookies();
  const bea = person("bea");
  await (await signInFromPopup({ ...ada, person: bea })).close();
  await expectConnected(page);
  await runCommand(page, "Edit page");
  await expect(tray).toBeVisible();
  await expect(tray).toContainText("Edit set · 0");
  await expect(tray).not.toContainText("Ada's unsent rewrite.");
  await expect(goal).toHaveText(GOAL);
});

test("two frames showing one page each keep their own variant panel: the thread opened from a frame drives that frame (2-E4)", async ({
  pages,
  extensionPerson,
  mcp,
}) => {
  const ada = await extensionPerson("ada");
  const page = await openShell(ada, shellUrl(pages.base, undefined, { twin: true }));
  const twin = page.frameLocator("#dossier-twin");
  await expect(twin.locator(":root > [data-onlay-root]")).toBeAttached();
  const first = inFrame(page).locator("#goal-text");
  const second = twin.locator("#goal-text");

  await variantsInFrame(page, "#goal-text", "Shorter goal in one frame");
  const agent = mcp(ada.person);
  await agent.initialize();
  const ref = await refFor(agent, "Shorter goal in one frame");
  expect((await agent.call("take", { ref })).isError).toBe(false);
  const posted = await agent.call("post_variants", {
    ref,
    variants: [
      { label: "Calm", program: [{ op: "setText", target: ":scope", text: CALM }] },
      { label: "Bold", program: [{ op: "setText", target: ":scope", text: BOLD }] },
    ],
  });
  expect(posted.isError, posted.text).toBe(false);
  await expect(first).toHaveText(CALM);
  await page.keyboard.press("Escape");

  // The same Edit's pin in the second frame opens a panel that drives the second frame only.
  const twinPin = twin.locator("[data-onlay-root]").locator(".pin-layer .pin");
  await expect(twinPin).toHaveCount(1);
  await twinPin.click();
  const panel = overlay(page).locator(".interaction-modal .variant-panel");
  await expect(panel).toBeVisible();
  await expect(second).toHaveText(CALM);
  await panel.getByRole("button", { name: "›" }).click();
  await expect(second).toHaveText(BOLD);
  await expect(panel.locator(".variant-current")).toHaveText("2/2 — Bold");
  await expect(first).toHaveText(CALM);
});

interface CaptureRef {
  captureId: string;
  kind: string;
  parts: Array<{ name: string; role: string; mime: string }>;
}

/**
 * A thread's committed looks, read through the web app in another browser:
 * nothing opens in the person's own browser, whose tab must stay the active
 * one for its looks to be taken.
 */
async function capturesOf(web: Page, ref: string): Promise<CaptureRef[]> {
  const [spaceId, id] = ref.split("/");
  return web.evaluate(
    async ({ spaceId, id }) => {
      const res = await fetch(`/s/${spaceId}/interaction/${id}/captures`);
      const body = (await res.json()) as { captures?: unknown[] };
      return (body.captures ?? []) as never;
    },
    { spaceId, id },
  );
}

/** A look's witness: its size, the average colour of some of its rows (red, green, blue, alpha), and a PNG of it. */
async function witnessOf(
  web: Page,
  ref: string,
  cap: CaptureRef,
  rows: number[] = [1],
): Promise<{ width: number; height: number; rgb: number[]; rows: number[][]; png: string }> {
  const [spaceId, id] = ref.split("/");
  const part = cap.parts.find((p) => p.role === "witness");
  if (!part) throw new Error("no witness part");
  return web.evaluate(
    async ({ spaceId, id, captureId, name, mime, rows }) => {
      const res = await fetch(`/s/${spaceId}/interaction/${id}/capture/${captureId}/part/${name}`);
      const bmp = await createImageBitmap(new Blob([await res.arrayBuffer()], { type: mime }));
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      ctx.drawImage(bmp, 0, 0);
      // Rows given from the bottom when negative; the first is above the text's glyphs.
      const avg = (y: number): number[] => {
        const at = y < 0 ? bmp.height + y : y;
        const data = ctx.getImageData(0, at, bmp.width, 1).data;
        const sum = [0, 0, 0, 0];
        for (let i = 0; i < data.length; i += 4)
          for (let k = 0; k < 4; k += 1) (sum[k] as number) += data[i + k] as number;
        return sum.map((v) => Math.round(v / (data.length / 4)));
      };
      const sampled = rows.map(avg);
      const png = await canvas.convertToBlob({ type: "image/png" });
      const bytes = new Uint8Array(await png.arrayBuffer());
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      return {
        width: bmp.width,
        height: bmp.height,
        rgb: (sampled[0] as number[]).slice(0, 3),
        rows: sampled,
        png: btoa(bin),
      };
    },
    { spaceId, id, captureId: cap.captureId, name: part.name, mime: part.mime, rows },
  );
}

/** The first committed look of a thread with a witness, once there is one. */
async function firstLook(web: Page, ref: string): Promise<CaptureRef> {
  await expect
    .poll(async () => (await capturesOf(web, ref)).filter((c) => c.kind === "snapshot").length, {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  const [look] = (await capturesOf(web, ref)).filter((c) => c.kind === "snapshot");
  return look as CaptureRef;
}

/** Keep a look's image with the run, and where ONLAY_E2E_SAVE_DIR says. */
async function keep(name: string, png: string): Promise<void> {
  const dir = process.env.ONLAY_E2E_SAVE_DIR;
  if (dir) writeFileSync(`${dir}/${name}`, Buffer.from(png, "base64"));
  await test.info().attach(name, { body: Buffer.from(png, "base64"), contentType: "image/png" });
}

/** The line the web app shows under a thread's look: why its screenshot went, when it did. */
async function lookNote(web: Page, origin: string, ref: string): Promise<string> {
  const [spaceId, id] = ref.split("/");
  await web.goto(`${origin}/app/#/t/${spaceId}/${id}`);
  const note = web.locator(".cap-residue").first();
  await expect(note).toBeVisible({ timeout: 15_000 });
  return (await note.textContent()) ?? "";
}

/** A block's box in its own frame's CSS pixels. */
async function frameBox(page: Page, selector: string): Promise<{ width: number; height: number }> {
  const frame = page.frame({ url: /dossier-content/ });
  if (!frame) throw new Error("no content frame");
  return frame.evaluate((s) => {
    const r = (document.querySelector(s) as Element).getBoundingClientRect();
    return { width: r.width, height: r.height };
  }, selector);
}

/** Where each document of the shell is scrolled: the shell's and the frame's. */
async function scrolls(page: Page): Promise<number[]> {
  const frame = page.frame({ url: /dossier-content/ });
  return [
    await page.evaluate(() => window.scrollY),
    (await frame?.evaluate(() => window.scrollY)) ?? -1,
  ];
}

/** The first committed look of a thread, once there is one: its part roles. */
async function lookRoles(web: Page, ref: string): Promise<string[]> {
  await expect
    .poll(async () => (await capturesOf(web, ref)).filter((c) => c.kind === "snapshot").length, {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  const [look] = (await capturesOf(web, ref)).filter((c) => c.kind === "snapshot");
  return look?.parts.map((p) => p.role) ?? [];
}

/** The ref of the newest agent item whose text has `text`, from the person's agent. */
async function refFor(
  agent: ReturnType<Parameters<Parameters<typeof test>[2]>[0]["mcp"]>,
  text: string,
): Promise<string> {
  const inbox = await agent.call("inbox", {});
  // Each item is a `- <ref> · …` line, then its page and summary lines.
  const lines = inbox.text.split("\n");
  const at = lines.findIndex((l) => l.includes(text));
  const head = lines
    .slice(0, Math.max(0, at))
    .reverse()
    .find((l) => l.startsWith("- "));
  const ref = /^- (s_[a-z0-9]+\/\S+) · /.exec(head ?? "")?.[1];
  if (!ref) throw new Error(`no item for ${text}:\n${inbox.text}`);
  return ref;
}

test("a look of a block inside the frame is cropped to the block; another site's frame over a block takes the look's screenshot away", async ({
  origin,
  pages,
  person,
  launchExtension,
  webPerson,
  mcp,
}) => {
  const ada = await launchExtension(person("ada"), { captureGrant: true });
  const web = (await webPerson(ada.person)).page;
  await (await signInFromPopup(ada)).close();
  // The content frame holds a frame from the shell's own origin over #covered:
  // another site's frame, as far as the content page goes.
  const page = await openShell(ada, shellUrl(pages.base, pages.base));
  await expect(inFrame(page).frameLocator("#foreign").locator("p")).toBeVisible();
  const agent = mcp(ada.person);
  await agent.initialize();

  await commentInFrame(page, "#goal-text", [{ mention: "agent" }, " look at the goal"]);
  const goal = await refFor(agent, "look at the goal");
  await expect
    .poll(async () => (await capturesOf(web, goal)).filter((c) => c.kind === "snapshot").length, {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  const [look] = (await capturesOf(web, goal)).filter((c) => c.kind === "snapshot");
  expect(look?.parts.map((p) => p.role)).toContain("witness");
  const box = await inFrame(page).locator("#goal-text").boundingBox();
  const shot = await witnessOf(web, goal, look as CaptureRef);
  if (process.env.ONLAY_E2E_SAVE_LOOK)
    writeFileSync(process.env.ONLAY_E2E_SAVE_LOOK, Buffer.from(shot.png, "base64"));
  await test.info().attach("frame-look.png", {
    body: Buffer.from(shot.png, "base64"),
    contentType: "image/png",
  });
  // The block's own size, and its own background (#fff6e0), not the shell's or the page's.
  expect(Math.abs(shot.width - Math.round(box?.width ?? 0))).toBeLessThanOrEqual(2);
  expect(Math.abs(shot.height - Math.round(box?.height ?? 0))).toBeLessThanOrEqual(2);
  expect(shot.rgb[0]).toBeGreaterThan(240);
  expect(shot.rgb[1]).toBeGreaterThan(236);
  expect(shot.rgb[2]).toBeLessThan(235);

  await commentInFrame(page, "#covered-text", [{ mention: "agent" }, " look under the frame"]);
  const covered = await refFor(agent, "look under the frame");
  await expect
    .poll(
      async () => (await capturesOf(web, covered)).filter((c) => c.kind === "snapshot").length,
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  const [blocked] = (await capturesOf(web, covered)).filter((c) => c.kind === "snapshot");
  // The structured capture is kept; the screenshot is not, and the web app says why (L-3).
  expect(blocked?.parts.map((p) => p.role)).toContain("document");
  expect(blocked?.parts.map((p) => p.role)).not.toContain("witness");
  expect(await lookNote(web, origin, covered)).toBe(
    "No screenshot: another site's frame was in the way.",
  );
});

/** Edit block → Variants on a block inside the frame; resolves once the set's panel is up. */
async function variantsInFrame(page: Page, selector: string, intent: string): Promise<void> {
  await runCommand(page, "Edit block");
  await pickIn(page, inFrame(page), inFrame(page).locator(selector));
  const win = composerWindow(page);
  await expect(win).toBeVisible();
  await win.getByRole("button", { name: "Variants" }).click();
  await win.getByRole("textbox").click();
  await page.keyboard.type(intent);
  await win.getByRole("button", { name: "Generate variants" }).click();
  await expect(overlay(page).locator(".interaction-modal .variant-panel")).toBeVisible();
}

test("a variant of a block inside the frame gets its automatic look there; one under another site's frame says why (E-4)", async ({
  pages,
  person,
  launchExtension,
  webPerson,
  mcp,
}) => {
  const ada = await launchExtension(person("ada"), { captureGrant: true });
  const web = (await webPerson(ada.person)).page;
  await (await signInFromPopup(ada)).close();
  const page = await openShell(ada, shellUrl(pages.base, pages.base));
  await expect(inFrame(page).frameLocator("#foreign").locator("p")).toBeVisible();
  const agent = mcp(ada.person);
  await agent.initialize();

  await variantsInFrame(page, "#goal-text", "A calmer goal line");
  const goal = await refFor(agent, "A calmer goal line");
  expect((await agent.call("take", { ref: goal })).isError).toBe(false);
  const posted = await agent.call("post_variants", {
    ref: goal,
    variants: [{ label: "Calm", program: [{ op: "setText", target: ":scope", text: CALM }] }],
  });
  expect(posted.isError, posted.text).toBe(false);
  await expect
    .poll(
      async () => (await capturesOf(web, goal)).filter((c) => c.kind === "variant-look").length,
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  const [look] = (await capturesOf(web, goal)).filter((c) => c.kind === "variant-look");
  expect(look?.parts.map((p) => p.role)).toContain("witness");
  await page.keyboard.press("Escape");

  // Another site's frame lies over #covered: no look, and the top frame's panel says why.
  await variantsInFrame(page, "#covered-text", "Say what is covered");
  const covered = await refFor(agent, "Say what is covered");
  expect((await agent.call("take", { ref: covered })).isError).toBe(false);
  const again = await agent.call("post_variants", {
    ref: covered,
    variants: [
      { label: "Plain", program: [{ op: "setText", target: ":scope", text: "Covered." }] },
    ],
  });
  expect(again.isError, again.text).toBe(false);
  await expect(overlay(page).locator(".interaction-modal .variant-panel")).toContainText(
    "No automatic look: another site's frame is in the way.",
    { timeout: 30_000 },
  );
  expect((await capturesOf(web, covered)).filter((c) => c.kind === "variant-look")).toEqual([]);
});

test("the keyboard inside the frame reaches the top frame, and Escape there ends the pick in every frame", async ({
  pages,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  const page = await openShell(ada, shellUrl(pages.base));
  const bar = overlay(page).locator(".command-bar");

  // Focus inside the frame's page; the chord opens the top frame's command bar.
  await inFrame(page).locator("#title").click();
  await page.keyboard.press("Control+.");
  await expect(bar).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(bar).toBeHidden();

  // A pick armed from the top frame shows its box in the frame under the pointer…
  await runCommand(page, "Comment on block");
  await armIn(page, inFrame(page), inFrame(page).locator("#goal-text"));
  const frameBox = inFrame(page).locator("[data-onlay-root]").locator(".box").first();
  await expect(frameBox).toBeVisible();
  // …and Escape typed inside the frame ends it there and in the top frame.
  await page.keyboard.press("Escape");
  await expect(frameBox).toBeHidden();
  await inFrame(page).locator("#goal-text").click();
  await expect(composerWindow(page)).toBeHidden();
  await expect(framePins(page)).toHaveCount(0);
});

test("a look is dropped when the embedding page draws over the block, and when the frame can be seen through (2-F1)", async ({
  origin,
  pages,
  person,
  launchExtension,
  webPerson,
  mcp,
}) => {
  const ada = await launchExtension(person("ada"), { captureGrant: true });
  const web = (await webPerson(ada.person)).page;
  await (await signInFromPopup(ada)).close();
  const agent = mcp(ada.person);
  await agent.initialize();

  // The shell's own notification lies over the right half of #goal-text.
  const noticed = await openShell(ada, shellUrl(pages.base, undefined, { notice: true }));
  await expect(noticed.locator("#notice")).toBeVisible();
  await runCommand(noticed, "Comment on block");
  await pickIn(noticed, inFrame(noticed), inFrame(noticed).locator("#goal-text"), { x: 20, y: 8 });
  const win = composerWindow(noticed);
  await expect(win).toBeVisible();
  await typeParts(noticed, win.getByRole("textbox"), [{ mention: "agent" }, " under the notice"]);
  await win.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(overlay(noticed).getByText("comment posted")).toBeVisible();
  const noticeRef = await refFor(agent, "under the notice");
  const covered = await lookRoles(web, noticeRef);
  expect(covered).toContain("document");
  expect(covered).not.toContain("witness");
  await noticed.close();
  expect(await lookNote(web, origin, noticeRef)).toBe(
    "No screenshot: something on the page covered this block. Uncover it and ask for a fresh look.",
  );

  // Nothing in the frame paints a background: the shell would show through.
  const clear = await openShell(ada, shellUrl(pages.base, undefined, { clear: true }));
  await commentInFrame(clear, "#notes-text", [{ mention: "agent" }, " through the glass"]);
  const glassRef = await refFor(agent, "through the glass");
  const glass = await lookRoles(web, glassRef);
  expect(glass).toContain("document");
  expect(glass).not.toContain("witness");
  expect(await lookNote(web, origin, glassRef)).toBe(
    "No screenshot: this block's frame is transparent, so the page behind it would show.",
  );
});

test("a pick whose frame changed route before it was sent sends nothing and says so (2-F3)", async ({
  pages,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  const page = await openShell(ada, shellUrl(pages.base));
  await runCommand(page, "Comment on block");
  await pickIn(page, inFrame(page), inFrame(page).locator("#goal-text"));
  const win = composerWindow(page);
  await expect(win).toBeVisible();
  // The frame's host is named beside the block label.
  await expect(win.locator(".anchor-chip").nth(1)).toHaveText("localhost");
  await typeParts(page, win.getByRole("textbox"), ["Written before the route changed."]);
  // The embedded app moves to another route while the person types.
  await page
    .frame({ url: /dossier-content/ })
    ?.evaluate(() => history.pushState({}, "", "/dossier-content.html?route=2"));
  await page.waitForTimeout(700);
  await win.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(win).toContainText(
    "The page in this frame changed after you picked the block. Pick the block again.",
  );
  await expect(win.getByRole("textbox")).toContainText("Written before the route changed.");
  await page.waitForTimeout(1000);
  await expect(framePins(page)).toHaveCount(0);
  const popup = await ada.popup();
  await expect(popup.locator(".row").filter({ hasText: "Written before" })).toHaveCount(0);
});

test("a block in a blank frame of the frame's page is picked, pinned and opened by that page (A-3)", async ({
  pages,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  const page = await openShell(ada, shellUrl(pages.base));
  const blank = inFrame(page).frameLocator("#blank");
  await expect(blank.locator("#blank-text")).toBeVisible();
  await runCommand(page, "Comment on block");
  // The content page's overlay boxes the block inside its blank frame (the pick is armed there).
  await pickIn(page, inFrame(page), blank.locator("#blank-text"));
  const win = composerWindow(page);
  await expect(win).toBeVisible();
  await typeParts(page, win.getByRole("textbox"), ["Inside the blank frame."]);
  await win.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(overlay(page).getByText("comment posted")).toBeVisible();
  // Pinned by the content page, the owner of the blank frame's blocks.
  await expect(framePins(page)).toHaveCount(1);
  await page.reload();
  await expect(inFrame(page).frameLocator("#blank").locator("#blank-text")).toBeVisible();
  // The blank frame sits below the content page's fold (its tall blocks), and
  // only a block in view wears its pin: the person scrolls to it.
  await page
    .frame({ url: /dossier-content/ })
    ?.evaluate(() => document.getElementById("blank")?.scrollIntoView({ block: "center" }));
  await expect(framePins(page)).toHaveCount(1);
  await framePins(page).click();
  await expect(overlay(page).locator(".interaction-modal .msg").first()).toContainText(
    "Inside the blank frame.",
  );
});

test("a block whose anchor is lost inside the frame shows as lost and is re-anchored there (A-1)", async ({
  pages,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  // The shell's own notice is a place in the top frame to click.
  const page = await openShell(ada, shellUrl(pages.base, undefined, { notice: true }));
  await commentInFrame(page, "#notes-text", ["Are these the latest notes?"]);
  await expect(framePins(page)).toHaveCount(1);

  // The block's words change past recognition: the frame finds its anchor lost.
  await page.frame({ url: /dossier-content/ })?.evaluate(() => {
    const p = document.querySelector("#notes-text") as HTMLElement;
    p.textContent = "Quarterly hiring plan, second draft.";
  });
  await expect(framePins(page)).toHaveCount(0, { timeout: 20_000 });
  await overlay(page).getByRole("button", { name: "Onlay — open your Inbox" }).click();
  const row = overlay(page)
    .locator(".command-bar .q-row")
    .filter({ hasText: "Are these the latest notes?" });
  await expect(row).toContainText("anchor lost");
  await row.click();
  const modal = overlay(page).locator(".interaction-modal");
  await expect(modal).toContainText("anchor lost");
  await modal.getByRole("button", { name: "Re-anchor" }).click();
  await expect(modal).toBeHidden();

  // A click in the top frame picks nothing; the hint says what to do.
  await page.locator("#notice").click();
  await expect(overlay(page).locator(".toast")).toHaveText(
    "Pick a new block to re-anchor (Esc to cancel)",
  );
  await expect(framePins(page)).toHaveCount(0);
  // The frame that owns the thread answers the pick, and sends the re-anchor.
  await inFrame(page)
    .locator("#goal-text")
    .click({ position: { x: 20, y: 8 } });
  await expect(framePins(page)).toHaveCount(1);
  await expect(modal).toBeVisible();
  await expect(modal).not.toContainText("anchor lost");
  await expect(modal.locator(".msg").first()).toContainText("Are these the latest notes?");
});

test("a frame on a deeper route of the block's page never reports the block lost; the page itself does (2-A4)", async ({
  pages,
  extensionPerson,
  mcp,
}) => {
  const ada = await extensionPerson("ada");
  const page = await openShell(ada, shellUrl(pages.base));
  await commentInFrame(page, "#notes-text", [{ mention: "agent" }, " are the notes in?"]);
  await expect(framePins(page)).toHaveCount(1);
  const agent = mcp(ada.person);
  await agent.initialize();
  const ref = await refFor(agent, "are the notes in?");
  const frame = page.frame({ url: /dossier-content/ });
  // The embedded app moves to a deeper route of the same page (the URL prefix
  // still takes in the thread), and the block's words change there.
  await frame?.evaluate(() => {
    history.pushState({}, "", "/dossier-content.html?route=2");
    (document.querySelector("#notes-text") as HTMLElement).textContent =
      "Quarterly hiring plan, second draft.";
  });
  await page.waitForTimeout(1_000);
  // A change to the thread is broadcast for the block's page; the deeper
  // route hears it too (the URL prefix takes it in).
  expect((await agent.call("reply", { ref, text: "Checking now." })).isError).toBe(false);
  // Well past three loss passes (2 s each): the deeper route says nothing.
  await page.waitForTimeout(9_000);
  expect((await agent.call("read", { ref })).text).not.toContain("anchor lost");
  // Back on the block's own page, the same missing block is lost.
  await frame?.evaluate(() => history.pushState({}, "", "/dossier-content.html"));
  await expect
    .poll(async () => (await agent.call("read", { ref })).text, { timeout: 20_000 })
    .toContain("anchor lost");
});

test("a frame on a deeper route offers no re-anchor of its parent page's thread (3-A1)", async ({
  pages,
  extensionPerson,
  mcp,
}) => {
  const ada = await extensionPerson("ada");
  const page = await openShell(ada, shellUrl(pages.base));
  await commentInFrame(page, "#notes-text", [{ mention: "agent" }, " notes moved?"]);
  await expect(framePins(page)).toHaveCount(1);
  const agent = mcp(ada.person);
  await agent.initialize();
  const ref = await refFor(agent, "notes moved?");
  const frame = page.frame({ url: /dossier-content/ });
  // Lost on its own page…
  await frame?.evaluate(() => {
    (document.querySelector("#notes-text") as HTMLElement).textContent =
      "Quarterly hiring plan, second draft.";
  });
  await expect
    .poll(async () => (await agent.call("read", { ref })).text, { timeout: 20_000 })
    .toContain("anchor lost");
  // …then the app moves to a deeper route, which hears the thread's broadcast.
  await frame?.evaluate(() => history.pushState({}, "", "/dossier-content.html?route=2"));
  await page.waitForTimeout(1_000);
  expect((await agent.call("reply", { ref, text: "Still looking." })).isError).toBe(false);
  await overlay(page).getByRole("button", { name: "Onlay — open your Inbox" }).click();
  const row = overlay(page).locator(".command-bar .q-row").filter({ hasText: "notes moved?" });
  await expect(row).toContainText("anchor lost");
  await row.click();
  const modal = overlay(page).locator(".interaction-modal");
  await expect(modal).toContainText("Still looking.");
  await expect(modal).toContainText("anchor lost");
  await expect(modal.getByRole("button", { name: "Re-anchor" })).toHaveCount(0);
});

test("re-anchor from a thread opened in either of two frames on one page is answered by that frame (3-A2)", async ({
  pages,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  const page = await openShell(ada, shellUrl(pages.base, undefined, { twin: true }));
  const twin = page.frameLocator("#dossier-twin");
  await expect(twin.locator(":root > [data-onlay-root]")).toBeAttached();
  await expect(twin.locator("#notes-text")).toBeVisible();
  await commentInFrame(page, "#notes-text", ["Which notes are these?"]);
  const pinsIn = {
    first: framePins(page),
    second: twin.locator("[data-onlay-root]").locator(".pin-layer .pin"),
  };
  const docOf = async (which: "first" | "second") => {
    const f = await (
      await page.locator(which === "first" ? "#dossier-page" : "#dossier-twin").elementHandle()
    )?.contentFrame();
    if (!f) throw new Error(`no ${which} frame`);
    return f;
  };
  const modal = overlay(page).locator(".interaction-modal");
  // Both ways round: whichever frame the thread is opened from, that frame
  // alone answers its re-anchor (never the first frame found holding it).
  const rounds = [
    { from: "second", block: "#notes-text", to: "#goal-text" },
    { from: "first", block: "#goal-text", to: "#title" },
  ] as const;
  for (const round of rounds) {
    const pins = pinsIn[round.from];
    await expect(pins).toHaveCount(1);
    await pins.click();
    await expect(modal.locator(".msg").first()).toContainText("Which notes are these?");
    // The block is lost in that frame; the other frame still shows it.
    await (await docOf(round.from)).evaluate((sel) => {
      (document.querySelector(sel) as HTMLElement).textContent =
        "Quarterly hiring plan, second draft.";
    }, round.block);
    await expect(modal).toContainText("anchor lost", { timeout: 20_000 });
    await modal.getByRole("button", { name: "Re-anchor" }).click();
    await expect(modal).toBeHidden();
    const frame = round.from === "first" ? inFrame(page) : twin;
    await frame.locator(round.to).click({ position: { x: 20, y: 8 } });
    await expect(modal).toBeVisible();
    await expect(modal).not.toContainText("anchor lost");
    await expect(pins).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();
  }
});

test("Copy for agent on the shell copies the round of the frame's page (A-2)", async ({
  pages,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  await ada.context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: pages.base,
  });
  const page = await openShell(ada, shellUrl(pages.base));
  await commentInFrame(page, "#goal-text", [{ mention: "agent" }, " check the goal"]);
  await expect(framePins(page)).toHaveCount(1);
  await runCommand(page, "Copy for agent");
  await expect(overlay(page).locator(".toast")).toHaveText(
    "Copied. Paste it into your agent's session.",
  );
  const text = await page.evaluate(() => navigator.clipboard.readText());
  const frameUrl = `${content.base}/dossier-content.html`;
  expect(text).toContain(`1 item(s) for an agent on ${frameUrl}`);
  expect(text).toContain(`/app/#/round/s_`);
  expect(text).toContain(`?url=${encodeURIComponent(frameUrl)}`);
  expect(text).toContain(`"url": ${JSON.stringify(frameUrl)}`);
  expect(text).not.toContain("dossier-shell.html");
});

const blankUrl = (base: string): string => `${base}/blank-frames.html`;

test("blocks inside a srcdoc frame and a blank frame of the page are picked, pinned, opened, and stay after a reload (A-3)", async ({
  pages,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  const page = await ada.newPage();
  await page.goto(blankUrl(pages.base));
  await expectConnected(page);
  const srcdoc = page.frameLocator("#srcdoc-frame");
  const blank = page.frameLocator("#blank-frame");
  await expect(srcdoc.locator("#srcdoc-text")).toBeVisible();

  for (const [frame, selector, words] of [
    [srcdoc, "#srcdoc-text", "In the srcdoc frame."],
    [blank, "#blank-text", "In the blank frame."],
  ] as const) {
    await runCommand(page, "Comment on block");
    await frame.locator(selector).hover();
    await expect(overlay(page).locator(".box").first()).toBeVisible();
    await frame.locator(selector).click();
    const win = composerWindow(page);
    await expect(win).toBeVisible();
    await typeParts(page, win.getByRole("textbox"), [words]);
    await win.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(overlay(page).getByText("comment posted")).toBeVisible();
    await expect(win).toBeHidden();
  }
  // The page pins both, over their frames.
  const pinOf = (text: string) => pins(page).and(page.locator(`[title*="${text}"]`));
  await expect(pins(page)).toHaveCount(2);
  const srcdocPin = await pinOf("In a srcdoc frame").boundingBox();
  const frameBox = await page.locator("#srcdoc-frame").boundingBox();
  expect(
    srcdocPin &&
      frameBox &&
      srcdocPin.y >= frameBox.y &&
      srcdocPin.y <= frameBox.y + frameBox.height,
  ).toBe(true);

  await page.reload();
  await expect(page.frameLocator("#srcdoc-frame").locator("#srcdoc-text")).toBeVisible();
  await expect(pins(page)).toHaveCount(2);
  await pinOf("In a blank frame").click();
  const modal = overlay(page).locator(".interaction-modal");
  await expect(modal.locator(".msg").first()).toContainText("In the blank frame.");
  await page.keyboard.press("Escape");
  await pinOf("In a srcdoc frame").click();
  await expect(modal.locator(".msg").first()).toContainText("In the srcdoc frame.");
});

test("the composer beside a block inside a srcdoc frame follows it when that frame scrolls (A-3)", async ({
  pages,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  const page = await ada.newPage();
  // Room below the block for the whole card, so its moves are never clamped.
  await page.setViewportSize({ width: 1280, height: 1200 });
  await page.goto(blankUrl(pages.base));
  await expectConnected(page);
  const scrolling = page.frameLocator("#scroll-frame");
  await runCommand(page, "Comment on block");
  await scrolling.locator("#scroll-text").click();
  const win = composerWindow(page);
  await expect(win).toBeVisible();
  const before = await win.boundingBox();
  const frame = await (await page.locator("#scroll-frame").elementHandle())?.contentFrame();
  await frame?.evaluate(() => window.scrollBy(0, 60));
  // No scroll reaches the top window: the card moves up with the block all the same.
  await expect
    .poll(async () => {
      const now = await win.boundingBox();
      return before && now ? Math.round(before.y - now.y) : null;
    })
    .toBe(60);
});

test("the composer for a block inside another site's frame opens beside the block, then stays where it is when the shell or the frame scrolls", async ({
  pages,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  const page = await ada.newPage();
  // The frame starts 600px down the shell, which scrolls; room below the block for the whole card.
  await page.setViewportSize({ width: 1280, height: 1200 });
  await page.goto(shellUrl(pages.base, undefined, { lead: true }));
  await expectConnected(page);
  await expect(inFrame(page).locator(":root > [data-onlay-root]")).toBeAttached();
  const block = inFrame(page).locator("#goal-text");
  await expect(block).toBeVisible();
  // Its box in the shell's viewport.
  const b = await block.boundingBox();
  if (!b) throw new Error("no block box");
  await runCommand(page, "Comment on block");
  await pickIn(page, inFrame(page), block, { x: 20, y: 5 });
  const win = composerWindow(page);
  await expect(win).toBeVisible();
  // Beside the click (8px right of it and below), not centred in the shell.
  const opened = await win.boundingBox();
  if (!opened) throw new Error("no card box");
  expect(Math.abs(opened.x - (b.x + 28))).toBeLessThanOrEqual(2);
  expect(Math.abs(opened.y - (b.y + 13))).toBeLessThanOrEqual(2);

  // Then it is tied to nothing: the shell and the frame scroll, and the card stays put.
  await page.evaluate(() => window.scrollBy(0, 200));
  const frame = await (await page.locator("#dossier-page").elementHandle())?.contentFrame();
  await frame?.evaluate(() => window.scrollBy(0, 60));
  await page.waitForTimeout(300);
  expect(await win.boundingBox()).toEqual(opened);
});

test("the composer for a block inside a rotated frame of another site opens centred", async ({
  pages,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  const page = await openShell(ada, shellUrl(pages.base, undefined, { transform: "rotate(5deg)" }));
  await runCommand(page, "Comment on block");
  await pickIn(page, inFrame(page), inFrame(page).locator("#goal-text"));
  const win = composerWindow(page);
  await expect(win).toBeVisible();
  const vp = page.viewportSize();
  const box = await win.boundingBox();
  if (!vp || !box) throw new Error("no boxes");
  // Today's centred card: centred across, a fifth of the way down.
  expect(Math.abs(box.x + box.width / 2 - vp.width / 2)).toBeLessThanOrEqual(2);
  expect(Math.abs(box.y - Math.round(vp.height * 0.2))).toBeLessThanOrEqual(2);
});

test("the composer for a block in a frame inside another site's frame opens beside it, through both frames", async ({
  pages,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  const page = await ada.newPage();
  await page.setViewportSize({ width: 1280, height: 1200 });
  // The content frame holds a frame of the shell's own origin: shell → content → that frame.
  await page.goto(shellUrl(pages.base, pages.base));
  await expectConnected(page);
  const block = inFrame(page).frameLocator("#foreign").locator("p");
  await expect(block).toBeVisible();
  await expect(
    inFrame(page).frameLocator("#foreign").locator(":root > [data-onlay-root]"),
  ).toBeAttached();
  const b = await block.boundingBox();
  if (!b) throw new Error("no block box");
  await runCommand(page, "Comment on block");
  await pickIn(page, inFrame(page).frameLocator("#foreign"), block, { x: 20, y: 5 });
  const win = composerWindow(page);
  await expect(win).toBeVisible();
  const opened = await win.boundingBox();
  if (!opened) throw new Error("no card box");
  // Beside the click, through both frames.
  expect(Math.abs(opened.x - (b.x + 28))).toBeLessThanOrEqual(2);
  expect(Math.abs(opened.y - (b.y + 13))).toBeLessThanOrEqual(2);
});

test("the composer for a block inside a rotated blank frame of another site's page opens centred", async ({
  pages,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  const page = await openShell(ada, shellUrl(pages.base, undefined, { tiltblank: true }));
  const text = inFrame(page).frameLocator("#blank").locator("#blank-text");
  await expect(text).toBeVisible();
  await page
    .frame({ url: /dossier-content/ })
    ?.evaluate(() => document.getElementById("blank")?.scrollIntoView({ block: "center" }));
  await runCommand(page, "Comment on block");
  await pickIn(page, inFrame(page), text);
  const win = composerWindow(page);
  await expect(win).toBeVisible();
  const vp = page.viewportSize();
  const box = await win.boundingBox();
  if (!vp || !box) throw new Error("no boxes");
  expect(Math.abs(box.x + box.width / 2 - vp.width / 2)).toBeLessThanOrEqual(2);
  expect(Math.abs(box.y - Math.round(vp.height * 0.2))).toBeLessThanOrEqual(2);
});

/**
 * Patch what the service worker sends to the tab: each named message type is
 * dropped (`null`) or handed on that many milliseconds later.
 */
async function patchSends(
  ada: ExtensionHandle,
  rules: Record<string, number | null>,
): Promise<void> {
  const sw = await ada.serviceWorker();
  await sw.evaluate((r) => {
    const g = globalThis as unknown as {
      chrome: {
        tabs: {
          sendMessage: (tab: number, msg: { type?: string }, opts: unknown) => Promise<unknown>;
        };
      };
    };
    const tabs = g.chrome.tabs;
    const send = tabs.sendMessage.bind(tabs);
    tabs.sendMessage = (tab: number, msg: { type?: string }, opts: unknown) => {
      const type = msg?.type ?? "";
      if (!(type in r)) return send(tab, msg, opts);
      const delay = r[type];
      return delay === null
        ? Promise.resolve(undefined)
        : new Promise((res) => setTimeout(res, delay)).then(() => send(tab, msg, opts));
    };
  }, rules);
}

/**
 * The service worker drops every locate hop (no placement ever comes, the
 * wait runs out), or with `delayMs` hands each one on that much later.
 */
async function holdPlacements(ada: ExtensionHandle, delayMs?: number): Promise<void> {
  await patchSends(ada, { "frame-locate-up": delayMs ?? null });
}

for (const change of ["route", "removal"] as const) {
  test(`a composer whose frame ${change === "route" ? "changed route" : "was removed"} before any place came opens no centred card`, async ({
    pages,
    extensionPerson,
  }) => {
    const ada = await extensionPerson("ada");
    const page = await openShell(ada, shellUrl(pages.base));
    // No place ever comes: the wait runs out, and only a live pick may open.
    await holdPlacements(ada);
    await runCommand(page, "Comment on block");
    await pickIn(page, inFrame(page), inFrame(page).locator("#goal-text"));
    if (change === "route")
      await page
        .frame({ url: /dossier-content/ })
        ?.evaluate(() => history.pushState({}, "", "/dossier-content.html?route=moved"));
    else await page.evaluate(() => document.getElementById("dossier-page")?.remove());
    await page.waitForTimeout(1_500);
    await expect(composerWindow(page)).toBeHidden();
  });
}

test("a new pick calls off a composer still waiting for an older pick's place", async ({
  pages,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  const page = await openShell(ada, shellUrl(pages.base));
  await holdPlacements(ada);
  await runCommand(page, "Comment on block");
  await pickIn(page, inFrame(page), inFrame(page).locator("#goal-text"));
  // A new pick starts before the wait runs out: the old card never opens.
  await runCommand(page, "Comment on block");
  await page.waitForTimeout(1_500);
  await expect(composerWindow(page)).toBeHidden();
});

test("a frame's completion that loses the race with the pick's end leaves no outline behind", async ({
  pages,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  const page = await openShell(ada, shellUrl(pages.base));
  // The frame's choice reaches the top frame late, after the person ended the pick there.
  await patchSends(ada, { "frame-picked": 600 });
  await runCommand(page, "Comment on block");
  await pickIn(page, inFrame(page), inFrame(page).locator("#goal-text"));
  const ring = inFrame(page).locator("[data-onlay-root] .box.sel");
  await expect(ring).toBeVisible();
  await page.evaluate(() => window.focus());
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1_200);
  await expect(composerWindow(page)).toBeHidden();
  await expect(ring).toBeHidden();
});

test("a completed pick whose pick-end reaches the top frame before its choice still opens its composer", async ({
  pages,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  const page = await openShell(ada, shellUrl(pages.base));
  // The service worker sends the choice and the pick's end apart: here the end comes first.
  await patchSends(ada, { "frame-picked": 300 });
  await runCommand(page, "Comment on block");
  await pickIn(page, inFrame(page), inFrame(page).locator("#goal-text"));
  await expect(composerWindow(page)).toBeVisible();
  await expect(inFrame(page).locator("[data-onlay-root] .box.sel")).toBeVisible();
});

test("a frame whose page changed route while its composer waited for a place opens no composer", async ({
  pages,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  const page = await openShell(ada, shellUrl(pages.base));
  // The placement comes back within the wait, but after the route change.
  await holdPlacements(ada, 250);
  await runCommand(page, "Comment on block");
  await pickIn(page, inFrame(page), inFrame(page).locator("#goal-text"));
  await page
    .frame({ url: /dossier-content/ })
    ?.evaluate(() => history.pushState({}, "", "/dossier-content.html?route=moved"));
  await page.waitForTimeout(1_500);
  await expect(composerWindow(page)).toBeHidden();
});

test("with no placement in time, the composer for a frame's block opens centred all the same", async ({
  pages,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  const page = await openShell(ada, shellUrl(pages.base));
  await holdPlacements(ada);
  await runCommand(page, "Comment on block");
  await pickIn(page, inFrame(page), inFrame(page).locator("#goal-text"));
  const win = composerWindow(page);
  await expect(win).toBeVisible();
  const vp = page.viewportSize();
  const box = await win.boundingBox();
  if (!vp || !box) throw new Error("no boxes");
  expect(Math.abs(box.x + box.width / 2 - vp.width / 2)).toBeLessThanOrEqual(2);
});

for (const where of ["frame", "top"] as const) {
  test(`Escape in the ${where === "frame" ? "frame that holds the block" : "top frame"}, while the composer waits for its place, calls it off`, async ({
    pages,
    extensionPerson,
  }) => {
    const ada = await extensionPerson("ada");
    const page = await openShell(ada, shellUrl(pages.base));
    await holdPlacements(ada);
    await runCommand(page, "Comment on block");
    await pickIn(page, inFrame(page), inFrame(page).locator("#goal-text"));
    // Focus is in the frame after its click; the top frame takes it back for its own Escape.
    if (where === "top") await page.evaluate(() => window.focus());
    await page.keyboard.press("Escape");
    // Past the wait (half a second) and the frame's own locate giving up (2 s): nothing opens.
    await page.waitForTimeout(2_600);
    await expect(composerWindow(page)).toBeHidden();
    // A pick afterwards opens as ever.
    await runCommand(page, "Comment on block");
    await pickIn(page, inFrame(page), inFrame(page).locator("#goal-text"));
    await expect(composerWindow(page)).toBeVisible();
  });
}

test("a block in a blank frame its page fills after load gets its pin when it appears (A-3)", async ({
  pages,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  const page = await ada.newPage();
  await page.goto(blankUrl(pages.base));
  await expectConnected(page);
  const late = page.frameLocator("#late-frame");
  await expect(late.locator("#late-text")).toBeVisible();
  await runCommand(page, "Comment on block");
  await late.locator("#late-text").click();
  const win = composerWindow(page);
  await expect(win).toBeVisible();
  await typeParts(page, win.getByRole("textbox"), ["Filled in after the page loaded."]);
  await win.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(overlay(page).getByText("comment posted")).toBeVisible();
  await expect(pins(page)).toHaveCount(1);
  // After a reload the snapshot lands before the frame is filled; the pin
  // follows the block once it is there, with nothing else on the page moving.
  await page.reload();
  await expect(page.frameLocator("#late-frame").locator("#late-text")).toBeVisible();
  await expect(pins(page)).toHaveCount(1, { timeout: 6_000 });
});

test("a look of a block inside a srcdoc frame of the page is its own document, with no screenshot, and says why (2-A1)", async ({
  origin,
  pages,
  person,
  launchExtension,
  webPerson,
  mcp,
}) => {
  const ada = await launchExtension(person("ada"), { captureGrant: true });
  const web = (await webPerson(ada.person)).page;
  await (await signInFromPopup(ada)).close();
  const agent = mcp(ada.person);
  await agent.initialize();
  const page = await ada.newPage();
  await page.goto(blankUrl(pages.base));
  await expectConnected(page);
  const srcdoc = page.frameLocator("#srcdoc-frame");
  await expect(srcdoc.locator("#srcdoc-text")).toBeVisible();
  await runCommand(page, "Comment on block");
  await srcdoc.locator("#srcdoc-text").click();
  const win = composerWindow(page);
  await expect(win).toBeVisible();
  await typeParts(page, win.getByRole("textbox"), [{ mention: "agent" }, " look in the srcdoc"]);
  await win.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(overlay(page).getByText("comment posted")).toBeVisible();

  const ref = await refFor(agent, "look in the srcdoc");
  const roles = await lookRoles(web, ref);
  // The structured capture of the frame's own document is kept; a screenshot
  // is never taken for a block in a frame without an address of its own.
  expect(roles).toContain("document");
  expect(roles).not.toContain("witness");
  expect(await lookNote(web, origin, ref)).toBe(
    "No screenshot: this block is inside a frame that has no address of its own.",
  );
  // The walk read the frame's own document: its block, its words.
  const [look] = (await capturesOf(web, ref)).filter((c) => c.kind === "snapshot");
  const [spaceId, id] = ref.split("/");
  const html = await web.evaluate(
    async ({ spaceId, id, captureId }) => {
      const res = await fetch(`/s/${spaceId}/interaction/${id}/capture/${captureId}/part/document`);
      const body = res.body?.pipeThrough(new DecompressionStream("gzip"));
      return body ? await new Response(body).text() : "";
    },
    { spaceId, id, captureId: look?.captureId ?? "" },
  );
  expect(html).toContain("In a srcdoc frame.");
});

test("a block inside a sandboxed frame is not pickable, and the pick says why (A-3)", async ({
  pages,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  const page = await ada.newPage();
  await page.goto(blankUrl(pages.base));
  await expectConnected(page);
  const sandboxed = page.frameLocator("#sandboxed-frame");
  await expect(sandboxed.locator("#sandboxed-text")).toBeVisible();
  await runCommand(page, "Comment on block");
  await sandboxed.locator("#sandboxed-text").hover();
  await expect(overlay(page).locator(".toast")).toHaveText(
    "This block is in a sandboxed frame. Onlay can't anchor to it.",
  );
  await sandboxed.locator("#sandboxed-text").click();
  await page.waitForTimeout(500);
  await expect(composerWindow(page)).toBeHidden();
  await expect(pins(page)).toHaveCount(0);
  // The pick still runs for the page's own blocks.
  await page.locator("#title").click();
  await expect(composerWindow(page)).toBeVisible();
});

/* ── looks that scroll, tile and map through transforms (round 4, L-1 … L-3) ── */

/**
 * Comment on a block inside a frame drawn at `scale` from its top left
 * corner. Playwright's own click there lands where the block would be
 * unscaled, so the click is made where the tab really shows it.
 */
async function commentScaled(page: Page, selector: string, scale: number, parts: Part[]) {
  const frame = page.frame({ url: /dossier-content/ });
  if (!frame) throw new Error("no content frame");
  const at = await frame.evaluate((s) => {
    const b = (document.querySelector(s) as Element).getBoundingClientRect();
    return { x: b.left + 20, y: b.top + b.height / 2 };
  }, selector);
  const origin = await page.evaluate(() => {
    const b = (document.getElementById("dossier-page") as Element).getBoundingClientRect();
    return { x: b.left, y: b.top };
  });
  await runCommand(page, "Comment on block");
  // Moved over it until the frame shows its hover box (the pick is armed there), then clicked.
  const x = origin.x + at.x * scale;
  const y = origin.y + at.y * scale;
  const box = inFrame(page).locator("[data-onlay-root] .box:not(.sel)").first();
  let nudge = 0;
  await expect(async () => {
    nudge = 1 - nudge;
    await page.mouse.move(x + nudge, y);
    await expect(box).toBeVisible({ timeout: 250 });
  }).toPass({ timeout: 30_000 });
  await page.mouse.click(x, y);
  const win = composerWindow(page);
  await expect(win).toBeVisible();
  await typeParts(page, win.getByRole("textbox"), parts);
  await win.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(overlay(page).getByText("comment posted")).toBeVisible();
}

/** A person with the capture grant, their web app and their agent. */
async function looker(
  person: Parameters<Parameters<typeof test>[2]>[0]["person"],
  launchExtension: Parameters<Parameters<typeof test>[2]>[0]["launchExtension"],
  webPerson: Parameters<Parameters<typeof test>[2]>[0]["webPerson"],
  mcp: Parameters<Parameters<typeof test>[2]>[0]["mcp"],
) {
  const ada = await launchExtension(person("ada"), { captureGrant: true });
  const web = (await webPerson(ada.person)).page;
  await (await signInFromPopup(ada)).close();
  const agent = mcp(ada.person);
  await agent.initialize();
  return { ada, web, agent };
}

test("a block scrolled out of view inside the frame gets a look cropped to it, and the frame and the shell are scrolled back (L-1)", async ({
  pages,
  person,
  launchExtension,
  webPerson,
  mcp,
}) => {
  const { ada, web, agent } = await looker(person, launchExtension, webPerson, mcp);
  // The shell holds 600px of its own above the frame: the frame starts low on the page.
  const page = await openShell(ada, shellUrl(pages.base, undefined, { lead: true }));
  await runCommand(page, "Comment on block");
  // Picking the far block scrolls both documents to it.
  await pickIn(page, inFrame(page), inFrame(page).locator("#far-text"));
  const win = composerWindow(page);
  await expect(win).toBeVisible();
  await typeParts(page, win.getByRole("textbox"), [{ mention: "agent" }, " look far down"]);
  // Before it is sent, both documents go back to their tops: the block is far out of view.
  await page.frame({ url: /dossier-content/ })?.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await scrolls(page)).toEqual([0, 0]);
  await win.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(overlay(page).getByText("comment posted")).toBeVisible();

  const ref = await refFor(agent, "look far down");
  const look = await firstLook(web, ref);
  expect(look.parts.map((p) => p.role)).toContain("witness");
  const shot = await witnessOf(web, ref, look);
  await keep("frame-look-far.png", shot.png);
  const box = await frameBox(page, "#far-text");
  // The block's own size, and its own background (#fff6e0).
  expect(Math.abs(shot.width - Math.round(box.width))).toBeLessThanOrEqual(2);
  expect(Math.abs(shot.height - Math.round(box.height))).toBeLessThanOrEqual(2);
  expect(shot.rgb[0]).toBeGreaterThan(240);
  expect(shot.rgb[1]).toBeGreaterThan(236);
  expect(shot.rgb[2]).toBeLessThan(235);
  // Every scroll the look made is put back.
  await expect.poll(() => scrolls(page)).toEqual([0, 0]);

  // A block deep inside a scrolling pane of the frame, the pane scrolled away from it.
  const content = page.frame({ url: /dossier-content/ });
  const paneTop = () =>
    content?.evaluate(() => (document.getElementById("pane") as HTMLElement).scrollTop);
  await runCommand(page, "Comment on block");
  await pickIn(page, inFrame(page), inFrame(page).locator("#pane-text"));
  const paneWin = composerWindow(page);
  await expect(paneWin).toBeVisible();
  await typeParts(page, paneWin.getByRole("textbox"), [{ mention: "agent" }, " look in the pane"]);
  await content?.evaluate(() => {
    (document.getElementById("pane") as HTMLElement).scrollTop = 0;
    window.scrollTo(0, 0);
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await paneTop()).toBe(0);
  await paneWin.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(overlay(page).getByText("comment posted").last()).toBeVisible();
  const paneRef = await refFor(agent, "look in the pane");
  const paneLook = await firstLook(web, paneRef);
  expect(paneLook.parts.map((p) => p.role)).toContain("witness");
  const paneShot = await witnessOf(web, paneRef, paneLook);
  await keep("frame-look-pane.png", paneShot.png);
  const paneBox = await frameBox(page, "#pane-text");
  expect(Math.abs(paneShot.width - Math.round(paneBox.width))).toBeLessThanOrEqual(2);
  expect(Math.abs(paneShot.height - Math.round(paneBox.height))).toBeLessThanOrEqual(2);
  expect(paneShot.rgb[0]).toBeGreaterThan(240);
  expect(paneShot.rgb[1]).toBeGreaterThan(236);
  expect(paneShot.rgb[2]).toBeLessThan(235);
  await expect.poll(paneTop).toBe(0);
  await expect.poll(() => scrolls(page)).toEqual([0, 0]);
});

test("a block taller than the frame's view gets a whole look in tiles (L-1)", async ({
  pages,
  person,
  launchExtension,
  webPerson,
  mcp,
}) => {
  const { ada, web, agent } = await looker(person, launchExtension, webPerson, mcp);
  const page = await openShell(ada, shellUrl(pages.base));
  await runCommand(page, "Comment on block");
  // The section itself (beside its text), 1600px tall in a frame 720px tall.
  await pickIn(page, inFrame(page), inFrame(page).locator("#tall"), { x: 400, y: 200 });
  const win = composerWindow(page);
  await expect(win).toBeVisible();
  await typeParts(page, win.getByRole("textbox"), [{ mention: "agent" }, " the whole tall block"]);
  const before = await scrolls(page);
  await win.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(overlay(page).getByText("comment posted")).toBeVisible();

  const ref = await refFor(agent, "the whole tall block");
  const look = await firstLook(web, ref);
  expect(look.parts.map((p) => p.role)).toContain("witness");
  // Rows from each colour, and across both seams of 720px tiles.
  const shot = await witnessOf(web, ref, look, [700, 716, 720, 724, 900, 1434, 1440, -3]);
  await keep("frame-look-tall.png", shot.png);
  const box = await frameBox(page, "#tall");
  expect(box.height).toBe(1600);
  expect(Math.abs(shot.width - Math.round(box.width))).toBeLessThanOrEqual(2);
  expect(Math.abs(shot.height - 1600)).toBeLessThanOrEqual(2);
  const green = [0xdc, 0xef, 0xdc];
  const violet = [0xef, 0xdc, 0xef];
  const near = (rgba: number[] | undefined, rgb: number[]): boolean =>
    !!rgba && rgba[3] === 255 && rgb.every((v, i) => Math.abs((rgba[i] as number) - v) <= 6);
  // The top half green and the bottom half violet, every row opaque: no gap at a seam.
  for (const i of [0, 1, 2, 3]) expect(near(shot.rows[i], green), `row ${i}`).toBe(true);
  for (const i of [4, 5, 6, 7]) expect(near(shot.rows[i], violet), `row ${i}`).toBe(true);
  await expect.poll(() => scrolls(page)).toEqual(before);
});

test("a frame under a scale gets a look mapped through it; one under a rotation gets none, and each says why (L-2, L-3)", async ({
  origin,
  pages,
  person,
  launchExtension,
  webPerson,
  mcp,
}) => {
  const { ada, web, agent } = await looker(person, launchExtension, webPerson, mcp);

  // Enlarged by a quarter: the look is the block as the tab shows it, 1.25 times its own size.
  const big = await openShell(ada, shellUrl(pages.base, undefined, { transform: "scale(1.25)" }));
  await commentScaled(big, "#goal-text", 1.25, [{ mention: "agent" }, " enlarged"]);
  const bigRef = await refFor(agent, "enlarged");
  const bigLook = await firstLook(web, bigRef);
  expect(bigLook.parts.map((p) => p.role)).toContain("witness");
  const bigShot = await witnessOf(web, bigRef, bigLook);
  await keep("frame-look-scaled.png", bigShot.png);
  const box = await frameBox(big, "#goal-text");
  expect(Math.abs(bigShot.width - Math.round(box.width * 1.25))).toBeLessThanOrEqual(2);
  expect(Math.abs(bigShot.height - Math.round(box.height * 1.25))).toBeLessThanOrEqual(2);
  expect(bigShot.rgb[0]).toBeGreaterThan(240);
  expect(bigShot.rgb[1]).toBeGreaterThan(236);
  expect(bigShot.rgb[2]).toBeLessThan(235);
  await big.close();

  // Shrunk to 0.8: mapped the same way, but the browser never confirms a
  // shrunk frame's pixels as its own, so the screenshot goes and that is said.
  const small = await openShell(ada, shellUrl(pages.base, undefined, { transform: "scale(0.8)" }));
  await commentScaled(small, "#goal-text", 0.8, [{ mention: "agent" }, " shrunk"]);
  const smallRef = await refFor(agent, "shrunk");
  const smallLook = await firstLook(web, smallRef);
  expect(smallLook.parts.map((p) => p.role)).toContain("document");
  expect(smallLook.parts.map((p) => p.role)).not.toContain("witness");
  await small.close();
  expect(await lookNote(web, origin, smallRef)).toBe(
    "No screenshot: this block's frame is shrunk or stretched.",
  );

  // Rotated: no screenshot, and the structured capture is kept.
  const tilted = await openShell(
    ada,
    shellUrl(pages.base, undefined, { transform: "rotate(5deg)" }),
  );
  await commentInFrame(tilted, "#goal-text", [{ mention: "agent" }, " rotated"]);
  const tiltRef = await refFor(agent, "rotated");
  const tiltLook = await firstLook(web, tiltRef);
  expect(tiltLook.parts.map((p) => p.role)).toContain("document");
  expect(tiltLook.parts.map((p) => p.role)).not.toContain("witness");
  await tilted.close();
  expect(await lookNote(web, origin, tiltRef)).toBe(
    "No screenshot: this block's frame is rotated or skewed.",
  );
});

test("a tall block whose text changes between tiles keeps no screenshot, and says the page changed (2-L1)", async ({
  origin,
  pages,
  person,
  launchExtension,
  webPerson,
  mcp,
}) => {
  const { ada, web, agent } = await looker(person, launchExtension, webPerson, mcp);
  // #tall-text is rewritten whenever the frame scrolls, and the look must
  // scroll the frame between its tiles.
  const page = await openShell(ada, shellUrl(pages.base, undefined, { live: true }));
  await runCommand(page, "Comment on block");
  await pickIn(page, inFrame(page), inFrame(page).locator("#tall"), { x: 400, y: 200 });
  const win = composerWindow(page);
  await expect(win).toBeVisible();
  await typeParts(page, win.getByRole("textbox"), [{ mention: "agent" }, " the live table"]);
  await win.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(overlay(page).getByText("comment posted")).toBeVisible();

  const ref = await refFor(agent, "the live table");
  const look = await firstLook(web, ref);
  expect(look.parts.map((p) => p.role)).toContain("document");
  expect(look.parts.map((p) => p.role)).not.toContain("witness");
  expect(await lookNote(web, origin, ref)).toBe(
    "No screenshot: the page changed before the look finished. Ask for a fresh look once it settles.",
  );
});
