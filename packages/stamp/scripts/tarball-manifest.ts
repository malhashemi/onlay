// The package.json inside onlay-stamp.tgz: what a host project installs from
// https://onlay.dev/download/onlay-stamp.tgz. The bundles in dist/ inline
// every runtime helper, so the tarball declares no dependencies at all, and
// nothing workspace-only (devDependencies, scripts, `private`) goes with it.

interface WorkspaceManifest {
  name: string;
  description?: string;
  type?: string;
  exports: Record<string, string>;
  [field: string]: unknown;
}

/** npm's version grammar, without build metadata: 0.1.42, 1.2.3-rc.1. */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;

/** `ONLAY_STAMP_VERSION` (CI: `0.2.<run number>`), `0.0.0` for a local pack. */
export function stampVersion(raw: string | undefined): string {
  const version = raw?.trim() || "0.0.0";
  if (!SEMVER.test(version))
    throw new Error(`ONLAY_STAMP_VERSION must be a semver version, not "${version}"`);
  return version;
}

export function tarballManifest(
  source: WorkspaceManifest,
  version: string,
): Record<string, unknown> {
  return {
    name: source.name,
    version,
    description: source.description,
    license: "MIT",
    homepage: "https://onlay.dev",
    type: source.type ?? "module",
    exports: {
      ...Object.fromEntries(
        Object.entries(source.exports).map(([entry, js]) => [
          entry,
          // The declarations pack.ts emits beside each bundle: a project that
          // type-checks its vite.config.ts or next.config.ts needs them.
          { types: js.replace(/\.js$/, ".d.ts"), default: js },
        ]),
      ),
      "./package.json": "./package.json",
    },
    // README.md, LICENSE and package.json are always packed; the notices are named.
    files: ["dist", "THIRD-PARTY-NOTICES.md"],
  };
}
