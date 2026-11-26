// S-3: the Inbox's extension hint shows only on a desktop Chromium browser,
// only when no extension id answers the ping, and never again once dismissed.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  dismissHint,
  extensionInstalled,
  HINT_DISMISSED_KEY,
  isDesktopChromium,
  type PageRuntime,
  shouldShowExtensionHint,
} from "./extension-hint";

const chromeDesktop = {
  userAgentData: {
    brands: [{ brand: "Google Chrome" }, { brand: "Chromium" }, { brand: "Not_A Brand" }],
    mobile: false,
    platform: "macOS",
  },
};
const IDS = ["abcdefghijklmnopabcdefghijklmnop"];

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    },
  };
});
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

/** A page runtime whose extensions answer as `answers` says (by id); others never answer. */
function runtime(answers: Record<string, unknown>): PageRuntime & { asked: string[] } {
  const rt: PageRuntime & { asked: string[] } = {
    asked: [],
    sendMessage(id, message, callback) {
      rt.asked.push(`${id} ${JSON.stringify(message)}`);
      if (id in answers) setTimeout(() => callback(answers[id]), 0);
    },
  };
  return rt;
}

describe("desktop Chromium, from client hints alone", () => {
  test("Chrome, Edge and Brave on a desktop are; phones, Android tablets and other browsers are not", () => {
    expect(isDesktopChromium(chromeDesktop)).toBe(true);
    const edge = { userAgentData: { ...chromeDesktop.userAgentData, platform: "Windows" } };
    expect(isDesktopChromium(edge)).toBe(true);
    const phone = { userAgentData: { ...chromeDesktop.userAgentData, mobile: true } };
    expect(isDesktopChromium(phone)).toBe(false);
    const tablet = { userAgentData: { ...chromeDesktop.userAgentData, platform: "Android" } };
    expect(isDesktopChromium(tablet)).toBe(false);
    // Firefox and Safari expose no client hints at all.
    expect(isDesktopChromium({ userAgent: "Mozilla/5.0 … Firefox/140.0" })).toBe(false);
    expect(isDesktopChromium(undefined)).toBe(false);
  });
});

describe("the ping", () => {
  test("an installed extension answers ok: no hint", async () => {
    const rt = runtime({ [IDS[0] as string]: { ok: true, version: "0.1.9" } });
    expect(await extensionInstalled(IDS, rt)).toBe(true);
    expect(rt.asked).toEqual([`${IDS[0]} {"type":"onlay-ping"}`]);
    expect(await shouldShowExtensionHint(IDS, chromeDesktop, rt)).toBe(false);
  });

  test("no runtime, a refusal or silence means none is installed: the hint shows", async () => {
    expect(await shouldShowExtensionHint(IDS, chromeDesktop, undefined)).toBe(true);
    const refused = runtime({ [IDS[0] as string]: { ok: false } });
    expect(await shouldShowExtensionHint(IDS, chromeDesktop, refused)).toBe(true);
    expect(await shouldShowExtensionHint(IDS, chromeDesktop, runtime({}), 20)).toBe(true);
  });

  test("not on other browsers, not without ids, and not once dismissed in this browser", async () => {
    expect(await shouldShowExtensionHint(IDS, { userAgent: "Safari" }, undefined)).toBe(false);
    expect(await shouldShowExtensionHint(undefined, chromeDesktop, undefined)).toBe(false);
    expect(await shouldShowExtensionHint([], chromeDesktop, undefined)).toBe(false);
    dismissHint();
    expect(store.get(HINT_DISMISSED_KEY)).toBe("1");
    expect(await shouldShowExtensionHint(IDS, chromeDesktop, undefined)).toBe(false);
  });
});
