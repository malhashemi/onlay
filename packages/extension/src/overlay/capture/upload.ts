// The upload leg — content-side orchestrator (capture §8/A16).
//
// Assembles the CaptureDraft into the two-phase edit-context upload and hands it
// to the SW `captureUpload` handler. The content side gzips the document +
// authorsheet (the document part rides as opaque `application/gzip`, never as
// text/html) and base64s every part; the SW computes each part's `sha256` and
// the bounded `meta.targetKey` (crypto.subtle is undefined on an insecure-context
// page — A16), then drives POST → PUT-missing → commit under the paired token.
// Bytes ride the Stage-0 HTTP substrate, never a WS frame.
//
// Fail-soft (D9): an upload failure is NEITHER journaled NOR recorded as
// interaction residue — the ABSENCE of a committed CaptureRef is the honest
// signal, and the stage falls back to the legacy ElementContext renderer. So a
// failure here adds nothing to the draft; it just resolves.

import { LIMITS } from "@onlay/protocol";
import { bytesToBase64 } from "../../sw-capture";
import { spaceOfInteraction } from "../space-of";
import { uploadOrigin } from "../upload-origin";
import type { CaptureDraft, CaptureOutcome } from "./index";

/** The capture container format tag (capture §1). */
const CAPTURE_FORMAT = "onlay-cap/1";

/** One part as it rides the runtime message to the SW (raw bytes as base64). */
export interface UploadPart {
  name: string;
  role: "document" | "font" | "asset" | "witness" | "thumbnail";
  mime: string;
  b64: string;
}

// ── pure helpers (unit-pinned) ─────────────────────────────────────────────

