import { describe, expect, test } from "bun:test";
import * as z from "zod/mini";
import {
  CAPTURE_ATTACHMENT_MIMES,
  CAPTURE_KINDS,
  CaptureManifestSchema,
  type CaptureMeta,
  CaptureMetaSchema,
  type CaptureRef,
  CaptureRefSchema,
  captureFontMimeOf,
  captureImageMimeOf,
  RESIDUE_CLASSES,
  ResidueEntrySchema,
} from "./capture";
import { InteractionSnapshotSchema } from "./interaction";
import { LIMITS } from "./limits";

const IID = "1e8b6a2c-6f0f-4b7e-9a3c-2d1f0e9b8a7c";
const SHA256 = "a".repeat(64);

const manifest = {
  kind: "attachment",
  format: "image/png",
  caption: "Before the migration",
  parts: [
    {
      name: "file",
      role: "file",
      mime: "image/png",
      byteLen: 1_024,
      sha256: SHA256,
    },
  ],
};

const captureRef: CaptureRef = {
  captureId: "cap-1",
  interactionId: IID,
  kind: "attachment",
  lineageId: "cap-1",
  revision: 1,
  capturedAt: 1,
  capturedBy: "archsmith",
  capturedFrom: "cli",
  format: "image/png",
  totalBytes: 1_024,
  parts: [{ name: "file", role: "file", mime: "image/png", byteLen: 1_024 }],
  width: 640,
  height: 480,
  caption: "Before the migration",
};

const snapshot = {
  id: IID,
  kind: "comment",
  url: "http://127.0.0.1:8125/app",
  anchor: { level: "page" },
  authorId: "archsmith",
  participants: ["archsmith"],
  waitingOn: [],
  state: "open",
  thread: [],
  createdAt: 1,
};

describe("capture vocabulary and limits", () => {
  test("exports the specified capture kinds and attachment mime allowlist", () => {
    expect(CAPTURE_KINDS).toEqual(["edit-context", "snapshot", "attachment", "variant-look"]);
    expect(CAPTURE_ATTACHMENT_MIMES).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "application/pdf",
      "text/plain",
    ]);
  });

  test("exports the specified capture limits", () => {
    expect({
      MAX_CAPTURE_ID: LIMITS.MAX_CAPTURE_ID,
      MAX_CAPTURE_PART_NAME: LIMITS.MAX_CAPTURE_PART_NAME,
      MAX_CAPTURE_MIME: LIMITS.MAX_CAPTURE_MIME,
      MAX_CAPTURE_FORMAT: LIMITS.MAX_CAPTURE_FORMAT,
      MAX_CAPTURE_CAPTION: LIMITS.MAX_CAPTURE_CAPTION,
      MAX_CAPTURE_META: LIMITS.MAX_CAPTURE_META,
      MAX_CAPTURE_PART_BYTES: LIMITS.MAX_CAPTURE_PART_BYTES,
      MAX_CAPTURE_TOTAL_BYTES: LIMITS.MAX_CAPTURE_TOTAL_BYTES,
      MAX_CAPTURE_PARTS: LIMITS.MAX_CAPTURE_PARTS,
      MAX_CAPTURE_REVISIONS: LIMITS.MAX_CAPTURE_REVISIONS,
      MAX_CAPTURES_PER_INTERACTION: LIMITS.MAX_CAPTURES_PER_INTERACTION,
      MAX_CAPTURE_IMAGE_PIXELS: LIMITS.MAX_CAPTURE_IMAGE_PIXELS,
      MAX_CAPTURE_QUOTA_ACTOR_BYTES: LIMITS.MAX_CAPTURE_QUOTA_ACTOR_BYTES,
      MAX_CAPTURE_QUOTA_GLOBAL_BYTES: LIMITS.MAX_CAPTURE_QUOTA_GLOBAL_BYTES,
      MAX_PENDING_CAPTURES_PER_ACTOR: LIMITS.MAX_PENDING_CAPTURES_PER_ACTOR,
      STAGING_TTL_MS: LIMITS.STAGING_TTL_MS,
      CAPTURE_UPLOAD_TIMEOUT_MS: LIMITS.CAPTURE_UPLOAD_TIMEOUT_MS,
      MAX_RESIDUE_ENTRIES: LIMITS.MAX_RESIDUE_ENTRIES,
      MAX_RESIDUE_ORIGINS: LIMITS.MAX_RESIDUE_ORIGINS,
      MAX_RESIDUE_DETAIL: LIMITS.MAX_RESIDUE_DETAIL,
      MAX_RESIDUE_ORIGIN: LIMITS.MAX_RESIDUE_ORIGIN,
      MAX_CAPTURE_COORD: LIMITS.MAX_CAPTURE_COORD,
    }).toEqual({
      MAX_CAPTURE_ID: 64,
      MAX_CAPTURE_PART_NAME: 64,
      MAX_CAPTURE_MIME: 128,
      MAX_CAPTURE_FORMAT: 64,
      MAX_CAPTURE_CAPTION: 2_048,
      MAX_CAPTURE_META: 8_192,
      MAX_CAPTURE_PART_BYTES: 5_242_880,
      MAX_CAPTURE_TOTAL_BYTES: 8_388_608,
      MAX_CAPTURE_PARTS: 16,
      MAX_CAPTURE_REVISIONS: 10,
      MAX_CAPTURES_PER_INTERACTION: 50,
      MAX_CAPTURE_IMAGE_PIXELS: 40_000_000,
      MAX_CAPTURE_QUOTA_ACTOR_BYTES: 268_435_456,
      MAX_CAPTURE_QUOTA_GLOBAL_BYTES: 2_147_483_648,
      MAX_PENDING_CAPTURES_PER_ACTOR: 4,
      STAGING_TTL_MS: 600_000,
      CAPTURE_UPLOAD_TIMEOUT_MS: 30_000,
      MAX_RESIDUE_ENTRIES: 12,
      MAX_RESIDUE_ORIGINS: 8,
      MAX_RESIDUE_DETAIL: 64,
      MAX_RESIDUE_ORIGIN: 256,
      MAX_CAPTURE_COORD: 33_554_432,
    });
  });

  test("exports the closed 20-member residue enum (shared truth, §6; L-3 and 2-A1 add why a screenshot was dropped)", () => {
    expect(RESIDUE_CLASSES.length).toBe(20);
    expect(new Set(RESIDUE_CLASSES).size).toBe(20);
    expect([...RESIDUE_CLASSES].sort()).toEqual(
      (
        [
          "canvas-video-content",
          "closed-shadow-root",
          "cross-origin-frame",
          "declined-grant",
          "flat-raster",
          "generated-content-lost",
          "oversize-truncation",
          "quiescence-timeout",
          "security-error",
          "shadow-scoped-rules",
          "stripped-url",
          "unfetchable-asset",
          "screenshot-covered",
          "screenshot-see-through",
          "screenshot-foreign-frame",
          "screenshot-page-changed",
          "screenshot-unplaced",
          "screenshot-transformed",
          "screenshot-scaled",
          "screenshot-inner-frame",
        ] as (typeof RESIDUE_CLASSES)[number][]
      ).sort(),
    );
  });
});

