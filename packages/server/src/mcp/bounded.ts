/**
 * Reading a body with a ceiling: a declared `Content-Length` over the limit
 * is refused unread, and a body without one is read only until it passes the
 * limit. Local to the MCP layer for now; replace it with the edge's shared
 * bounded reader when the two branches merge.
 */

/** The body's bytes, or null when it is (or declares itself) larger than `max`. */
export async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  headers: Headers,
  max: number,
): Promise<Uint8Array | null> {
  const declared = headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max)) {
    await body?.cancel();
    return null;
  }
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
