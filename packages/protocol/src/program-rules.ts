/**
 * What a mutation program may do, as far as it can be told from the program
 * alone (no page). ONE rule, shared: the preview engine (`@onlay/render`)
 * builds its allowlists and its page-independent refusals from these, and the
 * space checks every posted program with `staticOpRefusal` before it stores
 * it, so the server never answers "ok" for a step the engine refuses on every
 * page. What depends on the page (a target that isn't there, a resource from
 * an origin the page doesn't already load from) only the engine can tell.
 *
 * Pure and DOM-free: this package runs in the Worker, the extension and the
 * web app. The fragment check reads the HTML with a small tokenizer that
 * follows the browser's parser closely enough to be sure; where it can't be
 * sure (foreign content, odd nesting) it lets the step through and the engine
 * decides on the page.
 */
import type { StepRefusalReason } from "./step-refusal";
import type { MutationOp } from "./variant";

/* ── the allowlists ─────────────────────────────────────────────────── */

/** Tags an inserted fragment may hold; anything else is dropped with its content. */
export const FRAGMENT_TAGS: ReadonlySet<string> = new Set([
  "a",
  "abbr",
  "article",
  "aside",
  "b",
  "blockquote",
  "br",
  "button",
  "caption",
  "code",
  "dd",
  "del",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "main",
  "mark",
  "nav",
  "ol",
  "p",
  "pre",
  "s",
  "samp",
  "section",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
  "var",
]);

/** Rule (e): never inserted, whatever the allowlist says now or later. */
export const NEVER_INSERTED: ReadonlySet<string> = new Set([
  "form",
  "input",
  "select",
  "textarea",
  "iframe",
  "object",
  "embed",
  "meta",
  "base",
  "link",
  "style",
  "script",
]);

/** Elements that show something with no content of their own. */
export const VOID_RENDERABLE_TAGS: ReadonlySet<string> = new Set(["br", "hr", "img"]);

const GLOBAL_ATTRS = new Set(["class", "id", "title", "role", "aria-label", "aria-hidden"]);
const TAG_ATTRS = new Map<string, Set<string>>([
  ["a", new Set(["href", "target", "rel"])],
  ["button", new Set(["type", "disabled", "aria-pressed"])],
  ["img", new Set(["src", "alt", "width", "height", "loading", "decoding"])],
  ["td", new Set(["colspan", "rowspan"])],
  ["th", new Set(["colspan", "rowspan", "scope"])],
]);
const URL_ATTRS = new Set(["href", "src", "xlink:href", "formaction", "action", "poster"]);
const ALLOWED_HREF_SCHEMES = new Set(["http", "https", "mailto", "tel"]);
const ALLOWED_SRC_SCHEMES = new Set(["http", "https"]);

/**
 * A `data-*` or `aria-*` name the DOM accepts: letters, digits, `.`, `_` and
 * `-` only, so `setAttribute` can never throw on it (a name with a space, a
 * quote or `=` makes it throw part-way through a program).
 */
const PREFIXED_ATTR = /^(?:data|aria)-[a-z0-9._-]*$/;

/** The attribute allowlist: an element the engine inserts or edits, and the names it may carry. */
export function isAttrAllowed(tag: string, name: string): boolean {
  if (!FRAGMENT_TAGS.has(tag)) return false;
  if (PREFIXED_ATTR.test(name)) return true;
  if (GLOBAL_ATTRS.has(name)) return true;
  return TAG_ATTRS.get(tag)?.has(name) ?? false;
}

function schemeOf(value: string): string | null {
  let normalized = "";
  for (const ch of value.trim()) {
    const code = ch.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f) continue;
    normalized += ch;
  }
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(normalized);
  const scheme = match?.[1];
  return scheme ? scheme.toLowerCase() : null;
}

function isSafeUrlAttr(name: string, value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.startsWith("//")) return false;
  const scheme = schemeOf(value);
  if (scheme === null) return true;
  if (name === "href") return ALLOWED_HREF_SCHEMES.has(scheme);
  if (name === "src") return ALLOWED_SRC_SCHEMES.has(scheme);
  return false;
}

