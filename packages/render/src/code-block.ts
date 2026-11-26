// The code block, one component for the web app and the extension: a frame
// with an optional language label and a Copy button, the code in mono with
// horizontal scroll, and syntax colors that arrive later as plain data.
// Nothing here imports the highlighter: the overlay's content script carries
// this file only, and colors reach it as runs (text + a kind from a closed
// set) that are checked against the code before they touch the DOM. Text
// reaches the DOM as text nodes only.
import type { FenceBlock } from "@onlay/protocol";
import { findSpelling, spanHolds } from "./mentions";

/** The languages colored, by the name the highlighter knows them by. */
export const CODE_LANGS = [
  "json",
  "jsonc",
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "html",
  "css",
  "bash",
  "python",
  "diff",
  "yaml",
  "toml",
  "sql",
  "markdown",
] as const;
export type CodeLang = (typeof CODE_LANGS)[number];

const ALIASES: Readonly<Record<string, CodeLang>> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  sh: "bash",
  shell: "bash",
  shellscript: "bash",
  zsh: "bash",
  console: "bash",
  py: "python",
  yml: "yaml",
  md: "markdown",
  patch: "diff",
  htm: "html",
  json5: "jsonc",
};

/** The language a fence's word names, or null (uncolored). */
export function codeLangOf(word: string | null | undefined): CodeLang | null {
  if (!word) return null;
  const w = word.toLowerCase();
  if ((CODE_LANGS as readonly string[]).includes(w)) return w as CodeLang;
  return Object.hasOwn(ALIASES, w) ? (ALIASES[w] as CodeLang) : null;
}

/**
 * The token kinds a run may carry, by index (0 is plain text). They are the
 * slots of a CSS-variables theme, so every color comes from the client's own
 * stylesheet, never from the highlighter.
 */
export const TOKEN_KINDS = [
  "plain",
  "keyword",
  "string",
  "comment",
  "constant",
  "function",
  "parameter",
  "punctuation",
  "string-expression",
  "link",
  "inserted",
  "deleted",
  "changed",
  "heading",
  "strong",
] as const;

/** One colored stretch of code: its text and its kind's index. */
export type CodeRun = [text: string, kind: number];

/** Code longer than this stays uncolored. Message bodies are shorter still. */
export const MAX_HIGHLIGHT_CHARS = 8_192;

/**
 * Runs from outside (the service worker, the highlighter chunk) as the code
 * may show them: an array of `[text, kind]` with a known kind, at most one
 * run per character, whose texts put together are exactly `code`. Anything
 * else is null and the block stays uncolored.
 */
export function validateRuns(raw: unknown, code: string): CodeRun[] | null {
  if (!Array.isArray(raw) || raw.length > code.length) return null;
  const out: CodeRun[] = [];
  let at = 0;
  for (const item of raw) {
    if (!Array.isArray(item) || item.length !== 2) return null;
    const [text, kind] = item as [unknown, unknown];
    if (typeof text !== "string" || text.length === 0) return null;
    if (typeof kind !== "number" || !Number.isInteger(kind)) return null;
    if (kind < 0 || kind >= TOKEN_KINDS.length) return null;
    if (!code.startsWith(text, at)) return null;
    at += text.length;
    out.push([text, kind]);
  }
  return at === code.length ? out : null;
}

/** Where colors come from: a synchronous look for what is known, a load for the rest. */
export interface CodeHighlighter {
  peek(lang: CodeLang, code: string): CodeRun[] | null | undefined;
  load(lang: CodeLang, code: string): Promise<CodeRun[] | null>;
}

const CACHE_SIZE = 64;

/**
 * A highlighter over `fetchRuns`, whose answer is untrusted: each answer is
 * validated, kept for the next render (the newest 64), and asked for once
 * per code at a time. A failure is kept as null, so a thread that repaints
 * does not ask again.
 */
