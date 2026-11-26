import * as z from "zod/mini";
import { LIMITS } from "./limits";
import { bounded, count } from "./schema-helpers";

export const CAPTURE_KINDS = ["edit-context", "snapshot", "attachment", "variant-look"] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

export const CAPTURE_PART_ROLES = [
  "file",
  "document",
  "font",
  "asset",
  "witness",
  "thumbnail",
] as const;

// ClientKind vocabulary of a capture's producing ingress (advisory 11 alignment with ADR-0022's
// part names; advisory 13 — agent-token uploads have no ClientKind, so 'agent' is the ingress class).
export const CAPTURE_SOURCE_KINDS = ["extension", "cli", "plugin", "pwa", "agent"] as const;

export const CAPTURE_ATTACHMENT_MIMES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
] as const;

// ── shared byte-magic sniffers (capture §3.4 / F32) ─────────────────────────
// The server's hostile-file gate classifies every structured part from its
// LEADING BYTES, never the declared mime. These two positive matchers are that
// gate's admission core for image + font roles, shared here so the extension's
// harvest can refuse-before-upload exactly what the server would 415 — parity
// by construction, no client copy to drift.

const bytesStartWith = (b: Uint8Array, sig: number[], offset = 0): boolean => {
  if (b.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i += 1) if (b[offset + i] !== sig[i]) return false;
  return true;
};

/** The raster mimes an asset/witness/thumbnail part may carry (server-enforced). */
export const CAPTURE_IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type CaptureImageMime = (typeof CAPTURE_IMAGE_MIMES)[number];

