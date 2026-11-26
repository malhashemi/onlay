import { expect, test } from "bun:test";
import { bindCapture } from "./binding";

test("a capture holds only while page, fragment, account and the caller's check all hold", () => {
  const at = {
    url: "https://app.test/orders#1",
    account: "p_a|https://app.onlay.dev" as string | null,
  };
  let block = true;
  const check = bindCapture({ frameUrl: () => at.url, account: () => at.account }, () => block);
  expect(check()).toBe(true);
  at.url = "https://app.test/orders#2"; // a hash-routed app's other record
  expect(check()).toBe(false);
  at.url = "https://app.test/orders#1";
  at.account = "p_b|https://app.onlay.dev";
  expect(check()).toBe(false);
  at.account = "p_a|https://app.onlay.dev";
  block = false;
  expect(check()).toBe(false);
});

test("a capture started signed out never holds", () => {
  expect(bindCapture({ frameUrl: () => "https://app.test/", account: () => null })()).toBe(false);
});
