import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ONLAY_PROVENANCE_ATTR, ONLAY_SOURCE_ATTR } from "@onlay/protocol";
import MagicString from "magic-string";
import { readGitProvenance } from "./provenance";
import { onlayStampVite } from "./vite";

/** Astro 7 parses with @astrojs/compiler-rs; ≤6 with @astrojs/compiler. */
export type AstroParserFlavor = "compiler" | "compiler-rs";

export type TransformAstroOptions = {
  filename: string;
  root: string;
  dev: boolean;
  /**
   * Document-level provenance (ADR-0017 §3). Astro has no index.html for
   * Vite's transformIndexHtml, so the `<html>` element of a layout/page
   * template carries `data-onlay-provenance` instead.
   */
  provenance?: string;
  /** Force a parser flavor; by default the project's astro dependency decides. */
  parser?: AstroParserFlavor;
};

export type TransformAstroResult = {
  code: string;
  map?: unknown;
};

export type OnlayStampAstroOptions = {
  root?: string;
};

type ViteResolvedConfig = {
  root: string;
};

type ViteTransformResult = null | {
  code: string;
  map: null;
};

type VitePlugin = {
  name: string;
  enforce: "pre";
  apply: "serve";
  configResolved(config: ViteResolvedConfig): void;
  load(id: string): Promise<ViteTransformResult>;
};

/** Structural slice of Astro's integration API — enough to register plugins. */
type AstroConfigSetupContext = {
  command: string;
  updateConfig(config: { vite: { plugins: unknown[] } }): void;
};

export type OnlayAstroIntegration = {
  name: string;
  hooks: {
    "astro:config:setup"(context: AstroConfigSetupContext): void;
  };
};

type AstroAstNode = Record<string, unknown>;

type AstroParser = {
  flavor: AstroParserFlavor;
  parse(source: string, options: { position: boolean }): Promise<unknown>;
};

/** A stampable element occurrence found by either parser. */
type ElementSite = {
  name: string;
  /** UTF-8 byte offset of the `<` — null when the parser gave no position. */
  byteOffset: number | null;
  hasSourceAttr: boolean;
  hasProvenanceAttr: boolean;
};

/** DOM-rendered template nodes; components stay unstamped (attrs become props). */
const STAMPABLE_GO_NODE_TYPES = new Set(["element", "custom-element"]);

/** Compile-time-special elements where an injected attribute could change meaning. */
const UNSTAMPABLE_ELEMENT_NAMES = new Set(["script", "slot", "style"]);

export async function transformAstro(
  code: string,
  options: TransformAstroOptions,
): Promise<TransformAstroResult> {
  if (!options.dev) return { code };

  const parser = await loadAstroParser(options.root, options.parser);
  if (!parser) return { code };

  const sites: ElementSite[] = [];
  try {
    const result = (await parser.parse(code, { position: true })) as { ast?: unknown };
    if (parser.flavor === "compiler-rs") collectRsElements(result.ast, sites);
    else collectGoElements(result.ast, sites);
  } catch {
    // Malformed template — let Astro's own compiler report it.
    return { code };
  }

  const byteToChar = byteToCharConverter(code);
  const rootRelativeFile = toRootRelativeFile(options.filename, options.root);
  const output = new MagicString(code);
  let stamped = false;

  for (const site of sites) {
    // Both compilers report UTF-8 byte offsets; MagicString and line:col
    // math need UTF-16 string indices. The legacy compiler also leaves the
    // document-root <html> positionless when the page carries a <head> —
    // recover it lexically, it appears once.
    const offset =
      site.byteOffset === null
        ? site.name === "html"
          ? findHtmlTagOffset(code)
          : null
        : byteToChar(site.byteOffset);
    if (offset === null || !sourceMatchesTag(code, offset, site.name)) continue;
    const insertAt = offset + 1 + site.name.length;

    if (options.provenance && site.name === "html" && !site.hasProvenanceAttr) {
      output.appendLeft(
        insertAt,
        ` ${ONLAY_PROVENANCE_ATTR}="${escapeHtmlAttributeValue(options.provenance)}"`,
      );
      stamped = true;
    }

    if (site.hasSourceAttr) continue;
    const location = offsetToLineColumn(code, offset);
    const sourceValue = escapeHtmlAttributeValue(
      `${rootRelativeFile}:${location.line}:${location.column}`,
    );
    output.appendLeft(insertAt, ` ${ONLAY_SOURCE_ATTR}="${sourceValue}"`);
    stamped = true;
  }

  if (!stamped) return { code };
  return { code: output.toString() };
}

