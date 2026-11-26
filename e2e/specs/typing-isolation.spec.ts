// Typing isolation (R2-C1): a visited page listens on window and document, in
// both phases, for every key, input, composition and clipboard event. A person
// writes a comment with a mention and sends it, types in the command bar and
// pastes into a composer. The page records nothing that came from onlay, and
// the comments arrive with exactly the words typed and pasted.
//
// Keyboard only, so the same spec runs against the open test build and the
// closed default build (`E2E_SHADOW_MODE=closed`).
import { expect, test } from "../harness/fixtures";

interface Seen {
  type: string;
  target: string;
  onlay: boolean;
  key: string;
  data: string;
  clip: string;
}

interface ThreadSnap {
  thread: Array<{ body: { text: string; tokens?: Array<{ t: string }> } }>;
}

test("nothing typed, pasted or composed in onlay reaches the page; everything typed arrives", async ({
  pages,
  extensionPerson,
}) => {
  const ada = await extensionPerson("ada");
  await ada.context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: pages.base,
  });
  const url = `${pages.base}/listeners.html`;
  const page = await ada.newPage();
  await page.goto(url);
  await expect(page.locator("[data-onlay-root]")).toBeAttached();
  const sw = await ada.serviceWorker();
  await expect
    .poll(() =>
      sw.evaluate(async () => {
        const r = await new Promise<{ connected?: boolean }>((res) =>
          (
            globalThis as unknown as {
              chrome: { runtime: { sendMessage(m: unknown, cb: (r: never) => void): void } };
            }
          ).chrome.runtime.sendMessage({ type: "getStatus" }, res),
        ).catch(() => ({ connected: false }));
        return r?.connected === true;
      }),
    )
    .toBe(true)
    .catch(() => {});
  await page.waitForTimeout(1000);

  // The page's own field still hears its own typing (the listeners work).
  await page.locator("#page-field").click();
  await page.keyboard.type("own");
  const own = await page.evaluate(() => (window as unknown as { __seen: Seen[] }).__seen.length);
  expect(own).toBeGreaterThan(0);
  await page.evaluate(() => {
    (window as unknown as { __seen: Seen[] }).__seen = [];
  });

  // 1. A comment with a mention, written and sent from the keyboard.
  await page.locator("body").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Control+.");
  await page.waitForTimeout(300);
  await page.keyboard.type("Comment on block");
  await page.keyboard.press("Enter");
  await page.locator("#price").click();
  await page.waitForTimeout(400);
  await page.keyboard.type("zebra check for ");
  await page.keyboard.type("@agent");
  await page.waitForTimeout(300);
  await page.keyboard.press("Enter"); // the mention menu takes Enter
  await page.keyboard.type("please"); // accepting a mention already adds the space
  await page.keyboard.press("Enter"); // send

  // 2. Typing in the command bar (and Escape closes it).
  await page.waitForTimeout(800);
  await page.locator("body").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Control+.");
  await page.waitForTimeout(300);
  await page.keyboard.type("quokka");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // 3. Paste into a composer and send it.
  await page.evaluate(() => navigator.clipboard.writeText("narwhal pasted words"));
  await page.locator("body").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Control+.");
  await page.waitForTimeout(300);
  await page.keyboard.type("Comment on block");
  await page.keyboard.press("Enter");
  await page.locator("#other").click();
  await page.waitForTimeout(400);
  await page.keyboard.press("ControlOrMeta+V");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1000);

  // 4. The page moves onlay's host into a shadow tree of its own — open, then
  //    closed — while the person types in the command bar. The overlay comes
  //    off that host at once and is mounted again where it belongs, and what
  //    is typed into it afterwards still never reaches the page.
  for (const mode of ["open", "closed"] as const) {
    await page.locator("body").click({ position: { x: 4, y: 4 } });
    await page.keyboard.press("Control+.");
    await page.waitForTimeout(300);
    await page.keyboard.type(`kiwi${mode}`);
    expect(
      await page.evaluate(
        (m) => (window as unknown as { __moveHost(m: string): boolean }).__moveHost(m),
        mode,
      ),
    ).toBe(true);
    await page.waitForTimeout(300);
    const hosts = await page.evaluate(() => ({
      inPlace: document.querySelectorAll(":root > [data-onlay-root]").length,
      anywhere: document.querySelectorAll("[data-onlay-root]").length,
    }));
    expect(hosts).toEqual({ inPlace: 1, anywhere: 1 });
    // The fresh host opens with nothing on it (3b-C2); Escape is harmless.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.locator("body").click({ position: { x: 4, y: 4 } });
    await page.keyboard.press("Control+.");
    await page.waitForTimeout(300);
    await page.keyboard.type(`lychee${mode}`);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  }

  // The page saw nothing from onlay: no event aimed at the overlay, and none
  // of the words typed or pasted there.
  const seen = await page.evaluate(() => (window as unknown as { __seen: Seen[] }).__seen);
  const fromOverlay = seen.filter((s) => s.onlay || s.target.startsWith("page-widget"));
  expect(fromOverlay).toEqual([]);
  const carried = seen.map((s) => `${s.key}${s.data}${s.clip}`).join("");
  for (const word of ["zebra", "agent", "please", "quokka", "narwhal", "kiwi", "lychee"]) {
    expect(carried).not.toContain(word);
  }

  // Both comments arrived with exactly the words typed and pasted.
  const threads = await sw.evaluate(async (pageUrl: string) => {
    const g = globalThis as unknown as {
      chrome: { storage: { local: { get(k: string[]): Promise<Record<string, unknown>> } } };
    };
    const l = await g.chrome.storage.local.get(["token", "tokenOrigin", "spaces"]);
    const spaces = (l.spaces as Array<{ id: string }>) ?? [];
    const out: ThreadSnap[] = [];
    for (const s of spaces) {
      const res = await fetch(
        `${l.tokenOrigin}/s/${s.id}/interaction?url=${encodeURIComponent(pageUrl)}`,
        { headers: { authorization: `Bearer ${l.token}`, "Onlay-Protocol": "2" } },
      );
      if (!res.ok) continue;
      const body = (await res.json()) as { interactions?: ThreadSnap[] };
      out.push(...(body.interactions ?? []));
    }
    return out;
  }, url);
  const texts = threads.map((t) => t.thread[0]?.body.text ?? "");
  expect(texts).toContain("zebra check for @agent please");
  const mention = threads.find((t) => t.thread[0]?.body.text.startsWith("zebra"));
  expect(mention?.thread[0]?.body.tokens?.some((k) => k.t === "agent")).toBe(true);
  expect(texts).toContain("narwhal pasted words");

  // 5. A page that wraps every new top-level element cannot make the remount
  //    loop (3b-C2): after a bounded number of fresh hosts the overlay stays
  //    down for this page load, and the tab stays responsive.
  await page.evaluate(() => (window as unknown as { __wrapForever(): void }).__wrapForever());
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => ({
    wraps: (window as unknown as { __wraps: number }).__wraps,
    hosts: document.querySelectorAll("[data-onlay-root]").length,
  }));
  expect(after.wraps).toBeGreaterThan(0);
  expect(after.wraps).toBeLessThanOrEqual(4);
  expect(after.hosts).toBe(0);
});
