import { env, exports } from "cloudflare:workers";
import { PROTOCOL_VERSION } from "@onlay/protocol";
import { describe, expect, test } from "vitest";
import * as entry from "../../src/worker";

describe("the Worker boots in workerd", () => {
  test("the edge answers /healthz", async () => {
    const res = await exports.default.fetch(`${env.PUBLIC_ORIGIN}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sha: "dev", protocol: PROTOCOL_VERSION });
  });

  test("a space's Durable Object answers from its SQLite storage", async () => {
    const stub = env.SPACE.get(env.SPACE.idFromName("s_abcdefghijklmnopqrst"));
    const res = await stub.fetch("https://space/healthz");
    expect(await res.json()).toEqual({ ok: true, protocol: PROTOCOL_VERSION });
  });

  test("the D1 directory binding answers", async () => {
    expect(await env.DB.prepare("SELECT 1 AS ok").first("ok")).toBe(1);
  });

  test("the entry module exports only handlers, functions and classes (workerd refuses anything else)", () => {
    for (const [name, value] of Object.entries(entry)) {
      if (name === "default") expect(typeof value).toBe("object");
      else expect([name, typeof value]).toEqual([name, "function"]);
    }
  });

  test("the dev environment enables the sign-in stub", () => {
    expect(env.DEV_AUTH).toBe("1");
  });
});
