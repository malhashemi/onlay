// Pack the built stamp (run `bun scripts/build.ts` first) into
// release/onlay-stamp.tgz: the tarball https://onlay.dev/download/onlay-stamp.tgz
// serves, installable with `npm i -D https://onlay.dev/download/onlay-stamp.tgz`.
// The package is staged outside the repository, so the workspace's own
// package.json and lockfile never reach the pack.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stampVersion, tarballManifest } from "./tarball-manifest";

const ROOT = join(import.meta.dir, "..");
const RELEASE = join(ROOT, "release");
const NAME = "onlay-stamp.tgz";

if (!existsSync(join(ROOT, "dist/vite.js")))
  throw new Error("packages/stamp/dist is missing: run `bun run build:stamp` first");

const version = stampVersion(process.env.ONLAY_STAMP_VERSION);
const source = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const stage = mkdtempSync(join(tmpdir(), "onlay-stamp-pack-"));
try {
  cpSync(join(ROOT, "dist"), join(stage, "dist"), { recursive: true });
  // Declarations beside the bundles (the tests' harness has none to ship).
  const tsc = spawnSync(
    process.execPath,
    [
      require.resolve("typescript/bin/tsc"),
      "-p",
      ROOT,
      "--noEmit",
      "false",
      "--declaration",
      "--emitDeclarationOnly",
      "--outDir",
      join(stage, "dist"),
    ],
    { encoding: "utf8" },
  );
  if (tsc.status !== 0) throw new Error(`declarations failed: ${tsc.stdout}${tsc.stderr}`);
  rmSync(join(stage, "dist/fixture-harness.d.ts"), { force: true });
  for (const entry of Object.values(source.exports as Record<string, string>)) {
    const types = join(stage, entry.replace(/\.js$/, ".d.ts"));
    if (!existsSync(types)) throw new Error(`no declarations for ${entry}`);
  }
  copyFileSync(join(ROOT, "README.md"), join(stage, "README.md"));
  copyFileSync(join(ROOT, "../../LICENSE"), join(stage, "LICENSE"));
  // The bundles inline Babel, magic-string, the Svelte compiler and more: their notices.
  copyFileSync(join(ROOT, "../../THIRD-PARTY-NOTICES.md"), join(stage, "THIRD-PARTY-NOTICES.md"));
  writeFileSync(
    join(stage, "package.json"),
    `${JSON.stringify(tarballManifest(source, version), null, 2)}\n`,
  );
  mkdirSync(RELEASE, { recursive: true });
  rmSync(join(RELEASE, NAME), { force: true });
  const packed = spawnSync(
    "bun",
    // --filename takes a path (bun refuses it together with --destination).
    ["pm", "pack", "--quiet", "--ignore-scripts", "--filename", join(RELEASE, NAME)],
    { cwd: stage, encoding: "utf8" },
  );
  if (packed.status !== 0 || !existsSync(join(RELEASE, NAME)))
    throw new Error(`bun pm pack failed: ${packed.stderr || packed.stdout}`);
  console.log(`packed @onlay/stamp ${version} → release/${NAME}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