/** The `.astro` template stamp as a plain Vite plugin (dev-serve only). */
export function onlayStampAstroVite(options: OnlayStampAstroOptions = {}): VitePlugin {
  let config: ViteResolvedConfig | undefined;

  return {
    name: "onlay:astro-source-stamp",
    enforce: "pre",
    apply: "serve",
    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },
    // Astro compiles `.astro` inside its own enforce-pre transform, which runs
    // BEFORE integration-injected plugins — a transform hook here only ever
    // sees compiled TypeScript. Stamping in `load` hands Astro's compiler the
    // stamped template instead. Query sub-requests (?astro&type=style/script)
    // stay with Astro's own loader.
    async load(id) {
      if (id.includes("?") || !id.endsWith(".astro")) return null;

      let code: string;
      try {
        code = readFileSync(id, "utf8");
      } catch {
        return null;
      }

      const root = options.root ?? config?.root ?? process.cwd();
      const provenance = readGitProvenance(root);
      const result = await transformAstro(code, {
        dev: true,
        filename: id,
        root,
        ...(provenance ? { provenance } : {}),
      });
      if (result.code === code) return null;

      return { code: result.code, map: null };
    },
  };
}

/**
 * The Astro integration: registers the `.astro` template stamp plus the JSX
 * stamp for framework islands (React etc.). Dev-only twice over — the hook
 * bails outside `astro dev` and both plugins are `apply: "serve"`.
 */
export function onlayStampAstro(options: OnlayStampAstroOptions = {}): OnlayAstroIntegration {
  return {
    name: "onlay:source-stamp",
    hooks: {
      "astro:config:setup"(context) {
        if (context.command !== "dev") return;
        context.updateConfig({
          vite: { plugins: [onlayStampAstroVite(options), onlayStampVite(options)] },
        });
      },
    },
  };
}

export default onlayStampAstro;

/**
 * The Astro compiler is resolved at runtime from the host project (it ships
 * with `astro` itself) rather than bundled — its WASM/NAPI payload does not
 * survive bundling. Astro 7 depends on `@astrojs/compiler-rs`, older majors
 * on `@astrojs/compiler`; resolving through the project's own `astro`
 * dependency picks whichever the project actually uses, with bare imports as
 * a fallback for hoisted installs. Failure disables the stamp with a warning;
 * it never gates the dev server.
 */
const parserCache = new Map<string, Promise<AstroParser | null>>();

function loadAstroParser(root: string, flavor?: AstroParserFlavor): Promise<AstroParser | null> {
  const key = `${root}\0${flavor ?? "auto"}`;
  let cached = parserCache.get(key);
  if (!cached) {
    cached = importAstroParser(root, flavor);
    parserCache.set(key, cached);
  }
  return cached;
}

async function importAstroParser(
  root: string,
  flavor?: AstroParserFlavor,
): Promise<AstroParser | null> {
  const flavors: AstroParserFlavor[] = flavor ? [flavor] : ["compiler-rs", "compiler"];
  for (const candidate of flavors) {
    const packageName = candidate === "compiler-rs" ? "@astrojs/compiler-rs" : "@astrojs/compiler";
    const parse =
      (await importParseThroughAstro(root, packageName)) ?? (await importParseBare(packageName));
    if (parse) return { flavor: candidate, parse };
  }
  console.warn(
    `[onlay] source stamp disabled: neither @astrojs/compiler-rs nor @astrojs/compiler is resolvable from ${root}`,
  );
  return null;
}

/** Isolated stores (pnpm, bun) hide transitive deps — walk project → astro → compiler. */
async function importParseThroughAstro(
  root: string,
  packageName: string,
): Promise<AstroParser["parse"] | null> {
  try {
    const projectRequire = createRequire(join(root, "package.json"));
    const astroRequire = createRequire(projectRequire.resolve("astro/package.json"));
    const entry = astroRequire.resolve(packageName);
    const compiler = (await import(pathToFileURL(entry).href)) as {
      parse?: AstroParser["parse"];
    };
    return compiler.parse ?? null;
  } catch {
    return null;
  }
}

async function importParseBare(packageName: string): Promise<AstroParser["parse"] | null> {
  try {
    const compiler = (await import(packageName)) as { parse?: AstroParser["parse"] };
    return compiler.parse ?? null;
  } catch {
    return null;
  }
}

