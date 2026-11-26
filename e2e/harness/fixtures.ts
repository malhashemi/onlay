// The fixtures every journey builds on: signed-in people.
//
// - `launchExtension` / `signInFromPopup`: a person's own Chromium with the
//   unpacked extension, signed in through the real flow (the popup's Sign in →
//   the `/auth/extension` tab → the dev sign-in form → the hand-off message).
// - `extensionPerson`: both, for journeys that start signed in.
// - `webPerson`: a browser with no extension, signed in to the web app through
//   the dev form (a guest, or anyone who only uses the web app).
// - `mcp`: an MCP client acting as a person (`mcp.ts`).
//
// People get unique emails per test (`<name>@<random>.e2e.test`, so the name
// onlay derives from the email stays readable) and their own
// `CF-Connecting-IP`: every browser in a run reaches `wrangler dev` from one
// loopback address, and the sign-in rate limit is per address.
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Browser,
  type BrowserContext,
  test as base,
  chromium,
  expect,
  type Page,
  type TestInfo,
  type Worker,
} from "@playwright/test";
import { type McpClient, mcpClient } from "./mcp";
import { type PageServer, startPageServer } from "./page-server";
import { stackInfo } from "./stack";

export interface Person {
  /** What onlay calls them: the email's local part. */
  name: string;
  email: string;
  /** The address their browser appears to come from. */
  ip: string;
}

export interface ExtensionHandle {
  person: Person;
  context: BrowserContext;
  extensionId: string;
  serviceWorker(): Promise<Worker>;
  /** The toolbar popup, opened as a tab. */
  popup(): Promise<Page>;
  /** A page in the same browser: the web app shares the extension sign-in's session. */
  newPage(): Promise<Page>;
  /** The toolbar badge's text, as the person sees it. */
  badge(): Promise<string>;
}

interface WebHandle {
  person: Person;
  context: BrowserContext;
  page: Page;
}

interface Fixtures {
  origin: string;
  pages: PageServer;
  /** `<pages.base>/article.html` */
  article: string;
  person(name: string): Person;
  /**
   * With `captureGrant`, the extension holds the broad host grant a look's
   * screenshot needs (the person would grant it from the popup; an unpacked
   * test copy is given it in its manifest instead).
   */
  launchExtension(person: Person, opts?: { captureGrant?: boolean }): Promise<ExtensionHandle>;
  extensionPerson(name: string): Promise<ExtensionHandle>;
  /** A web app user: a new person by name, or one made earlier with `person`. */
  webPerson(who: string | Person): Promise<WebHandle>;
  mcp(person: Person): McpClient;
}

let ipCounter = 0;

