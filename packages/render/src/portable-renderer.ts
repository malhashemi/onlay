// The portable renderer (render spec §1). Turns a committed edit-context capture
// into a self-contained, scriptless, offline `srcdoc` string for a `sandbox=""`
// iframe. Pure and PWA-importable (R1): no chrome.*, no live-DOM globals beyond
// `DOMParser`/`TextDecoder`/`DecompressionStream`/`btoa`; the only environment
// difference — how bytes are fetched — is the injected `fetchPart` callback.
//
// Computed-style flattening (the `oc-base` sheet baked at capture) is the
// PRIMARY renderer; the harvested authorsheet is appended ONLY in variant mode
// to resolve class/attr rules (§1.5). Every layer of the isolation stack is
// re-asserted here: active content is re-stripped (defense-in-depth), external
// URLs are scrubbed + metered, and the document carries its own meta-CSP.

import type { CaptureRef, MutationProgram } from "@onlay/protocol";
import { classAttrTokens, gateAuthorsheet } from "./authorsheet";
import { gunzip, inlinePlaceholders } from "./inline";
import { applyProgramToRoot } from "./preview-engine";
import { scrubExternalUrls } from "./scrub";

export interface BuildSrcdocInput {
  /** The edit-context capture (part list + declared mimes live here). */
  ref: CaptureRef;
  /** Injected transport: SW base64 proxy in the extension, same-origin fetch in the PWA. */
  fetchPart: (name: string) => Promise<Uint8Array | null>;
  /** Absent → the Original; present → a variant program to pre-apply. */
  program?: MutationProgram;
}

export interface RenderResidue {
  /** `{{font|asset}}` whose bytes never arrived → declaration/attr removed. */
  strippedPlaceholders: number;
  /** Residual external url()/src/@import scrubbed at render (§1.6). */
  strippedUrls: number;
  /** Program toggles a class/attr but no covering authorsheet (§1.5). */
  authorRulesMissing: boolean;
  /** The surviving preview-engine miss-tally. */
  applied: number;
  misses: number;
  rejected: number;
}

export interface BuildSrcdocResult {
  srcdoc: string;
  residue: RenderResidue;
  /** True when this is the minimal honest failure page, NOT a reconstruction —
   *  its zero-residue must never read as "clean evidence" (F30 sol-13: the
   *  rung verdict treats a failed render as render-unavailable, never rung 3). */
  failed?: boolean;
}

/** The in-frame egress wall the capture stage emits; re-asserted on fallbacks. */
const META_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

const HONEST_MESSAGE = "This capture couldn't be rendered — compare with the captured screenshot.";

/** Elements whose content is code/foreign-document — dropped defense-in-depth. */
const DROP_ELEMENTS = new Set([
  "script",
  "link",
  "iframe",
  "object",
  "embed",
  "noscript",
  "template",
]);
/** Attributes that carry a URL a `javascript:` value could hide in. */
const URL_ATTRS = new Set(["href", "src", "xlink:href", "formaction", "action", "poster"]);

function emptyResidue(): RenderResidue {
  return {
    strippedPlaceholders: 0,
    strippedUrls: 0,
    authorRulesMissing: false,
    applied: 0,
    misses: 0,
    rejected: 0,
  };
}

/** A minimal inert srcdoc inside the CSP frame — never throws for content reasons. */
function minimalSrcdoc(): BuildSrcdocResult {
  const srcdoc =
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${META_CSP}">` +
    `</head><body><p>${HONEST_MESSAGE}</p></body></html>`;
  return { srcdoc, residue: emptyResidue(), failed: true };
}

function isJavascriptUrl(value: string): boolean {
  let i = 0;
  while (i < value.length && value.charCodeAt(i) <= 0x20) i += 1;
  return /^javascript:/i.test(value.slice(i));
}

/**
 * Re-assert the scriptless invariant over the parsed doc: drop any
 * script/link/iframe/object/embed and any non-`oc-*` `<style>`, strip `on*`
 * handlers and `javascript:` URLs. A no-op on a well-formed capture (capture
 * already strips active content), but a corrupted/hostile document part must
 * not smuggle live content past the parse.
 */
function stripActiveContent(doc: Document): void {
  for (const el of [...doc.querySelectorAll("*")]) {
    const tag = el.localName.toLowerCase();
    if (DROP_ELEMENTS.has(tag)) {
      el.remove();
      continue;
    }
    if (tag === "style" && !(el.getAttribute("id") ?? "").startsWith("oc")) {
      el.remove();
      continue;
    }
    // Keep only `<meta charset>` — drop any `http-equiv` meta (a hostile
    // document part's `<meta http-equiv="refresh">` would navigate the frame:
    // `sandbox=""` does not block self-navigation, and `default-src` does not
    // govern it). The canonical CSP meta is re-injected fresh below.
    if (tag === "meta" && !el.hasAttribute("charset")) {
      el.remove();
      continue;
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (URL_ATTRS.has(name) && isJavascriptUrl(attr.value)) el.removeAttribute(attr.name);
    }
  }
}