/** Gzip a UTF-8 string via the Web-standard `CompressionStream` (mirror of R2's gunzip). */
export async function gzip(text: string): Promise<Uint8Array> {
  const input = new TextEncoder().encode(text);
  const body = new Response(input as unknown as BodyInit).body;
  if (!body) throw new Error("gzip: empty stream");
  const stream = body.pipeThrough(new CompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * The bounded manifest `meta` (capture §1.8) minus `targetKey` (the SW derives
 * that from the un-hashed source, A16). Residue is included only when non-empty
 * (absent residue reads the same as `[]` to the meter). captureMs is dropped
 * when unset.
 */
export function buildUploadMeta(draft: CaptureDraft): Record<string, unknown> {
  const residue = draft.residue.toArray();
  const meta: Record<string, unknown> = {
    viewport: clampViewport(draft.meta.viewport),
    blockRect: clampRect(draft.meta.blockRect),
    habitatRect: clampRect(draft.meta.habitatRect),
    quiescence: draft.meta.quiescence,
  };
  if (residue.length > 0) meta.residue = residue;
  if (typeof draft.meta.captureMs === "number") meta.captureMs = draft.meta.captureMs;
  // F30 — the variant identity triplet the server validates + derives the
  // varlook lineage from; only a variant-look draft carries it.
  if (draft.variantMeta) {
    meta.variantSetId = draft.variantMeta.variantSetId;
    meta.variantId = draft.variantMeta.variantId;
    meta.variantVersion = draft.variantMeta.variantVersion;
  }
  return meta;
}

/** F30 — a variant-look manifest is its raster: witness (+thumbnail) only,
 *  no document/authorsheet (the reconstruction base lives on the edit-context
 *  capture), its own format tag. */
async function assembleVariantLookParts(draft: CaptureDraft): Promise<UploadPart[]> {
  return draft.parts
    .filter((p) => p.role === "witness" || p.role === "thumbnail")
    .map((p) => ({ name: p.name, role: p.role, mime: p.mime, b64: bytesToBase64(p.bytes) }));
}

/** Clamp a dimension to the wire-schema range so a degenerate page can't 400 the manifest. */
function clampDim(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(LIMITS.MAX_CAPTURE_COORD, Math.max(0, n));
}
/** Clamp a (signed) document coordinate to the wire-schema range. */
function clampCoord(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(LIMITS.MAX_CAPTURE_COORD, Math.max(-LIMITS.MAX_CAPTURE_COORD, n));
}
function clampRect(r: { x: number; y: number; width: number; height: number }): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return {
    x: clampCoord(r.x),
    y: clampCoord(r.y),
    width: clampDim(r.width),
    height: clampDim(r.height),
  };
}
function clampViewport(v: {
  innerWidth: number;
  innerHeight: number;
  dpr: number;
  layoutWidth: number;
}): { innerWidth: number; innerHeight: number; dpr: number; layoutWidth: number } {
  return {
    innerWidth: clampDim(v.innerWidth),
    innerHeight: clampDim(v.innerHeight),
    dpr: Number.isFinite(v.dpr) ? Math.min(16, Math.max(0.01, v.dpr)) : 1,
    layoutWidth: clampDim(v.layoutWidth),
  };
}

/**
 * Assemble the ordered part list: the gzipped document first, then the gzipped
 * authorsheet (variant-mode author CSS) if any, then the font/asset/witness/
 * thumbnail parts the harvest + witness accumulated.
 */
export async function assembleParts(draft: CaptureDraft): Promise<UploadPart[]> {
  const docBytes = await gzip(draft.documentHtml);

  // D4 — an authorsheet whose gzipped part exceeds the per-part cap is dropped
  // ALONE (metered), never aborting the whole upload: the Original still renders
  // from the flattened base; only setClass/setAttr fidelity degrades honestly
  // (the render gate then shows the note because no authorsheet part exists).
  let sheetBytes: Uint8Array | null = null;
  if (draft.authorsheet) {
    const gz = await gzip(draft.authorsheet);
    if (gz.byteLength > LIMITS.MAX_CAPTURE_PART_BYTES) {
      draft.authorsheet = null;
      draft.residue.add("oversize-truncation");
    } else {
      sheetBytes = gz;
    }
  }

  // D13 finalizer — the authoritative guarantee the manifest fits
  // MAX_CAPTURE_PARTS + MAX_CAPTURE_TOTAL_BYTES (the harvest budget already
  // reserved for this; this backstops it against the gzipped doc/authorsheet
  // sizes only known here). Document + authorsheet are mandatory-priority; trim
  // trailing data parts (assets, then fonts, then thumbnail/witness) until within
  // budget, metering each pass. Without it a part-rich page 400s at init and the
  // capability is silently absent (gpt56-2 / fable-1).
  const dataParts = [...draft.parts];
  const fixedCount = 1 + (sheetBytes ? 1 : 0);
  const fixedBytes = docBytes.byteLength + (sheetBytes?.byteLength ?? 0);
  let total = fixedBytes + dataParts.reduce((n, p) => n + p.bytes.byteLength, 0);
  let trimmed = false;
  while (
    dataParts.length > 0 &&
    (fixedCount + dataParts.length > LIMITS.MAX_CAPTURE_PARTS ||
      total > LIMITS.MAX_CAPTURE_TOTAL_BYTES)
  ) {
    const dropped = dataParts.pop();
    if (dropped) total -= dropped.bytes.byteLength;
    trimmed = true;
  }
  if (trimmed) draft.residue.add("oversize-truncation");

  const parts: UploadPart[] = [
    { name: "document", role: "document", mime: "application/gzip", b64: bytesToBase64(docBytes) },
  ];
  if (sheetBytes) {
    parts.push({
      name: "authorsheet",
      role: "document",
      mime: "application/gzip",
      b64: bytesToBase64(sheetBytes),
    });
  }
  for (const p of dataParts) {
    parts.push({ name: p.name, role: p.role, mime: p.mime, b64: bytesToBase64(p.bytes) });
  }
  return parts;
}

// ── the transport contract + orchestrator ──────────────────────────────────

export type UploadResponse =
  | { ok: true; captureId: string; capture?: unknown }
  | { ok: false; reason?: string; status?: number; serverReason?: string };

/** Capacity refusals the server raises at commit (§3): the actor/global byte
 *  quota and the per-lineage series cap both mean "no room for a fresh look". */
const STORAGE_CAP_REASONS = new Set(["quota", "too-many", "too-large"]);

function refusalOf(
  res: UploadResponse | undefined,
): "storage-cap" | "stale-extension" | "not-yours" | "other" {
  if (res && res.ok === false) {
    // The server says this capture is not this person's to make: final, never retried.
    if (res.serverReason === "not-yours") return "not-yours";
    if (res.serverReason && STORAGE_CAP_REASONS.has(res.serverReason)) return "storage-cap";
    if (res.reason === "stale-extension") return "stale-extension";
  }
  return "other";
}

export interface UploadDeps {
  send?: (msg: Record<string, unknown>) => Promise<UploadResponse | undefined>;
  assemble?: (draft: CaptureDraft) => Promise<UploadPart[]>;
}

const defaultSend = (msg: Record<string, unknown>): Promise<UploadResponse | undefined> => {
  // A reloaded extension orphans this tab's content script: sendMessage then
  // THROWS SYNCHRONOUSLY ("extension context invalidated") — the F-053 hazard
  // app.send already guards. Name it, so the fresh-look toast can say
  // "refresh this tab" instead of the generic failure line (F6).
  try {
    return chrome.runtime.sendMessage(msg).then(
      (r: UploadResponse) => r,
      () => undefined,
    );
  } catch {
    return Promise.resolve({ ok: false, reason: "stale-extension" });
  }
};

/**
 * Drive the two-phase edit-context upload. Fail-soft: any failure resolves
 * without throwing and WITHOUT touching residue (D9 — absence of the CaptureRef
 * is the signal). Returns the committed capture id on success, else a refusal
 * naming whether the server hit a capacity cap (§3 "storage cap") or any other
 * reason, so the one-action fresh-look can confirm or admit failure honestly.
 */
export async function upload(draft: CaptureDraft, deps: UploadDeps = {}): Promise<CaptureOutcome> {
  const send = deps.send ?? defaultSend;
  const isVarlook = draft.kind === "variant-look";
  const assemble = deps.assemble ?? (isVarlook ? assembleVariantLookParts : assembleParts);
  try {
    const parts = await assemble(draft);
    // A variant-look IS its witness: with the raster missing (grant revoked
    // mid-pass, grab refused) the upload is SKIPPED client-side — the server
    // would refuse the shape anyway, and a 404-shaped probe teaches nothing
    // (F30 fable-advisory 5).
    if (isVarlook && !parts.some((p) => p.role === "witness")) {
      return { ok: false, refusal: "other" };
    }
    // Server-derived lineages (`snap:<interactionId>`, `varlook:<digest>`) omit
    // `targetKeyRaw` entirely — the SW then writes no `meta.targetKey`, and the
    // client cannot fork the server's ordered history.
    const spaceId = spaceOfInteraction(draft.interactionId);
    // The last check, after compression and immediately before the bytes
    // leave: still the page, interaction and account it was taken for (R3-C4).
    if (draft.aborted || (draft.verify && !draft.verify())) return { ok: false, refusal: "other" };
    const res = await send({
      type: "captureUpload",
      ...uploadOrigin(),
      ...(spaceId ? { spaceId } : {}),
      id: draft.interactionId,
      kind: draft.kind,
      format: isVarlook ? "onlay-varlook/1" : CAPTURE_FORMAT,
      meta: buildUploadMeta(draft),
      ...(draft.kind === "snapshot" || isVarlook ? {} : { targetKeyRaw: draft.targetKeySource }),
      parts,
    });
    if (res?.ok) {
      // A commit with no screenshot where the residue names a DECLINED GRANT —
      // that pairing is the grant's doing (witness.ts meters declined-grant vs
      // security-error, and with the grant ON no declined-grant entry can
      // exist). A throttled captureVisibleTab or a budget-trimmed witness must
      // NOT blame the switch (F6 + review catch).
      const witnessMissing =
        !parts.some((p) => p.role === "witness") &&
        draft.residue.toArray().some((e) => e.class === "declined-grant");
      return witnessMissing
        ? { ok: true, captureId: res.captureId, witnessMissing: true }
        : { ok: true, captureId: res.captureId };
    }
    return { ok: false, refusal: refusalOf(res) };
  } catch {
    return { ok: false, refusal: "other" };
  }
}
