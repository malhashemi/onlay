// The shared code block: runs from outside are checked against the code
// before they paint, colors are progressive (uncolored first, never hidden),
// Copy copies the code and says so, and fenced bodies keep their pills
// outside the code.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseFences } from "@onlay/protocol";
import { Window } from "happy-dom";
import {
  CODE_BLOCK_CSS,
  type CodeBlockDeps,
  type CodeRun,
  codeBlock,
  codeLangOf,
  createCodeHighlighter,
  MAX_HIGHLIGHT_CHARS,
  placeOutsideFences,
  renderFencedBody,
  TOKEN_KINDS,
  validateRuns,
} from "./code-block";

let win: Window | null = null;
beforeEach(() => {
  win = new Window({ url: "http://127.0.0.1:8123/app/" });
});
afterEach(() => {
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
});
const doc = () => (win as Window).document as unknown as Document;
const tick = () => new Promise((r) => setTimeout(r, 0));
/** Long enough for the status line's emptying and refilling. */
const said = () => new Promise((r) => setTimeout(r, 80));

describe("validateRuns", () => {
  const code = 'const a = "x";';
  const good: CodeRun[] = [
    ["const", 1],
    [" a = ", 0],
    ['"x"', 2],
    [";", 7],
  ];

  test("runs that spell the code exactly, with known kinds, pass", () => {
    expect(validateRuns(good, code)).toEqual(good);
  });

  test("runs whose text differs from the code are refused (no injected text)", () => {
    expect(validateRuns([...good.slice(0, 3), ["; alert(1)", 7]], code)).toBeNull();
    expect(validateRuns(good.slice(0, 3), code)).toBeNull();
  });

  test("an unknown kind, a non-integer, an empty run or a bad shape is refused", () => {
    expect(validateRuns([[code, TOKEN_KINDS.length]], code)).toBeNull();
    expect(validateRuns([[code, -1]], code)).toBeNull();
    expect(validateRuns([[code, 1.5]], code)).toBeNull();
    expect(
      validateRuns(
        [
          ["", 0],
          [code, 0],
        ],
        code,
      ),
    ).toBeNull();
    expect(validateRuns([[code, "keyword"]], code)).toBeNull();
    expect(validateRuns([{ text: code, kind: 0 }], code)).toBeNull();
    expect(validateRuns([[code, 0, "color: red"]], code)).toBeNull();
    expect(validateRuns({ runs: [] }, code)).toBeNull();
    expect(validateRuns(null, code)).toBeNull();
  });

  test("diff and Markdown kinds pass, and paint their own classes", () => {
    const kind = (k: string) => (TOKEN_KINDS as readonly string[]).indexOf(k);
    const diff = "-old\n+new\n! changed";
    const diffRuns: CodeRun[] = [
      ["-old", kind("deleted")],
      ["\n", 0],
      ["+new", kind("inserted")],
      ["\n", 0],
      ["! changed", kind("changed")],
    ];
    expect(validateRuns(diffRuns, diff)).toEqual(diffRuns);
    const md = "# Title\n**bold**";
    const mdRuns: CodeRun[] = [
      ["# Title", kind("heading")],
      ["\n", 0],
      ["**bold**", kind("strong")],
    ];
    expect(validateRuns(mdRuns, md)).toEqual(mdRuns);
    // The set stays closed: one past the last kind is refused.
    expect(validateRuns([[md, TOKEN_KINDS.length]], md)).toBeNull();
    const hl = createCodeHighlighter(async () => diffRuns);
    const node = codeBlock(doc(), { code: diff, lang: "diff" }, deps({ highlighter: hl }));
    return tick().then(() => {
      expect([...node.querySelectorAll(".code-text span")].map((n) => n.className)).toEqual([
        "code-k-deleted",
        "code-k-inserted",
        "code-k-changed",
      ]);
    });
  });

  test("more runs than characters is refused", () => {
    expect(
      validateRuns(
        [
          ["a", 0],
          ["b", 0],
          ["", 0],
        ],
        "ab",
      ),
    ).toBeNull();
  });
});

describe("codeLangOf", () => {
  test("names, aliases, and anything else uncolored", () => {
    expect(codeLangOf("json")).toBe("json");
    expect(codeLangOf("TS")).toBe("typescript");
    expect(codeLangOf("sh")).toBe("bash");
    expect(codeLangOf("yml")).toBe("yaml");
    expect(codeLangOf("brainfuck")).toBeNull();
    expect(codeLangOf("constructor")).toBeNull();
    expect(codeLangOf(null)).toBeNull();
  });
});

function deps(over: Partial<CodeBlockDeps> = {}): CodeBlockDeps & { copiedText: string[] } {
  const copiedText: string[] = [];
  return {
    copy: async (t) => {
      copiedText.push(t);
      return true;
    },
    trusted: () => true,
    copiedText,
    ...over,
  };
}

