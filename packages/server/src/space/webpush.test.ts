import { describe, expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { decryptAes128Gcm } from "./testing/webpush-receiver";
import {
  b64url,
  encryptAes128Gcm,
  generateVapidKeys,
  pushTopicOf,
  sendWebPush,
  unb64url,
  vapidAuthorization,
} from "./webpush";

/**
 * The Web Push crypto on Web Crypto, pinned to the RFC 8291 Appendix A test
 * vector (deterministic: the app-server keypair + salt are injected), opened
 * by an independent node:crypto receiver, plus the RFC 8292 / RFC 8030 wire
 * details (VAPID header, Topic derivation) and the delivery guards.
 */

// RFC 8291 Appendix A — quoted verbatim.
const VECTOR = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  message:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

/** The vector's application-server key as a JWK (d from as_private, x/y from as_public). */
const asJwk = (): JsonWebKey => {
  const point = unb64url(VECTOR.asPublic);
  return {
    kty: "EC",
    crv: "P-256",
    d: VECTOR.asPrivate,
    x: b64url(point.subarray(1, 33)),
    y: b64url(point.subarray(33)),
  };
};

describe("encryptAes128Gcm", () => {
  test("reproduces the RFC 8291 Appendix A message byte-for-byte", async () => {
    const body = await encryptAes128Gcm(
      unb64url(VECTOR.uaPublic),
      unb64url(VECTOR.authSecret),
      unb64url(VECTOR.plaintext),
      { asKeys: { privateJwk: asJwk() }, salt: unb64url(VECTOR.salt) },
    );
    expect(b64url(body)).toBe(VECTOR.message);
  });

  test("round-trips under a fresh ephemeral keypair + random salt", async () => {
    const payload = new TextEncoder().encode(JSON.stringify({ interactionId: "x", title: "Ada" }));
    const body = await encryptAes128Gcm(
      unb64url(VECTOR.uaPublic),
      unb64url(VECTOR.authSecret),
      payload,
    );
    const open = decryptAes128Gcm(
      unb64url(VECTOR.uaPrivate),
      unb64url(VECTOR.authSecret),
      Buffer.from(body),
    );
    expect(new Uint8Array(open)).toEqual(payload);
  });
});

describe("vapidAuthorization", () => {
  test("emits a verifiable ES256 JWT scoped to the endpoint origin", async () => {
    const keys = await generateVapidKeys();
    const now = 1_700_000_000_000;
    const header = await vapidAuthorization(
      "https://fcm.googleapis.com/fcm/send/abc123",
      "mailto:push@example.com",
      keys,
      now,
    );
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(m).not.toBeNull();
    const [, jwt, k] = m as unknown as [string, string, string];
    expect(k).toBe(keys.publicKey);
    const [h, c, sig] = jwt.split(".") as [string, string, string];
    const text = (s: string) => new TextDecoder().decode(unb64url(s));
    expect(JSON.parse(text(h))).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(text(c)) as { aud: string; exp: number; sub: string };
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.sub).toBe("mailto:push@example.com");
    expect(claims.exp).toBe(Math.floor(now / 1000) + 12 * 3600);
    // The signature verifies against the ADVERTISED public key.
    const point = unb64url(keys.publicKey);
    const pub = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: b64url(point.subarray(1, 33)),
        y: b64url(point.subarray(33)),
      },
      format: "jwk",
    });
    const ok = verify(
      "sha256",
      Buffer.from(`${h}.${c}`),
      { key: pub, dsaEncoding: "ieee-p1363" },
      unb64url(sig),
    );
    expect(ok).toBe(true);
  });

  test("without a contact the JWT carries no sub", async () => {
    const header = await vapidAuthorization(
      "https://push.example/x",
      undefined,
      await generateVapidKeys(),
      1_700_000_000_000,
    );
    const jwt = /^vapid t=([^,]+),/.exec(header)?.[1] ?? "";
    const claims = JSON.parse(new TextDecoder().decode(unb64url(jwt.split(".")[1] ?? "")));
    expect(Object.keys(claims).sort()).toEqual(["aud", "exp"]);
  });
});

describe("sendWebPush", () => {
  const target = {
    endpoint: "https://push.example/sub",
    keys: { p256dh: VECTOR.uaPublic, auth: VECTOR.authSecret },
  };

  test("POSTs the encrypted body with the push headers and returns the status", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const status = await sendWebPush(target, new TextEncoder().encode("{}"), {
      vapid: await generateVapidKeys(),
      subject: "mailto:push@example.com",
      topic: "t",
      ttlSeconds: 60,
      now: 1,
      fetch: async (url, init) => {
        seen = { url, init };
        return new Response(null, { status: 201 });
      },
    });
    expect(status).toBe(201);
    const headers = new Headers(seen?.init.headers);
    expect(headers.get("Content-Encoding")).toBe("aes128gcm");
    expect(headers.get("Authorization")).toMatch(/^vapid t=/);
    expect(seen?.init.redirect).toBe("manual");
  });

  test("a redirecting push service is refused, never followed", async () => {
    await expect(
      sendWebPush(target, new TextEncoder().encode("{}"), {
        vapid: await generateVapidKeys(),
        subject: "mailto:push@example.com",
        topic: "t",
        ttlSeconds: 60,
        now: 1,
        fetch: async () =>
          new Response(null, { status: 307, headers: { location: "https://evil.example/" } }),
      }),
    ).rejects.toThrow();
  });

  test("a hung push service is abandoned at the send timeout", async () => {
    await expect(
      sendWebPush(target, new TextEncoder().encode("{}"), {
        vapid: await generateVapidKeys(),
        subject: "mailto:push@example.com",
        topic: "t",
        ttlSeconds: 60,
        now: 1,
        timeoutMs: 50,
        fetch: (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      }),
    ).rejects.toThrow();
  });
});

describe("pushTopicOf", () => {
  test("a UUID collapses to exactly 32 base64url-safe chars (RFC 8030 Topic cap)", () => {
    const topic = pushTopicOf("d9b210d8-3ba9-4e46-a76a-cd8a1a6d9d18");
    expect(topic).toBe("d9b210d83ba94e46a76acd8a1a6d9d18");
    expect(topic).toHaveLength(32);
  });
});
