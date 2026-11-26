// The harvest (grant-gated Layer 2) — content-side orchestrator (capture §4).
//
// Purpose, and ONLY purpose: recover author CSS *text* so class/attr-conditional
// variant rules resolve (`setClass`/`setAttr` fidelity), and recover
// `@font-face` `src` URLs + referenced asset bytes to inline. It is NEVER the
// block's primary render path — the flattened `oc-base` sheet is. Harvest fills
// three things onto the draft:
//   1. `documentHtml`'s empty `#oc-fonts` sheet ← reconstructed @font-face rules
//      whose `src` is rewritten to `url({{font:<ref>}})` (bytes → font parts);
//   2. `authorsheet` ← the full harvested author CSS text (D4), @font-face
//      stripped (it lives in #oc-fonts), every asset `url()` rewritten to
//      `{{asset:<ref>}}` (A18);
//   3. `parts` ← the fetched font + asset bytes (deduped by content-address ref).
//
// Enumeration runs in the content (isolated) world: same-origin `cssRules` read
// directly as text; cross-origin/link sheets + fonts + cross-origin assets are
// pulled through the privileged SW `harvestFetch` leg under the host grant
// (declined → metered `declined-grant:<origin>` per origin, never silent).
// Same-origin assets fetch credentialed from content (D15). Fully fail-soft.
import { captureFontMimeOf, captureImageInfoOf, LIMITS } from "@onlay/protocol";
import { rewriteImageUrls } from "./css-images";
import { fnv8 } from "./hash";
import type { CaptureDraft } from "./index";
import { CAPTURE_LIMITS } from "./limits";

// ── pure helpers (unit-pinned) ─────────────────────────────────────────────

/** A parsed `@font-face` block: its full CSS text + the resolved absolute src URLs. */
export interface ParsedFontFace {
  css: string; // the full "@font-face{ … }" text, verbatim
  urls: string[]; // absolute `src` url()s, in declaration order
  base: string; // the declaring sheet's base URL — src url()s resolve against THIS (gpt56-5)
}

/** One stylesheet (or spliced @import) as ordered CSS text + the base its url()s resolve against. */
export interface CssSegment {
  text: string;
  base: string;
  media?: string; // a media condition wrapping an @import'd sheet, if any (A18)
}

const FONT_FACE_RE = /@font-face\s*\{[^}]*\}/gi;
// Captures the import target (url() form → g2, bare-string form → g4) and any
// trailing media-query text (g5) up to the `;`, so a conditional import wraps.
const IMPORT_RE = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)\s*([^;]*);/gi;

/** Resolve a possibly-relative URL against a base; null if unparseable. */
export function absoluteUrl(raw: string, base: string): string | null {
  try {
    return new URL(raw.trim(), base).href;
  } catch {
    return null;
  }
}

/** The origin of an absolute URL (for grant-check + declined-grant metering). */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/**
 * Extract every `@font-face` block and its resolved absolute `src` URLs. `data:`
 * srcs are dropped from the URL list (they inline verbatim, need no fetch) but
 * the block text keeps them. Preserves the block verbatim so `unicode-range` /
 * `font-weight` / `font-style` descriptors survive (multi-face families resolve).
 */
export function extractFontFaces(css: string, base: string): ParsedFontFace[] {
  const out: ParsedFontFace[] = [];
  for (const m of css.matchAll(FONT_FACE_RE)) {
    const block = m[0];
    const urls: string[] = [];
    rewriteImageUrls(block, (raw, whole) => {
      if (raw && !raw.startsWith("data:")) {
        const abs = absoluteUrl(raw, base);
        if (abs) urls.push(abs);
      }
      return whole;
    });
    out.push({ css: block, urls, base });
  }
  return out;
}

/** The author CSS with every `@font-face` block removed (they live in #oc-fonts). */
export function stripFontFaces(css: string): string {
  return css.replace(FONT_FACE_RE, "");
}

/**
 * Split off top-level `@import` rules: returns the imported targets (RAW url +
 * any media condition, resolved by the caller against each segment's own base)
 * and the CSS with those `@import` statements removed. Splicing the imported text
 * back inline at its position (A18) is the orchestrator's job — a literal
 * `@import url(…)` left in `oc-author` would be a live external ref the render
 * scrub strips on every variant render, falsifying the "non-zero strippedUrls =
 * capture bug" invariant.
 */
