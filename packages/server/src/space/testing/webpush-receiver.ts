// Test-side Web Push plumbing: a synthetic browser subscription (P-256 UA
// keypair + auth secret) and the RECEIVER half of RFC 8291 on node:crypto — an
// independent implementation that opens what the space's Web Crypto sender
// produced, so tests prove what was sent rather than trusting logs.
import { Buffer } from "node:buffer";
import { createDecipheriv, createECDH, createHmac, randomBytes } from "node:crypto";

export interface UaKeys {
  /** base64url values in the browser's PushSubscription.toJSON().keys shape. */
  p256dh: string;
  auth: string;
  uaPrivate: Buffer;
  authSecret: Buffer;
}

export function makeUaKeys(): UaKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const authSecret = randomBytes(16);
  return {
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: authSecret.toString("base64url"),
    uaPrivate: ecdh.getPrivateKey(),
    authSecret,
  };
}

function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Buffer {
  const prk = createHmac("sha256", salt).update(ikm).digest();
  return createHmac("sha256", prk)
    .update(Buffer.concat([info, Buffer.of(1)]))
    .digest()
    .subarray(0, length);
}

/** The receiver side of RFC 8291 aes128gcm (single record), for round-trip proofs. */
export function decryptAes128Gcm(
  uaPrivate: Uint8Array,
  authSecret: Uint8Array,
  body: Buffer,
): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body[20] as number;
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(uaPrivate));
  const ecdhSecret = ecdh.computeSecret(asPublic);
  const uaPublic = ecdh.getPublicKey();
  const te = new TextEncoder();
  const keyInfo = Buffer.concat([te.encode("WebPush: info"), Buffer.of(0), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = hkdf(
    salt,
    ikm,
    Buffer.concat([te.encode("Content-Encoding: aes128gcm"), Buffer.of(0)]),
    16,
  );
  const nonce = hkdf(
    salt,
    ikm,
    Buffer.concat([te.encode("Content-Encoding: nonce"), Buffer.of(0)]),
    12,
  );
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const sealed = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(tag);
  const record = Buffer.concat([decipher.update(sealed), decipher.final()]);
  return record.subarray(0, record.length - 1); // strip the 0x02 last-record delimiter
}
