import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AstroParserFlavor,
  onlayStampAstro,
  onlayStampAstroVite,
  transformAstro,
} from "./astro";

// Astro 7 parses with @astrojs/compiler-rs, older majors with
// @astrojs/compiler — the transform must behave identically on both.
const FLAVORS: AstroParserFlavor[] = ["compiler-rs", "compiler"];

for (const parser of FLAVORS) {
  describe(`@onlay/stamp/astro (${parser})`, () => {
    test("transformAstro returns source unchanged outside dev", async () => {
      const root = "/repo/app";
      const filename = join(root, "src/pages/index.astro");
      const input = '<main><button class="primary">Click</button></main>';

      const result = await transformAstro(input, { dev: false, filename, parser, root });

      expect(result.code).toBe(input);
      expect(result.code).not.toContain("data-onlay-source");
    });

    test("transformAstro does not stamp elements that already carry data-onlay-source", async () => {
      const root = "/repo/app";
      const filename = join(root, "src/pages/index.astro");
      const input = '<main data-onlay-source="manual:1:1">Already stamped</main>';

      const result = await transformAstro(input, { dev: true, filename, parser, root });

      expect(result.code).toBe(input);
      expect(countOccurrences(result.code, "data-onlay-source")).toBe(1);
    });

    test("transformAstro stamps template elements with 1-indexed coordinates, skipping frontmatter", async () => {
      const root = "/repo/app";
      const filename = join(root, "src/pages/index.astro");
      const input = [
        "---",
        'const items = ["a"];',
        "---",
        '<main id="target">',
        "  <button>Click</button>",
        "  {items.map((item) => <li>{item}</li>)}",
        "  <my-widget></my-widget>",
        "</main>",
      ].join("\n");

      const result = await transformAstro(input, { dev: true, filename, parser, root });

      expect(result.code).toContain('data-onlay-source="src/pages/index.astro:4:1"');
      expect(result.code).toContain('data-onlay-source="src/pages/index.astro:5:3"');
      expect(result.code).toContain('data-onlay-source="src/pages/index.astro:6:24"');
      expect(result.code).toContain('data-onlay-source="src/pages/index.astro:7:3"');
    });

    test("transformAstro leaves components, slots, scripts, and styles unstamped", async () => {
      const root = "/repo/app";
      const filename = join(root, "src/pages/index.astro");
      const input = [
        "<main>",
        '  <Card title="x"><span>Inside</span></Card>',
        "  <slot />",
        "  <script>console.log(1);</script>",
        "  <style>main { color: red; }</style>",
        "</main>",
      ].join("\n");

      const result = await transformAstro(input, { dev: true, filename, parser, root });

      expect(result.code).toContain('<main data-onlay-source="src/pages/index.astro:1:1">');
      expect(result.code).toContain('<span data-onlay-source="src/pages/index.astro:2:19">');
      expect(result.code).toContain('<Card title="x">');
      expect(result.code).toContain("<slot />");
      expect(result.code).toContain("<script>console.log(1);</script>");
      expect(result.code).toContain("<style>main { color: red; }</style>");
    });

    test("transformAstro converts the compiler's byte offsets for non-ASCII sources", async () => {
      const root = "/repo/app";
      const filename = join(root, "src/pages/index.astro");
      const input = [
        "<main>",
        "  <p>héllo wörld — “quotes” 🎉</p>",
        "  <button>Click</button>",
        "</main>",
      ].join("\n");

      const result = await transformAstro(input, { dev: true, filename, parser, root });

      expect(result.code).toContain('<main data-onlay-source="src/pages/index.astro:1:1">');
      expect(result.code).toContain('<p data-onlay-source="src/pages/index.astro:2:3">');
      expect(result.code).toContain('<button data-onlay-source="src/pages/index.astro:3:3">');
    });

    test("transformAstro stamps each same-named tag despite emoji byte drift", async () => {
      const root = "/repo/app";
      const filename = join(root, "src/pages/index.astro");
      const input = "<main><b>😀😀😀😀</b><b>x</b><b>y</b></main>";

      const result = await transformAstro(input, { dev: true, filename, parser, root });

      expect(result.code).toBe(
        '<main data-onlay-source="src/pages/index.astro:1:1">' +
          '<b data-onlay-source="src/pages/index.astro:1:7">😀😀😀😀</b>' +
          '<b data-onlay-source="src/pages/index.astro:1:22">x</b>' +
          '<b data-onlay-source="src/pages/index.astro:1:30">y</b></main>',
      );
    });

    test("transformAstro escapes source values before inserting template attributes", async () => {
      const root = "/repo/app";
      const filename = join(root, 'src/has"quote/index.astro');
      const input = "<main>Safe</main>";

      const result = await transformAstro(input, { dev: true, filename, parser, root });

      expect(result.code).toContain('data-onlay-source="src/has&quot;quote/index.astro:1:1"');
      expect(result.code).not.toContain('data-onlay-source="src/has"quote/index.astro:1:1"');
    });

    test("transformAstro stamps document-level provenance on the html element only", async () => {
      const root = "/repo/app";
      const filename = join(root, "src/layouts/Layout.astro");
      const provenance = "example.com/owner/repo@abc123;main;clean";
      const input = ['<html lang="en">', "  <body><main>Hi</main></body>", "</html>"].join("\n");

      const result = await transformAstro(input, { dev: true, filename, parser, provenance, root });

      expect(result.code).toContain(
        `<html data-onlay-provenance="${provenance}" data-onlay-source="src/layouts/Layout.astro:1:1" lang="en">`,
      );
      expect(countOccurrences(result.code, "data-onlay-provenance")).toBe(1);
    });

    test("transformAstro stamps the document-root html element of a full page", async () => {
      const root = "/repo/app";
      const filename = join(root, "src/pages/index.astro");
      const provenance = "example.com/owner/repo@abc123;main;clean";
      // A page with a <head> makes the legacy compiler leave <html>
      // positionless; the lexical fallback must cover it.
      const input = [
        '<html lang="en">',
        "  <head><title>Fixture</title></head>",
        "  <body><main>Hi</main></body>",
        "</html>",
      ].join("\n");

      const result = await transformAstro(input, { dev: true, filename, parser, provenance, root });

      expect(result.code).toContain(
        `<html data-onlay-provenance="${provenance}" data-onlay-source="src/pages/index.astro:1:1" lang="en">`,
      );
      expect(result.code).toContain('<head data-onlay-source="src/pages/index.astro:2:3">');
    });
  });
}

