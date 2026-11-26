// A face: Onlay's own picture path draws the picture, anything else (an
// address on another host, a data URL, nothing) the initials, and a picture
// that fails to load falls back to them. The person's name names it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { avatar, pictureOf } from "./avatar";

let win: Window | null = null;
const saved = new Map<string, unknown>();
const GLOBALS = ["window", "document", "HTMLElement", "Event"] as const;

beforeEach(() => {
  win = new Window({ url: "http://127.0.0.1:8123/app/" });
  const g = globalThis as unknown as Record<string, unknown>;
  for (const k of GLOBALS) {
    saved.set(k, g[k]);
    g[k] = (win as unknown as Record<string, unknown>)[k];
  }
});
afterEach(() => {
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
  const g = globalThis as unknown as Record<string, unknown>;
  for (const [k, v] of saved) g[k] = v;
  saved.clear();
});

const SPACE_PICTURE =
  "/s/s_aaaaaaaaaaaaaaaaaaaa/people/p_bbbbbbbbbbbbbbbbbbbb/picture/cccccccccccccccc";
const face = (avatarUrl?: string) => ({
  name: "Lina Haddad",
  initials: "LH",
  tint: "#0e7490",
  ...(avatarUrl !== undefined ? { avatarUrl } : {}),
});

describe("avatar", () => {
  test("Onlay's own picture path draws the picture, named by the person", () => {
    for (const url of [SPACE_PICTURE, "/api/me/picture/cccccccccccccccc"]) {
      const node = avatar(face(url), "sm");
      expect(node.querySelector("img")?.getAttribute("src")).toBe(url);
      expect(node.getAttribute("role")).toBe("img");
      expect(node.getAttribute("aria-label")).toBe("Lina Haddad");
      expect(node.className).toBe("avatar round sm");
    }
  });

  test("anything else wears the initials: no request leaves for another host", () => {
    for (const url of [
      undefined,
      "https://workoscdn.com/images/v1/x",
      "https://lh3.googleusercontent.com/a/x",
      "data:image/png;base64,AAAA",
      "/s/../api/me/picture/cccccccccccccccc",
      `${SPACE_PICTURE}?x=1`,
      "javascript:alert(1)",
    ]) {
      const node = avatar(face(url), "md");
      expect(node.querySelector("img")).toBeNull();
      expect(node.textContent).toBe("LH");
      expect(pictureOf(face(url))).toBeUndefined();
    }
  });

  test("a picture that fails to load falls back to the initials", () => {
    const node = avatar(face(SPACE_PICTURE));
    const img = node.querySelector("img") as HTMLImageElement;
    img.dispatchEvent(new Event("error"));
    expect(node.querySelector("img")).toBeNull();
    expect(node.textContent).toBe("LH");
  });

  test("no initials given: they come from the name", () => {
    const node = avatar({ name: "Omar Faris", initials: "", tint: "#000" });
    expect(node.textContent).toBe("OF");
  });
});
