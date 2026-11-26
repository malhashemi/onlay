import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import * as React from "react";
import * as ReactDomClient from "react-dom/client";
import { renderToString } from "react-dom/server";
import { build, createServer } from "vite";
import {
  buildStampPackage,
  makeViteReactFixture,
  readTree,
  removeFixtures,
  VITE_FIXTURE_TIMEOUT_MS,
} from "./fixture-harness";

beforeAll(() => {
  buildStampPackage();
});

afterEach(removeFixtures);

describe("@onlay/stamp/vite", () => {
  test(
    "stamps JSX in Vite dev transforms and emits no source attributes in prod builds",
    async () => {
      const fixture = makeViteReactFixture({ prefix: "onlay-vite-stamp-", stamped: true });
      expect(React.version).toBeTruthy();
      expect(typeof ReactDomClient.createRoot).toBe("function");
      const devServer = await createServer({
        configFile: join(fixture, "vite.config.mjs"),
        logLevel: "silent",
        root: fixture,
      });

      try {
        const appModule = (await devServer.ssrLoadModule("/src/App.jsx")) as {
          App: React.ComponentType;
        };
        const renderedHtml = renderToString(React.createElement(appModule.App));
        expect(renderedHtml).toContain('data-onlay-source="src/App.jsx:3:5"');

        const transformed = await devServer.transformRequest("/src/App.jsx");
        const devCode = transformed?.code ?? "";
        expect(devCode).toContain("data-onlay-source");
        expect(devCode).toContain("src/App.jsx:3:5");
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
