/**
 * HTML → compact structure-preserving markdown (ADR-0017 §2).
 *
 * The captured element's sanitized `outerHTML` is rendered into a bounded
 * markdown excerpt for agent wakes: tables become GitHub markdown tables
 * (the deepswe benchmark-table failure this kills — a table must NOT arrive
 * as `70%±3%$13.4180k68`), lists become bullets, headings become `#`. This
 * runs server-side with no DOM, so it carries its own tiny, forgiving HTML
 * parser. It is DISPLAY only — the caller declassifies the OUTPUT before it
 * reaches a prompt; this function never trusts its input.
 */

interface ElNode {
  type: "el";
  tag: string;
  children: Node[];
}
interface TextNode {
  type: "text";
  text: string;
}
type Node = ElNode | TextNode;

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

/** Tokenize + build a forgiving tree (auto-closes, ignores comments/DOCTYPE). */
function parseHtml(html: string): Node[] {
  const root: ElNode = { type: "el", tag: "#root", children: [] };
  const stack: ElNode[] = [root];
  const tagRe = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g;
  const top = (): ElNode => stack[stack.length - 1] as ElNode;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical tokenizer loop
  while ((m = tagRe.exec(html)) !== null) {
    const chunk = m[0];
    if (chunk.startsWith("<!--") || chunk.startsWith("<![CDATA[")) continue;
    if (chunk[0] !== "<") {
      const text = decodeEntities(chunk);
      if (text.length > 0) top().children.push({ type: "text", text });
      continue;
    }
    if (chunk.startsWith("<!") || chunk.startsWith("<?")) continue; // doctype/PI
    const close = chunk.startsWith("</");
    const nameMatch = /^<\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(chunk);
    if (!nameMatch) continue;
    const tag = (nameMatch[1] as string).toLowerCase();
    if (close) {
      // Pop to the nearest matching open (auto-closing anything between).
      for (let i = stack.length - 1; i >= 1; i--) {
        if ((stack[i] as ElNode).tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const node: ElNode = { type: "el", tag, children: [] };
    top().children.push(node);
    const selfClose = chunk.endsWith("/>") || VOID.has(tag);
    if (!selfClose) stack.push(node);
  }
  return root.children;
}

/* ── markdown emit ─────────────────────────────────────────────────── */

const INLINE = new Set([
  "a",
  "b",
  "strong",
  "i",
  "em",
  "code",
  "span",
  "small",
  "sub",
  "sup",
  "abbr",
  "mark",
  "u",
  "s",
  "del",
  "ins",
  "kbd",
]);

function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ");
}

/** Inline markdown for a node's descendants (used inside cells, headings, …). */
function inlineOf(nodes: Node[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.type === "text") {
      out += collapseWs(n.text);
      continue;
    }
    const inner = inlineOf(n.children);
    switch (n.tag) {
      case "br":
        out += " ";
        break;
      case "b":
      case "strong":
        out += inner ? `**${inner}**` : "";
        break;
      case "i":
      case "em":
        out += inner ? `*${inner}*` : "";
        break;
      case "code":
      case "kbd":
        out += inner ? `\`${inner}\`` : "";
        break;
      default:
        out += inner;
    }
  }
  return out;
}

function tableCells(tr: ElNode): string[] {
  const cells: string[] = [];
  for (const c of tr.children) {
    if (c.type === "el" && (c.tag === "td" || c.tag === "th")) {
      cells.push(inlineOf(c.children).trim().replace(/\|/g, "\\|"));
    }
  }
  return cells;
}

function collectRows(table: ElNode): ElNode[] {
  const rows: ElNode[] = [];
  const walk = (n: ElNode): void => {
    for (const c of n.children) {
      if (c.type !== "el") continue;
      if (c.tag === "tr") rows.push(c);
      else if (c.tag === "thead" || c.tag === "tbody" || c.tag === "tfoot") walk(c);
    }
  };
  walk(table);
  return rows;
}

/** GitHub-flavored markdown table — the flagship structure-preserving case. */
function renderTable(table: ElNode): string {
  const rows = collectRows(table);
  if (rows.length === 0) return "";
  const matrix = rows.map(tableCells).filter((r) => r.length > 0);
  if (matrix.length === 0) return "";
  const cols = Math.max(...matrix.map((r) => r.length));
  const pad = (r: string[]): string[] => {
    const copy = [...r];
    while (copy.length < cols) copy.push("");
    return copy;
  };
  const header = pad(matrix[0] as string[]);
  const lines = [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
  for (const r of matrix.slice(1)) lines.push(`| ${pad(r).join(" | ")} |`);
  return lines.join("\n");
}

function renderBlocks(nodes: Node[], depth = 0): string[] {
  const blocks: string[] = [];
  for (const n of nodes) {
    if (n.type === "text") {
      const t = collapseWs(n.text).trim();
      if (t) blocks.push(t);
      continue;
    }
    const tag = n.tag;
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      const text = inlineOf(n.children).trim();
      if (text) blocks.push(`${"#".repeat(level)} ${text}`);
    } else if (tag === "table") {
      const md = renderTable(n);
      if (md) blocks.push(md);
    } else if (tag === "ul" || tag === "ol") {
      const ordered = tag === "ol";
      const items: string[] = [];
      let i = 0;
      for (const c of n.children) {
        if (c.type !== "el" || c.tag !== "li") continue;
        i += 1;
        const marker = ordered ? `${i}.` : "-";
        const indent = "  ".repeat(depth);
        // Split an li into its inline lead and any nested block children.
        const lead = inlineOf(c.children.filter((x) => x.type === "text" || INLINE.has(x.tag)));
        const nested = renderBlocks(
          c.children.filter((x) => x.type === "el" && !INLINE.has(x.tag)),
          depth + 1,
        );
        items.push(`${indent}${marker} ${lead.trim()}`.trimEnd());
        for (const b of nested) items.push(b);
      }
      if (items.length > 0) blocks.push(items.join("\n"));
    } else if (tag === "pre") {
      const text = textContent(n).replace(/\n+$/, "");
      if (text) blocks.push(`\`\`\`\n${text}\n\`\`\``);
    } else if (tag === "blockquote") {
      const inner = renderBlocks(n.children, depth).join("\n\n");
      if (inner)
        blocks.push(
          inner
            .split("\n")
            .map((l) => `> ${l}`)
            .join("\n"),
        );
    } else if (tag === "hr") {
      blocks.push("---");
    } else if (INLINE.has(tag)) {
      const t = inlineOf([n]).trim();
      if (t) blocks.push(t);
    } else {
      // Generic block container (div/section/article/p/td/…): recurse.
      if (tag === "p") {
        const t = inlineOf(n.children).trim();
        if (t) blocks.push(t);
      } else {
        for (const b of renderBlocks(n.children, depth)) blocks.push(b);
      }
    }
  }
  return blocks;
}

function textContent(n: Node): string {
  if (n.type === "text") return n.text;
  return n.children.map(textContent).join("");
}

/**
 * Convert sanitized HTML to a compact markdown excerpt, capped at `maxLen`.
 * A truncation is marked with a trailing `…`.
 */
export function htmlToMarkdown(html: string, maxLen: number): string {
  const tree = parseHtml(html);
  const md = renderBlocks(tree)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (md.length <= maxLen) return md;
  return `${md.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}
