/**
 * One corpus for the rule a program is checked by without a page
 * (`program-rules.ts`) and the engine that applies it (`@onlay/render`
 * `preview-engine.ts`): both test files run it, so the space never says "ok"
 * to a step the engine refuses on every page, and never refuses one the engine
 * would apply. Test data only.
 */
import type { MutationOp } from "./variant";

type FragmentVerdict = "shows" | "fragment-empty" | "fragment-disallowed";

export interface FragmentCase {
  html: string;
  /** What the space's reading says: a refusal, or null (it lets the engine decide). */
  server: "fragment-empty" | "fragment-disallowed" | null;
  /** What the engine's DOM sanitizer finds; absent where only a real browser's parser can tell. */
  engine?: FragmentVerdict;
}

export const FRAGMENT_CASES: FragmentCase[] = [
  // The session that found this: a "sink" that shows nothing.
  { html: '<span class="onlay-sink"></span>', server: "fragment-empty", engine: "fragment-empty" },
  { html: "", server: "fragment-empty", engine: "fragment-empty" },
  { html: "   ", server: "fragment-empty", engine: "fragment-empty" },
  { html: "&nbsp;", server: "fragment-empty", engine: "fragment-empty" },
  { html: "<!-- a comment -->", server: "fragment-empty", engine: "fragment-empty" },
  {
    html: '<span class="a"></span><span class="b"></span>',
    server: "fragment-empty",
    engine: "fragment-empty",
  },
  { html: "<table></table>", server: "fragment-empty", engine: "fragment-empty" },
  {
    html: "<script>alert(1)</script>",
    server: "fragment-disallowed",
    engine: "fragment-disallowed",
  },
  {
    html: "<style>p { color: red }</style>",
    server: "fragment-disallowed",
    engine: "fragment-disallowed",
  },
  { html: "<form><p>Hi</p></form>", server: "fragment-disallowed", engine: "fragment-disallowed" },
  { html: '<input type="text">', server: "fragment-disallowed", engine: "fragment-disallowed" },
  {
    html: '<iframe src="/x"></iframe>',
    server: "fragment-disallowed",
    engine: "fragment-disallowed",
  },
  {
    html: "<textarea><b>x</b></textarea>",
    server: "fragment-disallowed",
    engine: "fragment-disallowed",
  },
  {
    html: "<template><p>x</p></template>",
    server: "fragment-disallowed",
    engine: "fragment-disallowed",
  },
  {
    html: "<span></span><script>x()</script>",
    server: "fragment-disallowed",
    engine: "fragment-disallowed",
  },
  // Foreign content and unknown tags: the reading isn't sure, the engine decides.
  { html: "<svg><script>alert(1)</script></svg>", server: null, engine: "fragment-disallowed" },
  { html: "<my-widget>Text</my-widget>", server: null, engine: "fragment-disallowed" },
  // What shows.
  { html: "hello", server: null, engine: "shows" },
  { html: "<b>bold</b>", server: null, engine: "shows" },
  { html: "<p>&nbsp;</p>", server: null, engine: "shows" },
  { html: "<div><span></span></div>", server: null, engine: "shows" },
  { html: "<span>  </span>", server: null, engine: "shows" },
  { html: "<br>", server: null, engine: "shows" },
  { html: "<hr/>", server: null, engine: "shows" },
  { html: '<img src="/a.png" alt="">', server: null, engine: "shows" },
  { html: '<a href="javascript:x()">Go</a>', server: null, engine: "shows" },
  { html: '<p title="a>b">x</p>', server: null, engine: "shows" },
  { html: "<tr><td>x</td></tr>", server: null, engine: "shows" },
  { html: '<div class="badge">New<script>x()</script></div>', server: null, engine: "shows" },
  // The parser drops the newline that opens a `pre`: nothing is left to show
  // (the HTML spec and Chromium do; happy-dom keeps it, so no engine verdict here).
  { html: "<pre>\n</pre>", server: "fragment-empty" },
  { html: "<pre>\n\n</pre>", server: null, engine: "shows" },
  // References are case-sensitive: the browser shows `&nBsP;` as text.
  { html: "&nBsP;", server: null, engine: "shows" },
  { html: "&NBSP;", server: null, engine: "shows" },
  { html: "&nbsp", server: "fragment-empty", engine: "fragment-empty" },
  { html: "&Tab;&NewLine;", server: "fragment-empty", engine: "fragment-empty" },
  // Parser quirks a real browser shows (the reading lets them through).
  { html: "<!-->hello", server: null },
  { html: "</br>", server: null },
  { html: "<div></p></div>", server: null },
  { html: '<image src="/a.png">', server: null },
];

/** A step the rule refuses on every page, or lets the page decide (`null`). */
export interface OpCase {
  op: MutationOp;
  page?: boolean;
  server: string | null;
  /** The element the engine test aims the step at (inside a `#root` block). */
  on?: string;
}

