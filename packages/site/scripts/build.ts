// Build @onlay/site → packages/site/dist/: a static landing page.
//
//   dist/index.html            the page, complete as markup (no-cache)
//   dist/site/*                everything it loads, each named by its content
//                              (immutable): scripts, two stylesheets, fonts,
//                              the film and its poster, the icon
//   dist/asset-manifest.json   what to serve, with content types and caching
//                              (for the step that wires this into the Worker;
//                              never served itself)
//
// The page's section fragments and code samples are rendered here, in a
// happy-dom document, by the same views the browser runs, and the code is
// colored here by the product's highlighter: the page needs no script to be
// whole, and no highlighter to be colored.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFences } from "@onlay/protocol";
import { applyProgramToRoot } from "@onlay/render";
import { CODE_BLOCK_CSS, codeLangOf } from "@onlay/render/code-block";
import { highlightRuns } from "@onlay/render/highlight";
import { Window } from "happy-dom";
import { FILM, PAGE_ORIGIN, SERVICE_ORIGIN, STORE_LISTED } from "../src/config";
import { OWN } from "../src/copy";
import { buildFragment, FRAGMENTS, type FragmentName } from "../src/fragments";
import { useDocument } from "../src/overlay/dom";
import { bakedHighlighter, bakedKey, fencedBlock } from "../src/overlay/rich";
import { AGENT_SETUP, type CodeSlot, renderPage } from "../src/page";
import { asStaticExample } from "../src/static";
import { minifyCss, scopeCss, zoomCss } from "./css";
import { ownScripts, sendingOrStoringNames } from "./scan";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");
/** Where the finished build lives. It is written beside it and swapped in whole at the end, so a failed build never takes a served page down. */
const FINAL = join(ROOT, "dist");
const DIST = join(ROOT, ".dist-next");
/** Where the page's files are served from. */
const BASE = "/site/";
const OUT = join(DIST, "site");
/** The extension's default overlay zoom (`UI_ZOOM_DEFAULT`). */
const OVERLAY_ZOOM = 1.25;

rmSync(DIST, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

interface Served {
  path: string;
  contentType: string;
  cache: "immutable" | "no-cache";
  bytes: number;
}
const served: Served[] = [];

function hash8(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 8);
}

/** Write a file under dist/site/, named by its content; returns its served path. */
function emit(base: string, ext: string, bytes: Uint8Array | string, contentType: string): string {
  const name = `${base}.${hash8(bytes)}.${ext}`;
  writeFileSync(join(OUT, name), bytes);
  served.push({
    path: `${BASE}${name}`,
    contentType,
    cache: "immutable",
    bytes: statSync(join(OUT, name)).size,
  });
  return `${BASE}${name}`;
}

/* ── scripts: a small entry, and everything else in chunks it asks for later ── */
const js = await Bun.build({
  entrypoints: [join(SRC, "main.ts")],
  outdir: OUT,
  target: "browser",
  format: "esm",
  splitting: true,
  minify: true,
  naming: { entry: "[name].[hash].[ext]", chunk: "chunk.[hash].[ext]" },
});
if (!js.success) {
  console.error(js.logs.join("\n"));
  throw new Error("script build failed");
}
let entry = "";
for (const out of js.outputs) {
  const name = out.path.split("/").pop() as string;
  if (out.kind === "entry-point") entry = `${BASE}${name}`;
  served.push({
    path: `${BASE}${name}`,
    contentType: "text/javascript; charset=utf-8",
    cache: "immutable",
    bytes: out.size,
  });
}
if (!entry) throw new Error("script build produced no entry");

// "Nothing is sent or stored": none of the page's own scripts may so much as
// name an API that sends or keeps anything (scan.ts says what this cannot see).
const scripts = ownScripts(entry.slice(BASE.length), (name) =>
  readFileSync(join(OUT, name), "utf8"),
);
for (const name of scripts.own) {
  const uses = sendingOrStoringNames(readFileSync(join(OUT, name), "utf8"));
  if (uses.length > 0)
    throw new Error(`${name} names ${uses.join(", ")}: the page sends and stores nothing`);
}

/* ── fonts, the film, the icon ── */
// IBM's own split files, unmodified (src/assets/fonts; THIRD-PARTY-NOTICES.md):
// each face's Latin1 file, and its Pi file for the arrows and symbols.
const FONTS = (["Sans", "Mono"] as const).flatMap((family) =>
  (["Regular", "Medium", "SemiBold"] as const).flatMap((weight) =>
    (["Latin1", "Pi"] as const).map((subset) => `IBMPlex${family}-${weight}-${subset}`),
  ),
);
const fontPath = new Map<string, string>();
for (const f of FONTS) {
  const bytes = readFileSync(join(SRC, "assets", "fonts", `${f}.woff2`));
  fontPath.set(f, emit(f, "woff2", bytes, "font/woff2"));
}
const film = emit("film", "mp4", readFileSync(join(SRC, FILM.src)), "video/mp4");
const poster = emit("film-poster", "webp", readFileSync(join(SRC, FILM.poster)), "image/webp");
// Onlay's licence and the third-party notices (fonts, icons, Shiki's grammars,
// bundled packages), linked from the footer.
const TEXT = "text/plain; charset=utf-8";
const license = emit("LICENSE", "txt", readFileSync(join(SRC, "../../../LICENSE")), TEXT);
const notices = emit(
  "THIRD-PARTY-NOTICES",
  "txt",
  readFileSync(join(SRC, "../../../THIRD-PARTY-NOTICES.md")),
  TEXT,
);
const favicon = emit(
  "favicon",
  "svg",
  readFileSync(join(SRC, "assets", "favicon.svg")),
  "image/svg+xml",
);