/** A copy of the run's extension whose manifest grants every host (looks need it). */
let grantedDir: string | null = null;
function grantedExtension(dir: string): string {
  if (grantedDir) return grantedDir;
  const copy = join(mkdtempSync(join(tmpdir(), "onlay-e2e-granted-")), "extension");
  cpSync(dir, copy, { recursive: true });
  const path = join(copy, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as { host_permissions: string[] };
  manifest.host_permissions = [...manifest.host_permissions, "<all_urls>"];
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  grantedDir = copy;
  return copy;
}

/**
 * Closes the contexts a test opened, keeping a screenshot of every page when
 * the test failed (Playwright's own trace covers these contexts too).
 */
async function closeAll(contexts: BrowserContext[], info: TestInfo, label: string): Promise<void> {
  const failed = info.status !== info.expectedStatus;
  for (const [i, context] of contexts.entries()) {
    if (failed) {
      for (const [j, page] of context.pages().entries()) {
        await page
          .screenshot({ path: info.outputPath(`${label}-${i}-page-${j}.png`) })
          .catch(() => {});
      }
    }
    await context.close();
  }
}

async function serviceWorkerOf(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? context.waitForEvent("serviceworker");
}

interface ChromeGlobal {
  chrome: {
    action: { getBadgeText(d: Record<string, never>): Promise<string> };
    runtime: { sendMessage(m: unknown): Promise<{ serverOrigin?: string } | undefined> };
  };
}

/** Signs a person in to the web app through the dev form on `page`, landing on /app/. */
async function devFormSignIn(page: Page, origin: string, person: Person): Promise<void> {
  await page.goto(`${origin}/auth/login?return_to=${encodeURIComponent("/app/")}`);
  await page.getByLabel("Email").fill(person.email);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${origin}/app/**`);
}

// The extension redeems its sign-in code from the service worker, whose
// requests carry no `CF-Connecting-IP`: every extension sign-in in a run
// counts against one address, and the server allows 10 a minute. Wait rather
// than be refused when a suite signs in more often than that.
const SIGN_INS_PER_MINUTE = 10;
const extensionSignIns: number[] = [];
async function paceExtensionSignIn(): Promise<void> {
  const now = Date.now();
  while (extensionSignIns.length > 0 && now - (extensionSignIns[0] ?? 0) > 61_000) {
    extensionSignIns.shift();
  }
  if (extensionSignIns.length >= SIGN_INS_PER_MINUTE) {
    const wait = Math.max(0, 61_000 - (now - (extensionSignIns[0] ?? now)));
    // The wait is the harness's, not the journey's: it does not count against the test.
    const info = base.info();
    info.setTimeout(info.timeout + wait + 1_000);
    await new Promise((r) => setTimeout(r, wait));
    extensionSignIns.shift();
  }
  extensionSignIns.push(Date.now());
}

/**
 * The popup's Sign in, as the person does it: the service worker opens the
 * sign-in tab; the dev form signs them in; the hand-off page gives the code
 * back to the extension; the popup turns into their Inbox.
 */
export async function signInFromPopup(ext: ExtensionHandle): Promise<Page> {
  await paceExtensionSignIn();
  const popup = await ext.popup();
  // The tab the service worker opens, and its token redemption, reach the
  // stack without the person's test address, so they share one sign-in rate
  // window (10 a minute) across the run: a refused attempt waits for the next
  // window and tries again.
  for (let attempt = 1; ; attempt += 1) {
    // A fresh popup: its button stays disabled once a sign-in tab was opened.
    if (attempt > 1) await popup.reload();
    const signInTab = ext.context.waitForEvent("page");
    await popup.getByRole("button", { name: "Sign in" }).click();
    const tab = await signInTab;
    const limited = tab.getByText("rate_limited");
    const email = tab.getByLabel("Email");
    await expect(email.or(limited)).toBeVisible();
    if (await limited.isVisible()) {
      await tab.close();
      if (attempt >= 3) throw new Error("sign-in stayed rate limited");
      await new Promise((r) => setTimeout(r, 61_000 - (Date.now() % 60_000)));
      continue;
    }
    await email.fill(ext.person.email);
    await tab.getByRole("button", { name: "Sign in" }).click();
    await expect(tab.getByText("You're signed in. You can close this tab.")).toBeVisible();
    await tab.close();
    const signedIn = await expect(popup.locator(".head .title"))
      .toHaveText("Inbox", { timeout: 10_000 })
      .then(
        () => true,
        () => false,
      );
    if (!signedIn) {
      // The hand-off's redemption was refused: the next window lets it through.
      if (attempt >= 3) throw new Error("sign-in did not complete");
      await new Promise((r) => setTimeout(r, 61_000 - (Date.now() % 60_000)));
      continue;
    }
    break;
  }
  await expect(popup.locator(".head .name")).toHaveText(ext.person.name);
  return popup;
}

export const test = base.extend<Fixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: playwright fixture signature
  origin: async ({}, use) => {
    await use(stackInfo().origin);
  },
  // biome-ignore lint/correctness/noEmptyPattern: playwright fixture signature
  pages: async ({}, use) => {
    const pages = await startPageServer();
    await use(pages);
    await pages.stop();
  },
  article: async ({ pages }, use) => {
    await use(`${pages.base}/article.html`);
  },
  // biome-ignore lint/correctness/noEmptyPattern: playwright fixture signature
  person: async ({}, use) => {
    const domain = `${randomBytes(4).toString("hex")}.e2e.test`;
    await use((name) => {
      ipCounter += 1;
      return {
        name,
        email: `${name}@${domain}`,
        ip: `10.${process.pid % 250}.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`,
      };
    });
  },
  launchExtension: async ({ origin }, use, info) => {
    const opened: BrowserContext[] = [];
    await use(async (person, opts) => {
      const extensionDir = opts?.captureGrant
        ? grantedExtension(stackInfo().extensionDir)
        : stackInfo().extensionDir;
      const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        viewport: { width: 1280, height: 1000 },
        args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
      });
      opened.push(context);
      await context.setExtraHTTPHeaders({ "CF-Connecting-IP": person.ip });
      const sw = await serviceWorkerOf(context);
      const extensionId = new URL(sw.url()).host;
      const handle: ExtensionHandle = {
        person,
        context,
        extensionId,
        serviceWorker: () => serviceWorkerOf(context),
        async popup() {
          const page = await context.newPage();
          await page.goto(`chrome-extension://${extensionId}/popup.html`);
          // The run's build talks to the run's server.
          await expect
            .poll(() =>
              page.evaluate(async () => {
                const r = await (globalThis as unknown as ChromeGlobal).chrome.runtime.sendMessage({
                  type: "getStatus",
                });
                return r?.serverOrigin;
              }),
            )
            .toBe(origin);
          return page;
        },
        newPage: () => context.newPage(),
        async badge() {
          const worker = await serviceWorkerOf(context);
          return worker.evaluate(() =>
            (globalThis as unknown as ChromeGlobal).chrome.action.getBadgeText({}),
          );
        },
      };
      return handle;
    });
    await closeAll(opened, info, "extension");
  },
  extensionPerson: async ({ person, launchExtension }, use) => {
    await use(async (name) => {
      const ext = await launchExtension(person(name));
      const popup = await signInFromPopup(ext);
      await popup.close();
      return ext;
    });
  },
  webPerson: async ({ origin, person, browser }, use, info) => {
    const opened: BrowserContext[] = [];
    await use(async (nameOrPerson) => {
      const who = typeof nameOrPerson === "string" ? person(nameOrPerson) : nameOrPerson;
      const context = await (browser as Browser).newContext({
        viewport: { width: 1100, height: 900 },
      });
      opened.push(context);
      await context.setExtraHTTPHeaders({ "CF-Connecting-IP": who.ip });
      const page = await context.newPage();
      await devFormSignIn(page, origin, who);
      return { person: who, context, page };
    });
    await closeAll(opened, info, "web");
  },
  mcp: async ({ origin }, use) => {
    await use((who) => mcpClient(origin, who.email));
  },
});

export { expect };
