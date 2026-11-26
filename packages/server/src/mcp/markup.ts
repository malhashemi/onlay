/**
 * Captured markup for `read_markup` (spec §9): a character slice, or the
 * elements a CSS selector matches, extracted with the Workers HTMLRewriter.
 *
 * Extraction marks each match with a comment carrying a per-call nonce before
 * and after the element, then cuts between the marks, so a match's markup is
 * exactly what the capture holds. Nested matches are cut out of the outer one
 * separately and their marks removed.
 */

/** At most this many matches are returned. */
export const MAX_SELECTOR_MATCHES = 20;

export interface Selection {
  /** Each returned match's markup, in document order. */
  matches: string[];
  /** Every match the selector found, returned or not. */
  found: number;
  /** True when a match was cut short or left out to stay within the size. */
  truncated: boolean;
}

/** null when HTMLRewriter does not support the selector. */
export async function selectElements(
  html: string,
  selector: string,
  maxChars: number,
): Promise<Selection | null> {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  let found = 0;
  let rewriter: HTMLRewriter;
  try {
    rewriter = new HTMLRewriter().on(selector, {
      element(el) {
        const i = found++;
        if (i >= MAX_SELECTOR_MATCHES) return;
        el.before(`<!--${nonce}:s:${i}-->`, { html: true });
        el.after(`<!--${nonce}:e:${i}-->`, { html: true });
      },
    });
  } catch {
    return null;
  }
  let marked: string;
  try {
    marked = await rewriter.transform(new Response(html)).text();
  } catch {
    return null;
  }
  const marks = new RegExp(`<!--${nonce}:[se]:\\d+-->`, "g");
  const matches: string[] = [];
  let used = 0;
  let truncated = found > MAX_SELECTOR_MATCHES;
  for (let i = 0; i < Math.min(found, MAX_SELECTOR_MATCHES); i++) {
    const open = `<!--${nonce}:s:${i}-->`;
    const close = `<!--${nonce}:e:${i}-->`;
    const start = marked.indexOf(open);
    const end = marked.indexOf(close, start);
    if (start < 0 || end < 0) continue;
    const element = marked.slice(start + open.length, end).replace(marks, "");
    const room = maxChars - used;
    if (room <= 0) {
      truncated = true;
      break;
    }
    if (element.length > room) {
      matches.push(element.slice(0, room));
      truncated = true;
      break;
    }
    matches.push(element);
    used += element.length;
  }
  return { matches, found, truncated };
}
