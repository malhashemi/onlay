// Message text as the overlay shows it: plain text, pills for `@agent` and for
// people, and a code block for each fence. The fence grammar, the pill
// placement and the code block are the product's own (@onlay/protocol
// `parseFences`, @onlay/render `code-block`); only the wiring is here.
import { parseFences } from "@onlay/protocol";
import {
  type CodeHighlighter,
  type CodeRun,
  codeBlock,
  codeLangOf,
  placeOutsideFences,
  renderFencedBody,
  TOKEN_KINDS,
  validateRuns,
} from "@onlay/render/code-block";
import { currentDocument, el, type Person } from "./dom";
import type { Directory } from "./model";

type Token = { t: "agent" } | { t: "person"; person: Person };

/** How the views get colors and reach the clipboard. */
export interface RichDeps {
  people: Directory;
  highlighter?: CodeHighlighter | undefined;
  copy(text: string): Promise<boolean>;
  /** The click gate for Copy (the build has no trusted events to give). */
  trusted?: ((e: Event) => boolean) | undefined;
}

function tokensIn(text: string, people: Directory): Token[] {
  const out: Token[] = [];
  if (text.includes("@agent")) out.push({ t: "agent" });
  for (const person of Object.values(people)) {
    if (text.includes(`@${person.name}`)) out.push({ t: "person", person });
  }
  return out;
}

function spellings(tok: Token): string[] {
  return tok.t === "agent" ? ["@agent"] : [`@${tok.person.name}`];
}

function pill(tok: Token, run: string): HTMLElement {
  const node = el("span", "token-pill token-actor", run);
  if (tok.t === "person" && tok.person.tint) node.classList.add(tok.person.tint);
  return node;
}

/** One fenced block, through the shared component. */
export function fencedBlock(
  code: string,
  lang: string | null,
  deps: Pick<RichDeps, "highlighter" | "copy" | "trusted">,
): HTMLElement {
  return codeBlock(
    currentDocument(),
    { code, label: lang, lang },
    {
      copy: deps.copy,
      highlighter: deps.highlighter,
      ...(deps.trusted ? { trusted: deps.trusted } : {}),
    },
  );
}

/** A message body: text nodes, pills outside fences, and a code block per fence. */
export function richBody(text: string, deps: RichDeps): DocumentFragment {
  const blocks = parseFences(text);
  const placed = placeOutsideFences<Token & { spans?: undefined }>(
    text,
    tokensIn(text, deps.people),
    blocks,
    spellings,
  );
  return renderFencedBody(
    currentDocument(),
    text,
    blocks,
    placed,
    (p, run) => pill(p.tok, run),
    (b) => fencedBlock(b.code, b.lang, deps),
  );
}

/* ── colors ── */

/**
 * The runs a code block already shows, read back from its DOM: the build
 * paints the page's code samples with the real highlighter, and the browser
 * takes the colors from that markup instead of loading one.
 */
export function runsFromDom(codeEl: Element): CodeRun[] {
  const runs: CodeRun[] = [];
  for (const node of codeEl.childNodes) {
    const text = node.textContent ?? "";
    if (!text) continue;
    let kind = 0;
    if (node.nodeType === 1) {
      const cls = (node as Element).getAttribute("class") ?? "";
      const m = /(?:^|\s)code-k-([a-z-]+)/.exec(cls);
      const at = m ? (TOKEN_KINDS as readonly string[]).indexOf(m[1] as string) : -1;
      kind = at > 0 ? at : 0;
    }
    runs.push([text, kind]);
  }
  return runs;
}

/**
 * A highlighter over runs known ahead of time (from the build, or read from
 * the page), falling back to `load` for code nobody has colored yet. Every
 * answer is checked against the code before a block paints it.
 */
export function bakedHighlighter(
  baked: ReadonlyMap<string, unknown>,
  load?: (lang: string, code: string) => Promise<unknown>,
): CodeHighlighter {
  const key = (lang: string, code: string) => `${lang}\u0000${code}`;
  const done = new Map<string, CodeRun[] | null>();
  return {
    peek(lang, code) {
      const k = key(lang, code);
      if (done.has(k)) return done.get(k);
      if (!baked.has(k)) return load ? undefined : null;
      const runs = validateRuns(baked.get(k), code);
      done.set(k, runs);
      return runs;
    },
    async load(lang, code) {
      const k = key(lang, code);
      if (done.has(k)) return done.get(k) ?? null;
      let runs: CodeRun[] | null = null;
      try {
        runs = load ? validateRuns(await load(lang, code), code) : null;
      } catch {
        runs = null;
      }
      done.set(k, runs);
      return runs;
    },
  };
}

/** The key `bakedHighlighter` looks a block up by. */
export function bakedKey(lang: string | null, code: string): string | null {
  const known = codeLangOf(lang);
  return known ? `${known}\u0000${code}` : null;
}