export function parseImports(css: string): {
  imports: { url: string; media: string }[];
  rest: string;
} {
  const imports: { url: string; media: string }[] = [];
  const rest = css.replace(IMPORT_RE, (_full, _q1, u1, _q2, u2, media) => {
    const raw = (u1 ?? u2 ?? "").trim();
    if (raw) imports.push({ url: raw, media: (media ?? "").trim() });
    return "";
  });
  return { imports, rest };
}

/**
 * Expand a segment's top-level `@import`s into ordered sub-segments — the
 * imported rules FIRST (forward document order, each carrying its OWN base URL +
 * media condition), then the segment's own body. Cycle-guarded (`seen`) and
 * depth-capped. Fixes A18/gpt56-5: the earlier code prepended fetched text
 * (reverse order), dropped media conditions, and resolved every url() against one
 * global base.
 */
export async function expandImports(
  seg: CssSegment,
  depth: number,
  fetchText: (url: string) => Promise<string | null>,
  seen: Set<string>,
): Promise<CssSegment[]> {
  const { imports, rest } = parseImports(seg.text);
  const body: CssSegment = {
    text: rest,
    base: seg.base,
    ...(seg.media ? { media: seg.media } : {}),
  };
  if (imports.length === 0 || depth >= CAPTURE_LIMITS.MAX_IMPORT_DEPTH) return [body];
  const out: CssSegment[] = [];
  for (const imp of imports) {
    const abs = absoluteUrl(imp.url, seg.base);
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    const fetched = await fetchText(abs);
    if (fetched === null) continue; // fetchText already metered the loss
    const media = [seg.media, imp.media].filter(Boolean).join(" and ") || undefined;
    out.push(
      ...(await expandImports(
        { text: fetched, base: abs, ...(media ? { media } : {}) },
        depth + 1,
        fetchText,
        seen,
      )),
    );
  }
  out.push(body);
  return out;
}

/**
 * Rewrite every non-`data:` asset `url()` in author CSS to `url({{asset:<ref>}})`
 * (every image form — `src()`, the strings of `image-set()` and `image()` — is
 * first put into `url()`, C-3),
 * routing each absolute URL through `refFor` (which records it for fetch). A URL
 * `refFor` declines (null) is left verbatim for the render scrub to strip+meter.
 * Gradients / `data:` URIs pass through untouched.
 */
export function rewriteAssetUrls(
  css: string,
  base: string,
  refFor: (absUrl: string) => string | null,
  /** "none": a URL `refFor` declines points at nothing instead of staying verbatim. */
  declined: "verbatim" | "none" = "verbatim",
): string {
  // The one quote-aware scan the walker uses too (2-C2).
  return rewriteImageUrls(css, (t, whole) => {
    // An empty target names nothing: never resolved to the page's own URL (3-C3).
    if (!t) return declined === "none" ? "none" : whole;
    if (t.startsWith("#")) return whole;
    if (t.startsWith("data:")) return declined === "none" ? "none" : whole;
    const abs = absoluteUrl(t, base);
    if (!abs) return declined === "none" ? "none" : whole;
    const ref = refFor(abs);
    if (ref) return `url({{asset:${ref}}})`;
    return declined === "none" ? "none" : whole;
  });
}

/**
 * Reconstruct the `#oc-fonts` sheet from parsed faces: each block's fetched src
 * url()s are rewritten to `url({{font:<ref>}})` via `refOf` (null → that url is
 * dropped). A face whose every src dropped is omitted entirely.
 */
export function buildFontsSheet(
  faces: ParsedFontFace[],
  refOf: (absUrl: string) => string | null,
): string {
  const blocks: string[] = [];
  for (const face of faces) {
    let anySrc = false;
    const rewritten = rewriteImageUrls(face.css, (t, whole) => {
      if (!t) return whole; // names nothing (3-C3)
      if (t.startsWith("data:")) {
        anySrc = true;
        return whole;
      }
      const abs = absoluteUrl(t, face.base); // resolve against the declaring sheet's base
      const ref = abs ? refOf(abs) : null;
      if (!ref) return whole; // unresolved src token left as-is (render scrub drops it)
      anySrc = true;
      return `url({{font:${ref}}})`;
    });
    if (anySrc) blocks.push(rewritten);
  }
  return blocks.join("\n");
}

