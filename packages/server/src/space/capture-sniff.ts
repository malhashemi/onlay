/**
 * Local, dependency-free MIME sniffing + image-dimension parsing for the
 * hostile-file gate (ADR-0022 §3.4, Finding 3). The DECLARED mime is never
 * trusted: every attachment is classified from its actual leading bytes.
 *
 * Order is load-bearing. Image/PDF magic wins first. Then a WHATWG-style
 * active-content scan runs BEFORE any `text/plain` fallback, so an HTML/SVG
 * file bearing `<script>` — even one declared `text/plain` — is classified
 * `text/html`/`image/svg+xml` and refused on its bytes, not merely on an
 * honest declaration. Only bytes with no image/PDF magic, no active-content
 * pattern, and valid UTF-8 (no NUL) fall through to `text/plain`.
 */

import { captureImageInfoOf } from "@onlay/protocol";

export interface Sniffed {
  /** Sniffed media type; may be an active-content type the caller then refuses. */
  mime: string;
  width?: number;
  height?: number;
}

const startsWith = (b: Uint8Array, sig: number[], offset = 0): boolean => {
  if (b.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i += 1) if (b[offset + i] !== sig[i]) return false;
  return true;
};

/** Skip leading ASCII whitespace and a UTF-8 BOM, returning the head offset. */
function headStart(b: Uint8Array): number {
  let i = 0;
  if (startsWith(b, [0xef, 0xbb, 0xbf])) i = 3; // UTF-8 BOM
  while (i < b.length) {
    const c = b[i] as number;
    if (c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20) i += 1;
    else break;
  }
  return i;
}

/**
 * WHATWG active-content scan over the WHOLE bounded upload (case-insensitive
 * substring). The upload is already capped at `MAX_CAPTURE_PART_BYTES` before
 * this runs, so scanning the full buffer is bounded work — and it closes the
 * "pad past 2 KiB, then `<script>`" evasion a head-only scan allowed (Finding 5).
 */
function activeContentMime(b: Uint8Array): "text/html" | "image/svg+xml" | null {
  const start = headStart(b);
  // Latin-1 byte→char decode (no multibyte surprises) — the tags we scan for
  // are ASCII, so a 1:1 byte mapping is sufficient and safe. Built in slices
  // to stay O(n) without a Node Buffer.
  const head = latin1(b.subarray(start)).toLowerCase();
  if (head.includes("<svg")) return "image/svg+xml";
  if (
    head.startsWith("<!doctype") ||
    head.startsWith("<html") ||
    head.startsWith("<head") ||
    head.startsWith("<body") ||
    head.startsWith("<script") ||
    head.startsWith("<iframe") ||
    head.includes("<script") ||
    head.includes("<iframe") ||
    head.includes("<html") ||
    head.includes("<!doctype")
  ) {
    return "text/html";
  }
  return null;
}

function latin1(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i += 8192) {
    out += String.fromCharCode(...b.subarray(i, i + 8192));
  }
  return out;
}

function isValidUtf8NoNul(b: Uint8Array): boolean {
  if (b.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(b);
    return true;
  } catch {
    return false;
  }
}

export function sniffCapture(bytes: Uint8Array): Sniffed {
  // 1. Image / PDF magic wins first — a real raster is never re-read as text.
  // Image magic + dimensions come from the SHARED protocol parsers (F32) so the
  // extension's harvest pre-gate and this gate read identical truths.
  const img = captureImageInfoOf(bytes);
  if (img) {
    return {
      mime: img.mime,
      ...(img.width !== undefined ? { width: img.width } : {}),
      ...(img.height !== undefined ? { height: img.height } : {}),
    };
  }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) {
    return { mime: "application/pdf" };
  }
  // 2. Active-content scan BEFORE the text/plain fallback.
  const active = activeContentMime(bytes);
  if (active) return { mime: active };
  // 3. text/plain only for valid UTF-8 with no NUL and no active-content.
  if (isValidUtf8NoNul(bytes)) return { mime: "text/plain" };
  return { mime: "application/octet-stream" };
}
