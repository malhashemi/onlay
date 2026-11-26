// Pure, chrome-free helpers for the service worker's capture contract
// (ADR-0022 §4/§5/§8). Extracted so the grant-pattern normalization, the
// private-network guard, part hashing, and manifest assembly are unit-testable
// without the `chrome.*` globals sw.ts pulls in at module load.
//
// crypto.subtle lives here (A16): sw.ts is always a secure context, but the
// captured PAGE may be insecure (plain-http tailnet remote), where the content
// script has no `crypto.subtle` — so every capture hash is computed in the SW.
import type { CaptureKind } from "@onlay/protocol";

/**
 * The port-stripped host-granularity match pattern for a URL or origin
 * (capture §4/§7, F8 — grants are host-granularity and port-agnostic;
 * `permissions.request` rejects a port-bearing pattern, so the canonical form
 * is `${protocol}//${hostname}/*`). Accepts either a full URL or a bare origin.
 */
export function patternForOrigin(input: string): string {
  const u = new URL(input);
  return `${u.protocol}//${u.hostname}/*`;
}

/** Classify a dotted-quad's first two octets as loopback / RFC-1918 / link-local. */
function classifyIpv4(a: number, b: number): boolean {
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/** Loopback / RFC-1918 / link-local / `.local` — the private-network surface. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
  // Dotted IPv4, including an IPv4-mapped IPv6 literal ending in a dotted quad
  // (`::ffff:127.0.0.1`) — classify the embedded IPv4 so a mapped-loopback
  // address cannot slip the guard by reading as a "public" host (gpt56-1).
  const dotted = h.match(/(?:^|:)(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (dotted) return classifyIpv4(Number(dotted[1]), Number(dotted[2]));
  // Hex-form IPv4-mapped IPv6 (`::ffff:7f00:0001` === 127.0.0.1).
  const hex = h.match(/^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/);
  if (hex?.[1]) {
    const hi = Number.parseInt(hex[1], 16);
    return classifyIpv4((hi >> 8) & 0xff, hi & 0xff);
  }
  return false;
}

export type HarvestGuardResult = { ok: true } | { ok: false; reason: "blocked"; detail: string };

/**
 * The SSRF guard for the privileged SW fetch leg (capture §4/F7). Onlay's
 * habitat is a LOCAL dev page, so the page must reach its OWN host's assets and
 * other ports; the paired server is allowed at its EXACT origin. A private host
 * that is neither the page's host nor the server's exact origin is the real SSRF
 * surface (a page on `localhost` steering the extension at `127.0.0.1:9999`, or
 * at the server's *other* ports) and is refused (capture §4). Public hosts pass
 * the guard (they are grant-gated separately).
 *
 * The paired server is matched by full ORIGIN (scheme://host:port), NOT by
 * hostname (gpt56-1): a hostname-only match would open every port on the server's
 * loopback host to a page on a *different* loopback host — exactly the surface
 * the spec says to refuse.
 */
export function harvestGuard(
  targetUrl: string,
  pageUrl?: string,
  serverUrl?: string,
): HarvestGuardResult {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return { ok: false, reason: "blocked", detail: "bad-url" };
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return { ok: false, reason: "blocked", detail: "protocol" };
  }
  if (!isPrivateHost(target.hostname)) return { ok: true };
  // The page may reach its own host at any port (spec §4 third clause).
  const pageHost = safeHost(pageUrl);
  if (pageHost && target.hostname.toLowerCase() === pageHost) return { ok: true };
  // The paired server is allowed only at its exact origin.
  const serverOrigin = safeOrigin(serverUrl);
  if (serverOrigin && target.origin === serverOrigin) return { ok: true };
  return { ok: false, reason: "blocked", detail: "private-network" };
}

function safeHost(u?: string): string | null {
  if (!u) return null;
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function safeOrigin(u?: string): string | null {
  if (!u) return null;
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

/** Lowercase-hex SHA-256 of raw bytes (secure-context WebCrypto). */
export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const view = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", view);
  const out = new Uint8Array(digest);
  let hex = "";
  for (const b of out) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * The bounded client hash the server needs to derive an edit-context lineage
 * (capture §1.8/D8): `sha256Hex(sourcePointer ?? selector).slice(0, 32)` — 32
 * hex ≤ MAX_CAPTURE_ID even after the server's `"edit:"` prefix. A raw
 * `data-onlay-source` pointer is NEVER sent as the key; it is hashed first.
 */
export async function targetKeyFrom(raw: string): Promise<string> {
  const hex = await sha256HexBytes(new TextEncoder().encode(raw));
  return hex.slice(0, 32);
}

export interface RawPart {
  name: string;
  role: "document" | "font" | "asset" | "witness" | "thumbnail";
  mime: string;
  bytes: Uint8Array;
}

/** The structured-capture upload manifest — `edit-context` or `snapshot` (Stage 2). */
export interface StructuredManifest {
  kind: CaptureKind;
  format: string;
  meta?: Record<string, unknown>;
  parts: Array<{ name: string; role: string; mime: string; byteLen: number; sha256: string }>;
}

/**
 * Assemble the two-phase upload manifest SHAPE from raw part bytes: the SW fills
 * in each part's sha256 + byteLen (A16 — hashing never runs on the page) and the
 * bounded `meta.targetKey` (from the un-hashed source string the content script
 * hands over). `kind` defaults to `edit-context`; a `snapshot` upload passes no
 * `targetKeyRaw`, so no `meta.targetKey` is written (its lineage is server-derived,
 * §1.3). Returns the manifest plus a sha→bytes map for the PUT phase.
 */
export async function buildEditContextUpload(input: {
  kind?: CaptureKind;
  format: string;
  parts: RawPart[];
  meta?: Record<string, unknown>;
  targetKeyRaw?: string;
}): Promise<{ manifest: StructuredManifest; bytesBySha: Map<string, Uint8Array> }> {
  const bytesBySha = new Map<string, Uint8Array>();
  const parts: StructuredManifest["parts"] = [];
  for (const p of input.parts) {
    const sha256 = await sha256HexBytes(p.bytes);
    bytesBySha.set(sha256, p.bytes);
    parts.push({ name: p.name, role: p.role, mime: p.mime, byteLen: p.bytes.byteLength, sha256 });
  }
  const meta: Record<string, unknown> = { ...(input.meta ?? {}) };
  if (input.targetKeyRaw !== undefined) meta.targetKey = await targetKeyFrom(input.targetKeyRaw);
  const manifest: StructuredManifest = {
    kind: input.kind ?? "edit-context",
    format: input.format,
    parts,
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
  };
  return { manifest, bytesBySha };
}

/** Chunked base64 encode — a runtime message is JSON (no transferables). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Inverse of `bytesToBase64` — decode a base64 part/tile back to bytes. */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
