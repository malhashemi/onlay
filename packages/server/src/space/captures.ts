import { fulfillResnap, type InteractionState, isLive } from "@onlay/kernel";
import {
  CAPTURE_ATTACHMENT_MIMES,
  CAPTURE_IMAGE_MIMES,
  type Caller,
  type CallerAccess,
  type CaptureManifest,
  CaptureManifestSchema,
  captureFontMimeOf,
  LIMITS,
} from "@onlay/protocol";
import { readCappedBody } from "./body";
import { sniffCapture } from "./capture-sniff";
import type { CaptureSourceKind } from "./capture-store";
import { errorResponse, json, notFound, parseBody, refusal, sha256Hex } from "./http";
import { canSee, fanOut, type PendingCapture, type Runtime } from "./runtime";
import { admit, commit, isMember, systemNote } from "./service";

/**
 * The capture upload + fetch contract (ADR-0022 §3/§4) in a space. An
 * attachment is producible by anyone who may attach to the interaction (a
 * member or the guest it is shared with); the structured kinds —
 * `edit-context`, `snapshot`, `variant-look` — only by a member's Full
 * client. Unknown id, unreadable interaction, wrong kind and the
 * role-capability refusal ALL collapse to the one `not_found` (no existence
 * oracle, no capability oracle). Bytes are content-addressed, refcounted,
 * interaction-scoped — never reachable by bare hash.
 *
 * Pending uploads live in memory only: a Durable Object evicted mid-upload
 * forgets them, and the next PUT or commit answers `not_found` (fail closed);
 * the staged bytes are reaped by the retention alarm.
 */

/** Base media type of a declared mime — lowercased, params stripped (§3.4 step 3). */
const baseMime = (mime: string): string => (mime.split(";")[0] ?? "").trim().toLowerCase();

const ACTIVE_MIMES = new Set(["text/html", "application/xhtml+xml", "image/svg+xml"]);
const ALLOWED_MIMES = new Set<string>(CAPTURE_ATTACHMENT_MIMES);
/** Raster mimes accepted for edit-context asset/witness/thumbnail parts —
 *  the SHARED protocol set (F32), so the extension's harvest pre-gate and this
 *  415 gate can never drift. Same for the font magic (`captureFontMimeOf`). */
const IMAGE_MIMES = new Set<string>(CAPTURE_IMAGE_MIMES);

const startsWith = (b: Uint8Array, sig: number[]): boolean => {
  if (b.length < sig.length) return false;
  for (let i = 0; i < sig.length; i += 1) if (b[i] !== sig[i]) return false;
  return true;
};

/**
 * Role-aware byte validation for a STRUCTURED part (edit-context OR snapshot —
 * they share the part family, §8/§1.4). The attachment MIME allowlist does NOT
 * apply here: the `document` part is gzip on the wire (magic `1f 8b`), fonts are
 * woff/ttf/otf, and asset/witness/thumbnail are the existing rasters. A part
 * whose sniffed class doesn't match its declared role → the caller returns 415.
 * The document is never served as `text/html` (octet-stream header unchanged).
 */
function classifyStructuredPart(
  bytes: Uint8Array,
  role: CaptureManifest["parts"][number]["role"],
): { mime: string; width?: number; height?: number } | null {
  if (role === "document") {
    return startsWith(bytes, [0x1f, 0x8b]) ? { mime: "application/gzip" } : null;
  }
  if (role === "font") {
    const mime = captureFontMimeOf(bytes);
    return mime ? { mime } : null;
  }
  if (role === "asset" || role === "witness" || role === "thumbnail") {
    const sniff = sniffCapture(bytes);
    if (!IMAGE_MIMES.has(sniff.mime)) return null;
    return {
      mime: sniff.mime,
      ...(sniff.width !== undefined ? { width: sniff.width } : {}),
      ...(sniff.height !== undefined ? { height: sniff.height } : {}),
    };
  }
  return null; // `file` role never appears in an edit-context manifest
}

