import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import {
  FIXTURE_ROOT,
  linkStampPackage,
  makeFixtureDir,
  REPO_ROOT,
  removeFixtures,
  STAMP_PACKAGE_ROOT,
} from "./fixture-harness";

describe("fixture folders", () => {
  test("sit in a git-ignored cache and are removed, links and all, when a test ends", () => {
    const fixture = makeFixtureDir("onlay-harness-");
    linkStampPackage(fixture);
    expect(fixture.startsWith(FIXTURE_ROOT)).toBe(true);
    expect(existsSync(join(fixture, "node_modules/@onlay/stamp/package.json"))).toBe(true);
    const ignored = spawnSync(
      "git",
      ["check-ignore", "-q", "--no-index", relative(REPO_ROOT, fixture)],
      {
        cwd: REPO_ROOT,
      },
    );
    expect(ignored.status).toBe(0);

    removeFixtures();

    expect(existsSync(fixture)).toBe(false);
    // The link is removed, never followed: the package it pointed at stays.
    expect(existsSync(join(STAMP_PACKAGE_ROOT, "package.json"))).toBe(true);
  });
});