describe("codeBlock", () => {
  test("shows the code at once as text, with its label and a labelled Copy", () => {
    const code = "<img src=x onerror=alert(1)>";
    const node = codeBlock(doc(), { code, label: "html", lang: "html" }, deps());
    expect(node.querySelector("img")).toBeNull();
    expect(node.querySelector(".code-text")?.textContent).toBe(code);
    expect(node.querySelector(".code-lang")?.textContent).toBe("html");
    const copy = node.querySelector(".code-copy") as HTMLButtonElement;
    expect(copy.textContent).toBe("Copy");
    expect(copy.type).toBe("button");
    expect(copy.getAttribute("aria-label")).toBe("Copy code");
    const pre = node.querySelector(".code-pre") as HTMLElement;
    expect(pre.tabIndex).toBe(0);
    // A right-to-left page never turns the code around.
    expect(pre.getAttribute("dir")).toBe("ltr");
    // The copy's outcome has its status region from the start, empty.
    const status = node.querySelector(".code-status") as HTMLElement;
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).toBe("");
  });

  test("no label, no label tag", () => {
    const node = codeBlock(doc(), { code: "https://app.onlay.dev/mcp" }, deps());
    expect(node.querySelector(".code-lang")).toBeNull();
  });

  test("Copy copies the code and says so in the block's status; the button keeps its name", async () => {
    const d = deps();
    const node = codeBlock(doc(), { code: "bun run check" }, d);
    const copy = node.querySelector(".code-copy") as HTMLElement;
    copy.click();
    await said();
    expect(d.copiedText).toEqual(["bun run check"]);
    expect(node.querySelector(".code-status")?.textContent).toBe("Copied.");
    expect(copy.classList.contains("is-copied")).toBe(true);
    expect(copy.textContent).toBe("Copy");
    expect(copy.getAttribute("aria-label")).toBe("Copy code");
  });

  test("a repeated outcome is emptied and filled again, so it is heard again", async () => {
    const node = codeBlock(doc(), { code: "x" }, deps());
    const status = node.querySelector(".code-status") as HTMLElement;
    // Record every write the region gets.
    const seen: string[] = [];
    const proto = Object.getPrototypeOf(status);
    let owner = proto;
    while (owner && !Object.getOwnPropertyDescriptor(owner, "textContent")) {
      owner = Object.getPrototypeOf(owner);
    }
    const real = Object.getOwnPropertyDescriptor(owner, "textContent") as PropertyDescriptor;
    Object.defineProperty(status, "textContent", {
      configurable: true,
      get: () => real.get?.call(status),
      set: (v: string) => {
        seen.push(v);
        real.set?.call(status, v);
      },
    });
    const copy = node.querySelector(".code-copy") as HTMLElement;
    copy.click();
    await said();
    copy.click();
    await said();
    expect(seen.filter((t) => t === "Copied.")).toHaveLength(2);
    expect(seen.at(-2)).toBe("");
    expect(status.textContent).toBe("Copied.");
  });

  test("the empty status region stays in the accessibility tree (never display: none)", () => {
    expect(CODE_BLOCK_CSS).not.toMatch(/\.code-status[^{]*\{[^}]*display:\s*none/);
    expect(CODE_BLOCK_CSS).toContain(".code-status:empty");
  });

  test("an untrusted click copies nothing", async () => {
    const d = deps({ trusted: (e) => e.isTrusted });
    const node = codeBlock(doc(), { code: "x" }, d);
    (node.querySelector(".code-copy") as HTMLElement).click();
    await tick();
    expect(d.copiedText).toEqual([]);
  });

  test("a failed copy says so in the status, in the client's words when it has them", async () => {
    for (const [failedText, words] of [
      [undefined, "Couldn't copy. Try again."],
      [
        "Couldn't copy. Your browser blocked the clipboard.",
        "Couldn't copy. Your browser blocked the clipboard.",
      ],
    ] as const) {
      const node = codeBlock(doc(), { code: "x" }, deps({ copy: async () => false, failedText }));
      (node.querySelector(".code-copy") as HTMLElement).click();
      await said();
      expect(node.querySelector(".code-status")?.textContent).toBe(words);
      expect(node.querySelector(".code-copy")?.textContent).toBe("Copy");
    }
  });

  test("colors arrive later as spans of the closed kinds; the text never changes", async () => {
    const code = '{"a": 1}';
    let answer: (v: unknown) => void = () => {};
    const hl = createCodeHighlighter(() => new Promise((r) => (answer = r)));
    const node = codeBlock(doc(), { code, lang: "json" }, deps({ highlighter: hl }));
    const text = node.querySelector(".code-text") as HTMLElement;
    expect(text.children.length).toBe(0);
    await tick();
    expect(text.children.length).toBe(0);
    answer([
      ["{", 7],
      ['"a"', 1],
      [": ", 7],
      ["1", 4],
      ["}", 7],
    ]);
    await tick();
    expect([...text.querySelectorAll("span")].map((s) => s.className)).toEqual([
      "code-k-punctuation",
      "code-k-keyword",
      "code-k-punctuation",
      "code-k-constant",
      "code-k-punctuation",
    ]);
    expect(text.textContent).toBe(code);
    // The next render of the same code paints at once, from the cache.
    const again = codeBlock(doc(), { code, lang: "json" }, deps({ highlighter: hl }));
    expect(again.querySelectorAll(".code-text span").length).toBe(5);
  });

  test("a failed, refused or absent highlighter leaves the code uncolored and copyable", async () => {
    const code = "a";
    const failing = createCodeHighlighter(() => Promise.reject(new Error("gone")));
    const lying = createCodeHighlighter(async () => [["b", 1]]);
    for (const hl of [failing, lying, undefined]) {
      const d = deps({ highlighter: hl });
      const node = codeBlock(doc(), { code, lang: "json" }, d);
      await tick();
      expect(node.querySelector(".code-text")?.textContent).toBe("a");
      expect(node.querySelectorAll(".code-text span").length).toBe(0);
      (node.querySelector(".code-copy") as HTMLElement).click();
      await tick();
      expect(d.copiedText).toEqual(["a"]);
    }
  });

  test("an unknown language or code over the cap is never sent to the highlighter", async () => {
    const asked: string[] = [];
    const hl = createCodeHighlighter(async (lang) => {
      asked.push(lang);
      return null;
    });
    codeBlock(doc(), { code: "x", lang: "cobol" }, deps({ highlighter: hl }));
    codeBlock(
      doc(),
      { code: "x".repeat(MAX_HIGHLIGHT_CHARS + 1), lang: "json" },
      deps({ highlighter: hl }),
    );
    await tick();
    expect(asked).toEqual([]);
  });

  test("one code is asked for once, however many blocks show it", async () => {
    let calls = 0;
    const hl = createCodeHighlighter(async () => {
      calls += 1;
      return [["x", 0]];
    });
    codeBlock(doc(), { code: "x", lang: "json" }, deps({ highlighter: hl }));
    codeBlock(doc(), { code: "x", lang: "json" }, deps({ highlighter: hl }));
    await tick();
    codeBlock(doc(), { code: "x", lang: "json" }, deps({ highlighter: hl }));
    expect(calls).toBe(1);
  });
});