/**
 * Validate raw bytes for a declared role, kind-aware, with the pixel cap applied
 * (§8). Returns the sniffed mime + dims on success, or a rejection reason. One
 * shared core so the primary PUT and the same-sha sibling registration below
 * (gpt56-8) can never drift in what a role admits.
 */
function classifyPartBounded(
  kind: CaptureManifest["kind"],
  bytes: Uint8Array,
  role: CaptureManifest["parts"][number]["role"],
): { ok: true; mime: string; width?: number; height?: number } | { ok: false; reason: string } {
  if (kind !== "attachment") {
    const cls = classifyStructuredPart(bytes, role);
    if (!cls) return { ok: false, reason: "unsupported-media" };
    if (
      cls.width !== undefined &&
      cls.height !== undefined &&
      cls.width * cls.height > LIMITS.MAX_CAPTURE_IMAGE_PIXELS
    ) {
      return { ok: false, reason: "image-too-large" };
    }
    return { ok: true, ...cls };
  }
  const sniff = sniffCapture(bytes);
  if (ACTIVE_MIMES.has(sniff.mime) || !ALLOWED_MIMES.has(sniff.mime)) {
    return { ok: false, reason: "unsupported-media" };
  }
  if (
    sniff.width !== undefined &&
    sniff.height !== undefined &&
    sniff.width * sniff.height > LIMITS.MAX_CAPTURE_IMAGE_PIXELS
  ) {
    return { ok: false, reason: "image-too-large" };
  }
  return { ok: true, ...sniff };
}

/**
 * Structural shape check for a STRUCTURED manifest (edit-context OR snapshot,
 * §8/§1.1/§1.4/§1.7): exactly one `document` part named `document`; at most one
 * `authorsheet` (also role `document`); 0..n `font`/`asset`; at most one
 * `witness`; at most one `thumbnail`; NO `file`-role part; part names unique.
 * A snapshot may omit the authorsheet (0 is valid) — nothing toggles a class
 * against it. The role×name binding is structural, not conventional (mirrors
 * the attachment gate's discipline).
 */
function validStructuredShape(parts: CaptureManifest["parts"]): boolean {
  const names = new Set<string>();
  let documents = 0;
  let authorsheets = 0;
  let witnesses = 0;
  let thumbnails = 0;
  for (const p of parts) {
    if (names.has(p.name)) return false;
    names.add(p.name);
    if (p.role === "file") return false;
    if (p.role === "document") {
      if (p.name === "document") documents += 1;
      else if (p.name === "authorsheet") authorsheets += 1;
      else return false; // a stray document-role name
    } else if (p.role === "witness") {
      if (p.name !== "witness") return false;
      witnesses += 1;
    } else if (p.role === "thumbnail") {
      if (p.name !== "thumbnail") return false;
      thumbnails += 1;
    }
    // font / asset: any name, any count (budget-capped by MAX_CAPTURE_PARTS)
  }
  return documents === 1 && authorsheets <= 1 && witnesses <= 1 && thumbnails <= 1;
}

/**
 * F30 `variant-look` shape: the raster IS the capture — exactly one
 * `witness`/`witness` part, at most one `thumbnail`/`thumbnail`, nothing else
 * (the reconstruction base lives on the edit-context capture; a witness-less
 * variant-look would be a claim with no evidence, so it is refused here).
 */
function validVariantLookShape(parts: CaptureManifest["parts"]): boolean {
  const names = new Set<string>();
  let witnesses = 0;
  let thumbnails = 0;
  for (const p of parts) {
    if (names.has(p.name)) return false;
    names.add(p.name);
    if (p.role === "witness" && p.name === "witness") witnesses += 1;
    else if (p.role === "thumbnail" && p.name === "thumbnail") thumbnails += 1;
    else return false;
  }
  return witnesses === 1 && thumbnails <= 1;
}

/** Provenance (never a gate): the class the credential carries. */
function capturedFromOf(caller: Caller): CaptureSourceKind {
  if (caller.class === "full") return "extension";
  if (caller.class === "interaction") return "pwa";
  return "agent";
}