/** Classify image bytes by magic; null = not an admissible capture raster. */
export function captureImageMimeOf(b: Uint8Array): CaptureImageMime | null {
  if (bytesStartWith(b, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (bytesStartWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (bytesStartWith(b, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (
    bytesStartWith(b, [0x52, 0x49, 0x46, 0x46]) &&
    bytesStartWith(b, [0x57, 0x45, 0x42, 0x50], 8) // "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

// ── image dimension parsers (the server's pixel-cap gate, shared) ───────────
// The server refuses any raster over MAX_CAPTURE_IMAGE_PIXELS (`image-too-large`,
// §8) — so the harvest pre-gate needs the SAME dimensions the server will read,
// or an over-cap asset re-creates exactly the one-part-kills-the-capture bug the
// mime mirror closed.

const u16be = (b: Uint8Array, o: number) => ((b[o] as number) << 8) | (b[o + 1] as number);
const u16le = (b: Uint8Array, o: number) => (b[o] as number) | ((b[o + 1] as number) << 8);
const u24le = (b: Uint8Array, o: number) =>
  (b[o] as number) | ((b[o + 1] as number) << 8) | ((b[o + 2] as number) << 16);
const u32be = (b: Uint8Array, o: number) =>
  (b[o] as number) * 0x1000000 +
  (((b[o + 1] as number) << 16) | ((b[o + 2] as number) << 8) | (b[o + 3] as number));

function pngSize(b: Uint8Array): { width: number; height: number } | undefined {
  if (b.length < 24) return undefined;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function gifSize(b: Uint8Array): { width: number; height: number } | undefined {
  if (b.length < 10) return undefined;
  return { width: u16le(b, 6), height: u16le(b, 8) };
}

function jpegSize(b: Uint8Array): { width: number; height: number } | undefined {
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) {
      o += 1;
      continue;
    }
    const marker = b[o + 1] as number;
    // Start-of-frame markers carry the dimensions (skip C4/C8/CC — not SOF).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(b, o + 5), width: u16be(b, o + 7) };
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      o += 2; // standalone markers carry no length
      continue;
    }
    o += 2 + u16be(b, o + 2); // skip this segment
  }
  return undefined;
}

function webpSize(b: Uint8Array): { width: number; height: number } | undefined {
  if (b.length < 30) return undefined;
  if (bytesStartWith(b, [0x56, 0x50, 0x38, 0x58], 12)) {
    // "VP8X"
    return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  }
  if (bytesStartWith(b, [0x56, 0x50, 0x38, 0x4c], 12)) {
    // "VP8L"
    const b0 = b[21] as number;
    const b1 = b[22] as number;
    const b2 = b[23] as number;
    const b3 = b[24] as number;
    return {
      width: (((b1 & 0x3f) << 8) | b0) + 1,
      height: (((b3 & 0x0f) << 10) | (b2 << 2) | (b1 >> 6)) + 1,
    };
  }
  if (bytesStartWith(b, [0x56, 0x50, 0x38, 0x20], 12)) {
    // "VP8 "
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  return undefined;
}

/** Magic + dimensions in one read — what the server's raster gate sees. */
export function captureImageInfoOf(
  b: Uint8Array,
): { mime: CaptureImageMime; width?: number; height?: number } | null {
  const mime = captureImageMimeOf(b);
  if (!mime) return null;
  const size =
    mime === "image/png"
      ? pngSize(b)
      : mime === "image/jpeg"
        ? jpegSize(b)
        : mime === "image/gif"
          ? gifSize(b)
          : webpSize(b);
  return { mime, ...(size ?? {}) };
}

/** The font mimes a font part may carry (server-enforced). */
export const CAPTURE_FONT_MIMES = ["font/woff2", "font/woff", "font/otf", "font/ttf"] as const;
export type CaptureFontMime = (typeof CAPTURE_FONT_MIMES)[number];

/** Classify font bytes by magic; null = not an admissible capture font. */
export function captureFontMimeOf(b: Uint8Array): CaptureFontMime | null {
  if (bytesStartWith(b, [0x77, 0x4f, 0x46, 0x32])) return "font/woff2"; // wOF2
  if (bytesStartWith(b, [0x77, 0x4f, 0x46, 0x46])) return "font/woff"; // wOFF
  if (bytesStartWith(b, [0x4f, 0x54, 0x54, 0x4f])) return "font/otf"; // OTTO
  if (
    bytesStartWith(b, [0x00, 0x01, 0x00, 0x00]) || // TrueType
    bytesStartWith(b, [0x74, 0x72, 0x75, 0x65]) || // 'true'
    bytesStartWith(b, [0x74, 0x74, 0x63, 0x66]) // 'ttcf' (collection)
  ) {
    return "font/ttf";
  }
  return null;
}

/**
 * The closed, honest enumeration of everything a capture could NOT faithfully
 * reproduce (capture spec §6). Shared truth across server / CLI / PWA and the
 * extension (whose `overlay/capture/residue.ts` re-exports this union and layers
 * the recorder on top). Adding a member here is the ONLY way to widen residue.
 */
export const RESIDUE_CLASSES = [
  "closed-shadow-root", // §2 — unreachable shadow content, box reserved, witness covers it
  "shadow-scoped-rules", // §4/D14 — shadow constructed sheets excluded; class-variant fidelity lost
  "declined-grant", // §4/§5/§7 — a host grant absent for an origin (carries origin)
  "security-error", // an unexpected SecurityError / API failure during capture
  "stripped-url", // §1.3 — an un-embeddable / cross-document URL removed (never left live)
  "unfetchable-asset", // §4 — a font/asset URL known but fetch failed
  "generated-content-lost", // §1.4/D12 — a counter()/counters() in `content` unresolved
  "quiescence-timeout", // §3 — froze a possibly-mid-transition frame
  "oversize-truncation", // node/part/byte/tile ceiling hit; content trimmed
  "canvas-video-content", // §1.1 — canvas/WebGL/<video> pixels not reconstructable (box reserved)
  "cross-origin-frame", // §2 — nested cross-origin iframe not reconstructed
  "flat-raster", // §5/F31 — the witness grab returned a uniform frame (degenerate raster) even after a retry
  // Why a look kept no screenshot (its structured capture is kept). Mostly a
  // block inside a frame, whose screenshot is kept only when the frame shows
  // the crop is its own pixels (round 4, L-3).
  "screenshot-covered", // something from any document was drawn over the block
  "screenshot-see-through", // nothing opaque under the block: the embedding page would show
  "screenshot-foreign-frame", // another site's frame in the way
  "screenshot-page-changed", // the page, a frame or the overlay moved during the grab
  "screenshot-unplaced", // the block's frame could not be located in the tab
  "screenshot-transformed", // the frame, or an element holding it, is rotated, skewed or 3D
  "screenshot-scaled", // the frame is shrunk or stretched: the browser can't confirm its pixels
  "screenshot-inner-frame", // the block is inside a frame that has no address of its own (2-A1)
] as const;
export type ResidueClass = (typeof RESIDUE_CLASSES)[number];

/**
 * One residue occurrence as it rides `meta.residue` (capture spec §6): deduped
 * per-origin for `declined-grant`, per-class-with-`count` otherwise. Bounded so
 * a hostile manifest can't inflate `meta_json` past `MAX_CAPTURE_META`.
 */
export const ResidueEntrySchema = z.object({
  class: z.enum(RESIDUE_CLASSES),
  origin: z.optional(bounded(LIMITS.MAX_RESIDUE_ORIGIN)),
  detail: z.optional(bounded(LIMITS.MAX_RESIDUE_DETAIL)),
  count: z.optional(count()),
});
export type ResidueEntry = z.infer<typeof ResidueEntrySchema>;

/**
 * At most `MAX_RESIDUE_ORIGINS` DISTINCT declined-grant origins may ride a
 * manifest (§6/A24) — the extension collapses the excess into one origin-less
 * counted entry, but an extension-authenticated manifest must not bypass the
 * bound on the wire (gpt56-11). `MAX_RESIDUE_ENTRIES` alone did not enforce it.
 */
function withinResidueOriginBound(entries: ResidueEntry[]): boolean {
  const origins = new Set<string>();
  for (const e of entries) {
    if (e.class === "declined-grant" && e.origin) origins.add(e.origin);
  }
  return origins.size <= LIMITS.MAX_RESIDUE_ORIGINS;
}

/** A non-negative, finite document-space CSS-px dimension (§1.6). */
const dimension = () => z.number().check(z.gte(0), z.lte(LIMITS.MAX_CAPTURE_COORD));
/** A signed, finite document-space CSS-px coordinate (§1.6 — x/y may be < 0). */
const coordinate = () =>
  z.number().check(z.gte(-LIMITS.MAX_CAPTURE_COORD), z.lte(LIMITS.MAX_CAPTURE_COORD));

/** Captured viewport + DPR (capture spec §1.6). */
export const CaptureViewportSchema = z.object({
  innerWidth: dimension(),
  innerHeight: dimension(),
  dpr: z.number().check(z.gt(0), z.lte(16)),
  layoutWidth: dimension(),
});
export type CaptureViewport = z.infer<typeof CaptureViewportSchema>;

/** A block/habitat rect in document coordinates, CSS px (capture spec §1.6). */
export const CaptureRectSchema = z.object({
  x: coordinate(),
  y: coordinate(),
  width: dimension(),
  height: dimension(),
});
export type CaptureRect = z.infer<typeof CaptureRectSchema>;

/**
 * The bounded manifest `meta` (capture spec §1.8). Server-validated at init and
 * persisted into `captures.meta_json`; the store surfaces a compact residue
 * summary + rects onto the derived `CaptureRef` so the runtime meter and frame
 * sizing read them without a document fetch (D5/F1). `targetKey` is a client
 * hash of `sourcePointer ?? selector` the server folds into the D8 lineage.
 */
export const CaptureMetaSchema = z.object({
  targetKey: z.optional(z.string().check(z.regex(/^[0-9a-z]{1,64}$/))),
  // F30 `variant-look` identity: which variant (at which version) this raster
  // witnesses. Server-VALIDATED at init against the live set (the set exists,
  // it belongs to the route's change interaction, the variant is in it, the
  // version isn't from the future) and folded into the server-derived
  // `varlook:<setId>:<variantId>` lineage — spoof-shaped values collapse to 404.
  variantSetId: z.optional(bounded(LIMITS.MAX_VARIANT_SET_ID)),
  variantId: z.optional(bounded(LIMITS.MAX_VARIANT_SET_ID)),
  variantVersion: z.optional(count().check(z.gte(1))),
  viewport: z.optional(CaptureViewportSchema),
  blockRect: z.optional(CaptureRectSchema),
  habitatRect: z.optional(CaptureRectSchema),
  residue: z.optional(
    z
      .array(ResidueEntrySchema)
      .check(z.maxLength(LIMITS.MAX_RESIDUE_ENTRIES), z.refine(withinResidueOriginBound)),
  ),
  captureMs: z.optional(count()),
  quiescence: z.optional(z.enum(["settled", "timeout"])),
});
export type CaptureMeta = z.infer<typeof CaptureMetaSchema>;

/**
 * The compact per-`CaptureRef` residue summary (D5): the closed class + optional
 * origin only — `detail`/`count` stay in `meta_json`. Tiny + bounded, so it is
 * safe on wake frames / snapshot lists the way inline thumbs are not.
 */
export const CaptureRefResidueSchema = z.object({
  class: z.enum(RESIDUE_CLASSES),
  origin: z.optional(bounded(LIMITS.MAX_RESIDUE_ORIGIN)),
});
export type CaptureRefResidue = z.infer<typeof CaptureRefResidueSchema>;

/** One part of a capture, as declared in the upload manifest (client → server). */
export const CapturePartManifestSchema = z.object({
  name: bounded(LIMITS.MAX_CAPTURE_PART_NAME), // 'file'
  role: z.enum(CAPTURE_PART_ROLES),
  mime: bounded(LIMITS.MAX_CAPTURE_MIME), // declared; server re-sniffs (§3)
  byteLen: count().check(z.lte(LIMITS.MAX_CAPTURE_PART_BYTES)),
  sha256: z.string().check(z.regex(/^[0-9a-f]{64}$/)), // content address; hash-verified
});

export const CaptureManifestSchema = z.object({
  kind: z.enum(CAPTURE_KINDS),
  format: bounded(LIMITS.MAX_CAPTURE_FORMAT),
  caption: z.optional(bounded(LIMITS.MAX_CAPTURE_CAPTION)), // UntrustedText at the edge
  parts: z
    .array(CapturePartManifestSchema)
    .check(z.minLength(1), z.maxLength(LIMITS.MAX_CAPTURE_PARTS)),
  meta: z.optional(CaptureMetaSchema), // §1.8 — bounded; edit-context carries it, attachment omits it
});
export type CaptureManifest = z.infer<typeof CaptureManifestSchema>;

/**
 * Thumbless descriptor that rides interaction snapshots + agent wake digests.
 * DERIVED at frame-build time from the captures table — never journaled, never carries bytes,
 * never carries a thumb (fable MUST-REJECT #8). The client fetches a part's bytes on demand.
 */
export const CaptureRefSchema = z.object({
  captureId: bounded(LIMITS.MAX_CAPTURE_ID),
  interactionId: z.uuid(), // interaction ids are uuids (advisory 10b)
  kind: z.enum(CAPTURE_KINDS),
  lineageId: bounded(LIMITS.MAX_CAPTURE_ID),
  revision: count().check(z.gte(1)),
  capturedAt: count(),
  capturedBy: bounded(LIMITS.MAX_ACTOR_ID),
  capturedFrom: z.enum(CAPTURE_SOURCE_KINDS), // client-kind ingress, not a format tag (advisory 10b)
  format: bounded(LIMITS.MAX_CAPTURE_FORMAT), // attachment: primary mime
  totalBytes: count(),
  parts: z
    .array(
      z.object({
        name: bounded(LIMITS.MAX_CAPTURE_PART_NAME),
        role: z.enum(CAPTURE_PART_ROLES),
        mime: bounded(LIMITS.MAX_CAPTURE_MIME),
        byteLen: count(),
      }),
    )
    .check(z.maxLength(LIMITS.MAX_CAPTURE_PARTS)),
  width: z.optional(count()),
  height: z.optional(count()),
  // Derived from `meta_json` by `refOf` (F1) so the render surface sizes the
  // frame + clips the diff + renders the meter WITHOUT a document-part fetch.
  viewport: z.optional(CaptureViewportSchema), // §1.6 — frame width = layoutWidth
  blockRect: z.optional(CaptureRectSchema), // §1.6 — CI ground-truth clip
  habitatRect: z.optional(CaptureRectSchema), // §1.6 — stage-frame height
  residue: z.optional(
    z.array(CaptureRefResidueSchema).check(z.maxLength(LIMITS.MAX_RESIDUE_ENTRIES)),
  ), // §6/D5 — the runtime meter's capture-time honesty signal
  // F30 — derived from trusted meta_json for `variant-look` refs only: clients
  // match refs to variants themselves (no capture↔variant FK, no journal touch).
  // A ref whose variantVersion trails the variant's current version is a STALE
  // witness — display law demotes it out of the ground-truth rung.
  variantSetId: z.optional(bounded(LIMITS.MAX_VARIANT_SET_ID)),
  variantId: z.optional(bounded(LIMITS.MAX_VARIANT_SET_ID)),
  variantVersion: z.optional(count().check(z.gte(1))),
  caption: z.optional(bounded(LIMITS.MAX_CAPTURE_CAPTION)), // raw stored (untrusted); declassified by CLI, textContent by clients
});
export type CaptureRef = z.infer<typeof CaptureRefSchema>;