describe("fenced bodies", () => {
  type Tok = { wire: string; spans?: Array<{ start: number; length: number }> };
  const spellingsOf = (tok: Tok) => [tok.wire];

  function draw(text: string, tokens: Tok[]): HTMLElement {
    const blocks = parseFences(text);
    const placed = placeOutsideFences(text, tokens, blocks, spellingsOf);
    const host = doc().createElement("div");
    host.append(
      renderFencedBody(
        doc(),
        text,
        blocks,
        placed,
        (_p, run) => {
          const pill = doc().createElement("span");
          pill.className = "pill";
          pill.textContent = run;
          return pill;
        },
        (b) => codeBlock(doc(), { code: b.code, label: b.lang, lang: b.lang }, deps()),
      ),
    );
    return host;
  }

  test("pills before, between and after blocks sit where the text says", () => {
    const text = "@ada look\n```js\nx\n```\nthen @bea\n```\ny\n```\nand @cy";
    const host = draw(text, [{ wire: "@ada" }, { wire: "@bea" }, { wire: "@cy" }]);
    expect([...host.querySelectorAll(".pill")].map((p) => p.textContent)).toEqual([
      "@ada",
      "@bea",
      "@cy",
    ]);
    expect([...host.querySelectorAll(".code-text")].map((c) => c.textContent)).toEqual(["x", "y"]);
    // The text outside reads exactly as written, without the blocks' lines.
    const outside = [...host.childNodes]
      .filter((n) => !(n as HTMLElement).classList?.contains("code-block"))
      .map((n) => n.textContent)
      .join("|");
    expect(outside).toBe("@ada| look|then |@bea|and |@cy");
  });

  test("nothing inside a fence becomes a pill; the token's next occurrence outside does", () => {
    const text = "```\n@ada in code\n```\nhi @ada";
    const host = draw(text, [{ wire: "@ada" }]);
    const pills = [...host.querySelectorAll(".pill")];
    expect(pills).toHaveLength(1);
    expect(pills[0]?.parentElement).toBe(host);
    expect(host.querySelector(".code-text")?.textContent).toBe("@ada in code");
  });

  test("a token found only inside a fence is no pill at all", () => {
    const host = draw("```\n@ada\n```", [{ wire: "@ada" }]);
    expect(host.querySelector(".pill")).toBeNull();
  });

  test("no fences: the same nodes as before", () => {
    const host = draw("hi @ada there", [{ wire: "@ada" }]);
    expect([...host.childNodes].map((n) => n.textContent)).toEqual(["hi ", "@ada", " there"]);
  });

  test("stored spans place each pill, even where the same words come first as plain text", () => {
    const text = "@agent said before; now @agent please";
    const at = text.lastIndexOf("@agent");
    const host = draw(text, [{ wire: "@agent", spans: [{ start: at, length: 6 }] }]);
    const pills = [...host.querySelectorAll(".pill")];
    expect(pills).toHaveLength(1);
    expect(host.firstChild?.textContent).toBe("@agent said before; now ");
  });

  test("several spans on one token give a pill each, in text order", () => {
    const text = "@ada and @ada again";
    const host = draw(text, [
      {
        wire: "@ada",
        spans: [
          { start: 9, length: 4 },
          { start: 0, length: 4 },
        ],
      },
    ]);
    expect([...host.childNodes].map((n) => n.textContent)).toEqual([
      "@ada",
      " and ",
      "@ada",
      " again",
    ]);
    expect(host.querySelectorAll(".pill")).toHaveLength(2);
  });

  test("a span that reaches into a fence, or past the text, is dropped", () => {
    const text = "hi @ada\n```\n@ada\n```";
    const fenceStart = parseFences(text)[0]?.start ?? -1;
    const host = draw(text, [
      {
        wire: "@ada",
        spans: [
          { start: fenceStart - 2, length: 4 },
          { start: text.indexOf("@ada", fenceStart), length: 4 },
          { start: text.length - 1, length: 4 },
        ],
      },
    ]);
    expect(host.querySelector(".pill")).toBeNull();
    expect(host.querySelector(".code-text")?.textContent).toBe("@ada");
  });

  test("a token without spans still finds its text, past pills placed by spans", () => {
    const text = "@ada and @ada";
    const host = draw(text, [{ wire: "@ada", spans: [{ start: 0, length: 4 }] }, { wire: "@ada" }]);
    expect(host.querySelectorAll(".pill")).toHaveLength(2);
  });

  test("a span over text that is not its token's run draws no pill, and the words stay", () => {
    // A wrong name: the span covers @Other but the token spells @Bea.
    const wrong = draw("hi @Other", [{ wire: "@Bea", spans: [{ start: 3, length: 6 }] }]);
    expect(wrong.querySelector(".pill")).toBeNull();
    expect(wrong.textContent).toBe("hi @Other");
    // A partial name: @Ann at the start of @Anna is not a whole run.
    const partial = draw("hi @Anna", [{ wire: "@Ann", spans: [{ start: 3, length: 4 }] }]);
    expect(partial.querySelector(".pill")).toBeNull();
    expect(partial.textContent).toBe("hi @Anna");
    // Half a surrogate pair: the span ends inside an emoji.
    const emoji = "@agent\u{1F600}";
    const half = draw(emoji, [{ wire: "@agent\uD83D", spans: [{ start: 0, length: 7 }] }]);
    expect(half.querySelector(".pill")).toBeNull();
    expect(half.textContent).toBe(emoji);
  });

  test("a token whose spans all fail is not found by its text elsewhere", () => {
    const host = draw("@Bea here, @Other there", [
      { wire: "@Bea", spans: [{ start: 11, length: 6 }] },
    ]);
    expect(host.querySelector(".pill")).toBeNull();
  });

  test("a blocked match never hides an eligible one: @ada-id before a stored @Ada", () => {
    const text = "@ada-id @Ada";
    const host = doc().createElement("div");
    const tokens = [
      { wires: ["@Ada"], spans: [{ start: 8, length: 4 }] },
      { wires: ["@Ada", "@ada-id"] },
    ];
    const placed = placeOutsideFences(text, tokens, parseFences(text), (t) => t.wires);
    expect(placed.map((p) => [p.index, p.length])).toEqual([
      [0, 7],
      [8, 4],
    ]);
    host.append(
      renderFencedBody(
        doc(),
        text,
        [],
        placed,
        (_p, run) => {
          const pill = doc().createElement("span");
          pill.className = "pill";
          pill.textContent = run;
          return pill;
        },
        () => doc().createElement("div"),
      ),
    );
    expect([...host.querySelectorAll(".pill")].map((p) => p.textContent)).toEqual([
      "@ada-id",
      "@Ada",
    ]);
  });
});
