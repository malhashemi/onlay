/**
 * Bounded request bodies: read while they stream, never past a byte limit.
 * Portable (no Bun, no Workers imports): the space and the edge share it.
 */

/**
 * Read a request body into memory, aborting the moment it crosses `cap`, so an
 * absent or lying Content-Length can't force a large buffer. Null = too large.
 */
export async function readCappedBody(req: Request, cap: number): Promise<Uint8Array | null> {
  const body = req.body;
  if (!body) {
    const buf = new Uint8Array(await req.arrayBuffer());
    return buf.byteLength > cap ? null : buf;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * A JSON body read with a byte limit, checked while it streams and before it
 * is parsed: a `Content-Length` over the limit is refused unread, and a body
 * without one stops being read the moment it passes the limit. The one
 * bounded reader for every JSON entry point, in the space and at the edge.
 */
export async function readJsonCapped(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; data: unknown } | { ok: false; reason: "too-large" | "invalid-json" }> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) return { ok: false, reason: "too-large" };
  const bytes = await readCappedBody(req, maxBytes);
  if (bytes === null) return { ok: false, reason: "too-large" };
  try {
    return { ok: true, data: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
}
