// S-3: the "is the extension installed?" ping is answered only for a top-level
// page on the configured server origin (the web app) or the public site (its
// landing page), with the version alone.
import { describe, expect, test } from "bun:test";
import { answerPing, isPing } from "./ping";

const SERVER = "https://app.onlay.dev";
const SITE = "https://onlay.dev";
const BOTH = [SERVER, SITE];

describe("onlay-ping", () => {
  test("a top-level page on the server origin gets the version and nothing else", () => {
    const sender = { origin: SERVER, url: `${SERVER}/app/`, frameId: 0, tab: { id: 4 } };
    expect(answerPing(sender, BOTH, "0.1.42")).toEqual({ ok: true, version: "0.1.42" });
  });

  test("so does a top-level page on the public site, with the same answer", () => {
    const sender = { origin: SITE, url: `${SITE}/`, frameId: 0, tab: { id: 4 } };
    expect(answerPing(sender, BOTH, "0.1.42")).toEqual({ ok: true, version: "0.1.42" });
    expect(answerPing({ url: `${SITE}/install` }, BOTH, "1")).toEqual({ ok: true, version: "1" });
  });

  test("another origin, an opaque one, a frame, or none at all is refused", () => {
    const refused = { ok: false } as const;
    expect(answerPing({ origin: "https://evil.example", frameId: 0 }, BOTH, "1")).toEqual(refused);
    expect(answerPing({ origin: "null", url: `${SERVER}/app/` }, BOTH, "1")).toEqual(refused);
    expect(answerPing({ origin: SERVER, frameId: 3 }, BOTH, "1")).toEqual(refused);
    expect(answerPing({ origin: SITE, frameId: 3 }, BOTH, "1")).toEqual(refused);
    expect(answerPing({}, BOTH, "1")).toEqual(refused);
    // Read off the URL when Chrome gives no origin.
    expect(answerPing({ url: "https://onlay.dev.evil.example/app/" }, BOTH, "1")).toEqual(refused);
    expect(answerPing({ url: "http://onlay.dev/" }, BOTH, "1")).toEqual(refused);
    // Another subdomain of the site is neither origin.
    expect(answerPing({ origin: "https://www.onlay.dev" }, BOTH, "1")).toEqual(refused);
  });

  test("only the ping's own shape counts as one", () => {
    expect(isPing({ type: "onlay-ping" })).toBe(true);
    expect(isPing({ type: "onlay-auth" })).toBe(false);
    expect(isPing("onlay-ping")).toBe(false);
    expect(isPing(null)).toBe(false);
  });
});