describe("@onlay/stamp/astro plugin wiring", () => {
  test("onlayStampAstro registers Vite plugins for astro dev and nothing otherwise", () => {
    const registered: unknown[][] = [];
    const integration = onlayStampAstro();
    expect(integration.name).toBe("onlay:source-stamp");

    integration.hooks["astro:config:setup"]({
      command: "build",
      updateConfig: (config) => registered.push(config.vite.plugins),
    });
    expect(registered).toHaveLength(0);

    integration.hooks["astro:config:setup"]({
      command: "dev",
      updateConfig: (config) => registered.push(config.vite.plugins),
    });
    expect(registered).toHaveLength(1);
    const names = registered[0]?.map((plugin) => (plugin as { name: string }).name);
    expect(names).toEqual(["onlay:astro-source-stamp", "onlay:source-stamp"]);
  });

  test("onlayStampAstroVite loads and stamps only plain .astro module requests", async () => {
    const root = mkdtempSync(join(tmpdir(), "onlay-astro-stamp-"));
    try {
      mkdirSync(join(root, "src/pages"), { recursive: true });
      const page = join(root, "src/pages/index.astro");
      writeFileSync(page, "<main>Hi</main>");

      const plugin = onlayStampAstroVite({ root });
      expect(plugin.apply).toBe("serve");
      expect(plugin.enforce).toBe("pre");

      const loaded = await plugin.load(page);
      expect(loaded?.code).toContain('data-onlay-source="src/pages/index.astro:1:1"');

      // Query sub-requests (styles/scripts) stay with Astro's own loader.
      expect(await plugin.load(`${page}?astro&type=script&index=0`)).toBe(null);
      expect(await plugin.load(join(root, "src/pages/missing.astro"))).toBe(null);
      expect(await plugin.load(join(root, "src/pages/other.html"))).toBe(null);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
