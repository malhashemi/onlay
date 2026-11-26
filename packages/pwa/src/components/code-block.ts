// Code blocks in the web app: @onlay/render's block, with colors from Shiki
// in a chunk of its own, fetched the first time a page shows a block in a
// language it colors. Until then (or if it never loads) the block shows
// uncolored and copies all the same.
import {
  type CodeHighlighter,
  type CodeLang,
  codeBlock,
  createCodeHighlighter,
} from "@onlay/render/code-block";
import { copyText } from "../dom";

let shared: CodeHighlighter | null = null;

async function loadRuns(lang: CodeLang, code: string): Promise<unknown> {
  const { highlightRuns } = await import("@onlay/render/highlight");
  return highlightRuns(lang, code);
}

function highlighter(): CodeHighlighter {
  shared ??= createCodeHighlighter(loadRuns);
  return shared;
}

/** Tests swap in their own highlighter. */
export function setCodeHighlighter(h: CodeHighlighter | null): void {
  shared = h;
}

/**
 * A code block: `code`, colored as `lang` when it is one of ours, with an
 * optional label in its frame and a Copy button named `copyLabel`.
 */
export function webCodeBlock(
  code: string,
  opts: { lang?: string | null; label?: string | null; copyLabel?: string } = {},
): HTMLElement {
  return codeBlock(
    document,
    { code, lang: opts.lang ?? null, label: opts.label ?? null },
    {
      copy: copyText,
      failedText: "Couldn't copy. Your browser blocked the clipboard.",
      highlighter: highlighter(),
      copyLabel: opts.copyLabel,
    },
  );
}