/**
 * Replace the walker's empty `<style id="oc-fonts"></style>` body with the
 * reconstructed @font-face rules. Re-parse + re-serialize via `outerHTML` (never
 * XMLSerializer — it entity-escapes `<style>` raw text; proto Q8). A no-op when
 * `fontsCss` is empty or no `#oc-fonts` node exists.
 */
export function injectFontsSheet(documentHtml: string, fontsCss: string): string {
  if (!fontsCss) return documentHtml;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(documentHtml, "text/html");
  } catch {
    return documentHtml;
  }
  const fonts = doc.getElementById("oc-fonts");
  if (!fonts) return documentHtml;
  fonts.textContent = fontsCss;
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

// ── the transport contract + orchestrator ──────────────────────────────────

/** One fetched body: bytes + the advisory content-type (MIME is by-magic at consume, §4). */
export type FetchBytes = { bytes: Uint8Array; mime: string };
/** The SW cross-origin leg result — mirrors sw.ts `handleHarvestFetch`. */
export type SwFetchResult =
  | { ok: true; bytes: Uint8Array; mime: string }
  | { ok: false; reason: "declined-grant" | "blocked" | "error" | "too-large" };

export interface HarvestDeps {
  doc?: Document;
  baseUrl?: string;
  /** Read a same-origin sheet's cssRules text; null when unreadable (cross-origin). */
  sheetText?: (sheet: CSSStyleSheet) => string | null;
  /** Enumerate the sheets to harvest (test seam; default = document.styleSheets + adopted). */
  sheets?: () => CSSStyleSheet[];
  /** Open shadow roots in-scope whose constructed sheets are EXCLUDED (D14). */
  shadowSheets?: () => number;
  /** Credentialed same-origin content fetch (D15). */
  sameOriginFetch?: (url: string) => Promise<FetchBytes | null>;
  /** Privileged cross-origin fetch via the SW harvest leg (grant-gated). */
  swFetch?: (url: string) => Promise<SwFetchResult>;
}