describe("capture manifests", () => {
  test("accepts every capture kind and a part at the byte cap", () => {
    for (const kind of CAPTURE_KINDS) {
      const result = z.safeParse(CaptureManifestSchema, {
        ...manifest,
        kind,
        parts: [{ ...manifest.parts[0], byteLen: LIMITS.MAX_CAPTURE_PART_BYTES }],
      });
      expect(result.success).toBe(true);
    }
  });

  test("rejects a bad capture kind", () => {
    expect(z.safeParse(CaptureManifestSchema, { ...manifest, kind: "video" }).success).toBe(false);
  });

  test("rejects a part over MAX_CAPTURE_PART_BYTES", () => {
    const result = z.safeParse(CaptureManifestSchema, {
      ...manifest,
      parts: [{ ...manifest.parts[0], byteLen: LIMITS.MAX_CAPTURE_PART_BYTES + 1 }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects more than MAX_CAPTURE_PARTS", () => {
    const result = z.safeParse(CaptureManifestSchema, {
      ...manifest,
      parts: Array.from({ length: LIMITS.MAX_CAPTURE_PARTS + 1 }, () => manifest.parts[0]),
    });
    expect(result.success).toBe(false);
  });

  test("rejects an invalid sha256", () => {
    for (const sha256 of ["a".repeat(63), "A".repeat(64), "z".repeat(64)]) {
      const result = z.safeParse(CaptureManifestSchema, {
        ...manifest,
        parts: [{ ...manifest.parts[0], sha256 }],
      });
      expect(result.success).toBe(false);
    }
  });
});

describe("capture refs", () => {
  test("round-trips a valid descriptor", () => {
    const result = z.safeParse(CaptureRefSchema, captureRef);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(captureRef);
  });

  test("bounds captions at MAX_CAPTURE_CAPTION", () => {
    expect(
      z.safeParse(CaptureRefSchema, {
        ...captureRef,
        caption: "x".repeat(LIMITS.MAX_CAPTURE_CAPTION),
      }).success,
    ).toBe(true);
    expect(
      z.safeParse(CaptureRefSchema, {
        ...captureRef,
        caption: "x".repeat(LIMITS.MAX_CAPTURE_CAPTION + 1),
      }).success,
    ).toBe(false);
  });
});

describe("capture manifest meta (§1.8)", () => {
  const meta: CaptureMeta = {
    targetKey: "a".repeat(32),
    viewport: { innerWidth: 1280, innerHeight: 800, dpr: 2, layoutWidth: 1280 },
    blockRect: { x: 10, y: 20, width: 300, height: 150 },
    habitatRect: { x: 0, y: 0, width: 1280, height: 600 },
    residue: [
      { class: "declined-grant", origin: "https://cdn.example.com" },
      { class: "closed-shadow-root", count: 2 },
    ],
    captureMs: 420,
    quiescence: "settled",
  };

  test("round-trips a full edit-context manifest with meta", () => {
    const result = z.safeParse(CaptureManifestSchema, {
      ...manifest,
      kind: "edit-context",
      format: "onlay-cap/1",
      parts: [
        {
          name: "document",
          role: "document",
          mime: "application/gzip",
          byteLen: 9,
          sha256: SHA256,
        },
      ],
      meta,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.meta).toEqual(meta);
  });

  test("meta is optional (attachment omits it) and every field within it is optional", () => {
    expect(z.safeParse(CaptureManifestSchema, manifest).success).toBe(true);
    expect(z.safeParse(CaptureMetaSchema, {}).success).toBe(true);
  });

  test("targetKey is regex-pinned /^[0-9a-z]{1,64}$/ and length-bounded", () => {
    expect(z.safeParse(CaptureMetaSchema, { targetKey: "abc123" }).success).toBe(true);
    expect(z.safeParse(CaptureMetaSchema, { targetKey: "A".repeat(10) }).success).toBe(false); // uppercase
    expect(z.safeParse(CaptureMetaSchema, { targetKey: "has-dash" }).success).toBe(false); // punctuation
    expect(z.safeParse(CaptureMetaSchema, { targetKey: "" }).success).toBe(false); // empty
    expect(z.safeParse(CaptureMetaSchema, { targetKey: "a".repeat(65) }).success).toBe(false); // over 64
  });

  test("rejects a residue class outside the closed enum", () => {
    expect(
      z.safeParse(CaptureMetaSchema, { residue: [{ class: "invented-residue" }] }).success,
    ).toBe(false);
  });

  test("bounds DISTINCT declined-grant origins at MAX_RESIDUE_ORIGINS on the wire (gpt56-11)", () => {
    const originEntries = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        class: "declined-grant" as const,
        origin: `https://cdn${i}.example.com`,
      }));
    expect(
      z.safeParse(CaptureMetaSchema, { residue: originEntries(LIMITS.MAX_RESIDUE_ORIGINS) })
        .success,
    ).toBe(true);
    expect(
      z.safeParse(CaptureMetaSchema, { residue: originEntries(LIMITS.MAX_RESIDUE_ORIGINS + 1) })
        .success,
    ).toBe(false);
  });

  test("caps residue at MAX_RESIDUE_ENTRIES and bounds detail/origin", () => {
    const entry = { class: "oversize-truncation" };
    expect(
      z.safeParse(CaptureMetaSchema, {
        residue: Array.from({ length: LIMITS.MAX_RESIDUE_ENTRIES }, () => entry),
      }).success,
    ).toBe(true);
    expect(
      z.safeParse(CaptureMetaSchema, {
        residue: Array.from({ length: LIMITS.MAX_RESIDUE_ENTRIES + 1 }, () => entry),
      }).success,
    ).toBe(false);
    expect(
      z.safeParse(ResidueEntrySchema, {
        class: "security-error",
        detail: "x".repeat(LIMITS.MAX_RESIDUE_DETAIL + 1),
      }).success,
    ).toBe(false);
    expect(
      z.safeParse(ResidueEntrySchema, {
        class: "declined-grant",
        origin: "x".repeat(LIMITS.MAX_RESIDUE_ORIGIN + 1),
      }).success,
    ).toBe(false);
  });

  test("rejects a non-finite / out-of-range coordinate, accepts a signed x/y", () => {
    expect(
      z.safeParse(CaptureMetaSchema, { blockRect: { x: -5, y: -10, width: 3, height: 4 } }).success,
    ).toBe(true);
    expect(
      z.safeParse(CaptureMetaSchema, {
        blockRect: { x: 0, y: 0, width: LIMITS.MAX_CAPTURE_COORD + 1, height: 4 },
      }).success,
    ).toBe(false);
    expect(
      z.safeParse(CaptureMetaSchema, {
        blockRect: { x: 0, y: 0, width: -1, height: 4 }, // width must be non-negative
      }).success,
    ).toBe(false);
    expect(
      z.safeParse(CaptureMetaSchema, {
        viewport: { innerWidth: 1, innerHeight: 1, dpr: 0, layoutWidth: 1 }, // dpr must be > 0
      }).success,
    ).toBe(false);
  });
});

describe("capture ref derived fields (F1/D5)", () => {
  const enriched: CaptureRef = {
    ...captureRef,
    kind: "edit-context",
    viewport: { innerWidth: 1280, innerHeight: 800, dpr: 2, layoutWidth: 1280 },
    blockRect: { x: 10, y: 20, width: 300, height: 150 },
    habitatRect: { x: 0, y: 0, width: 1280, height: 600 },
    residue: [{ class: "declined-grant", origin: "https://cdn.example.com" }],
  };

  test("round-trips a ref carrying viewport/blockRect/habitatRect/residue", () => {
    const result = z.safeParse(CaptureRefSchema, enriched);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(enriched);
  });

  test("the ref residue summary carries only class + origin (no detail/count)", () => {
    const bad = { ...enriched, residue: [{ class: "declined-grant", count: 3 }] };
    const result = z.safeParse(CaptureRefSchema, bad);
    // extra keys are stripped by the object schema — the parsed entry is class-only.
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.residue).toEqual([{ class: "declined-grant" }]);
  });

  test("caps the ref residue summary at MAX_RESIDUE_ENTRIES", () => {
    expect(
      z.safeParse(CaptureRefSchema, {
        ...enriched,
        residue: Array.from({ length: LIMITS.MAX_RESIDUE_ENTRIES + 1 }, () => ({
          class: "oversize-truncation",
        })),
      }).success,
    ).toBe(false);
  });
});

