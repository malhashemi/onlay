// Shiki through the JavaScript engine, read back as runs: they spell the code
// exactly and carry only the closed kinds. (JSON here: the runtimes that
// matter are Chromium's; Bun's regex engine differs on the larger grammars.)
import { describe, expect, test } from "bun:test";
import { MAX_HIGHLIGHT_CHARS, TOKEN_KINDS, validateRuns } from "./code-block";
import { highlightRuns } from "./highlight";

describe("highlightRuns", () => {
  test("JSON comes back as runs that pass the page's own check", async () => {
    const code =
      '{\n  "mcpServers": { "onlay": { "url": "https://app.onlay.dev/mcp" } },\n  "n": 1\n}';
    const runs = await highlightRuns("json", code);
    expect(runs).not.toBeNull();
    expect(validateRuns(runs, code)).toEqual(runs);
    const kinds = new Set((runs ?? []).map(([, k]) => TOKEN_KINDS[k]));
    expect(kinds.has("constant")).toBe(true);
    expect(kinds.has("punctuation")).toBe(true);
  });

  test("an unknown language, empty code, code over the cap or with a CR gets nothing", async () => {
    expect(await highlightRuns("cobol", "x")).toBeNull();
    expect(await highlightRuns("constructor", "x")).toBeNull();
    expect(await highlightRuns("json", "")).toBeNull();
    expect(await highlightRuns("json", "1".repeat(MAX_HIGHLIGHT_CHARS + 1))).toBeNull();
    expect(await highlightRuns("json", "{}\r\n")).toBeNull();
  });
});
