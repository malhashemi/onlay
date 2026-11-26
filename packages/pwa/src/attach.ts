// The one attachment-upload path for the web app (Attach is an
// `interaction`-class capability, open to members and guests alike). A file is
// staged locally, then uploaded against a KNOWN interaction id in the strict
// three phases the substrate demands — (1) capture-init (manifest), (2) PUT
// the bytes, (3) commit. Shared by the compose screen (attach while creating a
// new Comment) and the thread screen (attach to an EXISTING interaction).

import type { ApiClient } from "./api";
import * as api from "./api";

/** A file the human chose, with its bytes read once for hashing + upload. */
export interface StagedFile {
  file: File;
  bytes: Uint8Array;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Upload one staged file as an `attachment` capture on interaction `id`. Returns
 * false on any phase failure (the caller keeps the file staged and offers Retry
 * against the same id — an attachment is single-revision, so a retry re-runs the
 * three phases, never a duplicate interaction). The server binds `attachment` to
 * the caller's access + class; nothing here trusts the file's own claims.
 */
export async function uploadAttachment(
  c: ApiClient,
  spaceId: string,
  id: string,
  s: StagedFile,
): Promise<boolean> {
  const mime = s.file.type || "application/octet-stream";
  const sha256 = await sha256Hex(s.bytes);
  const manifest = {
    kind: "attachment",
    format: mime,
    caption: s.file.name.slice(0, 200),
    parts: [{ name: "file", role: "file", mime, byteLen: s.bytes.byteLength, sha256 }],
  };
  const init = await api.captureInit(c, spaceId, id, manifest);
  if (!init) return false;
  if (!(await api.capturePutPart(c, spaceId, id, init.captureId, "file", s.bytes, mime)))
    return false;
  return api.captureCommit(c, spaceId, id, init.captureId);
}
