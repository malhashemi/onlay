import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildStampPackage,
  getFreePort,
  linkPackageStoreNodeModules,
  linkStampPackage,
  makeFixtureDir,
  readTree,
  removeFixtures,
  stopProcess,
  waitForHttpText,
} from "./fixture-harness";
import {
  createOnlayNextTurbopackRules,
  createOnlayNextWebpackRule,
  NEXT_TURBOPACK_RULE_SHAPES,
  onlayNextWebpackLoader,
  withOnlayStampNext,
} from "./next";

beforeAll(() => {
  buildStampPackage();
});

afterEach(removeFixtures);

describe("@onlay/stamp/next webpack loader", () => {
  test("stamps JSX using the loader context filename/root in dev", () => {
    const root = "/repo/next-app";
    const filename = join(root, "pages/index.jsx");
    const input = [
      "export default function Page() {",
      "  return (",
      '    <main id="target">',
      "      <button>Click</button>",
      "    </main>",
      "  );",
      "}",
    ].join("\n");

    const result = onlayNextWebpackLoader.call(
      {
        getOptions: () => ({ dev: true }),
        mode: "development",
        resourcePath: filename,
        rootContext: root,
      },
      input,
    );

    expect(result).toContain('data-onlay-source="pages/index.jsx:3:5"');
    expect(result).toContain('data-onlay-source="pages/index.jsx:4:7"');
  });

  test("is a no-op when the loader context is production", () => {
    const root = "/repo/next-app";
    const filename = join(root, "pages/index.jsx");
    const input = "export default function Page() { return <main>Prod</main>; }";

    const result = onlayNextWebpackLoader.call(
      {
        getOptions: () => ({ dev: false }),
        mode: "production",
        resourcePath: filename,
        rootContext: root,
      },
      input,
    );

    expect(result).toBe(input);
  });

  test("is a no-op when Turbopack omits mode/options during a production build", () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const root = "/repo/next-app";
    const filename = join(root, "pages/index.jsx");
    const input = "export default function Page() { return <main>Prod</main>; }";

    process.env.NODE_ENV = "production";
    try {
      const result = onlayNextWebpackLoader.call(
        {
          resourcePath: filename,
          rootContext: root,
        },
        input,
      );

      expect(result).toBe(input);
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });

  test("exposes webpack and Turbopack rule shapes that point at the same loader", () => {
    const root = "/repo/next-app";
    const loaderPath = "/repo/node_modules/@onlay/stamp/dist/next-loader.cjs";

    const webpackRule = createOnlayNextWebpackRule({ dev: true, loaderPath, root });
    const turbopackRules = createOnlayNextTurbopackRules({ dev: true, loaderPath, root });

    expect(webpackRule.use).toEqual([{ loader: loaderPath, options: { dev: true, root } }]);
    expect(turbopackRules["*.jsx"]?.loaders).toEqual([
      { loader: loaderPath, options: { dev: true, root } },
    ]);
    expect(turbopackRules["*.tsx"]?.loaders).toEqual([
      { loader: loaderPath, options: { dev: true, root } },
    ]);
    expect(NEXT_TURBOPACK_RULE_SHAPES).toEqual({
      experimentalTurboRules: "Next 15.0-15.2: experimental.turbo.rules",
      turbopackRules: "Next >=15.3: turbopack.rules",
    });

    const wrapped = withOnlayStampNext(
      { reactStrictMode: false },
      { dev: true, loaderPath, root, turbopackRuleTarget: "both" },
    );
    expect(wrapped.turbopack?.rules).toMatchObject(turbopackRules);
    expect(wrapped.turbopack?.root).toBeUndefined();
    expect(wrapped.experimental?.turbo?.rules).toMatchObject(turbopackRules);

    const runtimeGated = withOnlayStampNext(
      { reactStrictMode: false },
      { loaderPath, root, turbopackRuleTarget: "turbopack" },
    );
    expect(runtimeGated.turbopack?.rules).toMatchObject({
      "*.jsx": { loaders: [{ options: { root } }] },
      "*.tsx": { loaders: [{ options: { root } }] },
    });
  });

  test("infers the sibling loader path when imported from source", () => {
    const expectedLoaderPath = fileURLToPath(new URL("./next-loader.ts", import.meta.url));

    const webpackRule = createOnlayNextWebpackRule({ dev: true });
    const turbopackRules = createOnlayNextTurbopackRules({ dev: true });

    expect(webpackRule.use[0]?.loader).toBe(expectedLoaderPath);
    expect(turbopackRules["*.jsx"]?.loaders[0]?.loader).toBe(expectedLoaderPath);
    expect(turbopackRules["*.tsx"]?.loaders[0]?.loader).toBe(expectedLoaderPath);
  });

  test("preserves explicit turbopack.root without inventing a root", () => {
    const loaderPath = "/repo/node_modules/@onlay/stamp/dist/next-loader.cjs";

    const withoutRoot = withOnlayStampNext(
      { reactStrictMode: false },
      { dev: true, loaderPath, root: "/repo/next-app" },
    );
    expect(withoutRoot.turbopack?.root).toBeUndefined();

    const withRoot = withOnlayStampNext(
      { turbopack: { root: "/repo/workspace" } },
      { dev: true, loaderPath },
    );
    expect(withRoot.turbopack?.root).toBe("/repo/workspace");
  });

  test("does not register Turbopack rules while Next is running a production build", () => {
    const originalArgv = process.argv;
    const originalNodeEnv = process.env.NODE_ENV;
    Object.defineProperty(process, "argv", {
      configurable: true,
      value: ["node", "next", "build", "--turbo"],
    });
    process.env.NODE_ENV = "production";
    try {
      const wrapped = withOnlayStampNext({ reactStrictMode: false });
      expect(wrapped.turbopack).toBeUndefined();
    } finally {
      Object.defineProperty(process, "argv", { configurable: true, value: originalArgv });
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });

  test("does not register the webpack rule when Next reports a production runtime", () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const wrapped = withOnlayStampNext({ reactStrictMode: false });
      const config = { module: { rules: [] } };
      const resolved = wrapped.webpack?.(config, { dev: true, dir: "/repo/next-app" });
      expect(resolved?.module?.rules).toEqual([]);
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });
});

