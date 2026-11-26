// The build's check that the page's own scripts name no API that sends or stores.
import { describe, expect, test } from "bun:test";
import { ownScripts, sendingOrStoringNames } from "./scan";

describe("sendingOrStoringNames", () => {
  test("finds each API by the name code must use, once", () => {
    const code = `localStorage.setItem("a","b");window.sessionStorage;fetch("/x");fetch("/y");
      new WebSocket(u);navigator.sendBeacon(u);document.cookie="a=b";indexedDB.open("d");caches.open("c")`;
    expect(sendingOrStoringNames(code)).toEqual([
      "WebSocket",
      "caches",
      "cookie",
      "fetch",
      "indexedDB",
      "localStorage",
      "sendBeacon",
      "sessionStorage",
    ]);
  });

  test("a name as a quoted property is found too", () => {
    expect(sendingOrStoringNames('window["localStorage"]')).toEqual(["localStorage"]);
    expect(sendingOrStoringNames("globalThis['fetch'](u)")).toEqual(["fetch"]);
  });

  test("a longer word that only contains a name is not one", () => {
    expect(sendingOrStoringNames("prefetch();fetchRuns();cookies;my_caches;$fetch")).toEqual([]);
  });

  test("what it cannot see: a name put together when the code runs", () => {
    expect(sendingOrStoringNames('window["local" + "Storage"]')).toEqual([]);
  });
});

describe("ownScripts", () => {
  const files: Record<string, string> = {
    "main.js": 'import{a}from"./shared.js";import("./live.js")',
    "shared.js": "export const a=1",
    "live.js":
      'import{a}from"./shared.js";import{b}from"./engine.js";const h=()=>import("./highlight.js")',
    "engine.js": "export const b=2",
    "highlight.js": 'import("./grammar.js")',
    "grammar.js": 'export default ["fetch","localStorage"]',
  };
  const read = (name: string): string => files[name] as string;

  test("the entry, the chunk it loads after the page, and all they import outright", () => {
    const { own, later } = ownScripts("main.js", read);
    expect(own).toEqual(["engine.js", "live.js", "main.js", "shared.js"]);
    // The highlighter loads on demand from there: it is named, not scanned.
    expect(later).toEqual(["highlight.js"]);
  });
});
