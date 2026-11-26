// Placeholder → data: URI assembly + gunzip, for the portable renderer.
// Pure over a parsed Document + an injected part-fetcher: no chrome.*, no live
// DOM beyond the standard `DecompressionStream`/`TextDecoder`/`btoa` the PWA
// shares (render spec §1.2 steps 6-8, R1/R2). Part names resolve by EXACT
// equality against the placeholder suffix — `{{font:<sha8>}}` ↔ part
// `font-<sha8>`, no full-sha fallback (render §1.2 step 7, capture D11/F1).

import type { CaptureRef } from "@onlay/protocol";

/** A `{{font:<sha>}}` / `{{asset:<sha>}}` reference; sha is 8/12/16 hex. */
const TOKEN_RE = /\{\{(font|asset):([0-9a-f]{8,64})\}\}/g;

/**
 * The decompressed-output ceiling for a single gzipped capture part (gpt56-3).
 * The server caps only the COMPRESSED bytes (5 MiB) and checks gzip magic, so a
 * highly-compressible hostile document/authorsheet can commit within that cap yet
 * expand without bound at render — a decompression bomb that OOMs any participant
 * who opens rung 1. 32 MiB is far above a real flattened block (~200 KiB raw,
 * §1.2) while bounding the blast radius; over it, `gunzip` rejects and the
 * renderer falls back to its minimal honest srcdoc.
 */
const MAX_GUNZIP_BYTES = 32 * 1024 * 1024;

/**
 * Gunzip a stored capture part (`application/gzip`) to a UTF-8 string via the
 * Web-standard `DecompressionStream` (R2 — no bundled inflate; present in the
 * extension page and the Stage-3 PWA alike). Streams with a hard output cap so a
 * decompression bomb aborts instead of exhausting memory. Rejects on a corrupt
 * stream OR an over-cap expansion, which the renderer catches into its minimal
 * honest srcdoc.
 */
export async function gunzip(bytes: Uint8Array, cap: number = MAX_GUNZIP_BYTES): Promise<string> {
  const gzipped = new Response(bytes as unknown as BodyInit).body;
  if (!gzipped) throw new Error("gunzip: empty stream");
  const reader = gzipped.pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new Error("gunzip: output exceeds cap");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(out);
}

/** Encode bytes to a `data:<mime>;base64,…` URI (chunked to survive big fonts). */
export function bytesToDataUri(bytes: Uint8Array, mime: string): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

/** The part name a placeholder token addresses, or null if malformed. */
export function partNameForToken(token: string): string | null {
  const m = /^\{\{(font|asset):([0-9a-f]{8,64})\}\}$/.exec(token);
  return m ? `${m[1]}-${m[2]}` : null;
}

/**
 * The bounds of the whole CSS declaration containing the span `[start,end)`:
 * from just after the preceding `;`/`{` through the terminating `;` (inclusive)
 * or up to the closing `}` (exclusive). Used to drop a declaration whose only
 * asset/font never arrived, so no empty/live `url()` survives (§1.2 step 8).
 * Exported so the render scrub reuses one declaration-removal core.
 */
export function declarationBounds(
  css: string,
  start: number,
  end: number,
): { from: number; to: number } {
  let from = start;
  while (from > 0 && css[from - 1] !== ";" && css[from - 1] !== "{" && css[from - 1] !== "}") {
    from -= 1;
  }
  let to = end;
  while (to < css.length && css[to] !== ";" && css[to] !== "}") {
    to += 1;
  }
  if (css[to] === ";") to += 1;
  return { from, to };
}

type Resolve = (token: string) => string | null;

/** Rewrite `{{…}}` tokens in one CSS text: substitute resolved data: URIs,
 *  drop the enclosing declaration when a token resolves null. */
function rewriteCssPlaceholders(css: string, resolve: Resolve): { text: string; stripped: number } {
  let working = css;
  let cursor = 0;
  let stripped = 0;
  for (;;) {
    const re = new RegExp(TOKEN_RE.source);
    const m = re.exec(working.slice(cursor));
    if (!m) break;
    const idx = cursor + m.index;
    const token = m[0];
    const uri = resolve(token);
    if (uri !== null) {
      working = working.slice(0, idx) + uri + working.slice(idx + token.length);
      cursor = idx + uri.length;
    } else {
      const { from, to } = declarationBounds(working, idx, idx + token.length);
      working = working.slice(0, from) + working.slice(to);
      stripped += 1;
      cursor = from;
    }
  }
  return { text: working, stripped };
}

/**
 * Fetch every unique placeholder's bytes once (cached by part name via the
 * injected `fetchPart`), then substitute `data:` URIs into the parsed doc's
 * `<style>` sheets and element attributes — stripping any placeholder whose
 * bytes never arrived (declined grant / fetch failure / unknown part) so no
 * live external URL is left to beacon. Returns the strip tally.
 */
export async function inlinePlaceholders(
  doc: Document,
  ref: CaptureRef,
  fetchPart: (name: string) => Promise<Uint8Array | null>,
): Promise<{ stripped: number }> {
  const tokens = new Set<string>();
  for (const style of doc.querySelectorAll("style")) {
    for (const m of (style.textContent ?? "").matchAll(TOKEN_RE)) tokens.add(m[0]);
  }
  for (const el of doc.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      if (attr.value.includes("{{"))
        for (const m of attr.value.matchAll(TOKEN_RE)) tokens.add(m[0]);
    }
  }

  const resolved = new Map<string, string | null>();
  for (const token of tokens) {
    const partName = partNameForToken(token);
    const part = partName ? ref.parts.find((p) => p.name === partName) : undefined;
    if (!partName || !part) {
      resolved.set(token, null);
      continue;
    }
    const bytes = await fetchPart(partName);
    resolved.set(token, bytes ? bytesToDataUri(bytes, part.mime) : null);
  }
  const resolve: Resolve = (token) => resolved.get(token) ?? null;

  let stripped = 0;
  for (const style of doc.querySelectorAll("style")) {
    const text = style.textContent ?? "";
    if (!text.includes("{{")) continue;
    const out = rewriteCssPlaceholders(text, resolve);
    style.textContent = out.text;
    stripped += out.stripped;
  }
  for (const el of doc.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      if (!attr.value.includes("{{")) continue;
      const matches = [...attr.value.matchAll(TOKEN_RE)];
      const nulls = matches.filter((m) => resolve(m[0]) === null);
      if (nulls.length > 0) {
        el.removeAttribute(attr.name);
        stripped += nulls.length;
        continue;
      }
      let value = attr.value;
      for (const m of matches) value = value.split(m[0]).join(resolve(m[0]) as string);
      el.setAttribute(attr.name, value);
    }
  }
  return { stripped };
}
