// Browser entry bundled (Bun.build) into `.gen/onlay-render.js` and injected
// into the live fixture page by the fidelity gate. It exposes the REAL landed
// engines — `walk()` (capture spec §1-§2) and `buildSrcdoc()` (render spec §1) —
// and orchestrates the part *transport* the harness stands in for: turning the
// walked block into the capture *parts* the renderer's injected `fetchPart`
// consumes. This is exactly the in-memory `fetchPart` shape the renderer's own
// unit tests use — the code under test (walk + buildSrcdoc + applyProgramToRoot)
// is the real product code; only the part transport is harness-supplied.
//
// This gate proves the unit-transport fidelity + isolation core in-browser
// against hostile fixtures. The content-side pipeline (witness raster,
// harvest, upload) is unit-pinned in `overlay/capture/*.test.ts`.

import type { CaptureRef, MutationProgram } from "@onlay/protocol";
import { walk } from "../../../packages/extension/src/overlay/capture/walker";
import { buildSrcdoc, type RenderResidue } from "../../../packages/render/src/portable-renderer";
import { applyProgramToRoot } from "../../../packages/render/src/preview-engine";

interface PartBytes {
  role: CaptureRef["parts"][number]["role"];
  mime: string;
  bytes: Uint8Array;
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Sniff a coarse image mime from magic bytes (server does the real re-sniff). */
function sniffMime(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return "image/webp";
  if (bytes[0] === 0x3c) return "image/svg+xml";
  return "application/octet-stream";
}

/**
 * Harness-side harvest of author CSS text (render spec §4/D4 harvest stand-in):
 * concatenate every same-origin document stylesheet + document-level
 * adoptedStyleSheets, in order. Shadow-scoped adopted sheets are excluded (D14),
 * matching the product harvest, so a shadow-keyed setClass correctly surfaces
 * the honest note rather than resolving.
 */
function harvestAuthorCss(): string {
  const chunks: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const rules = sheet.cssRules; // throws SecurityError on a cross-origin sheet
      for (const rule of Array.from(rules)) chunks.push(rule.cssText);
    } catch {
      /* cross-origin sheet — text unreadable here (product routes it via the SW) */
    }
  }
  for (const sheet of Array.from(
    (document as unknown as { adoptedStyleSheets: CSSStyleSheet[] }).adoptedStyleSheets ?? [],
  )) {
    try {
      for (const rule of Array.from(sheet.cssRules)) chunks.push(rule.cssText);
    } catch {
      /* ignore */
    }
  }
  return chunks.join("\n");
}

export interface RenderReport {
  srcdoc: string;
  residue: RenderResidue;
  /** The capture-time closed-enum residue the walker metered (for the meter + inverted assert). */
  captureResidue: string[];
  layoutWidth: number;
  blockRect: { x: number; y: number; width: number; height: number };
  nodeCount: number;
  strippedAssetRefs: number;
}

const FRAME_ID = "onlay-fidelity-frame";

/**
 * Walk the live block, assemble capture parts, run the portable renderer, and
 * mount the result in a `sandbox=""` iframe appended to the page (below the
 * fold). Resolves once the reconstruction has loaded + fonts settled so the
 * gate can screenshot `[data-oc-block]` inside it. `program` absent → Original;
 * present → a variant.
 */
