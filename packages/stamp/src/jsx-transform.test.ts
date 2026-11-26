import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { transformJsx } from "./jsx-transform";

describe("transformJsx", () => {
  test("adds project-relative data-onlay-source attributes to JSX elements in dev", () => {
    const root = "/repo/app";
    const filename = join(root, "src/App.tsx");
    const input = [
      "export function App() {",
      "  return (",
      "    <main>",
      '      <button className="primary">Click</button>',
      "    </main>",
      "  );",
      "}",
    ].join("\n");

    const result = transformJsx(input, { dev: true, filename, root });

    expect(result.code).toContain('data-onlay-source="src/App.tsx:3:5"');
    expect(result.code).toContain('data-onlay-source="src/App.tsx:4:7"');
  });

  test("does not stamp JSX in production", () => {
    const root = "/repo/app";
    const filename = join(root, "src/App.tsx");
    const input = "export const App = () => <main><button>Click</button></main>;";

    const result = transformJsx(input, { dev: false, filename, root });

    expect(result.code).toBe(input);
    expect(result.code).not.toContain("data-onlay-source");
  });
});
