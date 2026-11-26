import { transformJsx } from "./jsx-transform";
import { readGitProvenance } from "./provenance";

export type OnlayNextLoaderOptions = {
  dev?: boolean;
  root?: string;
};

export type OnlayNextLoaderContext = {
  getOptions?: () => OnlayNextLoaderOptions;
  mode?: string;
  resourcePath?: string;
  rootContext?: string;
};

export function onlayNextWebpackLoader(this: OnlayNextLoaderContext, source: string): string {
  const options = readOptions(this);
  const filename = this.resourcePath;
  if (!filename || !isJsxSource(filename)) return source;

  const dev = readDevFlag(this, options);
  const root = options.root ?? this.rootContext ?? process.cwd();
  // Document-level provenance (ADR-0017 §3): stamped onto the root layout's
  // <html> — Next's equivalent of Vite's transformIndexHtml. Dev-only.
  const provenance = dev ? readGitProvenance(root) : undefined;
  const result = transformJsx(source, {
    dev,
    filename,
    root,
    ...(provenance !== undefined ? { provenance } : {}),
  });
  return result.code;
}

export default onlayNextWebpackLoader;

function readOptions(context: OnlayNextLoaderContext): OnlayNextLoaderOptions {
  return context.getOptions?.() ?? {};
}

function readDevFlag(context: OnlayNextLoaderContext, options: OnlayNextLoaderOptions): boolean {
  if (options.dev !== undefined) return options.dev;
  if (context.mode) return context.mode !== "production";
  // biome-ignore lint/complexity/useLiteralKeys: bracket access prevents Bun from constant-folding NODE_ENV in bundled stamp entries.
  return process.env["NODE_ENV"] !== "production";
}

function isJsxSource(filename: string): boolean {
  return filename.endsWith(".jsx") || filename.endsWith(".tsx");
}
