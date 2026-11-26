import { expect, test } from "bun:test";
import { LIMITS } from "@onlay/protocol";
import { gunzip } from "@onlay/render";
import type { CaptureDraft } from "./index";
import { ResidueLog } from "./residue";
import { assembleParts, buildUploadMeta, gzip, upload } from "./upload";

function draftOf(over: Partial<CaptureDraft> = {}): CaptureDraft {
  const residue = new ResidueLog();
  return {
    interactionId: "int-1",
    kind: "edit-context",
    targetKeySource: "#hero",
    documentHtml: "<!doctype html><html><body>hi</body></html>",
    authorsheet: null,
    assetRefs: [],
    parts: [],
    residue,
    meta: {
      viewport: { innerWidth: 800, innerHeight: 600, dpr: 2, layoutWidth: 800 },
      blockRect: { x: 0, y: 0, width: 100, height: 40 },
      habitatRect: { x: 0, y: 0, width: 200, height: 80 },
      quiescence: "settled",
      captureMs: 123,
    },
    block: null as unknown as Element,
    scope: null as unknown as Element,
    ...over,
  };
}

test("gzip round-trips through the renderer's gunzip", async () => {
  const text = "@font-face{font-family:X}\n.foo{color:red}";
  const bytes = await gzip(text);
  expect(bytes[0]).toBe(0x1f); // gzip magic
  expect(bytes[1]).toBe(0x8b);
  expect(await gunzip(bytes)).toBe(text);
});

test("buildUploadMeta carries viewport/rects/quiescence and omits empty residue + targetKey", () => {
  const meta = buildUploadMeta(draftOf());
  expect(meta.viewport).toEqual({ innerWidth: 800, innerHeight: 600, dpr: 2, layoutWidth: 800 });
  expect(meta.blockRect).toEqual({ x: 0, y: 0, width: 100, height: 40 });
  expect(meta.habitatRect).toEqual({ x: 0, y: 0, width: 200, height: 80 });
  expect(meta.quiescence).toBe("settled");
  expect(meta.captureMs).toBe(123);
  expect("residue" in meta).toBe(false); // empty → omitted
  expect("targetKey" in meta).toBe(false); // the SW derives it (A16)
});

test("buildUploadMeta includes residue when non-empty", () => {
  const draft = draftOf();
  draft.residue.declinedGrant("https://cdn.example.com");
  const meta = buildUploadMeta(draft);
  expect(meta.residue).toEqual([{ class: "declined-grant", origin: "https://cdn.example.com" }]);
});

test("assembleParts gzips the document first, then authorsheet, then media parts", async () => {
  const draft = draftOf({
    authorsheet: ".btn--brand{color:blue}",
    parts: [
      { name: "font-aaa", role: "font", mime: "font/woff2", bytes: new Uint8Array([1, 2, 3]) },
      { name: "witness", role: "witness", mime: "image/webp", bytes: new Uint8Array([4, 5]) },
    ],
  });
  const parts = await assembleParts(draft);
  expect(parts.map((p) => p.name)).toEqual(["document", "authorsheet", "font-aaa", "witness"]);
  expect(parts[0]?.role).toBe("document");
  expect(parts[0]?.mime).toBe("application/gzip");
  expect(parts[1]?.mime).toBe("application/gzip"); // authorsheet also gzipped
  // the document part is a real gzip of the html
  const docBytes = Uint8Array.from(atob(parts[0]?.b64 ?? ""), (c) => c.charCodeAt(0));
  expect(await gunzip(docBytes)).toBe(draft.documentHtml);
});

test("assembleParts omits the authorsheet part when there is none", async () => {
  const parts = await assembleParts(draftOf({ authorsheet: null }));
  expect(parts.map((p) => p.name)).toEqual(["document"]);
});

test("assembleParts finalizer trims to MAX_CAPTURE_PARTS + meters oversize-truncation (D13)", async () => {
  const parts = Array.from({ length: 20 }, (_, i) => ({
    name: `asset-${i}`,
    role: "asset" as const,
    mime: "image/png",
    bytes: new Uint8Array([i]),
  }));
  const draft = draftOf({ authorsheet: ".x{color:red}", parts });
  const out = await assembleParts(draft);
  expect(out.length).toBeLessThanOrEqual(LIMITS.MAX_CAPTURE_PARTS);
  // document + authorsheet are kept (mandatory-priority); assets are trimmed.
  expect(out[0]?.name).toBe("document");
  expect(out[1]?.name).toBe("authorsheet");
  expect(draft.residue.toArray().some((e) => e.class === "oversize-truncation")).toBe(true);
});

test("buildUploadMeta clamps a degenerate rect/dpr to the wire-schema range", () => {
  const draft = draftOf();
  draft.meta.blockRect = {
    x: -1e12,
    y: Number.POSITIVE_INFINITY,
    width: 1e15,
    height: -5,
  };
  draft.meta.viewport = {
    innerWidth: 800,
    innerHeight: 600,
    dpr: Number.NaN,
    layoutWidth: 800,
  };
  const meta = buildUploadMeta(draft) as {
    blockRect: { x: number; y: number; width: number; height: number };
    viewport: { dpr: number };
  };
  expect(meta.blockRect.x).toBe(-LIMITS.MAX_CAPTURE_COORD);
  expect(meta.blockRect.y).toBe(0); // non-finite → 0
  expect(meta.blockRect.width).toBe(LIMITS.MAX_CAPTURE_COORD);
  expect(meta.blockRect.height).toBe(0); // negative dim → 0
  expect(meta.viewport.dpr).toBe(1); // non-finite dpr → 1
});

