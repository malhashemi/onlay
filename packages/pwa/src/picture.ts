// A picture the person chooses, made ready to upload: the browser decodes it
// (any image it can read), crops it to a centred square and draws it at
// PICTURE_UPLOAD_SIDE pixels, then encodes WebP (PNG where the browser
// can't). The server still checks the bytes, the type and the size: nothing
// here is trusted, it only keeps the upload small.
import { MAX_PICTURE_BYTES, PICTURE_UPLOAD_SIDE } from "@onlay/protocol";

/** Files larger than this are not even decoded. */
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

export type Prepared =
  | { ok: true; image: Blob }
  | { ok: false; reason: "unreadable" | "too-large" };

/** Where a `side`-pixel square crop of a `w` × `h` image starts, and its size. */
export function squareCrop(w: number, h: number): { x: number; y: number; size: number } {
  const size = Math.min(w, h);
  return { x: Math.floor((w - size) / 2), y: Math.floor((h - size) / 2), size };
}

function encode(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function preparePicture(file: Blob): Promise<Prepared> {
  if (file.size > MAX_SOURCE_BYTES) return { ok: false, reason: "too-large" };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  try {
    const side = PICTURE_UPLOAD_SIDE;
    const canvas = document.createElement("canvas");
    canvas.width = side;
    canvas.height = side;
    const g = canvas.getContext("2d");
    if (!g) return { ok: false, reason: "unreadable" };
    const crop = squareCrop(bitmap.width, bitmap.height);
    if (crop.size < 1) return { ok: false, reason: "unreadable" };
    g.imageSmoothingQuality = "high";
    g.drawImage(bitmap, crop.x, crop.y, crop.size, crop.size, 0, 0, side, side);
    // WebP when the browser encodes it (toBlob falls back to PNG otherwise).
    for (const [type, quality] of [
      ["image/webp", 0.86],
      ["image/webp", 0.6],
      ["image/png", undefined],
    ] as const) {
      const blob = await encode(canvas, type, quality);
      if (blob && blob.size <= MAX_PICTURE_BYTES) return { ok: true, image: blob };
    }
    return { ok: false, reason: "too-large" };
  } finally {
    bitmap.close();
  }
}
