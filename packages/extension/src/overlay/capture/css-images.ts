// CSS image values, wherever they appear (C-3). An image can enter a CSS value
// through `url()`, through the string form `src()`, and through the image
// functions that take a bare string as a URL: `image-set()` /
// `-webkit-image-set()` and `image()`; `cross-fade()` wraps further images.
// The walker and the harvest only ever rewrite `url()`, so every other form is
// first turned into `url()` (`imagesAsUrls`) or, where no image may travel at
// all (an ancestor's style context, a page-wide custom property), the whole
// image function goes (`withoutImages`).

/** Functions whose value is, or contains, an image reference. */
const IMAGE_FNS = new Set([
  "url",
  "src",
  "image",
  "image-set",
  "-webkit-image-set",
  "cross-fade",
  "-webkit-cross-fade",
]);
/** Functions whose top-level string arguments are URLs. */
const STRING_URL_FNS = new Set(["image", "image-set", "-webkit-image-set"]);

const IMAGE_FN_RE = /(?:^|[^\w-])(?:-webkit-)?(?:url|src|image|image-set|cross-fade)\s*\(/i;

/** A CSS value (or rule text) holds an image reference of any form. */
export function hasImageValue(v: string): boolean {
  return IMAGE_FN_RE.test(v);
}

const isIdent = (c: string | undefined): boolean => c !== undefined && /[\w-]/.test(c);

/** The index just past a quoted string starting at `i` (backslash escapes honoured). */
function stringEnd(s: string, i: number): number {
  const q = s[i];
  let j = i + 1;
  while (j < s.length && s[j] !== q) j += s[j] === "\\" ? 2 : 1;
  return Math.min(s.length, j + 1);
}

/** The index just past a comment starting at `i`. */
function commentEnd(s: string, i: number): number {
  const end = s.indexOf("*/", i + 2);
  return end < 0 ? s.length : end + 2;
}

/** The index just past the `)` that closes the `(` at `open`. */
function closeOf(s: string, open: number): number {
  let depth = 0;
  let j = open;
  while (j < s.length) {
    const c = s[j];
    if (c === '"' || c === "'") {
      j = stringEnd(s, j);
      continue;
    }
    if (c === "/" && s[j + 1] === "*") {
      j = commentEnd(s, j);
      continue;
    }
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
    j += 1;
  }
  return s.length;
}

/**
 * Walk `s`, handing every image function call (outside strings and comments)
 * to `fn` with its lower-cased name, and keeping everything else verbatim.
 */
function mapImageFns(
  s: string,
  fn: (name: string, whole: string, inner: string) => string,
): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (c === '"' || c === "'") {
      const end = stringEnd(s, i);
      out += s.slice(i, end);
      i = end;
      continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      const end = commentEnd(s, i);
      out += s.slice(i, end);
      i = end;
      continue;
    }
    if (c === "\\") {
      out += s.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (isIdent(c) && !isIdent(s[i - 1])) {
      let j = i;
      while (isIdent(s[j])) j += 1;
      const name = s.slice(i, j).toLowerCase();
      let k = j;
      while (s[k] === " " || s[k] === "\t" || s[k] === "\n") k += 1;
      if (s[k] === "(" && IMAGE_FNS.has(name)) {
        const end = closeOf(s, k);
        const inner = s.slice(k + 1, Math.max(k + 1, end - 1));
        out += fn(name, s.slice(i, end), inner);
        i = end;
        continue;
      }
      out += s.slice(i, j);
      i = j;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** A `url()`'s argument names a fragment of this same document (`url(#clip)`), not a resource. */
function isFragmentRef(inner: string): boolean {
  const t = inner
    .trim()
    .replace(/^(['"])(.*)\1$/s, "$2")
    .trim();
  return t.startsWith("#");
}

/**
 * The value with every image function call (`url()`, `src()`, `image-set()`,
 * `-webkit-image-set()`, `image()`, `cross-fade()`) turned into `none`: it
 * keeps its gradients and layout, and points at no image. A same-document
 * `url(#id)` (an SVG paint server, clip or filter) is no resource and stays.
 */
export function withoutImages(v: string): string {
  return mapImageFns(v, (name, whole, inner) =>
    name === "url" && isFragmentRef(inner) ? whole : "none",
  );
}

/** Wrap every top-level quoted string of a function's arguments in `url()`. */
function stringsAsUrls(inner: string): string {
  let out = "";
  let depth = 0;
  let i = 0;
  while (i < inner.length) {
    const c = inner[i] as string;
    if (c === '"' || c === "'") {
      const end = stringEnd(inner, i);
      const str = inner.slice(i, end);
      out += depth === 0 ? `url(${str})` : str;
      i = end;
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    out += c;
    i += 1;
  }
  return out;
}

/**
 * The value with every image reference in `url()` form, so the one `url()`
 * rewrite (asset placeholder, or `none`) covers them all: `src("x")` becomes
 * `url("x")` (one with modifiers becomes `none`), and the bare strings of
 * `image-set()`, `-webkit-image-set()` and `image()` become `url("…")`, nested
 * ones (inside `cross-fade()`) included.
 */
export function imagesAsUrls(v: string): string {
  if (!hasImageValue(v)) return v;
  return mapImageFns(v, (name, whole, inner) => {
    if (name === "url") return whole;
    if (name === "src") {
      const t = inner.trim();
      const q = t[0];
      if ((q === '"' || q === "'") && stringEnd(t, 0) === t.length) return `url(${t})`;
      return "none";
    }
    const head = whole.slice(0, whole.indexOf("(") + 1);
    const body = imagesAsUrls(inner);
    return `${head}${STRING_URL_FNS.has(name) ? stringsAsUrls(body) : body})`;
  });
}

/** What a `url()` names: its argument with the quotes off and CSS escapes decoded. */
function urlTarget(inner: string): string {
  let t = inner.trim();
  const q = t[0];
  if ((q === '"' || q === "'") && t.length >= 2 && stringEnd(t, 0) === t.length) t = t.slice(1, -1);
  return t
    .replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n]?|\n|([\s\S]))/g, (_m, hex?: string, ch?: string) => {
      if (hex) {
        const cp = Number.parseInt(hex, 16);
        return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "�";
      }
      return ch ?? "";
    })
    .trim();
}

/**
 * Rewrite every image reference in `css`, in every form (2-C2): each is first
 * put into `url()` form, then every `url()` — found by the same quote-aware
 * scan, so a quoted URL holding `)` or a quote is one reference, whole — is
 * handed to `fn` with what it names and its original text, and replaced by
 * what `fn` returns. Image functions around it (`image-set()`,
 * `cross-fade()`…) keep their shape. The walker's and the harvest's rewrites
 * both go through here.
 */
export function rewriteImageUrls(
  css: string,
  fn: (target: string, whole: string) => string,
): string {
  if (!hasImageValue(css)) return css;
  const visit = (s: string): string =>
    mapImageFns(s, (name, whole, inner) => {
      if (name === "url") return fn(urlTarget(inner), whole);
      const head = whole.slice(0, whole.indexOf("(") + 1);
      return `${head}${visit(inner)})`;
    });
  return visit(imagesAsUrls(css));
}

/**
 * A `url()` for `target` that every CSS reader takes as one token, the
 * renderer's scrub included (it reads a quoted URL to the next matching
 * quote): quoted with a quote the URL does not hold, and any character that
 * would end or escape the string percent-encoded.
 */
export function cssUrl(target: string): string {
  const safe = target.replace(/[\\\n\r]/g, (c) => encodeURIComponent(c));
  if (!safe.includes('"')) return `url("${safe}")`;
  if (!safe.includes("'")) return `url('${safe}')`;
  return `url("${safe.replace(/"/g, "%22")}")`;
}