async function render(blockSelector: string, program?: MutationProgram): Promise<RenderReport> {
  const block = document.querySelector(blockSelector);
  if (!block) throw new Error(`fidelity: block not found for selector ${blockSelector}`);

  const result = walk({ block });

  const parts = new Map<string, PartBytes>();
  parts.set("document", {
    role: "document",
    mime: "application/gzip",
    bytes: await gzip(result.documentHtml),
  });

  // Harness harvest: fetch each rewritten asset ({{asset:<ref>}} ↔ asset-<ref>).
  let strippedAssetRefs = 0;
  for (const asset of result.assetRefs) {
    try {
      const res = await fetch(asset.url);
      if (!res.ok) {
        strippedAssetRefs += 1;
        continue;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      parts.set(`asset-${asset.ref}`, { role: "asset", mime: sniffMime(bytes), bytes });
    } catch {
      strippedAssetRefs += 1;
    }
  }

  // Author CSS travels as the `authorsheet` document-part (variant mode only).
  const authorCss = harvestAuthorCss();
  if (authorCss.trim().length > 0) {
    parts.set("authorsheet", {
      role: "document",
      mime: "application/gzip",
      bytes: await gzip(authorCss),
    });
  }

  let totalBytes = 0;
  const refParts: CaptureRef["parts"] = [];
  for (const [name, p] of parts) {
    totalBytes += p.bytes.byteLength;
    refParts.push({ name, role: p.role, mime: p.mime, byteLen: p.bytes.byteLength });
  }

  const ref: CaptureRef = {
    captureId: "edit:fidelity",
    interactionId: "00000000-0000-4000-8000-000000000000",
    kind: "edit-context",
    lineageId: "edit:fidelity",
    revision: 1,
    capturedAt: Date.now(),
    capturedBy: "fidelity",
    capturedFrom: "extension",
    format: "onlay-cap/1",
    totalBytes,
    parts: refParts,
    width: result.meta.viewport.layoutWidth,
    height: Math.round(result.meta.blockRect.height),
  };

  const fetchPart = async (name: string): Promise<Uint8Array | null> =>
    parts.get(name)?.bytes ?? null;

  const built = await buildSrcdoc({ ref, fetchPart, program });

  // Mount in a sandbox="" iframe — the exact isolation the product stage builds.
  document.getElementById(FRAME_ID)?.remove();
  const frame = document.createElement("iframe");
  frame.id = FRAME_ID;
  frame.setAttribute("sandbox", ""); // attribute-present-empty = most restrictive
  // Mount fixed at the top-left, on-screen, above the page: an offscreen frame
  // makes Playwright's element-screenshot stability check (scroll-into-view of a
  // node inside a sandbox="" opaque-origin frame) never converge. The gate
  // removes the frame before any post-render live screenshot (variant tests).
  frame.style.cssText =
    "position:fixed;left:0;top:0;border:0;margin:0;padding:0;background:#fff;z-index:2147483647;";
  frame.style.width = `${result.meta.viewport.layoutWidth}px`;
  frame.style.height = `${Math.max(200, Math.ceil(result.meta.blockRect.height) + 200)}px`;
  frame.srcdoc = built.srcdoc;
  const loaded = new Promise<void>((resolve) => {
    frame.addEventListener("load", () => resolve(), { once: true });
  });
  document.body.appendChild(frame);
  await loaded;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));

  return {
    srcdoc: built.srcdoc,
    residue: built.residue,
    captureResidue: result.residue.map((r) => r.class),
    layoutWidth: result.meta.viewport.layoutWidth,
    blockRect: result.meta.blockRect,
    nodeCount: result.nodeCount,
    strippedAssetRefs,
  };
}

/**
 * Apply a variant program to the LIVE block via the REAL preview engine — the
 * ground-truth side of a variant-truth spot check (render spec §4.3). Uses the
 * same `applyProgramToRoot` the renderer applies to the reconstruction, so both
 * sides share op semantics; only the substrate (live DOM vs flattened capture)
 * differs. Returns the engine's miss-tally.
 */
function applyLive(
  blockSelector: string,
  program: MutationProgram,
): { applied: number; misses: number; rejected: number } {
  const block = document.querySelector(blockSelector);
  if (!block) throw new Error(`fidelity: block not found for selector ${blockSelector}`);
  return applyProgramToRoot(block, program);
}

declare global {
  interface Window {
    __onlayFidelity: { render: typeof render; applyLive: typeof applyLive };
  }
}

window.__onlayFidelity = { render, applyLive };
