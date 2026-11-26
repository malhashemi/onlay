import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import type { Component } from "svelte";
import { render } from "svelte/server";
import { build, createServer } from "vite";
import {
  buildStampPackage,
  linkPackageStoreNodeModules,
  linkStampPackage,
  makeFixtureDir,
  readTree,
  removeFixtures,
  VITE_FIXTURE_TIMEOUT_MS,
} from "./fixture-harness";
import { onlaySveltePreprocess, transformSvelte } from "./svelte";

afterEach(removeFixtures);

describe("@onlay/stamp/svelte", () => {
  test("transformSvelte returns source unchanged outside dev", () => {
    const root = "/repo/app";
    const filename = join(root, "src/App.svelte");
    const input = '<main><button class="primary">Click</button></main>';

    const result = transformSvelte(input, { dev: false, filename, root });

    expect(result.code).toBe(input);
    expect(result.code).not.toContain("data-onlay-source");
  });

  test("transformSvelte does not stamp elements that already carry data-onlay-source", () => {
    const root = "/repo/app";
    const filename = join(root, "src/App.svelte");
    const input = '<main data-onlay-source="manual:1:1">Already stamped</main>';

    const result = transformSvelte(input, { dev: true, filename, root });

    expect(result.code).toBe(input);
    expect(countOccurrences(result.code, "data-onlay-source")).toBe(1);
  });

  test("transformSvelte stamps nested control-flow elements with 1-indexed coordinates", () => {
    const root = "/repo/app";
    const filename = join(root, "src/App.svelte");
    const input = [
      "{#if visible}",
      "  <section>",
      "    <span>Visible</span>",
      "  </section>",
      "{:else}",
      "  <p>Hidden</p>",
      "{/if}",
      "{#each items as item}",
      "  <article>{item}</article>",
      "{/each}",
      "{#await promise}",
      "  <em>Pending</em>",
      "{:then value}",
      "  <strong>{value}</strong>",
      "{:catch error}",
      "  <small>{error.message}</small>",
      "{/await}",
    ].join("\n");

    const result = transformSvelte(input, { dev: true, filename, root });

    expect(result.code).toContain('data-onlay-source="src/App.svelte:2:3"');
    expect(result.code).toContain('data-onlay-source="src/App.svelte:3:5"');
    expect(result.code).toContain('data-onlay-source="src/App.svelte:6:3"');
    expect(result.code).toContain('data-onlay-source="src/App.svelte:9:3"');
    expect(result.code).toContain('data-onlay-source="src/App.svelte:12:3"');
    expect(result.code).toContain('data-onlay-source="src/App.svelte:14:3"');
    expect(result.code).toContain('data-onlay-source="src/App.svelte:16:3"');
  });

  test("transformSvelte escapes source values before inserting template attributes", () => {
    const root = "/repo/app";
    const filename = join(root, 'src/has"quote/App.svelte');
    const input = "<main>Safe</main>";

    const result = transformSvelte(input, { dev: true, filename, root });

    expect(result.code).toContain('data-onlay-source="src/has&quot;quote/App.svelte:1:1"');
    expect(result.code).not.toContain('data-onlay-source="src/has"quote/App.svelte:1:1"');
  });

  test("onlaySveltePreprocess stamps markup in dev and emits nothing when NODE_ENV is production", async () => {
    const root = "/repo/app";
    const filename = join(root, "src/App.svelte");
    const input = "<main>Preprocessed</main>";

    const devPreprocess = onlaySveltePreprocess({ dev: true, root });
    const devResult = await devPreprocess.markup?.({ content: input, filename });

    expect(devResult?.code).toContain('data-onlay-source="src/App.svelte:1:1"');

    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const prodPreprocess = onlaySveltePreprocess({ root });
      const prodResult = await prodPreprocess.markup?.({ content: input, filename });

      expect(prodResult).toBeUndefined();
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
    }
  });
});

describe("@onlay/stamp/svelte Vite fixture", () => {
  beforeAll(() => {
    buildStampPackage();
  });

  test(
    "stamps Svelte template elements in Vite dev transforms and emits no source attributes in prod builds",
    async () => {
      const fixture = makeSvelteFixture();
      expect(typeof svelte).toBe("function");
      const devServer = await createServer({
        configFile: join(fixture, "vite.config.mjs"),
        logLevel: "silent",
        root: fixture,
      });

      try {
        const appModule = (await devServer.ssrLoadModule("/src/App.svelte")) as {
          default: Component;
        };
        const renderedHtml = render(appModule.default).body;
        expect(renderedHtml).toContain('data-onlay-source="src/App.svelte:1:1"');
        expect(renderedHtml).toContain('data-onlay-source="src/App.svelte:2:3"');

        const transformed = await devServer.transformRequest("/src/App.svelte");
        const devCode = transformed?.code ?? "";
        expect(devCode).toContain("data-onlay-source");
        expect(devCode).toContain("src/App.svelte:1:1");
      } finally {
        await devServer.close();
      }

      await build({
        configFile: join(fixture, "vite.config.mjs"),
        logLevel: "silent",
        root: fixture,
      });

      expect(readTree(join(fixture, "dist"))).not.toContain("data-onlay-source");
    },
    VITE_FIXTURE_TIMEOUT_MS,
  );
});

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function makeSvelteFixture(): string {
  const fixture = makeFixtureDir("onlay-svelte-stamp-");
  mkdirSync(join(fixture, "src"), { recursive: true });
  linkPackageStoreNodeModules(fixture, "@sveltejs/vite-plugin-svelte");
  linkPackageStoreNodeModules(fixture, "vite");
  linkStampPackage(fixture);
  writeFileSync(
    join(fixture, "package.json"),
    JSON.stringify({
      dependencies: {
        "@sveltejs/vite-plugin-svelte": "*",
        "@onlay/stamp": "*",
        svelte: "*",
        vite: "*",
      },
      type: "module",
    }),
  );
  writeFileSync(
    join(fixture, "index.html"),
    '<div id="app"></div><script type="module" src="/src/main.js"></script>',
  );
  writeFileSync(
    join(fixture, "vite.config.mjs"),
    [
      'import { svelte } from "@sveltejs/vite-plugin-svelte";',
      'import onlayStampSvelte from "@onlay/stamp/svelte";',
      "",
      "export default {",
      "  plugins: [onlayStampSvelte(), svelte({ compilerOptions: { dev: false } })],",
      "};",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(fixture, "src/App.svelte"),
    ['<main id="target">', "  <button>Click</button>", "</main>", ""].join("\n"),
  );
  writeFileSync(
    join(fixture, "src/main.js"),
    [
      'import { mount } from "svelte";',
      'import App from "./App.svelte";',
      "",
      'mount(App, { target: document.getElementById("app") });',
      "",
    ].join("\n"),
  );
  return fixture;
}