test("upload sends the captureUpload message with targetKeyRaw and returns the capture id", async () => {
  const sent: Record<string, unknown>[] = [];
  const outcome = await upload(draftOf(), {
    send: async (msg) => {
      sent.push(msg);
      return { ok: true, captureId: "cap-9" };
    },
  });
  expect(outcome).toEqual({ ok: true, captureId: "cap-9" });
  expect(sent[0]?.type).toBe("captureUpload");
  expect(sent[0]?.id).toBe("int-1");
  expect(sent[0]?.targetKeyRaw).toBe("#hero"); // un-hashed; SW hashes → meta.targetKey
  expect(sent[0]?.format).toBe("onlay-cap/1");
  expect(sent[0]?.kind).toBe("edit-context");
});

test("a snapshot upload carries kind and OMITS targetKeyRaw (server-derived lineage, §1.3)", async () => {
  const sent: Record<string, unknown>[] = [];
  const outcome = await upload(draftOf({ kind: "snapshot" }), {
    send: async (msg) => {
      sent.push(msg);
      return { ok: true, captureId: "snap-1" };
    },
  });
  expect(outcome).toEqual({ ok: true, captureId: "snap-1" });
  expect(sent[0]?.kind).toBe("snapshot");
  // No client lineage key — the client cannot fork a snapshot's look history.
  expect("targetKeyRaw" in (sent[0] ?? {})).toBe(false);
  // The rest of the meta (viewport/rects/residue) still rides, powering the
  // full-page look history sizing + residue meter (§1.4).
  expect((sent[0]?.meta as { viewport?: unknown }).viewport).toEqual({
    innerWidth: 800,
    innerHeight: 600,
    dpr: 2,
    layoutWidth: 800,
  });
});

test("upload failure is fail-soft: refuses, adds NO residue (D9)", async () => {
  const draft = draftOf();
  const before = draft.residue.toArray().length;
  const rejected = await upload(draft, {
    send: async () => {
      throw new Error("network down");
    },
  });
  expect(rejected).toEqual({ ok: false, refusal: "other" });
  const declined = await upload(draft, { send: async () => ({ ok: false, reason: "commit" }) });
  expect(declined).toEqual({ ok: false, refusal: "other" });
  // A capacity refusal (quota / series cap) is named "storage-cap" so the caller
  // can show the §3 storage-cap toast; any other reason stays generic.
  const capped = await upload(draft, {
    send: async () => ({ ok: false, reason: "commit", serverReason: "quota" }),
  });
  expect(capped).toEqual({ ok: false, refusal: "storage-cap" });
  const series = await upload(draft, {
    send: async () => ({ ok: false, reason: "commit", serverReason: "too-many" }),
  });
  expect(series).toEqual({ ok: false, refusal: "storage-cap" });
  // The absence of a CaptureRef is the honest signal — no interaction residue.
  expect(draft.residue.toArray().length).toBe(before);
});

test("witnessMissing fires ONLY for a declined-grant witness absence (F6)", async () => {
  // Grant-declined: witness absent + declined-grant residue → the toast may
  // honestly point at the capture switch.
  const declined = draftOf();
  declined.residue.declinedGrant("https://example.com");
  const blamed = await upload(declined, {
    send: async () => ({ ok: true, captureId: "cap-a" }),
  });
  expect(blamed).toEqual({ ok: true, captureId: "cap-a", witnessMissing: true });
  // A throttled/failed grab meters security-error, not declined-grant — the
  // switch is innocent and must not be blamed.
  const throttled = draftOf();
  throttled.residue.add("security-error");
  const plain = await upload(throttled, {
    send: async () => ({ ok: true, captureId: "cap-b" }),
  });
  expect(plain).toEqual({ ok: true, captureId: "cap-b" });
});

test("a not-yours refusal is named, so callers stop instead of retrying", async () => {
  const refused = await upload(draftOf(), {
    send: async () => ({ ok: false, reason: "init", status: 403, serverReason: "not-yours" }),
  });
  expect(refused).toEqual({ ok: false, refusal: "not-yours" });
});

test("the binding is checked again after compression, immediately before the send (R3-C4)", async () => {
  let live = true;
  const sent: Array<Record<string, unknown>> = [];
  const draft = draftOf({ verify: () => live });
  const out = await upload(draft, {
    // The page moves on while the parts are being compressed.
    assemble: async (d) => {
      const parts = await assembleParts(d);
      live = false;
      return parts;
    },
    send: async (m) => {
      sent.push(m);
      return { ok: true, captureId: "c1" };
    },
  });
  expect(sent).toEqual([]);
  expect(out).toEqual({ ok: false, refusal: "other" });
  // Still bound: the message goes, carrying the page and generation for the SW's own check.
  live = true;
  await upload(draftOf({ verify: () => true }), {
    send: async (m) => {
      sent.push(m);
      return { ok: true, captureId: "c2" };
    },
  });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toHaveProperty("pageUrl");
  expect(sent[0]).toHaveProperty("generation");
});
