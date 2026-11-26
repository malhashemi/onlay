// The smallest headers the picture check reads, for each type it takes and
// some it refuses: a type is judged by its bytes alone, never a header.

/** A PNG signature and IHDR naming `w` × `h`, padded to `size` bytes. */
export function pngOf(w: number, h: number, size = 64): Uint8Array {
  const b = new Uint8Array(Math.max(size, 24));
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0, 0, 0, 13], 8);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

/** A JPEG: SOI, then a baseline start-of-frame naming `w` × `h`. */
export function jpegOf(w: number, h: number): Uint8Array {
  const b = new Uint8Array(32);
  b.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
  new DataView(b.buffer).setUint16(7, h);
  new DataView(b.buffer).setUint16(9, w);
  return b;
}

/** A WebP (VP8X) naming `w` × `h`. */
export function webpOf(w: number, h: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  b.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  b.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
  const u24 = (at: number, v: number) => b.set([v & 255, (v >> 8) & 255, (v >> 16) & 255], at);
  u24(24, w - 1);
  u24(27, h - 1);
  return b;
}

export const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);
export const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0]);