export function createCodeHighlighter(
  fetchRuns: (lang: CodeLang, code: string) => Promise<unknown>,
): CodeHighlighter {
  const done = new Map<string, CodeRun[] | null>();
  const pending = new Map<string, Promise<CodeRun[] | null>>();
  const keyOf = (lang: CodeLang, code: string) => `${lang}\u0000${code}`;
  return {
    peek(lang, code) {
      return done.get(keyOf(lang, code));
    },
    load(lang, code) {
      const key = keyOf(lang, code);
      if (done.has(key)) return Promise.resolve(done.get(key) ?? null);
      const inFlight = pending.get(key);
      if (inFlight) return inFlight;
      const p = Promise.resolve()
        .then(() => fetchRuns(lang, code))
        .then(
          (raw) => validateRuns(raw, code),
          () => null,
        )
        .then((runs) => {
          pending.delete(key);
          done.set(key, runs);
          if (done.size > CACHE_SIZE) done.delete(done.keys().next().value as string);
          return runs;
        });
      pending.set(key, p);
      return p;
    },
  };
}

export interface CodeBlockDeps {
  /** Put the code on the clipboard; true when it went. Runs inside the click. */
  copy(text: string): Promise<boolean>;
  /** What a failed copy says (default "Couldn't copy. Try again."). */
  failedText?: string | undefined;
  /** Colors, when the client has a highlighter. */
  highlighter?: CodeHighlighter | undefined;
  /** The click gate; default: the event is trusted. */
  trusted?: ((e: Event) => boolean) | undefined;
  /** The Copy button's accessible name (default "Copy code"). */
  copyLabel?: string | undefined;
}

export interface CodeBlockInput {
  code: string;
  /** The label shown in the frame (the fence's word as written), if any. */
  label?: string | null | undefined;
  /** The language to color in; null or unknown stays uncolored. */
  lang?: string | null | undefined;
}

export const COPY_CODE_LABEL = "Copy code";
/** What the block's status line says after a copy. */
export const CODE_COPY_SAID = { copied: "Copied.", failed: "Couldn't copy. Try again." } as const;
/** How long the status line keeps its words. */
const SAID_MS = 2000;
/** The pause between emptying the status line and filling it again. */
const ANNOUNCE_GAP_MS = 50;

function paint(doc: Document, target: HTMLElement, runs: readonly CodeRun[]): void {
  const frag = doc.createDocumentFragment();
  for (const [text, kind] of runs) {
    if (kind === 0) {
      frag.appendChild(doc.createTextNode(text));
      continue;
    }
    const span = doc.createElement("span");
    span.className = `code-k-${TOKEN_KINDS[kind]}`;
    span.appendChild(doc.createTextNode(text));
    frag.appendChild(span);
  }
  target.replaceChildren(frag);
}

/**
 * A code block. It shows at once, uncolored and copyable; when a highlighter
 * answers with runs that match the code, the colors are painted in.
 */
