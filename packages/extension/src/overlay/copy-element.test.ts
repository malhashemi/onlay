// Copy element (F-041): clipboard-only, toast with char count, failure toast.
import { describe, expect, test } from "bun:test";
import { copyElement } from "./copy-element";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("copyElement", () => {
  test("copies the full outerHTML synchronously and toasts the char count", async () => {
    const markup = '<div id="hero"><h1>Big</h1></div>';
    const target = { outerHTML: markup } as unknown as Element;
    const writes: string[] = [];
    const toasts: string[] = [];
    let syncWrite = false;
    copyElement(
      target,
      {
        writeText(text) {
          writes.push(text);
          syncWrite = true; // called before copyElement returns
          return Promise.resolve();
        },
      },
      (t) => toasts.push(t),
    );
    expect(syncWrite).toBe(true); // user-gesture requirement: no await first
    await flush();
    expect(writes).toEqual([markup]);
    expect(toasts).toEqual([`block HTML copied (${markup.length} chars)`]);
  });

  test("a refused clipboard write toasts the failure", async () => {
    const target = { outerHTML: "<p>x</p>" } as unknown as Element;
    const toasts: string[] = [];
    copyElement(target, { writeText: () => Promise.reject(new Error("denied")) }, (t) =>
      toasts.push(t),
    );
    await flush();
    expect(toasts).toEqual(["copy failed — clipboard unavailable"]);
  });
});