/** Drop timed-out pending inits and reap their abandoned staged blobs. */
function reapPending(rt: Runtime, now: number): void {
  let expired = false;
  for (const [id, p] of rt.pendingCaptures) {
    if (p.deadline < now) {
      rt.pendingCaptures.delete(id);
      expired = true;
    }
  }
  if (expired) rt.captureStore.sweepOrphans(now);
}

function stagedPersonBytes(rt: Runtime, personId: string): number {
  let n = 0;
  for (const p of rt.pendingCaptures.values()) if (p.personId === personId) n += p.stagedBytes;
  return n;
}

const closed = () => errorResponse("conflict", "This interaction is closed.", "closed");

/** A capture manifest: up to MAX_CAPTURE_PARTS parts and MAX_CAPTURE_META of meta. */
const MANIFEST_MAX_BYTES = 65_536;

/** The readable, live interaction for an upload phase, or the response to send. */
function uploadTarget(rt: Runtime, caller: Caller, id: string): InteractionState | Response {
  const s = rt.interactions.get(id);
  if (!s || !canSee(caller.access, id)) return notFound();
  if (!isLive(s)) return closed();
  return s;
}

/** The caller's access now: an edge update since the request began wins (null = revoked). */
function accessNow(rt: Runtime, caller: Caller, startedAt: number): CallerAccess | null {
  const update = rt.accessUpdates.get(caller.personId);
  return update && update.at >= startedAt ? update.access : caller.access;
}

/** Only a member's Full client may produce the structured kinds (the role-capability gate). */
function mayProduce(kind: PendingCapture["kind"], caller: Caller, access: CallerAccess): boolean {
  return kind === "attachment" || (caller.class === "full" && access.kind === "member");
}

/**
 * Everything an upload phase rests on, checked again after its last `await`:
 * the caller still sees the interaction and may attach to it, it is still
 * live, the structured-kind gate still holds for their current role, and the
 * pending upload is still the one this request started with.
 */
function stillAdmitted(
  rt: Runtime,
  caller: Caller,
  id: string,
  pending: PendingCapture,
  startedAt: number,
): Response | null {
  const access = accessNow(rt, caller, startedAt);
  if (access === null) return notFound();
  const now = { ...caller, access };
  const g = admit(rt, now, "attach", id);
  if (!g.ok) return refusal(g);
  if (!isLive(g.s)) return closed();
  if (!mayProduce(pending.kind, caller, access)) return notFound();
  if (rt.pendingCaptures.get(pending.captureId) !== pending) return notFound();
  return null;
}

/** Usage numbers a refusal may show: a guest sees no space-wide totals. */
function quotaDetails(
  rt: Runtime,
  caller: Caller,
  startedAt: number,
  scope: "actor" | "global",
  usedBytes: number,
  limitBytes: number,
): Record<string, unknown> {
  // The caller's standing now: a member downgraded to guest mid-upload gets the guest's answer.
  const access = accessNow(rt, caller, startedAt);
  if (scope === "global" && access?.kind !== "member") return { scope };
  return { scope, usedBytes, limitBytes };
}