export function codeBlock(doc: Document, input: CodeBlockInput, deps: CodeBlockDeps): HTMLElement {
  const { code } = input;
  const root = doc.createElement("div");
  root.className = "code-block";
  const head = doc.createElement("div");
  head.className = "code-head";
  const label = input.label?.trim();
  if (label) {
    const tag = doc.createElement("span");
    tag.className = "code-lang";
    tag.textContent = label;
    head.appendChild(tag);
  }
  // The copy's outcome, in every client: a status region that is in the
  // block from the start (so a screen reader hears it change), beside the
  // button, whose name never changes.
  const status = doc.createElement("span");
  status.className = "code-status";
  status.setAttribute("role", "status");
  const copy = doc.createElement("button");
  copy.type = "button";
  copy.className = "code-copy";
  copy.textContent = "Copy";
  copy.setAttribute("aria-label", deps.copyLabel ?? COPY_CODE_LABEL);
  const trusted = deps.trusted ?? ((e: Event) => e.isTrusted);
  let settle: ReturnType<typeof setTimeout> | null = null;
  let say: ReturnType<typeof setTimeout> | null = null;
  copy.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!trusted(e)) return;
    void deps.copy(code).then((ok) => {
      const words = ok ? CODE_COPY_SAID.copied : (deps.failedText ?? CODE_COPY_SAID.failed);
      if (settle) clearTimeout(settle);
      if (say) clearTimeout(say);
      // Empty the region, then fill it in a later update: a repeated outcome
      // is a change a screen reader hears too.
      status.textContent = "";
      say = setTimeout(() => {
        say = null;
        status.textContent = words;
        status.classList.toggle("is-failed", !ok);
        copy.classList.toggle("is-copied", ok);
        settle = setTimeout(() => {
          copy.classList.remove("is-copied");
          status.textContent = "";
        }, SAID_MS);
      }, ANNOUNCE_GAP_MS);
    });
  });
  head.append(status, copy);

  const pre = doc.createElement("pre");
  pre.className = "code-pre";
  // Code reads left to right whatever the page around it does.
  pre.dir = "ltr";
  // A scrolling region is reachable from the keyboard.
  pre.tabIndex = 0;
  const text = doc.createElement("code");
  text.className = "code-text";
  text.textContent = code;
  pre.appendChild(text);
  root.append(head, pre);

  const lang = codeLangOf(input.lang);
  const hl = deps.highlighter;
  if (lang && hl && code.length > 0 && code.length <= MAX_HIGHLIGHT_CHARS) {
    root.dataset.lang = lang;
    const known = hl.peek(lang, code);
    if (known) paint(doc, text, known);
    else if (known === undefined)
      void hl.load(lang, code).then((runs) => {
        if (runs) paint(doc, text, runs);
      });
  }
  return root;
}

/** A token placed in message text: where its pill sits. */
export interface PlacedToken<T> {
  tok: T;
  index: number;
  length: number;
}

/** Where an editor said one pill sits (a token's `spans`). */
interface StoredSpan {
  start: number;
  length: number;
}

/**
 * Where each token's pills sit, in text order, never inside a fenced block.
 * `spellingsOf` gives the texts a token's pill may stand on (see
 * `mentionSpellings`); a token with none gets no pill. A token that carries
 * `spans` gets a pill at each span that really holds it (character
 * boundaries, exactly one of its spellings, a whole run), outside every
 * block and clear of the pills already placed; a span that fails draws
 * nothing, and its token is not looked for elsewhere. One without spans (an
 * older message) is found by its text as the clients always did: in order,
 * each searched from where the last such token ended, taking the earliest
 * occurrence outside every block and every placed pill.
 */
export function placeOutsideFences<T extends { spans?: readonly StoredSpan[] | undefined }>(
  text: string,
  tokens: readonly T[],
  blocks: readonly FenceBlock[],
  spellingsOf: (tok: T) => readonly string[],
): PlacedToken<T>[] {
  const placed: PlacedToken<T>[] = [];
  const inFence = (a: number, b: number) => blocks.some((bl) => a < bl.end && b > bl.start);
  const taken = (a: number, b: number) => placed.some((p) => a < p.index + p.length && p.index < b);
  const free = (a: number, b: number) => !inFence(a, b) && !taken(a, b);
  for (const tok of tokens) {
    if (tok.spans === undefined) continue;
    const spellings = spellingsOf(tok);
    for (const { start, length } of tok.spans) {
      if (!spanHolds(text, start, length, spellings)) continue;
      if (!free(start, start + length)) continue;
      placed.push({ tok, index: start, length });
    }
  }
  let cursor = 0;
  for (const tok of tokens) {
    if (tok.spans !== undefined) continue;
    const at = findSpelling(text, spellingsOf(tok), cursor, free);
    if (!at) continue;
    placed.push({ tok, index: at.index, length: at.length });
    cursor = at.index + at.length;
  }
  return placed.sort((a, b) => a.index - b.index);
}

/**
 * A message body: text nodes and pills outside fences, exactly as before,
 * and a code block for each fence.
 */
