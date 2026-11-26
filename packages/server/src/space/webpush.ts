/**
 * Web Push wire crypto — RFC 8291 (aes128gcm message encryption) + RFC 8292
 * (VAPID) on Web Crypto, no dependency, so the same bytes come out of Bun and
 * workerd. Pure byte-in/byte-out: everything stateful (subscriptions,
 * triggers) lives in push.ts. The encrypt path is pinned to the RFC 8291
 * Appendix A test vector in both test runtimes.
 */

const te = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function unb64url(s: string): Uint8Array {
  const b64 = s.replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

/** A fresh copy whose buffer is a plain ArrayBuffer (what Web Crypto wants). */
const buf = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw",
    buf(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, buf(data)));
}

/** HKDF-SHA256 (RFC 5869) — extract + single-block expand (every use is ≤ 32 bytes). */
async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, Uint8Array.of(1)))).subarray(0, length);
}

/** The uncompressed P-256 point of a public JWK. */
function pointOf(jwk: JsonWebKey): Uint8Array {
  return concat(Uint8Array.of(4), unb64url(jwk.x ?? ""), unb64url(jwk.y ?? ""));
}

/** Fixed application-server key material, for the RFC test vector only. */
export interface AsKeys {
  /** The private key as a JWK (d, x, y). */
  privateJwk: JsonWebKey;
}

/**
 * RFC 8291 §3.4: one aes128gcm content-coding record carrying the whole
 * payload — header(salt | rs | idlen | as_public) || ciphertext || tag. The
 * application-server ECDH keypair and salt are fresh per message; the test
 * vector injects both via `opts`.
 */
export async function encryptAes128Gcm(
  uaPublic: Uint8Array,
  authSecret: Uint8Array,
  plaintext: Uint8Array,
  opts: { asKeys?: AsKeys; salt?: Uint8Array } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const ecdh = { name: "ECDH", namedCurve: "P-256" } as const;
  let asPrivate: CryptoKey;
  let asPublic: Uint8Array;
  if (opts.asKeys) {
    asPrivate = await crypto.subtle.importKey("jwk", opts.asKeys.privateJwk, ecdh, false, [
      "deriveBits",
    ]);
    asPublic = pointOf(opts.asKeys.privateJwk);
  } else {
    const pair = (await crypto.subtle.generateKey(ecdh, true, ["deriveBits"])) as CryptoKeyPair;
    asPrivate = pair.privateKey;
    asPublic = new Uint8Array(
      (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
    );
  }
  const uaKey = await crypto.subtle.importKey("raw", buf(uaPublic), ecdh, false, []);
  // The standard member is `public`; workers-types spells it `$public` (its
  // C++ name), so the algorithm is cast to whichever shape the types expect.
  const derive = { name: "ECDH", public: uaKey } as unknown as Parameters<
    typeof crypto.subtle.deriveBits
  >[0];
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(derive, asPrivate, 256));

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const keyInfo = concat(te.encode("WebPush: info"), Uint8Array.of(0), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(
    salt,
    ikm,
    concat(te.encode("Content-Encoding: aes128gcm"), Uint8Array.of(0)),
    16,
  );
  const nonce = await hkdf(
    salt,
    ikm,
    concat(te.encode("Content-Encoding: nonce"), Uint8Array.of(0)),
    12,
  );

  // RFC 8188 header, rs=4096; the single (last) record ends in the 0x02 delimiter.
  const header = concat(salt, Uint8Array.of(0, 0, 16, 0), Uint8Array.of(asPublic.length), asPublic);
  const key = await crypto.subtle.importKey("raw", buf(cek), "AES-GCM", false, ["encrypt"]);
  // Web Crypto appends the 16-byte tag to the ciphertext, exactly RFC 8188's layout.
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: buf(nonce), tagLength: 128 },
      key,
      concat(plaintext, Uint8Array.of(2)),
    ),
  );
  return concat(header, sealed);
}

export interface VapidKeys {
  /** base64url of the uncompressed P-256 public point (what the web app feeds `applicationServerKey`). */
  publicKey: string;
  /** The private key as a JWK JSON string (persisted; imported per signature). */
  privateJwk: string;
}

/** Mints a fresh P-256 VAPID keypair. */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return { publicKey: b64url(pointOf(jwk)), privateJwk: JSON.stringify(jwk) };
}

/** RFC 8292 §3: `vapid t=<ES256 JWT>, k=<public key>` for the endpoint's origin. */
export async function vapidAuthorization(
  endpoint: string,
  subject: string | undefined,
  keys: VapidKeys,
  now: number,
): Promise<string> {
  const claims = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 3600,
    ...(subject ? { sub: subject } : {}),
  };
  const input = `${b64url(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })))}.${b64url(
    te.encode(JSON.stringify(claims)),
  )}`;
  const { key_ops: _ops, ext: _ext, ...jwk } = JSON.parse(keys.privateJwk) as JsonWebKey;
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  // Web Crypto's ECDSA signature is raw r||s — exactly the JWS ES256 encoding.
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(input)),
  );
  return `vapid t=${input}.${b64url(sig)}, k=${keys.publicKey}`;
}

/**
 * RFC 8030 §5.4 caps `Topic` at 32 base64url characters; a raw 36-char UUID
 * gets a 400 from push services. Dashes stripped = exactly 32 hex chars.
 */
export function pushTopicOf(interactionId: string): string {
  return interactionId.replaceAll("-", "");
}

export interface WebPushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** A push-service POST is bounded — an endpoint that never answers must not
 *  pin the delivery path (endpoints are client-supplied). */
const SEND_TIMEOUT_MS = 10_000;

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Encrypts and POSTs one push message. Returns the push service's HTTP status
 * (201 = accepted; 404/410 = the subscription is gone — the caller drops it).
 * Network failures, a redirect and the send timeout throw; the caller owns
 * logging.
 */
export async function sendWebPush(
  target: WebPushTarget,
  payload: Uint8Array,
  opts: {
    vapid: VapidKeys;
    /** The operator's contact (RFC 8292 §2.1); left out of the JWT when absent. */
    subject?: string;
    topic: string;
    ttlSeconds: number;
    now: number;
    fetch?: Fetcher;
    timeoutMs?: number;
  },
): Promise<number> {
  const body = await encryptAes128Gcm(
    unb64url(target.keys.p256dh),
    unb64url(target.keys.auth),
    payload,
  );
  const send = opts.fetch ?? ((input, init) => fetch(input, init));
  const res = await send(target.endpoint, {
    method: "POST",
    // Never follow redirects: a 307/308 would replay the signed POST against
    // an attacker-chosen Location, bypassing the endpoint guard.
    redirect: "manual",
    signal: AbortSignal.timeout(opts.timeoutMs ?? SEND_TIMEOUT_MS),
    headers: {
      TTL: String(opts.ttlSeconds),
      Urgency: "normal",
      Topic: opts.topic,
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      Authorization: await vapidAuthorization(target.endpoint, opts.subject, opts.vapid, opts.now),
    },
    body,
  });
  // Only the status matters: the body is never read, so a push service (or
  // anything posing as one) can't make the space buffer it.
  await res.body?.cancel().catch(() => undefined);
  if (res.status >= 300 && res.status < 400) throw new Error(`push redirect ${res.status}`);
  return res.status;
}