/* ── stylesheets ── */
// The page's: its own rules, then the shared code block's (from @onlay/render).
let siteCss = `${readFileSync(join(SRC, "styles", "site.css"), "utf8")}\n${CODE_BLOCK_CSS}`;
for (const f of FONTS) {
  const from = `url("fonts/${f}.woff2")`;
  if (!siteCss.includes(from)) throw new Error(`site.css does not use ${f}`);
  siteCss = siteCss.replace(from, `url("${fontPath.get(f)}")`);
}
const css = emit("site", "css", minifyCss(siteCss), "text/css; charset=utf-8");

// The overlay's: the sheet and the code block at the overlay's zoom, the orb
// at 1× (as in the extension), everything under `.ov`.
const overlaySrc = readFileSync(join(SRC, "styles", "overlay.css"), "utf8");
const orbSrc = readFileSync(join(SRC, "styles", "orb.css"), "utf8");
const overlayCss = emit(
  "overlay",
  "css",
  minifyCss(
    scopeCss(zoomCss(`${overlaySrc}\n${CODE_BLOCK_CSS}`, OVERLAY_ZOOM), ".ov") +
      scopeCss(orbSrc, ".ov"),
  ),
  "text/css; charset=utf-8",
);

/* ── the fragments and code samples, as markup ── */
const window = new Window({ url: `${PAGE_ORIGIN}/` });
const doc = window.document as unknown as Document;
useDocument(doc);

const samples: Record<CodeSlot, { code: string; lang: string | null }> = {
  claude: { code: AGENT_SETUP.claude, lang: "bash" },
  codex: { code: AGENT_SETUP.codex, lang: "bash" },
  others: { code: AGENT_SETUP.others, lang: "bash" },
  mcpUrl: { code: AGENT_SETUP.mcpUrl(), lang: null },
  mcpConfig: { code: AGENT_SETUP.mcpConfig(), lang: "json" },
};
// Color every sample now, with the product's highlighter.
const toColor = [
  ...Object.values(samples),
  ...parseFences(OWN.sample.agentAnswer).map((b) => ({ code: b.code, lang: b.lang })),
];
const baked = new Map<string, unknown>();
for (const s of toColor) {
  const lang = codeLangOf(s.lang);
  const key = bakedKey(s.lang, s.code);
  if (!lang || !key) continue;
  const runs = await highlightRuns(lang, s.code);
  if (!runs) throw new Error(`could not color the ${s.lang} sample`);
  baked.set(key, runs);
}
const highlighter = bakedHighlighter(baked);
const rich = { highlighter, copy: () => Promise.resolve(false) };

function markup(node: Element, what: string): string {
  const html = node.outerHTML;
  // The page's policy is `style-src 'self'`: built markup carries no inline style.
  if (/\sstyle=/.test(html)) throw new Error(`${what} carries an inline style`);
  return html;
}

const fragments = {} as Record<FragmentName, string>;
for (const name of FRAGMENTS) {
  const node = buildFragment(name, {
    now: Date.now(),
    rich,
    applyVariant: (plan, variant) => {
      if (variant) applyProgramToRoot(plan, variant.program);
    },
  });
  // Until the page's script takes it over, a fragment is an example to read.
  asStaticExample(node);
  fragments[name] = markup(node, `the ${name} fragment`);
}
const code = {} as Record<CodeSlot, string>;
for (const [slot, s] of Object.entries(samples) as Array<[CodeSlot, (typeof samples)[CodeSlot]]>) {
  code[slot] = markup(fencedBlock(s.code, s.lang, rich), `the ${slot} sample`);
}

/* ── the page ── */
const html = renderPage({
  css,
  overlayCss,
  js: entry,
  favicon,
  film,
  poster,
  license,
  notices,
  // The faces of the first view: the headline, the text, the micro-labels.
  preload: [
    "IBMPlexSans-SemiBold-Latin1",
    "IBMPlexSans-Regular-Latin1",
    "IBMPlexMono-SemiBold-Latin1",
  ].map((f) => fontPath.get(f) as string),
  fragments,
  code,
});
writeFileSync(join(DIST, "index.html"), html);
served.unshift({
  path: "/",
  contentType: "text/html; charset=utf-8",
  cache: "no-cache",
  bytes: Buffer.byteLength(html),
});

writeFileSync(
  join(DIST, "asset-manifest.json"),
  `${JSON.stringify({ index: "index.html", base: BASE, files: served }, null, 2)}\n`,
);

rmSync(FINAL, { recursive: true, force: true });
renameSync(DIST, FINAL);

const kb = (n: number): string => `${(n / 1024).toFixed(1)} kB`;
const gz = (path: string): string => {
  const rel = path === "/" ? "index.html" : path.slice(1);
  return kb(Bun.gzipSync(readFileSync(join(FINAL, rel))).length);
};
console.log(
  `built packages/site/dist/  (service ${SERVICE_ORIGIN}, store listed: ${STORE_LISTED})`,
);
console.log(
  `  ${scripts.own.length} own scripts name no sending or storing API; ${scripts.later.length} loaded on demand (the highlighter) is not scanned`,
);
for (const f of served) {
  const zipped = /\.(js|css|html|svg)$|^\/$/.test(f.path) ? `  gzip ${gz(f.path)}` : "";
  console.log(`  ${f.path.padEnd(46)} ${kb(f.bytes).padStart(10)}${zipped}`);
}
