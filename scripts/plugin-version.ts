// The agent plugin's version: one number in every manifest, changed whenever
// what a client installs changes.
//
//   bun run plugin:version           give plugin/ a new patch version if its content changed
//   bun run plugin:version 0.3.0     or the version you name
//   bun run plugin:version --check   exit 1 if the content changed without a new version,
//                                    or the manifests disagree (`bun run check` runs this)
//
// Clients install plugin/ from the git marketplace and compare versions, not
// content: Claude Code reads plugin/.claude-plugin/plugin.json, Codex the root
// plugin/plugin.json, and either keeps an installed copy whose version string
// is unchanged however the files moved on. So every manifest carries the same
// `version`, and the lock (plugin-version.lock.json, beside this script) pairs
// that version with a hash of the content it was given for: every file under
// plugin/ (with the version fields blanked) and the plugin's entry in each
// marketplace catalog. A change to any of it needs a new version, which this
// script writes everywhere at once. The catalogs carry no version: both
// clients take it from the manifests.
//
// `--root <dir>` runs against another copy of the repository (the tests).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** The manifests that carry the version, relative to the repository root. */
const MANIFESTS = [
  "plugin/plugin.json",
  "plugin/.claude-plugin/plugin.json",
  "plugin/.codex-plugin/plugin.json",
];
/** The marketplace catalogs that list the plugin. */
const CATALOGS = [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"];
const LOCK = "scripts/plugin-version.lock.json";
const PLUGIN = "onlay";
const VERSION_FIELD = /"version"\s*:\s*"([^"]*)"/g;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

type Lock = { version: string; contentHash: string };

const read = (root: string, file: string) => readFileSync(join(root, file), "utf8");

function filesUnder(root: string, dir: string): string[] {
  return readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

/** The one `version` a manifest declares, or a problem with it. */
function versionOf(root: string, file: string): string {
  const found = [...read(root, file).matchAll(VERSION_FIELD)];
  if (found.length !== 1)
    throw new Error(`${file} must declare "version" exactly once (it does ${found.length} times)`);
  return found[0]?.[1] ?? "";
}

/** Each catalog's entry for the plugin, which must not carry a version of its own. */
function catalogEntry(root: string, file: string): unknown {
  const catalog = JSON.parse(read(root, file));
  const entry = catalog.plugins?.find((p: { name?: string }) => p.name === PLUGIN);
  if (!entry) throw new Error(`${file} does not list the ${PLUGIN} plugin`);
  if ("version" in entry)
    throw new Error(
      `${file}: the ${PLUGIN} entry must not carry a version; the manifests under plugin/ do`,
    );
  return entry;
}

/** The hash of what a client installs, independent of the version string. */
function contentHash(root: string): string {
  const hash = createHash("sha256");
  for (const file of filesUnder(root, "plugin")) {
    let body = read(root, file);
    if (MANIFESTS.includes(file)) {
      versionOf(root, file);
      body = body.replace(VERSION_FIELD, '"version": ""');
    }
    hash.update(`${file}\0${createHash("sha256").update(body).digest("hex")}\n`);
  }
  for (const file of CATALOGS)
    hash.update(`${file}#${PLUGIN}\0${JSON.stringify(catalogEntry(root, file))}\n`);
  return `sha256:${hash.digest("hex")}`;
}

const readLock = (root: string): Lock => JSON.parse(read(root, LOCK));

/** Every reason the plugin's version and content are out of step; empty when they agree. */
function problems(root: string): string[] {
  const out: string[] = [];
  const versions = new Map(MANIFESTS.map((file) => [file, versionOf(root, file)]));
  const distinct = new Set(versions.values());
  if (distinct.size > 1)
    out.push(
      `the plugin manifests disagree on its version: ${[...versions]
        .map(([file, v]) => `${file} says ${v}`)
        .join(", ")}`,
    );
  const lock = readLock(root);
  const hash = contentHash(root);
  if (hash !== lock.contentHash)
    out.push(`what the plugin installs changed since ${lock.version} was given to it`);
  else if (distinct.size === 1 && !distinct.has(lock.version))
    out.push(`the manifests say ${[...distinct][0]} but ${LOCK} says ${lock.version}`);
  return out;
}

/** Writes `version` into every manifest and the lock; returns the version written. */
function bump(root: string, requested?: string): string | null {
  const lock = readLock(root);
  const hash = contentHash(root);
  const settled = MANIFESTS.every((file) => versionOf(root, file) === lock.version);
  if (!requested && settled && hash === lock.contentHash) return null;
  let version = requested;
  if (!version) {
    const m = SEMVER.exec(lock.version);
    if (!m) throw new Error(`${LOCK} has a version that is not x.y.z: ${lock.version}`);
    version = `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
  }
  if (!SEMVER.test(version)) throw new Error(`the version must be x.y.z, not ${version}`);
  // The same version over changed content would pass the check and reach no
  // one: a client compares the version, never the files.
  if (version === lock.version && hash !== lock.contentHash)
    throw new Error(
      `what the plugin installs changed since ${lock.version}, so it needs a version other than ${lock.version}`,
    );
  for (const file of MANIFESTS) {
    versionOf(root, file);
    writeFileSync(
      join(root, file),
      read(root, file).replace(VERSION_FIELD, `"version": "${version}"`),
    );
  }
  const next: Lock = { version, contentHash: contentHash(root) };
  writeFileSync(join(root, LOCK), `${JSON.stringify(next, null, 2)}\n`);
  return version;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--root");
  const root = at >= 0 ? (args[at + 1] ?? "") : join(import.meta.dir, "..");
  const rest = at >= 0 ? args.filter((_, i) => i !== at && i !== at + 1) : args;
  try {
    if (rest.includes("--check")) {
      const found = problems(root);
      if (found.length > 0) {
        for (const p of found) console.error(`plugin version: ${p}.`);
        console.error(
          "Run `bun run plugin:version` to give the plugin a new version in every manifest, and commit the result.",
        );
        process.exit(1);
      }
    } else {
      const written = bump(root, rest[0]);
      console.log(
        written
          ? `The plugin is now ${written} in ${MANIFESTS.join(", ")} and ${LOCK}.`
          : `The plugin's content has not changed since ${readLock(root).version}; nothing to do.`,
      );
    }
  } catch (error) {
    console.error(`plugin version: ${(error as Error).message}`);
    process.exit(1);
  }
}
