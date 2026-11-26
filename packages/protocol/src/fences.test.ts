// The fence grammar every client renders: where a block starts and ends in
// the original text (so pill offsets outside it stay true), its language
// word, its code, and an unclosed fence running to the end.
import { describe, expect, test } from "bun:test";
import { flattenFences, parseFences, previewFirstLine } from "./fences";

describe("parseFences", () => {
  test("no fence, no blocks", () => {
    expect(parseFences("plain words, `inline` stays text")).toEqual([]);
  });

  test("a block between two lines of text: offsets cover the fence lines and their breaks", () => {
    const text = 'before\n```json\n{"a": 1}\n```\nafter';
    const [b] = parseFences(text);
    expect(b).toEqual({
      start: "before".length,
      end: text.indexOf("after"),
      lang: "json",
      code: '{"a": 1}',
      closed: true,
    });
    expect(text.slice(0, b?.start)).toBe("before");
    expect(text.slice(b?.end)).toBe("after");
  });

  test("a block at the very start and the very end", () => {
    const text = "```\nx\n```";
    expect(parseFences(text)).toEqual([
      { start: 0, end: text.length, lang: null, code: "x", closed: true },
    ]);
  });

  test("an unclosed fence runs to the end of the text", () => {
    const text = "see\n```ts\nconst a = 1;\nconst b = 2;";
    const [b] = parseFences(text);
    expect(b?.closed).toBe(false);
    expect(b?.end).toBe(text.length);
    expect(b?.code).toBe("const a = 1;\nconst b = 2;");
    expect(b?.lang).toBe("ts");
  });

  test("an empty block", () => {
    const [b] = parseFences("a\n```\n```\nb");
    expect(b?.code).toBe("");
    expect(b?.closed).toBe(true);
  });

  test("the language word: lower-cased, one word only, trimmed", () => {
    expect(parseFences("```TypeScript\nx\n```")[0]?.lang).toBe("typescript");
    expect(parseFences("```  bash  \nx\n```")[0]?.lang).toBe("bash");
    expect(parseFences("```js title=x\nx\n```")[0]?.lang).toBeNull();
    expect(parseFences("```c++\nx\n```")[0]?.lang).toBe("c++");
  });

  test("backticks after the language make no fence (an inline run on one line)", () => {
    expect(parseFences("```js``` and more")).toEqual([]);
  });

  test("a fence must start its line: one inside a line of text is text", () => {
    // The opener is mid-line, and the last line opens nothing: no block at all.
    expect(parseFences("hey @agent ```js\nconst a = 1\n```")).toEqual([]);
    const text = "hey @agent look:\n```js\nconst a = 1\n```";
    expect(parseFences(text)[0]?.start).toBe("hey @agent look:".length);
  });

  test("a closing line takes only backticks and spaces", () => {
    const [b] = parseFences("```\na\n``` nope\nb\n```  ");
    expect(b?.code).toBe("a\n``` nope\nb");
    expect(b?.closed).toBe(true);
  });

  test("two blocks, text between them", () => {
    const text = "one\n```\na\n```\nmiddle\n```py\nb\n```\nend";
    const blocks = parseFences(text);
    expect(blocks.map((b) => b.code)).toEqual(["a", "b"]);
    const [x, y] = blocks;
    expect(text.slice(x?.end, y?.start)).toBe("middle");
    expect(text.slice(y?.end)).toBe("end");
  });

  test("CRLF: the code loses its CRs, the text around keeps its own characters", () => {
    const text = "hi\r\n```json\r\n{}\r\n[]\r\n```\r\nbye";
    const [b] = parseFences(text);
    expect(b?.code).toBe("{}\n[]");
    expect(b?.lang).toBe("json");
    expect(text.slice(0, b?.start)).toBe("hi");
    expect(text.slice(b?.end)).toBe("bye");
  });
});

describe("flattenFences", () => {
  test("text without fences is unchanged", () => {
    expect(flattenFences("just words\nand more")).toBe("just words\nand more");
  });

  test("a block reads as its code, no markers", () => {
    expect(flattenFences("Try this:\n```bash\nbun run check\n```")).toBe(
      "Try this:\nbun run check",
    );
    expect(flattenFences("```json\n{}\n```\nthanks")).toBe("{}\nthanks");
  });
});

describe("the edge cases that lost text", () => {
  test("an empty block between two lines keeps them apart in a preview", () => {
    expect(flattenFences("before\n```\n```\nafter")).toBe("before\nafter");
  });

  test("a fence line with a word inside a block is code, kept by one preview pass", () => {
    expect(flattenFences("```md\n```js\nx\n```")).toBe("```js\nx");
  });

  test("a bare CR at the end of an unclosed block is the code's own", () => {
    const [b] = parseFences("```\nline\r");
    expect(b?.closed).toBe(false);
    expect(b?.code).toBe("line\r");
    expect(parseFences("```\r\nline\r\n```")[0]?.code).toBe("line");
  });
});

describe("previewFirstLine", () => {
  test("a message that opens with code quotes its first line of code", () => {
    expect(previewFirstLine('```json\n{"a": 1}\n```\nthat one')).toBe('{"a": 1}');
    expect(previewFirstLine("words first\n```\nx\n```")).toBe("words first");
  });
});
