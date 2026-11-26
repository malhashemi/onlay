// Bundle each framework's stamp into dist/ — the package's exports. Runtime
// helpers (babel, magic-string, the svelte compiler, @onlay/protocol) are
// inlined so a dev build that adds the stamp needs nothing else installed.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "dist");

rmSync(OUT, { recursive: true, force: true });

async function bundle(
  entry: string,
  naming: string,
  options: { format?: "esm" | "cjs"; external?: string[] } = {},
): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(ROOT, "src", entry)],
    outdir: OUT,
    naming,
    target: "node",
    format: options.format ?? "esm",
    ...(options.external ? { external: options.external } : {}),
  });
  if (!result.success) {
    console.error(result.logs.join("\n"));
    throw new Error(`@onlay/stamp: ${naming} bundle failed`);
  }
  console.log(`built dist/${naming}`);
}

await bundle("vite.ts", "vite.js");
await bundle("next.ts", "next.js");
await bundle("svelte.ts", "svelte.js");
// The Astro compilers stay external: their WASM/NAPI payloads do not survive
// bundling, and astro.ts resolves them from the host project at runtime.
await bundle("astro.ts", "astro.js", { external: ["@astrojs/compiler", "@astrojs/compiler-rs"] });
await bundle("next-loader.ts", "next-loader.cjs", { format: "cjs" });

// webpack loads the loader through require(): export the function itself.
const loader = join(OUT, "next-loader.cjs");
writeFileSync(
  loader,
  `${readFileSync(loader, "utf8")}\nmodule.exports = module.exports.default ?? module.exports.onlayNextWebpackLoader;\n`,
);
