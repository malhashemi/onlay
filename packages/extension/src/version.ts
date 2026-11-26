// Whether this install is behind the extension the server publishes at
// /download (its version is in /healthz). Only an unpacked install of a
// release build is told: a store install updates itself, and a local build
// (0.0.0) is a developer's.

const DOTTED = /^\d{1,5}(\.\d{1,5}){0,3}$/;

/** Negative, zero or positive as `a` is older than, equal to or newer than `b`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The manifest fields that decide it (chrome.runtime.getManifest()). */
interface InstalledManifest {
  version: string;
  /** Present on a Chrome Web Store install. */
  update_url?: string | undefined;
}

/** The newer published version this install should mention, or null. */
export function newerPublished(installed: InstalledManifest, published: unknown): string | null {
  if (typeof published !== "string" || !DOTTED.test(published)) return null;
  if (installed.update_url) return null;
  if (!DOTTED.test(installed.version) || compareVersions(installed.version, "0.0.0") === 0)
    return null;
  return compareVersions(installed.version, published) < 0 ? published : null;
}
