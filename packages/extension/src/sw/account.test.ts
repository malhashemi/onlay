// The service worker's HTTP calls belong to the account they started under
// (findings 1 and 3): a pinned token only ever goes to its own origin, a call
// whose account moved on sends nothing more, and a late answer — data, 401 or
// 426 — from an older account is dropped.
import { expect, test } from "bun:test";
import { createAccountApi, type Pin } from "./account";

const DEV = "http://localhost:8787";
const PROD = "https://app.onlay.dev";

function rig() {
  let account: Pin = { origin: DEV, token: "onl_dev", generation: 1 };
  const sent: Array<{ url: string; auth: string | undefined }> = [];
  const signedOut: number[] = [];
  const upgrades: string[] = [];
  let answer: (url: string) => Promise<Response> = async () => new Response("{}");
  const api = createAccountApi({
    fetch: async (url, init) => {
      sent.push({ url, auth: (init.headers as Record<string, string>).authorization });
      return answer(url);
    },
    current: () => account,
    signedOut: async (g) => {
      signedOut.push(g);
    },
    upgradeRequired: async (o) => {
      upgrades.push(o);
    },
  });
  return {
    api,
    sent,
    signedOut,
    upgrades,
    switchTo: (next: Pin) => {
      account = next;
    },
    answerWith: (fn: (url: string) => Promise<Response>) => {
      answer = fn;
    },
  };
}

test("a pinned upload never sends the next account's token, and stops once the account moved", async () => {
  const r = rig();
  const pin = r.api.pin();
  await r.api.call(pin, "/s/a/interaction/i/capture", { method: "POST" });
  // The person signs in to production between the phases of the upload.
  r.switchTo({ origin: PROD, token: "onl_prod", generation: 2 });
  const put = await r.api.call(pin, "/s/a/interaction/i/capture/c/part/witness", { method: "PUT" });
  expect(put).toBeNull();
  expect(r.sent).toEqual([{ url: `${DEV}/s/a/interaction/i/capture`, auth: "Bearer onl_dev" }]);
  expect(r.sent.some((s) => s.auth === "Bearer onl_prod")).toBe(false);
});

test("a 401 that arrives after a new sign-in does not sign the new account out", async () => {
  const r = rig();
  const pin = r.api.pin();
  let release: (res: Response) => void = () => {};
  r.answerWith(
    () =>
      new Promise((ok) => {
        release = ok;
      }),
  );
  const late = r.api.call(pin, "/api/me");
  r.switchTo({ origin: DEV, token: "onl_new", generation: 2 });
  release(new Response("{}", { status: 401 }));
  expect(await late).toBeNull();
  expect(r.signedOut).toEqual([]);
});

test("a current 401 signs out once, naming its generation; a current 426 names its origin", async () => {
  const r = rig();
  r.answerWith(async (url) => new Response("{}", { status: url.endsWith("/old") ? 426 : 401 }));
  await r.api.call(r.api.pin(), "/api/me");
  await r.api.call(r.api.pin(), "/old");
  expect(r.signedOut).toEqual([1]);
  expect(r.upgrades).toEqual([DEV]);
});

test("a body read after the account moved on is dropped", async () => {
  const r = rig();
  r.answerWith(async () => new Response(JSON.stringify({ person: { id: "p_old" } })));
  const pin = r.api.pin();
  const res = await r.api.call(pin, "/api/me");
  r.switchTo({ origin: DEV, token: null, generation: 2 }); // signed out meanwhile
  expect(await r.api.json(pin, res)).toBeNull();
});

test("no token, nothing sent", async () => {
  const r = rig();
  r.switchTo({ origin: DEV, token: null, generation: 3 });
  expect(await r.api.call(r.api.pin(), "/api/me")).toBeNull();
  expect(r.sent).toEqual([]);
});
