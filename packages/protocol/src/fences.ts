// Fenced code blocks in message text: the one grammar every client reads.
// Storage and the wire never change: a body stays the same string, and only
// rendering parses it. A fence opens on a line that starts with three
// backticks, optionally followed by a language word, and closes on a line of
// three backticks and nothing else; an unclosed fence runs to the end of the
// text (a fence line that is the text's last line opens nothing). Nothing else is Markdown here: no inline code, no other syntax.

/** One fenced block, by its place in the original text. */
export interface FenceBlock {
  /** Where the block starts: the opening fence line, or the line break just before it. */
  start: number;
  /** Where the text after it resumes: past the closing fence line and its line break. */
  end: number;
  /** The language word, lower-cased; null when there is none or it is not one word. */
  lang: string | null;
  /** The code between the fences, lines joined with `\n` (a CRLF loses its CR). */
  code: string;
  /** False when the text ended before a closing fence. */
  closed: boolean;
}

const OPEN = /^```([^`]*)$/;
const CLOSE = /^```[ \t]*$/;
const LANG_WORD = /^[A-Za-z0-9_+#.-]{1,32}$/;

interface Line {
  /** Offset of the line's first character. */
  at: number;
  /** Offset just past the line's break (or the text's end). */
  next: number;
  /** The line without its break, a trailing CR dropped. */
  text: string;
}

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let at = 0;
  while (at <= text.length) {
    const nl = text.indexOf("\n", at);
    const stop = nl < 0 ? text.length : nl;
    const raw = text.slice(at, stop);
    lines.push({
      at,
      next: nl < 0 ? text.length : nl + 1,
      // A CR goes only as the first half of a CRLF; a bare one is the text's.
      text: nl >= 0 && raw.endsWith("\r") ? raw.slice(0, -1) : raw,
    });
    if (nl < 0) break;
    at = nl + 1;
  }
  return lines;
}

function langOf(info: string): string | null {
  const word = info.trim();
  return LANG_WORD.test(word) ? word.toLowerCase() : null;
}

/**
 * The fenced blocks in `text`, in order. The line break before an opening
 * fence belongs to the block, so the text around a block never ends or starts
 * with the break the block itself stands for.
 */
export function parseFences(text: string): FenceBlock[] {
  if (!text.includes("```")) return [];
  const lines = linesOf(text);
  const blocks: FenceBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = lines[i] as Line;
    const m = OPEN.exec(open.text);
    if (!m) {
      i += 1;
      continue;
    }
    const body: string[] = [];
    let j = i + 1;
    let closed = false;
    while (j < lines.length) {
      const line = lines[j] as Line;
      if (CLOSE.test(line.text)) {
        closed = true;
        break;
      }
      body.push(line.text);
      j += 1;
    }
    // A stray fence line on the last line, opening nothing, stays text.
    if (!closed && body.length === 0) break;
    const last = closed ? (lines[j] as Line) : (lines[lines.length - 1] as Line);
    // The break before the fence (`\n`, or `\r\n`) is the block's.
    const start =
      open.at === 0 ? 0 : text[open.at - 2] === "\r" && open.at >= 2 ? open.at - 2 : open.at - 1;
    blocks.push({
      start,
      end: last.next,
      lang: langOf(m[1] ?? ""),
      code: body.join("\n"),
      closed,
    });
    i = j + 1;
  }
  return blocks;
}

/**
 * The one preview formatter: `text` with each fenced block reduced to its
 * code, for previews (Inbox rows, notifications, quotes). No fence markers;
 * the words around a block stay on their own lines, even around an empty one.
 * Run it on the original text, before taking a first line or a cut.
 */
export function flattenFences(text: string): string {
  const blocks = parseFences(text);
  if (blocks.length === 0) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const b of blocks) {
    const before = text.slice(cursor, b.start);
    if (before) parts.push(before);
    if (b.code) parts.push(b.code);
    cursor = b.end;
  }
  const after = text.slice(cursor);
  if (after) parts.push(after);
  return parts.join("\n");
}

/** A quote's line: the first line of the text as previews show it. */
export function previewFirstLine(text: string): string {
  return flattenFences(text).split("\n")[0] ?? "";
}