export async function handleCaptureInit(
  rt: Runtime,
  requester: Caller,
  req: Request,
  id: string,
): Promise<Response> {
  const first = admit(rt, requester, "attach", id);
  if (!first.ok) return refusal(first);
  const now = rt.clock.now();
  reapPending(rt, now);
  if (!isLive(first.s)) return closed();

  const manifest = await parseBody(req, CaptureManifestSchema, MANIFEST_MAX_BYTES);
  if (manifest instanceof Response) return manifest;

  // The body was awaited: decide on the caller's standing and the
  // interaction as they are NOW (round 2, S11).
  const access = accessNow(rt, requester, now);
  if (access === null) return notFound();
  const caller: Caller = { ...requester, access };
  const g = admit(rt, caller, "attach", id);
  if (!g.ok) return refusal(g);
  const target = g.s;
  if (!isLive(target)) return closed();

  // Role-capability gate: the privileged structured kinds are admitted ONLY
  // for a member's Full client, derived from the credential. Anyone else
  // gets the same not_found as an unknown interaction.
  if (manifest.kind !== "attachment" && (caller.class !== "full" || !isMember(caller))) {
    return notFound();
  }
  // Kind ↔ interaction-shape binding: an edit-context belongs to an Edit, a
  // snapshot to an anchored place. A mismatch wears the same not_found.
  if (manifest.kind === "edit-context" && target.kind !== "change") return notFound();
  if (manifest.kind === "snapshot" && target.anchor.level === "unanchored") return notFound();
  // A variant-look binds to a live variant of a set this Edit owns, at a
  // version that is not from the future. Every spoof shape is not_found.
  if (manifest.kind === "variant-look") {
    const m = manifest.meta;
    const refuse = (why: string): Response => {
      rt.log("capture-refusal", { kind: "variant-look", why });
      return notFound();
    };
    if (target.kind !== "change") return refuse("not-a-change");
    if (!m?.variantSetId || !m.variantId || m.variantVersion === undefined)
      return refuse("meta-missing");
    const set = rt.variantSets.get(m.variantSetId);
    if (!set) return refuse("set-unknown");
    if (set.changeInteractionId !== id) return refuse("set-foreign");
    const variant = set.variants.find((v) => v.variantId === m.variantId);
    if (!variant) return refuse("variant-unknown");
    if (m.variantVersion > variant.version) return refuse("version-future");
  }

  // Automatic captures come only from the person who started the work (the
  // security audit's finding 2): a variant look or an Edit's context from its
  // author; a snapshot from the author or whoever asked for this fresh look.
  // Attachments stay open to every participant, as an explicit act.
  if (manifest.kind !== "attachment") {
    const mine =
      manifest.kind === "snapshot"
        ? target.authorId === caller.personId || target.resnapRequestedBy === caller.personId
        : target.authorId === caller.personId;
    if (!mine) {
      return errorResponse(
        "forbidden",
        "Only the person who started this can capture it automatically.",
        "not-yours",
      );
    }
  }

  const badManifest = () => errorResponse("invalid", "The manifest doesn't fit.", "bad-manifest");
  if (manifest.kind === "attachment") {
    if (
      manifest.parts.length !== 1 ||
      manifest.parts[0]?.name !== "file" ||
      manifest.parts[0]?.role !== "file"
    ) {
      return badManifest();
    }
  } else if (manifest.kind === "variant-look") {
    if (!validVariantLookShape(manifest.parts) || manifest.format !== "onlay-varlook/1") {
      return badManifest();
    }
  } else if (!validStructuredShape(manifest.parts)) {
    return badManifest();
  }
  const totalBytes = manifest.parts.reduce((n, p) => n + p.byteLen, 0);
  if (totalBytes > LIMITS.MAX_CAPTURE_TOTAL_BYTES) {
    return errorResponse("invalid", "The capture is too large.", "too-large");
  }

  // Concurrent-init cap — bounds the staged bytes a person can hold.
  const live = [...rt.pendingCaptures.values()].filter(
    (p) => p.personId === caller.personId && p.deadline >= now,
  ).length;
  if (live >= LIMITS.MAX_PENDING_CAPTURES_PER_ACTOR) {
    return errorResponse("rate_limited", "Too many uploads in flight.", "too-many-pending");
  }

  const captureId = rt.uuid();
  rt.pendingCaptures.set(captureId, {
    captureId,
    interactionId: id,
    personId: caller.personId,
    credentialId: caller.credentialId,
    ...(caller.credentialGeneration !== undefined
      ? { credentialGeneration: caller.credentialGeneration }
      : {}),
    capturedFrom: capturedFromOf(caller),
    kind: manifest.kind,
    format: manifest.format,
    ...(manifest.caption !== undefined ? { caption: manifest.caption } : {}),
    ...(manifest.meta !== undefined ? { meta: manifest.meta } : {}),
    parts: manifest.parts,
    received: new Map(),
    stagedBytes: 0,
    deadline: now + LIMITS.STAGING_TTL_MS,
  });
  // `missing` is a scope-blind copy of the manifest shas — never a query
  // against stored blobs — so uploads can't become an existence oracle.
  return json({
    ok: true,
    captureId,
    revision: 1,
    missing: manifest.parts.map((p) => p.sha256),
  });
}