export function renderFencedBody<T>(
  doc: Document,
  text: string,
  blocks: readonly FenceBlock[],
  placed: readonly PlacedToken<T>[],
  pill: (p: PlacedToken<T>, run: string) => Node,
  block: (b: FenceBlock) => Node,
): DocumentFragment {
  const frag = doc.createDocumentFragment();
  let cursor = 0;
  let next = 0;
  const textUpTo = (end: number) => {
    while (next < placed.length && (placed[next] as PlacedToken<T>).index < end) {
      const p = placed[next] as PlacedToken<T>;
      if (p.index > cursor) frag.appendChild(doc.createTextNode(text.slice(cursor, p.index)));
      frag.appendChild(pill(p, text.slice(p.index, p.index + p.length)));
      cursor = p.index + p.length;
      next += 1;
    }
    if (end > cursor) frag.appendChild(doc.createTextNode(text.slice(cursor, end)));
    cursor = Math.max(cursor, end);
  };
  for (const b of blocks) {
    textUpTo(b.start);
    frag.appendChild(block(b));
    cursor = b.end;
  }
  textUpTo(text.length);
  return frag;
}

/**
 * The block's styles, in the brand's tokens only (both clients define them):
 * syntax colors are the palette's hues mixed toward the foreground, so each
 * one reads in light and dark alike.
 */
export const CODE_BLOCK_CSS = `
.code-block {
  display: block;
  margin: 6px 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 10px);
  background: color-mix(in oklch, var(--foreground) 5%, transparent);
  white-space: normal;
  overflow: hidden;
  min-width: 0;
  max-width: 100%;
}
.code-head {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 4px 4px 0 10px;
}
.code-lang {
  margin-right: auto;
  font: 500 10px/1 var(--mono);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted-foreground);
}
.code-copy {
  appearance: none;
  border: 1px solid transparent;
  border-radius: var(--radius-sm, 6px);
  background: transparent;
  color: var(--muted-foreground);
  font: 500 11px/1 var(--font);
  padding: 4px 8px;
  cursor: pointer;
}
.code-copy:hover { color: var(--foreground); border-color: var(--border); }
.code-copy:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.code-copy.is-copied { color: var(--primary); border-color: color-mix(in oklch, var(--primary) 40%, transparent); }
.code-status { font: 500 11px/1 var(--font); color: var(--primary); }
.code-status.is-failed { color: var(--color-danger); }
/* Empty, the region takes no space but stays in the accessibility tree. */
.code-status:empty {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
}
.code-pre {
  margin: 0;
  padding: 4px 12px 10px;
  overflow-x: auto;
  white-space: pre;
  word-break: normal;
  overflow-wrap: normal;
  tab-size: 2;
  font: 400 var(--text-xs, 12px)/1.55 var(--mono);
  color: var(--foreground);
}
.code-pre:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
.code-text { font: inherit; white-space: inherit; }
.code-k-keyword { color: color-mix(in oklch, var(--color-primary-500) 70%, var(--foreground)); }
.code-k-string, .code-k-string-expression { color: color-mix(in oklch, var(--color-success) 72%, var(--foreground)); }
.code-k-comment { color: var(--muted-foreground); font-style: italic; }
.code-k-constant { color: color-mix(in oklch, var(--color-warning) 68%, var(--foreground)); }
.code-k-function { color: color-mix(in oklch, var(--color-info) 75%, var(--foreground)); }
.code-k-parameter { color: color-mix(in oklch, var(--kind-ask-strong) 60%, var(--foreground)); }
.code-k-punctuation { color: color-mix(in oklch, var(--muted-foreground) 60%, var(--foreground)); }
.code-k-link { color: var(--primary); text-decoration: underline; }
.code-k-inserted { color: color-mix(in oklch, var(--color-success) 72%, var(--foreground)); }
.code-k-deleted { color: color-mix(in oklch, var(--color-danger) 72%, var(--foreground)); }
.code-k-changed { color: color-mix(in oklch, var(--color-warning) 68%, var(--foreground)); }
.code-k-heading { color: color-mix(in oklch, var(--color-primary-500) 70%, var(--foreground)); font-weight: 600; }
.code-k-strong { font-weight: 600; }
`;
