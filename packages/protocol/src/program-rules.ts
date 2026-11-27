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

/** The attribute allowlist: an element the engine inserts or edits, and the names it may carry. */
export function isAttrAllowed(tag: string, name: string): boolean {
  if (!FRAGMENT_TAGS.has(tag)) return false;
  if (name.startsWith("data-") || name.startsWith("aria-")) return true;
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
/** Tags the parser folds into the document it already has: never an element in a fragment. */
const DOCUMENT_TAGS = new Set(["html", "head", "body", "frameset", "frame"]);
/**
 * Dropped elements the parser never closes early or moves content out of:
 * what is inside one is surely dropped with it. Anything else dropped (foreign
 * content, unknown tags) leaves the verdict to the engine.
 */
const SURELY_DROPPED = new Set([...NEVER_INSERTED, ...TEXT_ONLY_TAGS, "noscript", "template"]);

const NAMED_SPACES: Record<string, string> = {
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  tab: "\t",
  newline: "\n",
  numsp: " ",
  puncsp: " ",
  hairsp: " ",
};

/** Text that shows once its character references are read (an unknown one counts as showing). */
function showsText(raw: string): boolean {
  const decoded = raw.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]*));?/g,
    (_m, dec?: string, hex?: string, name?: string) => {
      if (dec !== undefined || hex !== undefined) {
        const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? "", 16);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "�";
      }
      return NAMED_SPACES[(name ?? "").toLowerCase()] ?? "x";
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

/** Read one tag starting at `<` (`html[i]`); attribute values may hold `>`. */
function readTag(html: string, i: number, end: boolean): Tag {
  let j = i + (end ? 2 : 1);
  let name = "";
  while (j < html.length && !/[\s/>]/.test(html[j] as string)) {
    name += html[j];
    j++;
  }
  while (j < html.length) {
    const c = html[j] as string;
    if (c === ">") return { name: name.toLowerCase(), end, next: j + 1 };
    if (c === "=") {
      j++;
      while (j < html.length && /\s/.test(html[j] as string)) j++;
      const q = html[j];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, j + 1);
        if (close < 0) return { name: name.toLowerCase(), end, next: -1 };
        j = close + 1;
        continue;
      }
    }
    j++;
  }
  return { name: name.toLowerCase(), end, next: -1 };
}

interface Open {
  name: string;
  kept: boolean;
  children: number;
}

/**
 * Whether the engine's sanitizer would find something that shows in this
 * fragment: a kept element with any content, text that isn't blank, or a
 * `br`, `hr` or `img`, after every tag outside `FRAGMENT_TAGS` (or in
 * `NEVER_INSERTED`) is dropped with its content. Null when it would, or when
 * the reading can't be sure (the engine then decides on the page);
 * `fragment-disallowed` when it would not and a dropped tag was met,
 * `fragment-empty` otherwise.
 */