/**
 * The pending upload, bound to the person AND the credential that opened it:
 * another device of the same person can't finish it.
 */
function pendingFor(
  rt: Runtime,
  caller: Caller,
  id: string,
  captureId: string,
  now: number,
): PendingCapture | null {
  const p = rt.pendingCaptures.get(captureId);
  if (!p || p.interactionId !== id || p.deadline < now) return null;
  if (p.personId !== caller.personId || p.credentialId !== caller.credentialId) return null;
  if (p.capturedFrom !== capturedFromOf(caller)) return null;
  return p;
}

export async function handleCapturePut(
  rt: Runtime,
  caller: Caller,
  req: Request,
  id: string,
  captureId: string,
  name: string,
): Promise<Response> {
  const target = uploadTarget(rt, caller, id);
  if (target instanceof Response) return target;
  const now = rt.clock.now();
  reapPending(rt, now);
  const pending = pendingFor(rt, caller, id, captureId, now);
  if (!pending || !mayProduce(pending.kind, caller, caller.access)) return notFound();
  const part = pending.parts.find((p) => p.name === name);
  if (!part) return notFound();

  // Active-content refusal on the declared mime too (normalized base type).
  if (ACTIVE_MIMES.has(baseMime(part.mime))) {
    return errorResponse("invalid", "That kind of file isn't accepted.", "unsupported-media");
  }
  const tooLarge = () => errorResponse("invalid", "The part is too large.", "too-large");
  const cl = req.headers.get("content-length");
  if (cl && Number(cl) > LIMITS.MAX_CAPTURE_PART_BYTES) return tooLarge();
  const bytes = await readCappedBody(req, LIMITS.MAX_CAPTURE_PART_BYTES);
  if (bytes === null) return tooLarge();

  const sha = await sha256Hex(bytes);
  if (sha !== part.sha256) {
    return errorResponse("invalid", "The bytes don't match the manifest.", "hash-mismatch");
  }
  // The declared length is what commit charges to quota; it must be honest.
  if (bytes.byteLength !== part.byteLen) {
    return errorResponse("invalid", "The length doesn't match the manifest.", "length-mismatch");
  }
  const cls = classifyPartBounded(pending.kind, bytes, part.role);
  if (!cls.ok) return errorResponse("invalid", "That file isn't accepted here.", cls.reason);
  // The body and its digest were awaited: the caller's standing may have moved since.
  const moved = stillAdmitted(rt, caller, id, pending, now);
  if (moved) return moved;

  // Staged-byte quota, dedup-blind: the decision never depends on whether the
  // blob already exists (no cross-participant existence probe).
  const alreadyReceived = pending.received.has(name);
  const incoming = alreadyReceived ? 0 : bytes.byteLength;
  if (incoming > 0) {
    const used =
      rt.captureStore.committedActorBytes(caller.personId) + stagedPersonBytes(rt, caller.personId);
    if (used + incoming > LIMITS.MAX_CAPTURE_QUOTA_ACTOR_BYTES) {
      return errorResponse(
        "conflict",
        "Your storage in this space is full.",
        "quota",
        quotaDetails(rt, caller, now, "actor", used, LIMITS.MAX_CAPTURE_QUOTA_ACTOR_BYTES),
      );
    }
    const usedGlobal = rt.captureStore.committedGlobalBytes() + rt.captureStore.stagedGlobalBytes();
    if (usedGlobal + incoming > LIMITS.MAX_CAPTURE_QUOTA_GLOBAL_BYTES) {
      return errorResponse(
        "conflict",
        "This space's storage is full.",
        "quota",
        quotaDetails(rt, caller, now, "global", usedGlobal, LIMITS.MAX_CAPTURE_QUOTA_GLOBAL_BYTES),
      );
    }
  }

  const wasNew = rt.captureStore.putBlobStaged(sha, cls.mime, bytes, now);
  if (!alreadyReceived) {
    pending.received.set(name, {
      sniffedMime: cls.mime,
      ...(cls.width !== undefined ? { width: cls.width } : {}),
      ...(cls.height !== undefined ? { height: cls.height } : {}),
    });
    if (wasNew) pending.stagedBytes += bytes.byteLength;
    // A shared sha is uploaded once; register every same-sha part whose role
    // the bytes ALSO satisfy (never a role bypass).
    for (const other of pending.parts) {
      if (other.name === name || other.sha256 !== sha || pending.received.has(other.name)) continue;
      // A sibling's declared length is what commit charges and serves: it must be these bytes'.
      if (other.byteLen !== bytes.byteLength) continue;
      const v = classifyPartBounded(pending.kind, bytes, other.role);
      if (!v.ok) continue;
      pending.received.set(other.name, {
        sniffedMime: v.mime,
        ...(v.width !== undefined ? { width: v.width } : {}),
        ...(v.height !== undefined ? { height: v.height } : {}),
      });
    }
  }
  return json({ ok: true, received: name, sha256: sha });
}