describe("interaction snapshot capture refs", () => {
  test("allows the captures field to be omitted", () => {
    expect(z.safeParse(InteractionSnapshotSchema, snapshot).success).toBe(true);
  });

  test("accepts MAX_CAPTURES_PER_INTERACTION refs and rejects one more", () => {
    expect(
      z.safeParse(InteractionSnapshotSchema, {
        ...snapshot,
        captures: Array.from({ length: LIMITS.MAX_CAPTURES_PER_INTERACTION }, () => captureRef),
      }).success,
    ).toBe(true);
    expect(
      z.safeParse(InteractionSnapshotSchema, {
        ...snapshot,
        captures: Array.from({ length: LIMITS.MAX_CAPTURES_PER_INTERACTION + 1 }, () => captureRef),
      }).success,
    ).toBe(false);
  });
});

describe("shared byte-magic sniffers (F32 — the 415 gate's admission core)", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  const webp = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  ]);

  test("classifies the four admissible raster magics", () => {
    expect(captureImageMimeOf(png)).toBe("image/png");
    expect(captureImageMimeOf(jpeg)).toBe("image/jpeg");
    expect(captureImageMimeOf(gif)).toBe("image/gif");
    expect(captureImageMimeOf(webp)).toBe("image/webp");
  });

  test("an SVG (active content — the live webawesome killer) is NOT an admissible raster", () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(captureImageMimeOf(svg)).toBeNull();
  });

  test("RIFF without the WEBP tag, truncated magic, and junk all classify null", () => {
    expect(captureImageMimeOf(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0]))).toBeNull();
    expect(captureImageMimeOf(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(captureImageMimeOf(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
    expect(captureImageMimeOf(new Uint8Array())).toBeNull();
  });

  test("classifies the font magics; TrueType flavours collapse to font/ttf", () => {
    expect(captureFontMimeOf(new Uint8Array([0x77, 0x4f, 0x46, 0x32]))).toBe("font/woff2");
    expect(captureFontMimeOf(new Uint8Array([0x77, 0x4f, 0x46, 0x46]))).toBe("font/woff");
    expect(captureFontMimeOf(new Uint8Array([0x4f, 0x54, 0x54, 0x4f]))).toBe("font/otf");
    expect(captureFontMimeOf(new Uint8Array([0x00, 0x01, 0x00, 0x00]))).toBe("font/ttf");
    expect(captureFontMimeOf(new Uint8Array([0x74, 0x72, 0x75, 0x65]))).toBe("font/ttf");
    expect(captureFontMimeOf(new Uint8Array([0x74, 0x74, 0x63, 0x66]))).toBe("font/ttf");
  });

  test("a woff2 served as an image (or vice versa) is refused by role", () => {
    expect(captureImageMimeOf(new Uint8Array([0x77, 0x4f, 0x46, 0x32]))).toBeNull();
    expect(captureFontMimeOf(png)).toBeNull();
  });
});
