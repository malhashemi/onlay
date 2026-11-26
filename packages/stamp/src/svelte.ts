import { relative, sep } from "node:path";
import { ONLAY_SOURCE_ATTR } from "@onlay/protocol";
import MagicString from "magic-string";
import { type PreprocessorGroup, parse } from "svelte/compiler";
import { injectProvenanceIntoHtml, readGitProvenance } from "./provenance";

export type TransformSvelteOptions = {
  filename: string;
  root: string;
  dev: boolean;
};

export type TransformSvelteResult = {
  code: string;
  map?: unknown;
};

export type OnlayStampSvelteOptions = {
  root?: string;
};

export type OnlaySveltePreprocessOptions = OnlayStampSvelteOptions & {
  dev?: boolean;
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
  transform(code: string, id: string): ViteTransformResult;
  transformIndexHtml(html: string): string;
};

type SvelteAstNode = Record<string, unknown>;

const STAMPABLE_ELEMENT_TYPES = new Set(["Element", "RegularElement", "SvelteElement"]);

export function transformSvelte(
  code: string,
  options: TransformSvelteOptions,
): TransformSvelteResult {
  if (!options.dev) return { code };

  const ast = parse(code, { filename: options.filename, modern: true });
  const rootRelativeFile = toRootRelativeFile(options.filename, options.root);
  const output = new MagicString(code);
  let stamped = false;

  visitFragment(ast.fragment, (node) => {
    if (!isStampableElement(node) || hasSourceAttr(node.attributes)) return;
    const location = offsetToLineColumn(code, node.start);
    const sourceValue = escapeHtmlAttributeValue(
      `${rootRelativeFile}:${location.line}:${location.column}`,
    );
    output.appendLeft(node.start + 1 + node.name.length, ` ${ONLAY_SOURCE_ATTR}="${sourceValue}"`);
    stamped = true;
  });

  if (!stamped) return { code };
  return { code: output.toString() };
}

export function onlayStampSvelte(options: OnlayStampSvelteOptions = {}): VitePlugin {
  let config: ViteResolvedConfig | undefined;

  return {
    name: "onlay:svelte-source-stamp",
    enforce: "pre",
    apply: "serve",
    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },
    transform(code, id) {
      const filename = cleanViteId(id);
      if (!isSvelteSource(filename)) return null;

      const result = transformSvelte(code, {
        dev: true,
        filename,
        root: options.root ?? config?.root ?? process.cwd(),
      });
      if (result.code === code) return null;

      return { code: result.code, map: null };
    },
    // Document-level provenance stamp (ADR-0017 §3), dev-only via apply:"serve".
    transformIndexHtml(html) {
      const provenance = readGitProvenance(options.root ?? config?.root ?? process.cwd());
      return provenance ? injectProvenanceIntoHtml(html, provenance) : html;
    },
  };
}

export function onlaySveltePreprocess(
  options: OnlaySveltePreprocessOptions = {},
): PreprocessorGroup {
  return {
    name: "onlay:svelte-source-stamp",
    markup({ content, filename }) {
      if (!filename || !isSvelteSource(filename)) return;
      const result = transformSvelte(content, {
        dev: options.dev ?? process.env.NODE_ENV !== "production",
        filename,
        root: options.root ?? process.cwd(),
      });
      if (result.code === content) return;
      return { code: result.code };
    },
  };
}

export default onlayStampSvelte;

function visitFragment(fragment: unknown, visit: (node: SvelteAstNode) => void): void {
  if (!isRecord(fragment)) return;
  for (const node of readNodeArray(fragment.nodes ?? fragment.children)) visitNode(node, visit);
}

function visitNode(node: SvelteAstNode, visit: (node: SvelteAstNode) => void): void {
  visit(node);
  visitFragment(node.fragment, visit);
  visitFragment(node.body, visit);
  visitFragment(node.fallback, visit);
  visitFragment(node.consequent, visit);
  visitFragment(node.alternate, visit);
  visitFragment(node.pending, visit);
  visitFragment(node.then, visit);
  visitFragment(node.catch, visit);
}

function isStampableElement(
  node: SvelteAstNode,
): node is SvelteAstNode & { attributes: unknown; name: string; start: number } {
  return (
    typeof node.type === "string" &&
    STAMPABLE_ELEMENT_TYPES.has(node.type) &&
    typeof node.start === "number" &&
    typeof node.name === "string"
  );
}

function hasSourceAttr(attributes: unknown): boolean {
  if (!Array.isArray(attributes)) return false;
  return attributes.some(
    (attribute) =>
      isRecord(attribute) && attribute.type === "Attribute" && attribute.name === ONLAY_SOURCE_ATTR,
  );
}

function readNodeArray(value: unknown): SvelteAstNode[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function isRecord(value: unknown): value is SvelteAstNode {
  return typeof value === "object" && value !== null;
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

function cleanViteId(id: string): string {
  return id.split("?", 1)[0] ?? id;
}

function isSvelteSource(filename: string): boolean {
  return filename.endsWith(".svelte");
}

function toRootRelativeFile(filename: string, root: string): string {
  return relative(root, filename).split(sep).join("/");
}