export async function handleCaptureCommit(
  rt: Runtime,
  caller: Caller,
  id: string,
  captureId: string,
): Promise<Response> {
  const target = uploadTarget(rt, caller, id);
  if (target instanceof Response) return target;
  const now = rt.clock.now();
  reapPending(rt, now);
  const pending = pendingFor(rt, caller, id, captureId, now);
  if (!pending) return repeatedCommit(rt, caller, id, captureId, now);
  if (!mayProduce(pending.kind, caller, caller.access)) return notFound();

  // Proof-of-possession is per NAME, in THIS init.
  for (const p of pending.parts) {
    if (!pending.received.has(p.name)) {
      return errorResponse("conflict", "Some parts haven't been uploaded.", "incomplete");
    }
  }
  const parts = pending.parts.map((p) => ({
    name: p.name,
    role: p.role,
    mime: pending.received.get(p.name)?.sniffedMime ?? p.mime,
    byteLen: p.byteLen,
    sha256: p.sha256,
  }));
  const totalBytes = pending.parts.reduce((n, p) => n + p.byteLen, 0);
  const isStructured = pending.kind !== "attachment";
  const primary = pending.received.get("file");
  const format = isStructured ? pending.format : (primary?.sniffedMime ?? pending.format);
  const block = pending.meta?.blockRect;
  const width = isStructured ? block?.width : primary?.width;
  const height = isStructured ? block?.height : primary?.height;

  // Lineage by kind: snapshot = server-derived `snap:<id>`; edit-context =
  // `edit:<targetKey>` (bounded) or the capture id; variant-look = a digest of
  // the validated (set, variant) pair; attachment = the capture id.
  const targetKey = pending.kind === "edit-context" ? pending.meta?.targetKey : undefined;
  const editLineage = targetKey ? `edit:${targetKey}` : undefined;
  const varlookLineage =
    pending.kind === "variant-look" && pending.meta?.variantSetId && pending.meta.variantId
      ? `varlook:${(
          await sha256Hex(
            new TextEncoder().encode(
              JSON.stringify([pending.meta.variantSetId, pending.meta.variantId]),
            ),
          )
        ).slice(0, 48)}`
      : undefined;
  const lineageId =
    pending.kind === "snapshot"
      ? `snap:${id}`
      : (varlookLineage ??
        (editLineage && editLineage.length <= LIMITS.MAX_CAPTURE_ID ? editLineage : captureId));

  // Server-derived lineages never persist a client `targetKey`.
  let commitMeta = isStructured ? pending.meta : undefined;
  if (
    commitMeta &&
    (pending.kind === "snapshot" || pending.kind === "variant-look") &&
    commitMeta.targetKey !== undefined
  ) {
    const { targetKey: _drop, ...rest } = commitMeta;
    commitMeta = rest;
  }

  // The digest above awaited: re-check everything, and a commit that finished
  // meanwhile (a repeated request) answers with that commit's result.
  if (rt.pendingCaptures.get(captureId) !== pending)
    return repeatedCommit(rt, caller, id, captureId, now);
  const moved = stillAdmitted(rt, caller, id, pending, now);
  if (moved) return moved;
  const current = rt.interactions.get(id);
  if (!current || !isLive(current)) return closed();

  const result = rt.captureStore.commitCapture({
    captureId,
    interactionId: id,
    kind: pending.kind,
    lineageId,
    capturedBy: caller.personId,
    capturedFrom: pending.capturedFrom,
    format,
    ...(pending.caption !== undefined ? { caption: pending.caption } : {}),
    parts,
    totalBytes,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(commitMeta !== undefined ? { meta: commitMeta } : {}),
    now,
  });
  if (!result.ok) {
    if (result.reason === "quota") {
      rt.pendingCaptures.delete(captureId);
      return errorResponse(
        "conflict",
        "Storage is full.",
        "quota",
        quotaDetails(rt, caller, now, result.scope, result.usedBytes, result.limitBytes),
      );
    }
    if (result.reason === "length-mismatch") {
      rt.pendingCaptures.delete(captureId);
      return errorResponse(
        "invalid",
        "A part's length doesn't match its bytes.",
        "length-mismatch",
      );
    }
    if (result.reason === "too-many") {
      rt.pendingCaptures.delete(captureId);
      return errorResponse("conflict", "This interaction has too many captures.", "too-many");
    }
    return errorResponse("conflict", "Some parts are missing.", "incomplete");
  }
  rt.pendingCaptures.delete(captureId);

  // A committed snapshot discharges a pending fresh-look duty — commit first,
  // then fulfil referencing the committed capture.
  let latest = current;
  if (pending.kind === "snapshot" && current.resnapRequestedBy) {
    latest = commit(
      rt,
      { k: "int-resnap-fulfill", ts: now, id, captureId: result.ref.captureId },
      fulfillResnap(current, result.ref.captureId),
    );
    latest = systemNote(rt, latest, "captured a fresh look");
  }
  fanOut(rt, current, latest);
  return json({ ok: true, capture: result.ref });
}

