import { describe, expect, test } from "bun:test";
import { compareVersions, newerPublished } from "./version";

describe("compareVersions", () => {
  test("compares part by part as numbers, missing parts as 0", () => {
    expect(compareVersions("0.1.9", "0.1.10")).toBeLessThan(0);
    expect(compareVersions("0.1.10", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.2", "0.1.99")).toBeGreaterThan(0);
    expect(compareVersions("0.1", "0.1.0")).toBe(0);
    expect(compareVersions("1.0.0.1", "1.0.0")).toBeGreaterThan(0);
  });
});

describe("newerPublished", () => {
  test("names the published version when an unpacked release build is behind it", () => {
    expect(newerPublished({ version: "0.1.40" }, "0.1.42")).toBe("0.1.42");
  });

  test("says nothing when up to date or ahead", () => {
    expect(newerPublished({ version: "0.1.42" }, "0.1.42")).toBeNull();
    expect(newerPublished({ version: "0.1.43" }, "0.1.42")).toBeNull();
  });

  test("says nothing to a store install, a local build, or without a published version", () => {
    expect(
      newerPublished(
        { version: "0.1.40", update_url: "https://clients2.google.com/service/update2/crx" },
        "0.1.42",
      ),
    ).toBeNull();
    expect(newerPublished({ version: "0.0.0" }, "0.1.42")).toBeNull();
    expect(newerPublished({ version: "0.1.40" }, undefined)).toBeNull();
    expect(newerPublished({ version: "0.1.40" }, "")).toBeNull();
    expect(newerPublished({ version: "0.1.40" }, "0.1.x")).toBeNull();
    expect(newerPublished({ version: "0.1.40" }, 42)).toBeNull();
  });
});
