// The space's Durable Object shell in workerd (spec §7, §11): hibernating
// sockets admitted by the caller header, state that survives eviction,
// per-socket filtering across real sockets, the alarm, and web push crypto on
// the runtime's own Web Crypto.
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type Caller, encodeCaller, PROTOCOL_VERSION } from "@onlay/protocol";
import { describe, expect, test } from "vitest";
import {
  b64url,
  encryptAes128Gcm,
  generateVapidKeys,
  unb64url,
  vapidAuthorization,
} from "../../src/space/webpush";

// biome-ignore lint/suspicious/noExplicitAny: tests read bodies and frames loosely
type Json = Record<string, any>;

const ADA = "p_adaadaadaadaadaadaad";
const GUS = "p_gusgusgusgusgusgusgu";
const PAGE = "https://example.com/pricing";

const caller = (
  personId: string,
  access: Caller["access"],
  cls: Caller["class"] = "full",
): Caller => ({
  personId,
  name: personId === ADA ? "Ada" : "Gus",
  initials: "A",
  tint: "#336699",
  class: cls,
  access,
  credentialId: `cred-${personId}`,
  // A space told of no access change yet is at epoch 0; the edge always sends one.
  accessEpoch: 0,
  credentialGeneration: 0,
});
const ada = caller(ADA, { kind: "member", role: "admin" });

let n = 0;
function space() {
  n += 1;
  return env.SPACE.get(env.SPACE.idFromName(`s_${"a".repeat(19)}${"bcdefghij"[n % 9]}`));
}

async function call(
  stub: DurableObjectStub,
  who: Caller,
  method: string,
  path: string,
  body?: unknown,
) {
  const res = await stub.fetch(`https://space${path}`, {
    method,
    headers: {
      "X-Onlay-Caller": encodeCaller(who),
      "Onlay-Protocol": String(PROTOCOL_VERSION),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

async function connect(stub: DurableObjectStub, who: Caller) {
  const res = await stub.fetch("https://space/ws", {
    headers: {
      Upgrade: "websocket",
      "X-Onlay-Caller": encodeCaller(who),
      "Sec-WebSocket-Protocol": "onlay.v1",
    },
  });
  expect(res.status).toBe(101);
  expect(res.headers.get("Sec-WebSocket-Protocol")).toBe("onlay.v1");
  const ws = res.webSocket;
  if (!ws) throw new Error("no socket");
  ws.accept();
  const frames: Array<Json> = [];
  ws.addEventListener("message", (e) => {
    frames.push(JSON.parse(String(e.data)));
  });
  ws.send(
    JSON.stringify({
      v: 1,
      type: "hello",
      sessionId: crypto.randomUUID(),
      bootCount: 1,
      swRestarts: 0,
      connects: 1,
      protocol: PROTOCOL_VERSION,
    }),
  );
  await until(() => frames.some((f) => f.type === "welcome"));
  return { ws, frames };
}

async function until(ok: () => boolean, ms = 2_000): Promise<void> {
  const start = Date.now();
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 100));

const comment = (text: string) => ({
  kind: "comment",
  url: PAGE,
  anchor: { level: "element", selector: "main > h1" },
  body: { text },
});

describe("the space Durable Object", () => {
  test("a socket opened with a caller header says hello and is welcomed", async () => {
    const stub = space();
    const { ws, frames } = await connect(stub, ada);
    const welcome = frames.find((f) => f.type === "welcome");
    expect(welcome?.person.id).toBe(ADA);
    expect(welcome?.needsYouCount).toBe(0);
    ws.send(JSON.stringify({ v: 1, type: "ping", t: 42 }));
    await until(() => frames.some((f) => f.type === "pong" && f.t === 42));
    ws.close();
  });

  test("no caller, or an agent caller, is refused at the socket door", async () => {
    const stub = space();
    const none = await stub.fetch("https://space/ws", { headers: { Upgrade: "websocket" } });
    expect(none.status).toBe(401);
    const agent = await stub.fetch("https://space/ws", {
      headers: {
        Upgrade: "websocket",
        "X-Onlay-Caller": encodeCaller(caller(ADA, { kind: "member", role: "member" }, "agent")),
      },
    });
    expect(agent.status).toBe(403);
  });

  test("state and hibernated sockets survive an eviction", async () => {
    const stub = space();
    const { ws, frames } = await connect(stub, ada);
    const created = await call(stub, ada, "POST", "/interaction", comment("before"));
    expect(created.status).toBe(200);
    const id = created.body.interactionId as string;
    await evictDurableObject(stub);
    const read = await call(stub, ada, "GET", `/interaction/${id}`);
    expect(read.body.interaction.thread[0].body.text).toBe("before");
    frames.length = 0;
    await call(stub, ada, "POST", `/interaction/${id}/reply`, { body: { text: "after" } });
    await until(() => frames.some((f) => f.type === "interactions-state"));
    ws.close();
  });

  test("a guest's socket never hears another interaction's broadcast", async () => {
    const stub = space();
    const shared = (await call(stub, ada, "POST", "/interaction", comment("shared"))).body
      .interactionId as string;
    const secret = (await call(stub, ada, "POST", "/interaction", comment("secret"))).body
      .interactionId as string;
    const gus = caller(GUS, { kind: "guest", interactionIds: [shared] });
    const { ws, frames } = await connect(stub, gus);
    frames.length = 0;
    await call(stub, ada, "POST", `/interaction/${secret}/reply`, {
      body: { text: "members only" },
    });
    await settle();
    expect(frames).toEqual([]);
    await call(stub, ada, "POST", `/interaction/${shared}/reply`, { body: { text: "for Gus" } });
    await until(() => frames.some((f) => f.type === "interactions-state"));
    const state = frames.find((f) => f.type === "interactions-state");
    expect(state?.interactions.map((i: { id: string }) => i.id)).toEqual([shared]);
    expect((await call(stub, gus, "GET", `/interaction/${secret}`)).status).toBe(404);
    ws.close();
  });

  test("retention runs from the alarm the object schedules", async () => {
    const stub = space();
    await call(stub, ada, "GET", "/attention");
    expect(await runDurableObjectAlarm(stub)).toBe(true);
  });
});

describe("web push crypto in workerd", () => {
  // RFC 8291 Appendix A.
  const V = {
    plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
    asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
    asPublic:
      "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
    uaPublic:
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
    salt: "DGv6ra1nlYgDCS1FRnbzlw",
    message:
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  };

  test("aes128gcm reproduces the RFC 8291 test vector byte-for-byte", async () => {
    const point = unb64url(V.asPublic);
    const body = await encryptAes128Gcm(
      unb64url(V.uaPublic),
      unb64url(V.authSecret),
      unb64url(V.plaintext),
      {
        asKeys: {
          privateJwk: {
            kty: "EC",
            crv: "P-256",
            d: V.asPrivate,
            x: b64url(point.subarray(1, 33)),
            y: b64url(point.subarray(33)),
          },
        },
        salt: unb64url(V.salt),
      },
    );
    expect(b64url(body)).toBe(V.message);
  });

  test("a VAPID JWT verifies against the advertised key", async () => {
    const keys = await generateVapidKeys();
    const header = await vapidAuthorization(
      "https://push.example/x",
      "mailto:push@example.com",
      keys,
      Date.now(),
    );
    const jwt = /vapid t=([^,]+),/.exec(header)?.[1] ?? "";
    const [h, c, sig] = jwt.split(".") as [string, string, string];
    const point = unb64url(keys.publicKey);
    const pub = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33)) },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pub,
      new Uint8Array(unb64url(sig)),
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(ok).toBe(true);
  });
});
