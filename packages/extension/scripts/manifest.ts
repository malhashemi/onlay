// The manifest transforms the build applies to src/manifest.json. Pure, so
// manifest.test.ts checks what each package ships.

/** The local wrangler dev servers a non-production build also reaches. */
const DEV_ORIGINS = ["http://localhost:8787", "http://127.0.0.1:8787"] as const;

export interface SourceManifest {
  version: string;
  key?: string;
  host_permissions: string[];
  externally_connectable: { matches: string[] };
  [field: string]: unknown;
}

/**
 * The version this build carries: `ONLAY_EXTENSION_VERSION` (CI sets
 * `0.2.<run number>`), `0.0.0` for a local build. Chrome takes one to four
 * dot-separated integers, each 0 to 65535 without leading zeros.
 */
export function extensionVersion(raw: string | undefined): string {
  const version = raw?.trim() || "0.0.0";
  const parts = version.split(".");
  const valid =
    parts.length >= 1 &&
    parts.length <= 4 &&
    parts.every((p) => /^(0|[1-9]\d{0,4})$/.test(p) && Number(p) <= 65535);
  if (!valid)
    throw new Error(
      `ONLAY_EXTENSION_VERSION must be 1 to 4 dot-separated integers (0-65535), not "${version}"`,
    );
  return version;
}

/** The `<origin>/*` patterns for the server, plus the local dev servers outside production. */
export function serverPatterns(serverOrigin: string, production: boolean): string[] {
  return [...new Set([serverOrigin, ...(production ? [] : DEV_ORIGINS)].map((o) => `${o}/*`))];
}

/**
 * Who may message the extension: the service (its sign-in hand-off and the
 * web app's ping) and the public site (whose landing page pings it), plus the
 * local dev servers outside production. One origin when they are the same.
 */
export function connectablePatterns(
  serverOrigin: string,
  siteOrigin: string,
  production: boolean,
): string[] {
  return [
    ...new Set([serverOrigin, siteOrigin, ...(production ? [] : DEV_ORIGINS)].map((o) => `${o}/*`)),
  ];
}

/**
 * The unpacked build: the server is the only required host; the server and
 * the public site are the only pages allowed to message the extension
 * (`connectable`, the server alone when not given). The `key` stays, so every
 * unpacked install has the id `EXTENSION_IDS` names.
 */
export function unpackedManifest(
  source: SourceManifest,
  options: { patterns: string[]; connectable?: string[]; version: string },
): SourceManifest {
  return {
    ...source,
    version: options.version,
    host_permissions: [...options.patterns],
    externally_connectable: { matches: [...(options.connectable ?? options.patterns)] },
  };
}

/** A loopback host: `localhost` (and its subdomains), 127.0.0.0/8 or `[::1]`. */
function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^127(\.\d{1,3}){3}$/.test(host) ||
    host === "[::1]"
  );
}

/**
 * Why `origin` cannot be in a release package (the downloadable zip or the
 * store package), or null when it can: a release reaches only `https:`
 * origins that are not loopback, so a stray `.env` or a dev shell can never
 * ship a package pointed at a local server. A self-hoster's own https origins
 * are fine.
 */
export function releaseOriginProblem(name: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return `${name} must be an origin, not "${origin}"`;
  }
  if (url.protocol !== "https:") return `a release needs an https ${name}, not ${origin}`;
  if (isLoopbackHost(url.hostname))
    return `a release cannot reach a loopback ${name} (${origin}): build without --zip or --store for local development`;
  return null;
}

function isLoopbackPattern(pattern: string): boolean {
  try {
    return isLoopbackHost(new URL(pattern.replace(/\/\*$/, "/")).hostname);
  } catch {
    return false;
  }
}

/**
 * The Chrome Web Store package: no `key` (the store assigns its own id) and
 * no loopback host permissions or `externally_connectable` entries.
 */
export function storeManifest(unpacked: SourceManifest): SourceManifest {
  const { key: _key, ...rest } = unpacked;
  return {
    ...rest,
    host_permissions: unpacked.host_permissions.filter((p) => !isLoopbackPattern(p)),
    externally_connectable: {
      matches: unpacked.externally_connectable.matches.filter((p) => !isLoopbackPattern(p)),
    },
  };
}