export function fragmentRefusal(html: string): "fragment-empty" | "fragment-disallowed" | null {
  const root: Open = { name: "#root", kept: true, children: 0 };
  const stack: Open[] = [root];
  let renderable = false;
  /** An element the engine drops was met where it would otherwise have been kept. */
  let dropped = false;
  let unsure = false;
  /** The outermost dropped element we are inside, if any. */
  let dropRoot: string | null = null;
  const top = () => stack[stack.length - 1] as Open;
  const inDrop = (): boolean => dropRoot !== null;
  /** Something that might show sat inside a dropped element the parser could let it out of. */
  const sawShowing = (): void => {
    if (inDrop() && !SURELY_DROPPED.has(dropRoot as string)) unsure = true;
  };
  const close = (o: Open): void => {
    if (o.kept && o.children > 0) renderable = true;
  };
  const popTo = (index: number): void => {
    while (stack.length > index) {
      const o = stack.pop() as Open;
      close(o);
    }
    if (dropRoot !== null && !stack.some((o) => !o.kept)) dropRoot = null;
  };
  const text = (t: string): void => {
    if (t.length === 0) return;
    const shows = showsText(t);
    if (top().kept) {
      top().children++;
      if (shows) renderable = true;
    } else if (shows) sawShowing();
  };
  const element = (rawName: string): void => {
    const name = rawName === "image" ? "img" : rawName;
    if (DOCUMENT_TAGS.has(name)) return;
    const parent = top();
    const kept = parent.kept && FRAGMENT_TAGS.has(name) && !NEVER_INSERTED.has(name);
    if (kept) parent.children++;
    else if (parent.kept) {
      dropRoot = name;
      dropped = true;
    } else if (FRAGMENT_TAGS.has(name)) sawShowing();
    if (VOID_TAGS.has(name)) {
      if (VOID_RENDERABLE_TAGS.has(name)) {
        if (kept) renderable = true;
        else sawShowing();
      }
      if (!kept && parent.kept) dropRoot = null;
      return;
    }
    stack.push({ name, kept, children: 0 });
  };

  let i = 0;
  let textStart = 0;
  const flush = (to: number): void => {
    if (to > textStart) text(html.slice(textStart, to));
  };
  while (i < html.length) {
    if (html[i] !== "<") {
      i++;
      continue;
    }
    const n = html[i + 1] ?? "";
    if (html.startsWith("<!--", i)) {
      flush(i);
      // `<!-->` and `<!--->` end at once; otherwise at `-->` or `--!>`.
      if (html.startsWith("<!-->", i)) i += 5;
      else if (html.startsWith("<!--->", i)) i += 6;
      else {
        const a = html.indexOf("-->", i + 4);
        const b = html.indexOf("--!>", i + 4);
        const endC = a < 0 ? b : b < 0 ? a : Math.min(a, b);
        i = endC < 0 ? html.length : endC + (endC === b ? 4 : 3);
      }
      textStart = i;
      continue;
    }
    if (n === "!" || n === "?") {
      flush(i);
      const endB = html.indexOf(">", i + 2);
      i = endB < 0 ? html.length : endB + 1;
      textStart = i;
      continue;
    }
    const isEnd = n === "/";
    const first = isEnd ? (html[i + 2] ?? "") : n;
    if (!/[a-zA-Z]/.test(first)) {
      if (isEnd) {
        // `</>` is dropped; `</ ...>` is a bogus comment.
        flush(i);
        const endB = html.indexOf(">", i + 2);
        i = endB < 0 ? html.length : endB + 1;
        textStart = i;
      } else i++;
      continue;
    }
    flush(i);
    const tag = readTag(html, i, isEnd);
    if (tag.next < 0) {
      i = html.length;
      textStart = i;
      break;
    }
    i = tag.next;
    textStart = i;
    if (!tag.end) {
      if (tag.name === "plaintext") {
        // Everything after it is its text, and it is dropped.
        element("plaintext");
        text(html.slice(i));
        i = html.length;
        textStart = i;
        break;
      }
      element(tag.name);
      if (TEXT_ONLY_TAGS.has(tag.name)) {
        const lower = html.toLowerCase();
        let endAt = -1;
        let from = i;
        while (from < html.length) {
          const at = lower.indexOf(`</${tag.name}`, from);
          if (at < 0) break;
          const after = lower[at + 2 + tag.name.length] ?? "";
          if (after === "" || /[\s/>]/.test(after)) {
            endAt = at;
            break;
          }
          from = at + 1;
        }
        const body = html.slice(i, endAt < 0 ? html.length : endAt);
        text(body);
        if (endAt < 0) {
          i = html.length;
          textStart = i;
          break;
        }
        const closing = readTag(html, endAt, true);
        i = closing.next < 0 ? html.length : closing.next;
        textStart = i;
        const idx = stack.map((o) => o.name).lastIndexOf(tag.name);
        if (idx > 0) popTo(idx);
      }
      continue;
    }
    // End tags.
    if (DOCUMENT_TAGS.has(tag.name)) continue;
    if (tag.name === "br") {
      element("br"); // `</br>` is read as `<br>`
      continue;
    }
    const idx = stack.map((o) => o.name).lastIndexOf(tag.name === "image" ? "img" : tag.name);
    if (idx > 0) {
      popTo(idx);
    } else if (tag.name === "p") {
      // A stray `</p>` makes an empty paragraph.
      element("p");
      popTo(stack.length - 1);
    }
  }
  flush(html.length);
  popTo(1);
  if (renderable || unsure) return null;
  return dropped ? "fragment-disallowed" : "fragment-empty";
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
