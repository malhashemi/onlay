// The page's words: the brand's lexicon holds everywhere, the film's length
// is one number, and no button names a place it does not lead to.
import { describe, expect, test } from "bun:test";
import { CHROME_WEB_STORE_URL, FILM, installHref, PATHS, STORE_LISTED, serviceUrl } from "./config";
import { COPY, OWN } from "./copy";
import * as PRODUCT from "./overlay/strings";
import { AGENT_SETUP } from "./page";

/** Every string in a table, functions sampled with real values. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "function")
    out.push(String((value as (...a: unknown[]) => unknown)("2", "3", "Label")));
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) strings(v, out);
  return out;
}

describe("the lexicon", () => {
  // block, Edit, Inbox, space; never element, queue, popover, membrane, an
  // exclamation mark, or the two primitives the product hides.
  const BANNED = [
    /\belements?\b/i,
    /\bqueue\b/i,
    /popover/i,
    /membrane/i,
    /!/,
    /\bAsks?\b/,
    /\bAnchor\b/,
  ];
  const page = [...strings(COPY), ...strings(OWN)];

  test("holds in every string of the page", () => {
    expect(page.length).toBeGreaterThan(60);
    for (const s of page) for (const re of BANNED) expect(s).not.toMatch(re);
  });

  test("holds in the product strings the demo shows", () => {
    // The product's own words (it says "Ask for one more variant", the verb):
    // the hidden primitives never appear as things.
    const things = [...BANNED.slice(0, 5), /\bAsks\b|\ban Ask\b|\bAnchor\b/];
    for (const s of strings(PRODUCT)) for (const re of things) expect(s).not.toMatch(re);
  });

  test("no emoji in the system voice (reactions are the visitor's own)", () => {
    const emoji = /\p{Extended_Pictographic}/u;
    for (const s of page) expect(s).not.toMatch(emoji);
  });
});

describe("the film", () => {
  test("its length is one number, and the copy follows it", () => {
    const clock = `${Math.floor(FILM.seconds / 60)}:${String(FILM.seconds % 60).padStart(2, "0")}`;
    expect(COPY.hero.ctaSecondary).toBe(`Watch the film (${clock})`);
    expect(COPY.film.headline).toBe(`See the loop in ${FILM.seconds} seconds.`);
  });
});

describe("the install buttons", () => {
  const labels = [COPY.hero.ctaPrimary, COPY.nav.install, COPY.install.cta];

  test("say the same thing everywhere", () => {
    expect(new Set(labels).size).toBe(1);
  });

  test("never name the store while they lead to /install", () => {
    if (STORE_LISTED) {
      expect(installHref()).toBe(CHROME_WEB_STORE_URL);
      expect(labels[0]).toBe("Add to Chrome");
      expect(COPY.install.alt).toBeTruthy();
      return;
    }
    expect(installHref()).toBe(PATHS.install);
    expect(labels[0]).toBe("Install the extension");
    for (const s of [...labels, COPY.install.body])
      expect(s).not.toMatch(/Chrome Web Store|Add to Chrome/);
    // The button itself leads to the manual install: no second line about it.
    expect(COPY.install.alt).toBeNull();
  });

  test("the store address is the submitted listing's", () => {
    expect(CHROME_WEB_STORE_URL).toBe(
      "https://chromewebstore.google.com/detail/ifolhmiajgkaecdfghbnkchpeibajnbj",
    );
  });
});

describe("the service", () => {
  test("one origin serves the web app link, the MCP address and its config", () => {
    const origin = serviceUrl("");
    expect(origin).toMatch(/^https?:\/\/[^/]+$/);
    expect(AGENT_SETUP.mcpUrl()).toBe(`${origin}/mcp`);
    expect(JSON.parse(AGENT_SETUP.mcpConfig())).toEqual({
      mcpServers: { onlay: { type: "http", url: `${origin}/mcp` } },
    });
  });

  test("the site's own pages stay relative", () => {
    expect(PATHS).toEqual({ install: "/install", privacy: "/privacy" });
  });
});
