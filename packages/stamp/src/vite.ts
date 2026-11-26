import { transformJsx } from "./jsx-transform";
import { injectProvenanceIntoHtml, readGitProvenance } from "./provenance";

export type OnlayStampViteOptions = {
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
  transform(code: string, id: string): ViteTransformResult;
  transformIndexHtml(html: string): string;
};

export function onlayStampVite(options: OnlayStampViteOptions = {}): VitePlugin {
  let config: ViteResolvedConfig | undefined;

  return {
    name: "onlay:source-stamp",
    enforce: "pre",
    apply: "serve",
    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },
    transform(code, id) {
      const filename = cleanViteId(id);
      if (!isJsxSource(filename)) return null;

      const result = transformJsx(code, {
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

export default onlayStampVite;

function cleanViteId(id: string): string {
  return id.split("?", 1)[0] ?? id;
}

function isJsxSource(filename: string): boolean {
  return filename.endsWith(".jsx") || filename.endsWith(".tsx");
}