/** The allowlist and the URL scheme rule for one attribute on one element (names any case). */
export function isSafeElementAttribute(tag: string, name: string, value: string | null): boolean {
  const t = tag.toLowerCase();
  const n = name.toLowerCase();
  if (!isAttrAllowed(t, n)) return false;
  if (value === null) return true;
  return !URL_ATTRS.has(n) || isSafeUrlAttr(n, value);
}

/** A link destination (the only `href` that navigates rather than loads). */
export function isNavigationalHref(tag: string, name: string): boolean {
  return name === "href" && (tag === "a" || tag === "area");
}

/**
 * Attributes the engine owns on every mutation, not only at insertion: a
 * button's `type` (an inserted one stays `button`, a page's keeps the page's)
 * and a link's `rel`, `referrerpolicy` and `ping`.
 */
export function engineManaged(tag: string, name: string): boolean {
  if (tag === "button") return name === "type";
  if (tag === "a" || tag === "area")
    return name === "rel" || name === "referrerpolicy" || name === "ping";
  return false;
}

const DENIED_ATTRS = new Set([
  "srcdoc",
  "action",
  "formaction",
  "http-equiv",
  "integrity",
  "nonce",
  "is",
  "style",
]);

/** Rule (d): attributes no program may set, whatever the element. */
export function attrDenied(tag: string, name: string): boolean {
  if (name.startsWith("on")) return true;
  if (name === "content" && tag === "meta") return true;
  return DENIED_ATTRS.has(name);
}

/**
 * The page-independent verdict on a `setAttr` aimed at an element with this
 * tag: the engine-owned names and rule (d) (`attr-denied`, when the allowlist
 * would otherwise let the name through), then the allowlist and URL schemes
 * (`attr-rejected`). Null when only the page can still refuse it.
 */
export function attrRefusalFor(
  tag: string,
  rawName: string,
  value: string | null,
): "attr-denied" | "attr-rejected" | null {
  const name = rawName.toLowerCase();
  if (engineManaged(tag, name)) return "attr-denied";
  const safe = isSafeElementAttribute(tag, name, value);
  if (attrDenied(tag, name)) return safe ? "attr-denied" : "attr-rejected";
  return safe ? null : "attr-rejected";
}

/** A `setAttr` refused on every element the engine would ever set it on. */
function attrNeverSet(name: string, value: string | null): "attr-denied" | "attr-rejected" | null {
  let denied = false;
  for (const tag of FRAGMENT_TAGS) {
    const why = attrRefusalFor(tag, name, value);
    if (why === null) return null;
    if (why === "attr-denied") denied = true;
  }
  return denied ? "attr-denied" : "attr-rejected";
}

/** `classList` throws on an empty token or one with ASCII whitespace: such a step is refused. */
export function classNameProblem(names: readonly string[]): boolean {
  return names.some((n) => n.length === 0 || /[\t\n\f\r ]/.test(n));
}

/* ── styles ─────────────────────────────────────────────────────────── */

const STYLE_PROPERTY = /^-{0,2}[a-z][a-z0-9-]*$/;
const STYLE_FORBIDDEN = ["expression(", "@import", "-moz-binding", "behavior"];

/** CSS escapes decoded, so `u\72l(` reads as what the browser would see. */
function decodeCssEscapes(value: string): string {
  return value.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_m, hex: string, ch: string) => {
    if (hex) {
      const code = Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return ch;
  });
}

/** The URLs inside `url(…)` and `image-set(…)` in a declaration value. */
function cssUrls(value: string): string[] {
  const urls: string[] = [];
  for (const m of value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/g))
    urls.push(m[1] ?? m[2] ?? m[3] ?? "");
  for (const set of value.matchAll(/image-set\(([\s\S]*)\)/g)) {
    for (const m of (set[1] ?? "").matchAll(/(?:^|[\s,(])(?:"([^"]*)"|'([^']*)')/g))
      urls.push(m[1] ?? m[2] ?? "");
  }
  return urls;
}

function stripControls(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f) continue;
    out += ch;
  }
  return out;
}