/**
 * Force the exact Stage-1 meta-CSP into `<head>`, replacing whatever the
 * document part carried (or supplying it when absent). The in-frame
 * `default-src 'none'` CSP is a non-negotiable of the isolation stack — the
 * renderer must never trust the untrusted document part to carry it correctly.
 */
function enforceMetaCsp(doc: Document): void {
  const head = doc.head ?? doc.documentElement;
  for (const m of [...doc.querySelectorAll("meta[http-equiv]")]) {
    if ((m.getAttribute("http-equiv") ?? "").toLowerCase() === "content-security-policy")
      m.remove();
  }
  const meta = doc.createElement("meta");
  meta.setAttribute("http-equiv", "Content-Security-Policy");
  meta.setAttribute("content", META_CSP);
  head.insertBefore(meta, head.firstChild);
}

/**
 * Neutralize the raw-text end sequence in every `<style>` so serialization is
 * round-trippable and can never smuggle a tag. HTML `<style>`/`<script>` bodies
 * are NOT entity-escaped by `outerHTML`, so untrusted CSS (the harvested
 * authorsheet) containing `</style><script>…` would re-parse as a real
 * `<script>` in the srcdoc. `</` never occurs in valid CSS except inside a
 * string/`content` value, where `<\/` is an equivalent escape — so replacing it
 * preserves CSS semantics while defeating the parser's end-tag scan.
 */
function neutralizeStyleRawText(doc: Document): void {
  for (const style of doc.querySelectorAll("style")) {
    const text = style.textContent ?? "";
    if (text.includes("</")) style.textContent = text.replace(/<\//g, "<\\/");
  }
}

/** Append the harvested authorsheet as `<style id="oc-author">` after `oc-base`. */
function appendAuthorsheet(doc: Document, text: string): void {
  const style = doc.createElement("style");
  style.id = "oc-author";
  style.textContent = text;
  const base = doc.getElementById("oc-base");
  if (base?.parentNode) {
    base.parentNode.insertBefore(style, base.nextSibling);
  } else {
    (doc.head ?? doc.documentElement).appendChild(style);
  }
}

/**
 * Build the self-contained srcdoc. Never throws for content reasons — a missing
 * document part, a failed gunzip, or a parse failure returns the minimal honest
 * srcdoc + zero residue so the stage always has something inert to mount. Throws
 * only on a programmer contract violation (null `ref`).
 */
export async function buildSrcdoc(input: BuildSrcdocInput): Promise<BuildSrcdocResult> {
  const { ref, fetchPart, program } = input;
  if (ref == null) throw new Error("buildSrcdoc: ref is required");

  // Cache bytes per part name so a font shared across placeholders (or the
  // authorsheet fetched for gating and inlining) is fetched once.
  const cache = new Map<string, Promise<Uint8Array | null>>();
  const cachedFetch = (name: string): Promise<Uint8Array | null> => {
    let pending = cache.get(name);
    if (!pending) {
      pending = fetchPart(name);
      cache.set(name, pending);
    }
    return pending;
  };

  const docBytes = await cachedFetch("document");
  if (!docBytes) return minimalSrcdoc();

  let html: string;
  try {
    html = await gunzip(docBytes);
  } catch {
    return minimalSrcdoc();
  }

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return minimalSrcdoc();
  }
  if (!doc?.documentElement || doc.querySelector("parsererror")) return minimalSrcdoc();

  const residue = emptyResidue();
  stripActiveContent(doc);
  enforceMetaCsp(doc);

  if (program !== undefined) {
    const blockRoot = doc.querySelector("[data-oc-block]");
    if (blockRoot) {
      const applied = applyProgramToRoot(blockRoot, program);
      residue.applied = applied.applied;
      residue.misses = applied.misses;
      residue.rejected = applied.rejected;
    } else {
      residue.misses = program.length;
    }

    const { classTokens, attrKeys } = classAttrTokens(program);
    if (classTokens.length > 0 || attrKeys.length > 0) {
      let authorsheetText: string | null = null;
      if (ref.parts.some((p) => p.name === "authorsheet")) {
        const bytes = await cachedFetch("authorsheet");
        if (bytes) {
          try {
            authorsheetText = await gunzip(bytes);
          } catch {
            authorsheetText = null;
          }
        }
      }
      const gate = gateAuthorsheet(program, authorsheetText);
      residue.authorRulesMissing = gate.authorRulesMissing;
      if (gate.append && authorsheetText !== null) appendAuthorsheet(doc, authorsheetText);
    }
  }

  const inlined = await inlinePlaceholders(doc, ref, cachedFetch);
  residue.strippedPlaceholders = inlined.stripped;
  residue.strippedUrls = scrubExternalUrls(doc);
  neutralizeStyleRawText(doc);

  // HTML serialization (R11/A14) — NOT XMLSerializer, which entity-escapes
  // `<style>` raw text and corrupts CSS on re-parse.
  const srcdoc = `<!doctype html>${doc.documentElement.outerHTML}`;
  return { srcdoc, residue };
}
