/// <reference types="chrome" />
// Faces in the extension: the initials stay unless the service worker hands
// over a real picture for one of Onlay's picture paths; nothing else is asked
// for. A decoded picture is reused only under the scope the service worker
// answers with now, and a refusal drops it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  DECODED_BUDGET_BYTES,
  decodedPictureBytes,
  forgetPictures,
  paintPicture,
  pictureBitmap,
  SHARED_SIDE,
} from "./picture-face";

let win: Window | null = null;
beforeEach(() => {
  win = new Window({ url: "https://strict.test/" });
});
afterEach(() => {
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
});

const PATH = "/s/s_aaaaaaaaaaaaaaaaaaaa/people/p_bbbbbbbbbbbbbbbbbbbb/picture/dddddddddddddddd";

function face(): HTMLElement {
  const doc = win?.document as unknown as Document;
  const node = doc.createElement("span");
  node.textContent = "LH";
  return node;
}

const settle = () => new Promise((r) => setTimeout(r, 10));

describe("paintPicture", () => {
  test("a value that is not a picture path asks nothing and keeps the initials", async () => {
    const asked: unknown[] = [];
    const node = face();
    for (const url of [undefined, "https://workoscdn.com/x", "data:image/png;base64,AA"]) {
      paintPicture(node, url, node.ownerDocument, async (m) => {
        asked.push(m);
        return { ok: true };
      });
    }
    await settle();
    expect(asked).toHaveLength(0);
    expect(node.textContent).toBe("LH");
  });

  test("a refusal, a wrong type or broken base64 keeps the initials", async () => {
    for (const answer of [
      { ok: false },
      { ok: true, scope: "1|me", type: "image/svg+xml", b64: "PHN2Zz4=" },
      { ok: true, scope: "1|me", type: "image/png", b64: "%%%" },
      // No scope: not an answer.
      { ok: true, type: "image/png", b64: "iVBORw0KGgo=" },
      { ok: true, scope: "", type: "image/png", b64: "iVBORw0KGgo=" },
      undefined,
    ]) {
      const node = face();
      const url = `${PATH.slice(0, -1)}${String.fromCharCode(97 + Math.floor(Math.random() * 20))}`;
      paintPicture(node, url, node.ownerDocument, async () => answer);
      await settle();
      expect(node.textContent).toBe("LH");
      expect(node.querySelector("canvas")).toBeNull();
    }
  });

  test("a failed load is not kept: the next face asks again", async () => {
    let asks = 0;
    const url = "/api/me/picture/eeeeeeeeeeeeeeee";
    const send = async () => {
      asks += 1;
      return { ok: false };
    };
    expect(await pictureBitmap(url, send)).toBeNull();
    await settle();
    expect(await pictureBitmap(url, send)).toBeNull();
    expect(asks).toBe(2);
  });

  test("decoded pictures stay within their byte budget, at one small shared size each, and are forgotten at once", async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = g.createImageBitmap;
    const sizes: Array<number | undefined> = [];
    let closed = 0;
    g.createImageBitmap = async (_src: unknown, ...rest: unknown[]) => {
      const opts = rest[4] as { resizeWidth?: number } | undefined;
      sizes.push(opts?.resizeWidth);
      return { width: 800, height: 600, close: () => (closed += 1) };
    };
    try {
      const send = async () => ({
        ok: true,
        scope: "1|me",
        type: "image/png",
        b64: "iVBORw0KGgo=",
      });
      const many = Math.ceil(DECODED_BUDGET_BYTES / (SHARED_SIDE * SHARED_SIDE * 4)) + 20;
      for (let i = 0; i < many; i++) {
        const key = i
          .toString(32)
          .padStart(16, "a")
          .replace(/[^a-z2-7]/g, "a")
          .slice(0, 16);
        await pictureBitmap(`/api/me/picture/${key}`, send);
      }
      expect(decodedPictureBytes()).toBeLessThanOrEqual(DECODED_BUDGET_BYTES);
      // Each picture: one full decode (closed at once) and one shared copy at SHARED_SIDE.
      expect(sizes.filter((s) => s === SHARED_SIDE).length).toBeGreaterThan(0);
      forgetPictures();
      expect(decodedPictureBytes()).toBe(0);
      await settle();
      expect(closed).toBeGreaterThan(many);
    } finally {
      g.createImageBitmap = saved;
    }
  });

  test("a decoded picture is reused only under the scope it was decoded in", async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = g.createImageBitmap;
    let decodes = 0;
    g.createImageBitmap = async () => {
      decodes += 1;
      return { width: 64, height: 64, close: () => {} };
    };
    try {
      const url = `${PATH.slice(0, -1)}z`;
      let scope = "1|s_aaaaaaaaaaaaaaaaaaaa:0";
      let refuse = false;
      const asked: Array<string | undefined> = [];
      const send = async (m: { held?: string }) => {
        asked.push(m.held);
        if (refuse) return { ok: false };
        if (m.held === scope) return { ok: true, scope, held: true };
        return { ok: true, scope, type: "image/png", b64: "iVBORw0KGgo=" };
      };
      const first = await pictureBitmap(url, send);
      expect(first).not.toBeNull();
      const perPicture = decodes;
      // The same scope: the service worker is asked, and the decode is reused.
      expect(await pictureBitmap(url, send)).toBe(first);
      expect(decodes).toBe(perPicture);
      expect(asked).toEqual([undefined, scope]);
      // Another scope (an access change, another account): decoded anew, never the old one.
      scope = "1|s_aaaaaaaaaaaaaaaaaaaa:1";
      const second = await pictureBitmap(url, send);
      expect(second).not.toBe(first);
      expect(decodes).toBe(perPicture * 2);
      // A refusal (the space is no longer theirs) drops what was decoded.
      refuse = true;
      expect(await pictureBitmap(url, send)).toBeNull();
      refuse = false;
      await pictureBitmap(url, send);
      expect(asked.at(-1)).toBeUndefined();
      expect(decodes).toBe(perPicture * 3);
    } finally {
      g.createImageBitmap = saved;
      forgetPictures();
    }
  });
});
