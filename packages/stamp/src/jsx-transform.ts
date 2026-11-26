import { relative, sep } from "node:path";
import generate from "@babel/generator";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { ONLAY_PROVENANCE_ATTR, ONLAY_SOURCE_ATTR } from "@onlay/protocol";

export type TransformJsxOptions = {
  filename: string;
  root: string;
  dev: boolean;
  /**
   * Document-level provenance (ADR-0017 §3). When set, the ROOT `<html>` JSX
   * element (Next App Router's root layout) is stamped with
   * `data-onlay-provenance` — the equivalent of Vite's transformIndexHtml.
   */
  provenance?: string;
};

export type TransformJsxResult = {
  code: string;
  map?: unknown;
};

export function transformJsx(code: string, options: TransformJsxOptions): TransformJsxResult {
  if (!options.dev) return { code };

  const rootRelativeFile = toRootRelativeFile(options.filename, options.root);
  const ast = parse(code, {
    plugins: ["jsx", "typescript"],
    sourceFilename: options.filename,
    sourceType: "module",
  });
  let stamped = false;

  traverse(ast, {
    JSXOpeningElement(path) {
      const start = path.node.loc?.start;
      if (!start) return;
      // Document-level provenance rides the root <html> element only.
      if (options.provenance && isHtmlElement(path.node) && !hasProvenanceAttr(path.node)) {
        path.node.attributes.push(
          t.jsxAttribute(
            t.jsxIdentifier(ONLAY_PROVENANCE_ATTR),
            t.stringLiteral(options.provenance),
          ),
        );
        stamped = true;
      }
      if (hasSourceAttr(path.node)) return;

      path.node.attributes.push(
        t.jsxAttribute(
          t.jsxIdentifier(ONLAY_SOURCE_ATTR),
          t.stringLiteral(`${rootRelativeFile}:${start.line}:${start.column + 1}`),
        ),
      );
      stamped = true;
    },
  });

  if (!stamped) return { code };

  const output = generate(ast, { retainLines: true }, code);
  return { code: output.code, ...(output.map ? { map: output.map } : {}) };
}

function hasSourceAttr(node: t.JSXOpeningElement): boolean {
  return node.attributes.some((attribute) => {
    if (!t.isJSXAttribute(attribute)) return false;
    return t.isJSXIdentifier(attribute.name) && attribute.name.name === ONLAY_SOURCE_ATTR;
  });
}

function hasProvenanceAttr(node: t.JSXOpeningElement): boolean {
  return node.attributes.some((attribute) => {
    if (!t.isJSXAttribute(attribute)) return false;
    return t.isJSXIdentifier(attribute.name) && attribute.name.name === ONLAY_PROVENANCE_ATTR;
  });
}

function isHtmlElement(node: t.JSXOpeningElement): boolean {
  return t.isJSXIdentifier(node.name) && node.name.name === "html";
}

function toRootRelativeFile(filename: string, root: string): string {
  return relative(root, filename).split(sep).join("/");
}