/** Default SW cross-origin fetch — one `harvestFetch` runtime round-trip. */
async function defaultSwFetch(url: string): Promise<SwFetchResult> {
  try {
    const r = (await chrome.runtime.sendMessage({
      type: "harvestFetch",
      url,
      origin: originOf(url),
    })) as { ok?: boolean; b64?: string; mime?: string; reason?: string } | undefined;
    if (r?.ok && typeof r.b64 === "string") {
      return { ok: true, bytes: base64ToBytes(r.b64), mime: r.mime ?? "application/octet-stream" };
    }
    const reason = r?.reason;
    if (reason === "declined-grant" || reason === "blocked" || reason === "too-large") {
      return { ok: false, reason };
    }
    return { ok: false, reason: "error" };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/** Default credentialed same-origin fetch from the content context (D15). */
async function defaultSameOriginFetch(url: string): Promise<FetchBytes | null> {
  try {
    const res = await fetch(url, { credentials: "same-origin", cache: "force-cache" });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > LIMITS_MAX_PART_BYTES) return null;
    const mime =
      res.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
    return { bytes: new Uint8Array(buf), mime };
  } catch {
    return null;
  }
}

// Kept local so the pure helpers file has no protocol import churn; mirrors
// LIMITS.MAX_CAPTURE_PART_BYTES (5 MiB) the SW leg also enforces.
const LIMITS_MAX_PART_BYTES = 5 * 1024 * 1024;

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Enumerate the document + document-level constructed sheets (NOT shadow ones, D14). */
function defaultSheets(doc: Document): CSSStyleSheet[] {
  const out: CSSStyleSheet[] = [];
  for (const s of Array.from(doc.styleSheets)) out.push(s as CSSStyleSheet);
  const adopted = (doc as unknown as { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets;
  if (Array.isArray(adopted)) out.push(...adopted);
  return out;
}

/** Read a same-origin sheet's rules as text; null on the cross-origin SecurityError. */
function defaultSheetText(sheet: CSSStyleSheet): string | null {
  try {
    let text = "";
    for (const rule of Array.from(sheet.cssRules)) text += `${rule.cssText}\n`;
    return text;
  } catch {
    return null;
  }
}

/** Count in-scope open shadow roots carrying constructed sheets (excluded → D14 meter). */
function defaultShadowSheets(block: Element): number {
  let n = 0;
  const seen = new Set<Element>();
  const visit = (el: Element): void => {
    if (seen.has(el)) return;
    seen.add(el);
    const root = (el as unknown as { shadowRoot?: ShadowRoot | null }).shadowRoot;
    const adopted = root
      ? (root as unknown as { adoptedStyleSheets?: unknown[] }).adoptedStyleSheets
      : undefined;
    if (Array.isArray(adopted) && adopted.length > 0) n += 1;
    for (const child of Array.from(el.children)) visit(child);
    if (root) for (const child of Array.from(root.children)) visit(child);
  };
  try {
    visit(block);
  } catch {
    /* defensive — a hostile getter */
  }
  return n;
}

/**
 * Run the harvest against the live document, mutating the draft (fonts sheet,
 * authorsheet, font+asset parts, residue). Fail-soft throughout: any leg that
 * fails degrades to metered residue, never an exception. `deps` are injectable
 * so the orchestration is unit-testable without `chrome.*` / real stylesheets.
 */
export async function harvest(draft: CaptureDraft, deps: HarvestDeps = {}): Promise<void> {
  const doc = deps.doc ?? (typeof document !== "undefined" ? document : undefined);
  if (!doc) return;
  const base = deps.baseUrl ?? doc.baseURI ?? "http://localhost/";
  const swFetch = deps.swFetch ?? defaultSwFetch;
  const sameOriginFetch = deps.sameOriginFetch ?? defaultSameOriginFetch;
  const sheetText = deps.sheetText ?? defaultSheetText;
  const enumerate = deps.sheets ?? (() => defaultSheets(doc));
  const shadowCount = deps.shadowSheets ?? (() => defaultShadowSheets(draft.block));

  // D14 — shadow-root constructed sheets are excluded from the doc authorsheet;
  // their class-conditional variant fidelity is lost, metered once.
  if (shadowCount() > 0) draft.residue.add("shadow-scoped-rules");

  // ── 1. gather author CSS as ordered {text, base} segments (cascade order) ──
  // Each sheet becomes a segment carrying its OWN base URL, in document order, so
  // the cascade is preserved (a cross-origin <link> that precedes a same-origin
  // sheet no longer sorts after it) and every relative font/asset url() resolves
  // against the sheet that declared it — a cross-origin webfont CSS resolves its
  // `src` against the CDN, not the page (the real-webfont fidelity fix). gpt56-5.
  const pageOrigin = originOf(base);

  /**
   * Fetch a stylesheet's TEXT: same-page-origin credentialed from content (so a
   * `localhost` dev page keeps its own imports/links), else the grant-gated SW
   * leg. Metered on failure so an @import/link loss is never silent
   * (`declined-grant` vs `unfetchable-asset` — closes fable-7).
   */
  const fetchCssText = async (url: string): Promise<string | null> => {
    if (originOf(url) === pageOrigin) {
      const got = await sameOriginFetch(url);
      if (got) return new TextDecoder("utf-8").decode(got.bytes);
      draft.residue.add("unfetchable-asset", { detail: originOf(url) });
      return null;
    }
    const r = await swFetch(url);
    if (r.ok) return new TextDecoder("utf-8").decode(r.bytes);
    if (r.reason === "declined-grant") draft.residue.declinedGrant(originOf(url));
    else draft.residue.add("unfetchable-asset", { detail: originOf(url) });
    return null;
  };

  const rawSegments: CssSegment[] = [];
  for (const sheet of enumerate()) {
    const text = sheetText(sheet);
    const href = (sheet as CSSStyleSheet).href;
    if (text !== null) {
      rawSegments.push({ text, base: href ?? base });
      continue;
    }
    if (!href) continue; // cross-origin inline with no href — unreadable, nothing to fetch
    const fetched = await fetchCssText(href);
    if (fetched !== null) rawSegments.push({ text: fetched, base: href });
  }

  // ── 2. expand @imports in place — forward order, per-import base + media (A18) ──
  const seenImports = new Set<string>();
  const segments: CssSegment[] = [];
  for (const seg of rawSegments) {
    segments.push(...(await expandImports(seg, 0, fetchCssText, seenImports)));
  }

  // ── D13 part/byte budget (fonts first, then assets) ──────────────────────
  // Reserve the slots the assembler adds later — document + a possible
  // authorsheet — on top of whatever the witness already staged, then admit
  // fonts first (most perceptual weight; dedup across captures) and assets next,
  // STOPPING once the budget (part count, total bytes, or a hard fetch-attempt
  // cap) is spent. Without this, author CSS enumerating thousands of `url()`s
  // turns one Edit into an unbounded privileged-fetch storm + unbounded draft
  // memory, and a >12-part page 400s the whole manifest at init — the capability
  // silently absent on exactly the asset-rich pages it targets. Every drop meters
  // `oversize-truncation` (surfacing the "A large block was trimmed to fit." copy).
  const RESERVED_SLOTS = 2; // document + (possible) authorsheet, added at assemble
  const MAX_FETCH_ATTEMPTS = LIMITS.MAX_CAPTURE_PARTS * 4; // bound the privileged-fetch storm
  const DOC_BYTE_RESERVE = 1024 * 1024; // headroom for the gzipped doc + authorsheet
  let partBudget = LIMITS.MAX_CAPTURE_PARTS - draft.parts.length - RESERVED_SLOTS;
  let byteBudget =
    LIMITS.MAX_CAPTURE_TOTAL_BYTES -
    draft.parts.reduce((n, p) => n + p.bytes.byteLength, 0) -
    DOC_BYTE_RESERVE;
  let attempts = 0;
  let budgetTruncated = false;
  /** Reserve one part slot + `len` bytes; false (and marks truncation) when the budget can't hold it. */
  const reserve = (len: number): boolean => {
    if (partBudget <= 0 || len > byteBudget) {
      budgetTruncated = true;
      return false;
    }
    partBudget -= 1;
    byteBudget -= len;
    return true;
  };
  /** True while the budget still has room AND we're under the hard fetch-attempt cap. */
  const canFetch = (): boolean => partBudget > 0 && attempts < MAX_FETCH_ATTEMPTS;

  // ── 3. @font-face → fetch bytes → font parts → #oc-fonts sheet ──
  // Faces harvested per segment so each src resolves against its own base.
  const faces: ParsedFontFace[] = [];
  for (const seg of segments) faces.push(...extractFontFaces(seg.text, seg.base));
  const fontRef = new Map<string, string | null>(); // absUrl → ref (null = unfetchable/over-budget)
  for (const face of faces) {
    for (const url of face.urls) {
      if (fontRef.has(url)) continue;
      if (!canFetch()) {
        budgetTruncated = true;
        fontRef.set(url, null);
        continue;
      }
      attempts += 1;
      const bytes = await fetchAsset(url, base, swFetch, sameOriginFetch, draft);
      if (!bytes) {
        fontRef.set(url, null);
        continue;
      }
      // F32 — the server's 415 gate, mirrored BEFORE upload: a part whose bytes
      // aren't an admissible font would refuse the WHOLE two-phase upload.
      // Refusing it here degrades honestly instead (the face falls back live).
      const fontMime = captureFontMimeOf(bytes.bytes);
      if (!fontMime || !reserve(bytes.bytes.byteLength)) {
        if (!fontMime) draft.residue.add("unfetchable-asset", { detail: originOf(url) });
        fontRef.set(url, null);
        continue;
      }
      const ref = fnv8(url);
      fontRef.set(url, ref);
      draft.parts.push({ name: `font-${ref}`, role: "font", mime: fontMime, bytes: bytes.bytes });
    }
  }
  const fontsCss = buildFontsSheet(faces, (u) => fontRef.get(u) ?? null);
  draft.documentHtml = injectFontsSheet(draft.documentHtml, fontsCss);

  // ── 4. asset url()s: walker refs + author-CSS backgrounds, one part each ──
  // The ref IS fnv8(absUrl) so the walker's inline `{{asset:<ref>}}` placeholders
  // and any author-CSS background collapse onto one content-addressed part. Each
  // segment's url()s resolve against ITS base, then wrap in the segment's media
  // condition — the authorsheet is concatenated in cascade order (gpt56-5).
  // Image bytes come only from the chosen block (3b-C7): the walker recorded
  // what nodes INSIDE it use. Page-wide author CSS adds no image of its own —
  // a url() there keeps its part only when it is one of those, and otherwise
  // points at nothing.
  const assetUrlByRef = new Map<string, string>(); // ref → absUrl (to fetch)
  for (const a of draft.assetRefs) assetUrlByRef.set(a.ref, a.url);
  const refFor = (abs: string): string | null => {
    const ref = fnv8(abs);
    return assetUrlByRef.has(ref) ? ref : null;
  };
  const authorPieces: string[] = [];
  for (const seg of segments) {
    const rewritten = rewriteAssetUrls(stripFontFaces(seg.text), seg.base, refFor, "none");
    if (!rewritten.trim()) continue;
    authorPieces.push(seg.media ? `@media ${seg.media} {\n${rewritten}\n}` : rewritten);
  }
  const authorCombined = authorPieces.join("\n");
  draft.authorsheet = authorCombined.trim() ? authorCombined : null;

  for (const [ref, url] of assetUrlByRef) {
    if (draft.parts.some((p) => p.name === `asset-${ref}`)) continue;
    if (!canFetch()) {
      budgetTruncated = true;
      break; // budget/attempt cap spent — over-budget refs strip at render, metered below
    }
    attempts += 1;
    const bytes = await fetchAsset(url, base, swFetch, sameOriginFetch, draft);
    if (!bytes) continue;
    // F32 — mirror of the server's raster gate: only png/jpeg/gif/webp bytes
    // UNDER the pixel cap are admissible as asset parts (an SVG background is
    // ACTIVE content the server rightly 415s — seen live on webawesome.com,
    // where one such part killed the whole edit-context upload; an over-cap
    // raster draws the same 415 as `image-too-large`). Drop it, meter it,
    // keep the capture.
    const img = captureImageInfoOf(bytes.bytes);
    if (
      !img ||
      (img.width !== undefined &&
        img.height !== undefined &&
        img.width * img.height > LIMITS.MAX_CAPTURE_IMAGE_PIXELS)
    ) {
      draft.residue.add("unfetchable-asset", { detail: originOf(url) });
      continue;
    }
    if (!reserve(bytes.bytes.byteLength)) continue;
    draft.parts.push({
      name: `asset-${ref}`,
      role: "asset",
      mime: img.mime,
      bytes: bytes.bytes,
    });
  }

  if (budgetTruncated) draft.residue.add("oversize-truncation");
}

/**
 * Fetch one asset/font URL, routing by origin (D15): same-origin → credentialed
 * content fetch; cross-origin → the grant-gated SW leg. Metered on failure:
 * `declined-grant:<origin>` for a missing grant, `unfetchable-asset` otherwise.
 */
async function fetchAsset(
  url: string,
  base: string,
  swFetch: (url: string) => Promise<SwFetchResult>,
  sameOriginFetch: (url: string) => Promise<FetchBytes | null>,
  draft: CaptureDraft,
): Promise<FetchBytes | null> {
  const sameOrigin = originOf(url) === originOf(base);
  if (sameOrigin) {
    const got = await sameOriginFetch(url);
    if (!got) draft.residue.add("unfetchable-asset", { detail: originOf(url) });
    return got;
  }
  const r = await swFetch(url);
  if (r.ok) return { bytes: r.bytes, mime: r.mime };
  if (r.reason === "declined-grant") draft.residue.declinedGrant(originOf(url));
  else draft.residue.add("unfetchable-asset", { detail: originOf(url) });
  return null;
}
