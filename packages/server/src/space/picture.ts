/**
 * People's pictures, as bytes: the one type check every stored picture
 * passes (a provider's copy and an upload alike), and the one way a picture
 * is answered. Portable: the space and the edge share it.
 */
import { type PictureType, pictureTypeOf } from "@onlay/protocol";

/** The one type check (`@onlay/protocol` `picture.ts`), here for the edge and the space. */
export { pictureTypeOf };

/**
 * A stored picture as a response: its checked type and nothing a browser
 * could sniff, run or embed elsewhere. `no-cache` with the copy's key as the
 * validator: every use is asked again (and so authorized again), and a
 * picture the browser already holds costs a `304`. For its own browser only.
 */
export function pictureResponse(
  request: Request,
  key: string,
  type: PictureType,
  bytes: Uint8Array,
): Response {
  const etag = `"${key}"`;
  const headers: Record<string, string> = {
    ETag: etag,
    "Cache-Control": "private, no-cache",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
  const asked = request.headers.get("If-None-Match") ?? "";
  if (asked.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    headers: {
      ...headers,
      "Content-Type": type,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": 'inline; filename="picture"',
    },
  });
}

/** D1 gives a blob as an array of numbers, SQLite ports as a Uint8Array. */
export function blobBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  return null;
}