/**
 * Rule (c) for one declaration, as far as the page doesn't matter: the
 * property's grammar, no custom properties, none of the forbidden names or
 * values (CSS escapes decoded), a `url(` that names a URL, and no URL with a
 * scheme other than http(s) or a `data:image/`. The URLs it returns are what
 * the engine still checks against the page's origins.
 */
export function styleStaticRefusal(
  prop: string,
  value: string,
): { reason: "style-property" | "style-value" } | { urls: string[] } {
  if (!STYLE_PROPERTY.test(prop)) return { reason: "style-property" };
  // No custom properties: a value set there is substituted later, past these checks.
  if (prop.startsWith("--")) return { reason: "style-property" };
  // The binding properties are refused by name as well as by value.
  if (STYLE_FORBIDDEN.includes(prop)) return { reason: "style-value" };
  const v = decodeCssEscapes(value).toLowerCase();
  if (STYLE_FORBIDDEN.some((bad) => v.includes(bad))) return { reason: "style-value" };
  if (!v.includes("url(") && !v.includes("image-set(")) return { urls: [] };
  const urls = cssUrls(v);
  if (urls.length === 0) return { reason: "style-value" };
  const fetched: string[] = [];
  for (const u of urls) {
    const clean = stripControls(u);
    if (/^data:image\//i.test(clean)) continue;
    const scheme = schemeOf(clean);
    if (scheme !== null && scheme !== "http" && scheme !== "https")
      return { reason: "style-value" };
    fetched.push(clean);
  }
  return { urls: fetched };
}

/* ── fragments, read without a DOM ──────────────────────────────────── */

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
/** Elements whose content is text up to their own end tag (raw text and RCDATA). */
const TEXT_ONLY_TAGS = new Set([
  "script",
  "style",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "textarea",
  "title",
]);
/**
 * The named references that read as blank, exactly as HTML spells them (they
 * are case-sensitive: `&nBsP;` is no reference, and the browser shows it as
 * text). Only `&nbsp` is also read without its semicolon.
 */
const NAMED_SPACES: Record<string, string> = {
  "nbsp;": "\u00a0",
  nbsp: "\u00a0",
  "ensp;": "\u2002",
  "emsp;": "\u2003",
  "thinsp;": "\u2009",
  "Tab;": "\t",
  "NewLine;": "\n",
  "numsp;": "\u2007",
  "puncsp;": "\u2008",
  "hairsp;": "\u200a",
};

/**
 * Text that shows once its character references are read. Any reference not
 * known here (or spelt in another case) counts as showing: the reading only
 * says "blank" when it is sure.
 */
function showsText(raw: string): boolean {
  const decoded = raw.replace(
    /&(?:#(\d{1,7});?|#[xX]([0-9a-fA-F]{1,6});?|([a-zA-Z][a-zA-Z0-9]*;?))/g,
    (_m, dec?: string, hex?: string, name?: string) => {
      if (dec !== undefined || hex !== undefined) {
        const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? "", 16);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\ufffd";
      }
      return NAMED_SPACES[name ?? ""] ?? "x";
    },
  );
  return decoded.trim().length > 0;
}

interface Tag {
  name: string;
  end: boolean;
  /** Index just past the tag's `>`; -1 when the input ended inside it (the tag is dropped). */
  next: number;
}

/** HTML's own whitespace (not JavaScript's `\s`, which takes many more). */
const HTML_SPACE = /[\t\n\f\r ]/;
const isSpace = (c: string | undefined): boolean => c !== undefined && HTML_SPACE.test(c);

/**
 * ASCII-only lower case, as HTML folds tag names: every offset stays where it
 * was (Unicode lower-casing can change a string's length, `İ` becomes two).
 */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/**
 * Read one tag starting at `<` (`html[i]`) as the HTML tokenizer does:
 * attribute names, then values quoted (which may hold `>`) or unquoted (up to
 * whitespace or `>`, `=` and quotes included).
 */
function readTag(html: string, i: number, end: boolean): Tag {
  const n = html.length;
  let j = i + (end ? 2 : 1);
  let name = "";
  while (j < n && !isSpace(html[j]) && html[j] !== "/" && html[j] !== ">") {
    name += html[j];
    j++;
  }
  const tag = (next: number): Tag => ({ name: asciiLower(name), end, next });
  while (j < n) {
    const c = html[j];
    if (c === ">") return tag(j + 1);
    if (isSpace(c) || c === "/") {
      j++;
      continue;
    }
    // An attribute name (a leading `=` is part of it), up to space, `/`, `>` or `=`.
    j++;
    while (j < n && !isSpace(html[j]) && html[j] !== "/" && html[j] !== ">" && html[j] !== "=") j++;
    while (j < n && isSpace(html[j])) j++;
    if (html[j] !== "=") continue;
    j++;
    while (j < n && isSpace(html[j])) j++;
    const q = html[j];
    if (q === '"' || q === "'") {
      const close = html.indexOf(q, j + 1);
      if (close < 0) return tag(-1);
      j = close + 1;
      continue;
    }
    while (j < n && !isSpace(html[j]) && html[j] !== ">") j++;
  }
  return tag(-1);
}

/**
 * The work a fragment reading may do, in units of characters examined and
 * open tags popped: linear in the fragment's length. Past it, the reading
 * gives up and lets the browser decide.
 */
export function fragmentWorkBudget(length: number): number {
  return 8 * length + 4_096;
}

/** What one reading found, and the work it did (tests bound the work). */
export interface FragmentReading {
  verdict: "fragment-empty" | "fragment-disallowed" | null;
  work: number;
  /** It ran out of budget: the verdict is null whatever the fragment holds. */
  exhausted: boolean;
}

/** Comment ends: `-->` or `--!>`, found in one pass from where the comment opened. */
const COMMENT_END = /--!?>/g;

/**
 * The one rule of this reading: it refuses only what it is SURE every browser
 * refuses; anything it can't classify with certainty is accepted and the
 * browser decides (a wrong accept costs an unhelpful "ok", a wrong refusal
 * blocks a valid variant). So it models none of the HTML tree builder: it
 * recognizes a small grammar whose parse is the same in every browser, and
 * gives up ("the browser decides") on anything else.
 *
 * Refused, and only these, made of nothing but blank text and comments
 * between them:
 * - empty kept elements, each a start tag at the top level followed at once
 *   by its own end tag (`<span class="sink"></span>`): `fragment-empty`;
 * - and with any of these, `fragment-disallowed`: a raw-text tag (`script`,
 *   `style`, `textarea`, `title`, …) whose text runs to its own end tag or to
 *   the end; a void tag never inserted (`input`, `meta`, `link`, `embed`,
 *   `base`); a `form`, `select` or `object` holding only text, then its own
 *   end tag.
 * A fragment of blank text and comments alone is `fragment-empty`.
 */
export function fragmentRefusal(html: string): "fragment-empty" | "fragment-disallowed" | null {
  return readFragment(html).verdict;
}

/** Never-inserted elements whose text-only content the reading may step over. */
const TEXT_ONLY_DROPS = new Set(["form", "select", "object"]);

/** Where the raw text that starts at `from` ends: its own end tag, or -1 (to the end). */
function rawTextEnd(lower: string, name: string, from: number): number {
  const needle = `</${name}`;
  let at = lower.indexOf(needle, from);
  while (at >= 0) {
    const after = lower[at + needle.length];
    if (after === undefined || isSpace(after) || after === "/" || after === ">") return at;
    at = lower.indexOf(needle, at + needle.length);
  }
  return -1;
}

/**
 * `fragmentRefusal` with its work counted. It reads forward once (every
 * search starts where the last one stopped), and a budget
 * (`fragmentWorkBudget`) caps it; a reading that reaches it answers null.
 */
export function readFragment(
  html: string,
  budget = fragmentWorkBudget(html.length),
): FragmentReading {
  const n = html.length;
  const lower = asciiLower(html);
  let work = 0;
  let dropped = false;
  const unsure = (): FragmentReading => ({ verdict: null, work, exhausted: false });
  let i = 0;
  while (i < n) {
    if (work > budget) return { verdict: null, work, exhausted: true };
    const lt = html.indexOf("<", i);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > i) {
      work += textEnd - i;
      if (showsText(html.slice(i, textEnd))) return unsure();
      i = textEnd;
      continue;
    }
    // A comment: `<!-->` and `<!--->` end at once, otherwise at `-->` or `--!>` (or the end).
    if (html.startsWith("<!--", i)) {
      let to: number;
      if (html.startsWith("<!-->", i)) to = i + 5;
      else if (html.startsWith("<!--->", i)) to = i + 6;
      else {
        COMMENT_END.lastIndex = i + 4;
        const m = COMMENT_END.exec(html);
        to = m ? m.index + m[0].length : n;
      }
      work += to - i;
      i = to;
      continue;
    }
    // A bogus comment or a doctype, to the next `>`.
    const c1 = html[i + 1] ?? "";
    if (c1 === "!" || c1 === "?") {
      const gt = html.indexOf(">", i + 2);
      const to = gt < 0 ? n : gt + 1;
      work += to - i;
      i = to;
      continue;
    }
    // Anything but a start tag here (an end tag, a lone `<`) is outside the grammar.
    if (!/[a-zA-Z]/.test(c1)) return unsure();
    const tag = readTag(html, i, false);
    if (tag.next < 0) return unsure();
    work += tag.next - i;
    const name = tag.name;
    if (VOID_TAGS.has(name)) {
      if (!NEVER_INSERTED.has(name)) return unsure(); // `br`, `hr`, `img` show; others aren't modelled
      dropped = true;
      i = tag.next;
      continue;
    }
    if (TEXT_ONLY_TAGS.has(name)) {
      const end = rawTextEnd(lower, name, tag.next);
      dropped = true;
      if (end < 0) {
        work += n - tag.next;
        i = n;
        continue;
      }
      const closing = readTag(html, end, true);
      work += (closing.next < 0 ? n : closing.next) - tag.next;
      i = closing.next < 0 ? n : closing.next;
      continue;
    }
    // A `form`, `select` or `object` holding only text, then its own end tag;
    // a kept element with nothing at all before its own end tag.
    const textOnly = TEXT_ONLY_DROPS.has(name);
    if (!textOnly && (!FRAGMENT_TAGS.has(name) || NEVER_INSERTED.has(name))) return unsure();
    const close = textOnly ? html.indexOf("<", tag.next) : tag.next;
    if (close < 0 || !lower.startsWith(`</${name}`, close)) return unsure();
    const closing = readTag(html, close, true);
    if (closing.next < 0 || closing.name !== name) return unsure();
    work += closing.next - tag.next;
    if (textOnly) dropped = true;
    i = closing.next;
  }
  if (work > budget) return { verdict: null, work, exhausted: true };
  return { verdict: dropped ? "fragment-disallowed" : "fragment-empty", work, exhausted: false };
}

/* ── one step, without the page ─────────────────────────────────────── */

/**
 * The page-independent refusal of one step, or null when only the page can
 * still refuse it. `page` says the program's root is the whole page.
 */
export function staticOpRefusal(op: MutationOp, page: boolean): StepRefusalReason | null {
  const target = op.target.trim().toLowerCase();
  const atRoot =
    target === ":scope" || target === "body" || target === "html" || target === ":root";
  switch (op.op) {
    case "setStyle":
      for (const { prop, value } of op.props) {
        const why = styleStaticRefusal(prop, value);
        if ("reason" in why) return why.reason;
      }
      return null;
    case "setClass":
      return classNameProblem(op.add) || classNameProblem(op.remove) ? "class-name" : null;
    case "setAttr":
      return attrNeverSet(op.name, op.value);
    case "setText":
      return page && atRoot ? "page-root-text" : null;
    case "insertFragment":
      if (page && atRoot && op.position === "replace") return "page-root-replace";
      return fragmentRefusal(op.html);
  }
}