/**
 * A commit for an upload no longer pending: when this person (on this
 * credential's class) already committed it, the first commit's result;
 * otherwise the collapsed `not_found`.
 */
function repeatedCommit(
  rt: Runtime,
  requester: Caller,
  id: string,
  captureId: string,
  startedAt: number,
): Response {
  // The answer follows the caller's standing now, not when the upload began.
  const access = accessNow(rt, requester, startedAt);
  if (access === null) return notFound();
  const caller: Caller = { ...requester, access };
  if (!admit(rt, caller, "attach", id).ok) return notFound();
  const ref = rt.captureStore.refById(id, captureId);
  if (!ref || ref.capturedBy !== caller.personId || ref.capturedFrom !== capturedFromOf(caller)) {
    return notFound();
  }
  return json({ ok: true, capture: ref });
}

export function handleCapturesList(rt: Runtime, caller: Caller, id: string): Response {
  if (!rt.interactions.has(id) || !canSee(caller.access, id)) return notFound();
  return json({ ok: true, captures: rt.captureStore.listForInteraction(id) });
}

export function handleCapturePartGet(
  rt: Runtime,
  caller: Caller,
  id: string,
  captureId: string,
  name: string,
): Response {
  if (!rt.interactions.has(id) || !canSee(caller.access, id)) return notFound();
  // Reachable only when the capture belongs to :id and the part exists.
  const part = rt.captureStore.readPart(id, captureId, name);
  if (!part) return notFound();
  return new Response(part.bytes, {
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename="${captureId}-${name}"`,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store",
    },
  });
}

/** A member sees their own and the space's usage; a guest only their own. */
export function handleCaptureUsage(rt: Runtime, caller: Caller): Response {
  const usage = rt.captureStore.usage(caller.personId);
  if (caller.access.kind !== "member") return json({ ok: true, actor: usage.actor });
  return json({ ok: true, ...usage });
}