/** Legacy Go compiler AST: typed element nodes under `children` fragments. */
function collectGoElements(node: unknown, sites: ElementSite[]): void {
  if (!isRecord(node)) return;
  if (
    typeof node.type === "string" &&
    STAMPABLE_GO_NODE_TYPES.has(node.type) &&
    typeof node.name === "string" &&
    !UNSTAMPABLE_ELEMENT_NAMES.has(node.name)
  ) {
    sites.push({
      name: node.name,
      byteOffset: readGoStartOffset(node),
      hasSourceAttr: hasNamedAttr(node.attributes, "attribute", ONLAY_SOURCE_ATTR),
      hasProvenanceAttr: hasNamedAttr(node.attributes, "attribute", ONLAY_PROVENANCE_ATTR),
    });
  }
  if (!Array.isArray(node.children)) return;
  for (const child of node.children) collectGoElements(child, sites);
}

/**
 * compiler-rs AST: oxc-style JSX. Elements can hide anywhere inside
 * expressions ({items.map(i => <li/>)}), so walk every object value.
 * Lowercase JSXIdentifier names are DOM elements; capitalized ones are
 * components and stay unstamped.
 */
function collectRsElements(node: unknown, sites: ElementSite[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRsElements(item, sites);
    return;
  }
  if (!isRecord(node)) return;

  if (node.type === "JSXElement" && isRecord(node.openingElement)) {
    const opening = node.openingElement;
    const name =
      isRecord(opening.name) &&
      opening.name.type === "JSXIdentifier" &&
      typeof opening.name.name === "string"
        ? opening.name.name
        : null;
    if (
      name &&
      /^[a-z]/.test(name) &&
      !UNSTAMPABLE_ELEMENT_NAMES.has(name) &&
      typeof opening.start === "number"
    ) {
      sites.push({
        name,
        byteOffset: opening.start,
        hasSourceAttr: hasNamedAttr(opening.attributes, "JSXAttribute", ONLAY_SOURCE_ATTR),
        hasProvenanceAttr: hasNamedAttr(opening.attributes, "JSXAttribute", ONLAY_PROVENANCE_ATTR),
      });
    }
  }

  for (const value of Object.values(node)) {
    if (typeof value === "object" && value !== null) collectRsElements(value, sites);
  }
}

function readGoStartOffset(node: AstroAstNode): number | null {
  if (!isRecord(node.position)) return null;
  if (!isRecord(node.position.start)) return null;
  const offset = node.position.start.offset;
  return typeof offset === "number" ? offset : null;
}

function findHtmlTagOffset(code: string): number | null {
  const match = /<html[\s/>]/i.exec(code);
  return match ? match.index : null;
}

/**
 * Both compilers report positions as UTF-8 byte offsets, but MagicString and
 * slicing index the UTF-16 string. Identical for pure-ASCII sources (the fast
 * path); otherwise map byte offsets of code-point starts to string indices.
 */
function byteToCharConverter(code: string): (byteOffset: number) => number | null {
  let ascii = true;
  for (let i = 0; i < code.length; i += 1) {
    if (code.charCodeAt(i) > 0x7f) {
      ascii = false;
      break;
    }
  }
  if (ascii) return (byteOffset) => byteOffset;

  const starts = new Map<number, number>();
  let byte = 0;
  let char = 0;
  while (char < code.length) {
    starts.set(byte, char);
    const codePoint = code.codePointAt(char) as number;
    byte += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    char += codePoint < 0x10000 ? 1 : 2;
  }
  starts.set(byte, char);
  return (byteOffset) => starts.get(byteOffset) ?? null;
}

/**
 * The compilers may synthesize elements with no literal tag in the source
 * (implicit head/body); only stamp when the offset really is `<name`.
 */
function sourceMatchesTag(code: string, offset: number, name: string): boolean {
  if (code[offset] !== "<") return false;
  const tag = code.slice(offset + 1, offset + 1 + name.length);
  if (tag.toLowerCase() !== name.toLowerCase()) return false;
  const next = code[offset + 1 + name.length];
  return next === undefined || next === ">" || next === "/" || /\s/.test(next);
}

function hasNamedAttr(attributes: unknown, attrType: string, name: string): boolean {
  if (!Array.isArray(attributes)) return false;
  return attributes.some((attribute) => {
    if (!isRecord(attribute) || attribute.type !== attrType) return false;
    if (typeof attribute.name === "string") return attribute.name === name;
    return isRecord(attribute.name) && attribute.name.name === name;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toRootRelativeFile(filename: string, root: string): string {
  return relative(root, filename).split(sep).join("/");
}

function offsetToLineColumn(code: string, offset: number): { column: number; line: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset; i += 1) {
    if (code.charCodeAt(i) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { column, line };
}

function escapeHtmlAttributeValue(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
