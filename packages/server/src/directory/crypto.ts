/**
 * The edge's small crypto vocabulary: random secrets, SHA-256 hashes of
 * credentials (only hashes are stored), and HMAC signatures for `state`.
 */
import { makePersonId, makeSpaceId } from "@onlay/protocol";

const encoder = new TextEncoder();

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64urlDecode(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** 32 random bytes, base64url: 43 characters. */
export function newSecret(): string {
  return base64url(randomBytes(32));
}

export const newPersonId = (): string => makePersonId(randomBytes);
export const newSpaceId = (): string => makeSpaceId(randomBytes);

/** An opaque row id with a readable prefix, such as `ses_…` or `tok_…`. */
export function newId(prefix: string): string {
  return `${prefix}_${base64url(randomBytes(15))}`;
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

export async function sha256Hex(text: string): Promise<string> {
  let out = "";
  for (const byte of await sha256(text)) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** PKCE S256: base64url(SHA-256(verifier)). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(await sha256(verifier));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** `<payload>.<signature>`, both base64url; the payload is JSON. */
export async function signValue(secret: string, value: unknown): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify(value)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    encoder.encode(payload),
  );
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}

/** The signed JSON value, or null for a bad signature or anything malformed. */
export async function verifyValue(secret: string, signed: string): Promise<unknown> {
  const dot = signed.indexOf(".");
  if (dot < 0) return null;
  const payload = signed.slice(0, dot);
  const signature = base64urlDecode(signed.slice(dot + 1));
  if (signature === null) return null;
  const ok = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    signature,
    encoder.encode(payload),
  );
  if (!ok) return null;
  const bytes = base64urlDecode(payload);
  if (bytes === null) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