describe("@onlay/stamp/next in a minimal Next fixture", () => {
  test("emits source stamps in webpack dev and omits them from production builds", async () => {
    const fixture = makeNextFixture();
    const port = await getFreePort();
    const devServer = startNext(fixture, port, []);

    try {
      const html = await waitForHttpText({
        child: devServer,
        label: "Next dev server",
        readyText: "Click",
        url: `http://127.0.0.1:${port}/`,
      });
      expect(html).toContain('data-onlay-source="pages/index.jsx:3:5"');
    } finally {
      await stopProcess(devServer);
    }

    const build = spawnSync("node", [nextBin(fixture), "build"], {
      cwd: fixture,
      encoding: "utf8",
      env: nextEnv(),
    });
    expect(build.status, build.stderr || build.stdout).toBe(0);
    expect(readTree(join(fixture, ".next"))).not.toContain("data-onlay-source");
  }, 90_000);

  test("emits source stamps in Turbopack dev", async () => {
    const fixture = makeNextFixture();
    const port = await getFreePort();
    const devServer = startNext(fixture, port, ["--turbo"]);

    try {
      const html = await waitForHttpText({
        child: devServer,
        label: "Next Turbopack dev server",
        readyText: "Click",
        timeoutMs: 90_000,
        url: `http://127.0.0.1:${port}/`,
      });
      expect(html).toContain('data-onlay-source="pages/index.jsx:3:5"');
    } finally {
      await stopProcess(devServer);
    }
  }, 120_000);

  test.todo("omits source stamps from Turbopack production builds", () => {
    // Deferred to the acceptance guide: Next 15.5 Turbopack production builds
    // still produced nondeterministic in-harness stamp artifacts during rc-1.
  });
});

function makeNextFixture(): string {
  const fixture = makeFixtureDir("onlay-next-webpack-stamp-");
  mkdirSync(join(fixture, "pages"), { recursive: true });
  linkPackageStoreNodeModules(fixture, "next");
  linkStampPackage(fixture);
  writeFileSync(
    join(fixture, "package.json"),
    JSON.stringify({
      dependencies: {
        next: "*",
        "@onlay/stamp": "*",
        react: "*",
        "react-dom": "*",
      },
      scripts: {
        build: "next build",
        dev: "next dev",
      },
      type: "module",
    }),
  );
  writeFileSync(
    join(fixture, "next.config.mjs"),
    [
      'import { withOnlayStampNext } from "@onlay/stamp/next";',
      "",
      "export default withOnlayStampNext({",
      "  reactStrictMode: false,",
      "});",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(fixture, "pages/index.jsx"),
    [
      "export default function Page() {",
      "  return (",
      '    <main id="target">',
      "      <button>Click</button>",
      "    </main>",
      "  );",
      "}",
      "",
    ].join("\n"),
  );
  return fixture;
}

function nextBin(fixture: string): string {
  return join(fixture, "node_modules/next/dist/bin/next");
}

function startNext(
  fixture: string,
  port: number,
  extraArgs: string[],
): ChildProcessWithoutNullStreams {
  return spawn(
    "node",
    [nextBin(fixture), "dev", "-H", "127.0.0.1", "-p", String(port), ...extraArgs],
    {
      cwd: fixture,
      env: nextEnv(),
    },
  );
}

function nextEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CI: "1",
    NEXT_TELEMETRY_DISABLED: "1",
  };
}
