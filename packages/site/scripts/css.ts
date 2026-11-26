// The build's CSS steps. The overlay sheet is written like the extension's
// (unscoped, at 1×); here it becomes one file that dresses both the demo's
// shadow root and the fragments in the page: every selector goes under
// `.ov`, `:host` becomes `.ov` itself, and every px length is multiplied by
// the extension's default overlay zoom.

/** Remove comments and the whitespace nothing needs. Safe for the sheets this package ships. */
export function minifyCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{};,>])\s*/g, "$1")
    .replace(/;}/g, "}")
    .replace(/:\s+/g, ":")
    .trim();
}

/** Multiply every px length (the extension's `zoomCss`); vw, vh, em and unitless numbers stay. */
export function zoomCss(css: string, zoom: number): string {
  if (zoom === 1) return css;
  return css.replace(/(-?\d*\.?\d+)px/g, (_, n: string) => {
    const v = Math.round(Number(n) * zoom * 1000) / 1000;
    return `${v}px`;
  });
}

function matchBrace(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    const ch = css[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error("unbalanced braces in CSS");
}

/** Split a selector list on its top-level commas. */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    else if (ch === "," && depth === 0) {
      out.push(list.slice(start, i));
      start = i + 1;
    }
  }
  out.push(list.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

function scopeSelector(selector: string, scope: string): string {
  // `:host(.x) rest` is the scope carrying `.x`; `:host rest` is the scope.
  const withClass = /^:host\(([^)]+)\)(.*)$/s.exec(selector);
  if (withClass) return `${scope}${withClass[1]}${withClass[2]}`;
  if (selector.startsWith(":host")) return `${scope}${selector.slice(":host".length)}`;
  return `${scope} ${selector}`;
}

/**
 * Put every rule under `scope`. Conditional groups (`@media`, `@supports`)
 * are scoped inside; `@keyframes` and `@font-face` are left as they are.
 */
export function scopeCss(css: string, scope: string): string {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let out = "";
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) {
      out += src.slice(i).trim();
      break;
    }
    const prelude = src.slice(i, open).trim();
    const close = matchBrace(src, open);
    const body = src.slice(open + 1, close);
    if (/^@(keyframes|font-face)\b/.test(prelude)) out += `${prelude}{${body}}\n`;
    else if (prelude.startsWith("@")) out += `${prelude}{\n${scopeCss(body, scope)}}\n`;
    else
      out += `${splitSelectors(prelude)
        .map((s) => scopeSelector(s, scope))
        .join(",")}{${body}}\n`;
    i = close + 1;
  }
  return out;
}
