import { describe, expect, test } from "bun:test";
import { htmlToMarkdown } from "./markdown";

describe("htmlToMarkdown — tables (the flagship, deepswe regression)", () => {
  test("a table becomes a GitHub markdown table, structure intact", () => {
    const html = `
      <table>
        <thead><tr><th>Model</th><th>Score</th><th>Cost</th></tr></thead>
        <tbody>
          <tr><td>gpt</td><td>70%±3%</td><td>$13.41</td></tr>
          <tr><td>claude</td><td>80k</td><td>68</td></tr>
        </tbody>
      </table>`;
    const md = htmlToMarkdown(html, 2048);
    expect(md).toContain("| Model | Score | Cost |");
    expect(md).toContain("| --- | --- | --- |");
    expect(md).toContain("| gpt | 70%±3% | $13.41 |");
    expect(md).toContain("| claude | 80k | 68 |");
    // The failure mode this kills: cells collapsed into one blob.
    expect(md).not.toContain("70%±3%$13.41");
  });

  test("pipes inside cells are escaped", () => {
    const html = "<table><tr><td>a|b</td><td>c</td></tr></table>";
    expect(htmlToMarkdown(html, 2048)).toContain("a\\|b");
  });

  test("ragged rows pad to the widest row", () => {
    const html = "<table><tr><th>A</th><th>B</th></tr><tr><td>x</td></tr></table>";
    const md = htmlToMarkdown(html, 2048);
    expect(md).toContain("| x |  |");
  });
});

describe("htmlToMarkdown — lists, headings, inline", () => {
  test("headings and bullets", () => {
    const html = "<h2>Title</h2><ul><li>one</li><li>two</li></ul>";
    const md = htmlToMarkdown(html, 2048);
    expect(md).toContain("## Title");
    expect(md).toContain("- one");
    expect(md).toContain("- two");
  });

  test("ordered lists number their items", () => {
    const md = htmlToMarkdown("<ol><li>first</li><li>second</li></ol>", 2048);
    expect(md).toContain("1. first");
    expect(md).toContain("2. second");
  });

  test("inline emphasis and links flatten to markdown", () => {
    const md = htmlToMarkdown("<p>a <strong>b</strong> <em>c</em> <code>d</code></p>", 2048);
    expect(md).toBe("a **b** *c* `d`");
  });

  test("entities decode", () => {
    expect(htmlToMarkdown("<p>a &amp; b &lt;c&gt;</p>", 2048)).toBe("a & b <c>");
  });
});

describe("htmlToMarkdown — bounds", () => {
  test("caps at maxLen and marks truncation with an ellipsis", () => {
    const html = `<p>${"x".repeat(500)}</p>`;
    const md = htmlToMarkdown(html, 50);
    expect(md.length).toBeLessThanOrEqual(50);
    expect(md.endsWith("…")).toBe(true);
  });

  test("empty / whitespace-only input yields empty string", () => {
    expect(htmlToMarkdown("   ", 2048)).toBe("");
  });
});