export const OP_CASES: OpCase[] = [
  {
    op: { op: "setAttr", target: ".t", name: "onclick", value: "x()" },
    server: "attr-rejected",
    on: "<a class=t>a</a>",
  },
  {
    op: { op: "setAttr", target: ".t", name: "style", value: "color:red" },
    server: "attr-rejected",
    on: "<p class=t>p</p>",
  },
  {
    op: { op: "setAttr", target: ".t", name: "srcdoc", value: "<p>x</p>" },
    server: "attr-rejected",
    on: "<div class=t></div>",
  },
  {
    op: { op: "setAttr", target: ".t", name: "autofocus", value: "" },
    server: "attr-rejected",
    on: "<button class=t>b</button>",
  },
  {
    op: { op: "setAttr", target: ".t", name: "rel", value: "opener" },
    server: "attr-denied",
    on: "<a class=t>a</a>",
  },
  {
    op: { op: "setAttr", target: ".t", name: "type", value: "submit" },
    server: "attr-denied",
    on: "<button class=t>b</button>",
  },
  {
    op: { op: "setAttr", target: ".t", name: "href", value: "javascript:alert(1)" },
    server: "attr-rejected",
    on: "<a class=t>a</a>",
  },
  {
    op: { op: "setAttr", target: ".t", name: "src", value: "//evil.example/x.png" },
    server: "attr-rejected",
    on: "<img class=t>",
  },
  // A name the DOM rejects would throw part-way through a program: refused before any write.
  {
    op: { op: "setAttr", target: ".t", name: "data-x y", value: "1" },
    server: "attr-rejected",
    on: "<div class=t></div>",
  },
  {
    op: { op: "setAttr", target: ".t", name: 'aria-"label', value: "1" },
    server: "attr-rejected",
    on: "<div class=t></div>",
  },
  {
    op: { op: "setAttr", target: ".t", name: "data-a=b", value: "1" },
    server: "attr-rejected",
    on: "<div class=t></div>",
  },
  {
    op: { op: "setAttr", target: ".t", name: "href", value: "https://example.com/" },
    server: null,
    on: "<a class=t>a</a>",
  },
  {
    op: { op: "setAttr", target: ".t", name: "data-state", value: "on" },
    server: null,
    on: "<div class=t></div>",
  },
  {
    op: { op: "setAttr", target: ".t", name: "title", value: null },
    server: null,
    on: "<div class=t></div>",
  },
  {
    op: { op: "setStyle", target: ".t", props: [{ prop: "--x", value: "1" }] },
    server: "style-property",
    on: "<div class=t></div>",
  },
  {
    op: { op: "setStyle", target: ".t", props: [{ prop: "Color", value: "red" }] },
    server: "style-property",
    on: "<div class=t></div>",
  },
  {
    op: { op: "setStyle", target: ".t", props: [{ prop: "behavior", value: "x" }] },
    server: "style-value",
    on: "<div class=t></div>",
  },
  {
    op: { op: "setStyle", target: ".t", props: [{ prop: "width", value: "expression(1)" }] },
    server: "style-value",
    on: "<div class=t></div>",
  },
  {
    op: {
      op: "setStyle",
      target: ".t",
      props: [{ prop: "background", value: "url(javascript:x)" }],
    },
    server: "style-value",
    on: "<div class=t></div>",
  },
  {
    op: {
      op: "setStyle",
      target: ".t",
      props: [{ prop: "background", value: "u\\72l(javascript:x)" }],
    },
    server: "style-value",
    on: "<div class=t></div>",
  },
  {
    op: {
      op: "setStyle",
      target: ".t",
      props: [{ prop: "background", value: "url(data:image/png;base64,AA==)" }],
    },
    server: null,
    on: "<div class=t></div>",
  },
  {
    op: { op: "setStyle", target: ".t", props: [{ prop: "color", value: "red" }] },
    server: null,
    on: "<div class=t></div>",
  },
  {
    op: { op: "setClass", target: ".t", add: ["two words"], remove: [] },
    server: "class-name",
    on: "<div class=t></div>",
  },
  {
    op: { op: "setClass", target: ".t", add: [], remove: [""] },
    server: "class-name",
    on: "<div class=t></div>",
  },
  {
    op: { op: "setClass", target: ".t", add: ["fine"], remove: [] },
    server: null,
    on: "<div class=t></div>",
  },
  { op: { op: "setText", target: ":scope", text: "x" }, page: true, server: "page-root-text" },
  { op: { op: "setText", target: "body", text: "x" }, page: true, server: "page-root-text" },
  {
    op: { op: "insertFragment", target: "body", position: "replace", html: "<p>x</p>" },
    page: true,
    server: "page-root-replace",
  },
  {
    op: { op: "insertFragment", target: ":scope", position: "append", html: "<p>x</p>" },
    page: true,
    server: null,
  },
  { op: { op: "setText", target: ":scope", text: "x" }, server: null, on: "<div class=t></div>" },
  {
    op: {
      op: "insertFragment",
      target: ".t",
      position: "append",
      html: '<span class="onlay-sink"></span>',
    },
    server: "fragment-empty",
    on: "<div class=t></div>",
  },
];
