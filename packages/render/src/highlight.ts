// Shiki, turned into code runs (text + a kind from code-block.ts's closed
// set). The fine-grained core with the JavaScript regex engine: no
// WebAssembly, no eval, so it runs under the web app's `script-src 'self'`
// and in the extension's service worker. The theme is Shiki's CSS-variables
// theme, read back as token kinds: colors are never taken from here, the
// clients paint each kind from the brand's tokens. Only the web app's lazy
// chunk and the extension's service worker import this file, never the
// overlay's content script.
import {
  createCssVariablesTheme,
  createHighlighterCore,
  type HighlighterCore,
  type LanguageRegistration,
} from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import { type CodeLang, type CodeRun, MAX_HIGHLIGHT_CHARS, TOKEN_KINDS } from "./code-block";

type Grammar = Promise<{ default: LanguageRegistration[] }>;

/** Each grammar loads the first time a block in its language shows. */
const GRAMMARS: Readonly<Record<CodeLang, () => Grammar>> = {
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  html: () => import("@shikijs/langs/html"),
  css: () => import("@shikijs/langs/css"),
  bash: () => import("@shikijs/langs/shellscript"),
  python: () => import("@shikijs/langs/python"),
  diff: () => import("@shikijs/langs/diff"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  sql: () => import("@shikijs/langs/sql"),
  markdown: () => import("@shikijs/langs/markdown"),
};

/** Shiki's own name for each language (bash is its `shellscript`). */
const SHIKI_NAME: Partial<Record<CodeLang, string>> = { bash: "shellscript" };

const PREFIX = "--onlay-code-";
const BASE = createCssVariablesTheme({ name: "onlay", variablePrefix: PREFIX, fontStyle: false });
// Markdown headings and strong text are font styles in the stock theme; here
// they are slots of their own, so the page can weigh them from its tokens.
const THEME = {
  ...BASE,
  tokenColors: [
    ...(BASE.tokenColors ?? []),
    { scope: ["markup.heading"], settings: { foreground: `var(${PREFIX}token-heading)` } },
    { scope: ["markup.bold"], settings: { foreground: `var(${PREFIX}token-strong)` } },
  ],
};

/** `var(--onlay-code-token-keyword)` → the index of `keyword`; anything else is plain. */
function kindOf(color: string | undefined): number {
  if (!color) return 0;
  const m = /^var\(--onlay-code-token-([a-z-]+)\)$/.exec(color);
  if (!m) return 0;
  const at = (TOKEN_KINDS as readonly string[]).indexOf(m[1] as string);
  return at > 0 ? at : 0;
}

let core: Promise<HighlighterCore> | null = null;
const loaded = new Map<CodeLang, Promise<boolean>>();

function highlighter(): Promise<HighlighterCore> {
  core ??= createHighlighterCore({
    themes: [THEME],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return core;
}

function ensure(h: HighlighterCore, lang: CodeLang): Promise<boolean> {
  let p = loaded.get(lang);
  if (!p) {
    p = h.loadLanguage(GRAMMARS[lang]()).then(
      () => true,
      () => false,
    );
    loaded.set(lang, p);
  }
  return p;
}

/**
 * The runs for `code` in `lang`, adjacent runs of one kind merged; null when
 * the language is not ours, the code is over the cap, or anything fails.
 */
export async function highlightRuns(lang: string, code: string): Promise<CodeRun[] | null> {
  if (!Object.hasOwn(GRAMMARS, lang)) return null;
  if (code.length === 0 || code.length > MAX_HIGHLIGHT_CHARS || code.includes("\r")) return null;
  const known = lang as CodeLang;
  try {
    const h = await highlighter();
    if (!(await ensure(h, known))) return null;
    const lines = h.codeToTokensBase(code, {
      lang: SHIKI_NAME[known] ?? known,
      theme: "onlay",
    });
    const runs: CodeRun[] = [];
    const push = (text: string, kind: number) => {
      if (!text) return;
      const last = runs[runs.length - 1];
      if (last && last[1] === kind) last[0] += text;
      else runs.push([text, kind]);
    };
    lines.forEach((line, i) => {
      if (i > 0) push("\n", 0);
      for (const t of line) push(t.content, kindOf(t.color));
    });
    return runs.map((r) => r[0]).join("") === code ? runs : null;
  } catch {
    return null;
  }
}
