import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  connectablePatterns,
  extensionVersion,
  releaseOriginProblem,
  type SourceManifest,
  serverPatterns,
  storeManifest,
  unpackedManifest,
} from "./manifest";

const SOURCE = JSON.parse(
  readFileSync(join(import.meta.dir, "../src/manifest.json"), "utf8"),
) as SourceManifest;

describe("the build's version", () => {
  test("is 0.0.0 locally and what CI sets otherwise", () => {
    expect(extensionVersion(undefined)).toBe("0.0.0");
    expect(extensionVersion("")).toBe("0.0.0");
    expect(extensionVersion("0.1.412")).toBe("0.1.412");
    expect(extensionVersion("1.2.3.4")).toBe("1.2.3.4");
  });

  test("refuses what Chrome would refuse", () => {
    for (const bad of ["0.1.", "v0.1.2", "0.01.2", "0.1.65536", "1.2.3.4.5", "0.1.2-beta"])
      expect(() => extensionVersion(bad)).toThrow(/ONLAY_EXTENSION_VERSION/);
  });
});

const SERVER = "https://app.onlay.dev";
const SITE = "https://onlay.dev";

describe("the source manifest", () => {
  test("names the service as the host and both origins as the pages that may message it", () => {
    expect(SOURCE.host_permissions).toEqual([`${SERVER}/*`]);
    expect(SOURCE.externally_connectable.matches).toEqual([`${SERVER}/*`, `${SITE}/*`]);
  });
});

describe("the unpacked build", () => {
  test("keeps the key, names the server and the dev servers outside production", () => {
    const dev = unpackedManifest(SOURCE, {
      patterns: serverPatterns(SERVER, false),
      connectable: connectablePatterns(SERVER, SITE, false),
      version: "0.0.0",
    });
    expect(dev.key).toBe(SOURCE.key as string);
    expect(dev.host_permissions).toEqual([
      `${SERVER}/*`,
      "http://localhost:8787/*",
      "http://127.0.0.1:8787/*",
    ]);
    expect(dev.externally_connectable.matches).toEqual([
      `${SERVER}/*`,
      `${SITE}/*`,
      "http://localhost:8787/*",
      "http://127.0.0.1:8787/*",
    ]);

    const release = unpackedManifest(SOURCE, {
      patterns: serverPatterns(SERVER, true),
      connectable: connectablePatterns(SERVER, SITE, true),
      version: "0.1.7",
    });
    expect(release.version).toBe("0.1.7");
    expect(release.key).toBe(SOURCE.key as string);
    // Only the service is a host: the extension never calls the public site.
    expect(release.host_permissions).toEqual([`${SERVER}/*`]);
    expect(release.externally_connectable.matches).toEqual([`${SERVER}/*`, `${SITE}/*`]);
  });

  test("one origin for both (dev, e2e) is named once", () => {
    const local = "http://localhost:8787";
    const one = unpackedManifest(SOURCE, {
      patterns: serverPatterns(local, false),
      connectable: connectablePatterns(local, local, false),
      version: "0.0.0",
    });
    expect(one.host_permissions).toEqual(["http://localhost:8787/*", "http://127.0.0.1:8787/*"]);
    expect(one.externally_connectable.matches).toEqual(one.host_permissions);
  });
});

describe("the Chrome Web Store package", () => {
  test("has no key and no loopback entries, names both origins, and keeps everything else", () => {
    const unpacked = unpackedManifest(SOURCE, {
      patterns: serverPatterns(SERVER, false),
      connectable: connectablePatterns(SERVER, SITE, false),
      version: "0.1.7",
    });
    const store = storeManifest(unpacked);
    expect("key" in store).toBe(false);
    expect(store.host_permissions).toEqual([`${SERVER}/*`]);
    expect(store.externally_connectable).toEqual({ matches: [`${SERVER}/*`, `${SITE}/*`] });
    expect(store.version).toBe("0.1.7");
    const { key: _k, host_permissions: _h, externally_connectable: _e, ...rest } = unpacked;
    expect(store).toMatchObject(rest);
    // The page-wide grant stays optional, as in every build.
    expect(store.optional_host_permissions).toEqual(SOURCE.optional_host_permissions);
  });
});

describe("a release package's origins", () => {
  test("the official and a self-hoster's own https origins are allowed", () => {
    for (const origin of [
      "https://app.onlay.dev",
      "https://onlay.dev",
      "https://app.example.com",
      "https://example.com:8443",
    ]) {
      expect(releaseOriginProblem("server origin", origin)).toBeNull();
    }
  });

  test("http and loopback origins are refused, whatever the scheme", () => {
    for (const origin of [
      "http://localhost:8787",
      "http://127.0.0.1:8787",
      "http://app.example.com",
      "https://localhost",
      "https://localhost:8787",
      "https://dev.localhost",
      "https://127.0.0.1",
      "https://127.10.0.3:9000",
      "https://[::1]:8787",
      "not an origin",
    ]) {
      expect(releaseOriginProblem("server origin", origin)).not.toBeNull();
    }
    expect(releaseOriginProblem("site origin", "http://localhost:8787")).toContain("site origin");
  });
});
