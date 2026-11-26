// Code blocks in the overlay. The block itself is @onlay/render's; colors
// come from the service worker (Shiki never loads in a page), as runs that
// the shared highlighter validates against the code before painting.
import type { FenceBlock } from "@onlay/protocol";
import {
  type CodeBlockDeps,
  type CodeHighlighter,
  codeBlock,
  createCodeHighlighter,
} from "@onlay/render/code-block";
import { isTrustedEvent } from "./trusted";

let shared: CodeHighlighter | null = null;

/** The overlay's one highlighter: the service worker's `highlight` handler. */
function highlighter(): CodeHighlighter {
  shared ??= createCodeHighlighter(async (lang, code) => {
    const res = (await chrome.runtime.sendMessage({ type: "highlight", lang, code })) as
      | { ok?: unknown; runs?: unknown }
      | undefined;
    return res?.ok === true ? res.runs : null;
  });
  return shared;
}

/** Tests swap in their own highlighter (or none). */
export function setCodeHighlighter(h: CodeHighlighter | null): void {
  shared = h;
}

function writeClipboard(text: string): Promise<boolean> {
  try {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

/** One fenced block of a message, as the overlay shows it. */
export function overlayCodeBlock(doc: Document, b: FenceBlock): HTMLElement {
  const deps: CodeBlockDeps = {
    copy: writeClipboard,
    trusted: isTrustedEvent,
    highlighter:
      shared ?? (typeof chrome !== "undefined" && chrome.runtime?.id ? highlighter() : undefined),
  };
  return codeBlock(doc, { code: b.code, label: b.lang, lang: b.lang }, deps);
}
