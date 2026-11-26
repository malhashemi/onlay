import { expect, test } from "bun:test";
import { originOf, PAGE_SYNC_TYPES, splitPageSync } from "./gate";

const A = "s_aaaaaaaaaaaaaaaaaaaa";
const B = "s_bbbbbbbbbbbbbbbbbbbb";

test("a page sync goes only to spaces whose origins hold the page's origin", () => {
  const split = splitPageSync("https://app.example/dash?x=1", [A, B], {
    [A]: ["https://app.example"],
    [B]: ["https://other.example"],
  });
  expect(split).toEqual({ relay: [A], local: [B] });
});

test("a space with no origins yet hears nothing", () => {
  expect(splitPageSync("https://app.example/", [A], {})).toEqual({ relay: [], local: [A] });
});

test("origins compare whole: scheme and port count, paths don't", () => {
  const origins = { [A]: ["https://app.example"] };
  expect(splitPageSync("http://app.example/", [A], origins).relay).toEqual([]);
  expect(splitPageSync("https://app.example:8443/", [A], origins).relay).toEqual([]);
  expect(splitPageSync("https://app.example.evil/", [A], origins).relay).toEqual([]);
  expect(splitPageSync("https://app.example/deep/path#h", [A], origins).relay).toEqual([A]);
});

test("non-web and malformed page URLs are never relayed", () => {
  const origins = { [A]: ["null", "chrome://newtab"] };
  for (const url of ["about:blank", "chrome://newtab/", "not a url", ""]) {
    expect(splitPageSync(url, [A], origins)).toEqual({ relay: [], local: [A] });
  }
  expect(originOf("file:///tmp/x.html")).toBeNull();
});

test("the gated frames are the page syncs", () => {
  expect([...PAGE_SYNC_TYPES].sort()).toEqual(["interaction-sync", "variant-sync"]);
});
