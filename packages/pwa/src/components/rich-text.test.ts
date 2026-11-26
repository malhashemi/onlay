// Mention display re-segmentation: a token-less @name stays plain (no token,
// no routing, no pill — visual truth), a person or agent token renders as a
// mention pill, anchor tokens and hostile body text stay text nodes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RawRichText } from "@onlay/protocol";
import { Window } from "happy-dom";
import { setCodeHighlighter } from "./code-block";
import { fencedText, renderRichText } from "./rich-text";

let win: Window | null = null;
const savedGlobals = new Map<string, unknown>();
const DOM_GLOBALS = ["window", "document", "Element", "HTMLElement", "Node", "Event"] as const;

beforeEach(() => {
  win = new Window({ url: "http://127.0.0.1:8123/app/" });
  const w = win as unknown as Record<string, unknown>;
  const g = globalThis as unknown as Record<string, unknown>;
  for (const k of DOM_GLOBALS) {
    savedGlobals.set(k, g[k]);
    g[k] = w[k];
  }
});
afterEach(() => {
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
  const g = globalThis as unknown as Record<string, unknown>;
  for (const [k, v] of savedGlobals) g[k] = v;
  savedGlobals.clear();
});

const ADA = "p_aaaaaaaaaaaaaaaaaaaa";
const NAMES: Record<string, string> = { [ADA]: "Ada Lovelace" };

function nameOf(id: string): string {
  return NAMES[id] ?? "Someone";
}

function draw(body: RawRichText): HTMLElement {
  const host = document.createElement("p");
  host.append(renderRichText(body, nameOf));
  return host;
}

describe("renderRichText", () => {
  test("a token-less @name renders plain — no pill for what never routed", () => {
    const host = draw({ text: "hey @ada-lovelace can you look" });
    expect(host.querySelector(".mention-pill")).toBeNull();
    expect(host.textContent).toBe("hey @ada-lovelace can you look");
  });

  test("a person token pills @<name>, the text either client writes, titled with the name", () => {
    const host = draw({
      text: "hey @Ada Lovelace can you look",
      tokens: [{ t: "actor", actorId: ADA }],
    });
    const pill = host.querySelector(".mention-pill") as HTMLElement;
    expect(pill.textContent).toBe("@Ada Lovelace");
    expect(pill.title).toBe("Ada Lovelace");
    expect(host.textContent).toBe("hey @Ada Lovelace can you look");
  });

  test("a bare @<person id> pills as the person's name", () => {
    const host = draw({ text: `ping @${ADA} now`, tokens: [{ t: "actor", actorId: ADA }] });
    expect((host.querySelector(".mention-pill") as HTMLElement).textContent).toBe("@Ada Lovelace");
  });

  test("an agent token pills @agent", () => {
    const host = draw({ text: "@agent please fix", tokens: [{ t: "agent" }] });
    const pill = host.querySelector(".mention-pill") as HTMLElement;
    expect(pill.textContent).toBe("@agent");
    expect(host.textContent).toBe("@agent please fix");
  });

  test("only the token's occurrence pills; later bare repeats stay plain", () => {
    const host = draw({
      text: "@Ada Lovelace then @Ada Lovelace again",
      tokens: [{ t: "actor", actorId: ADA }],
    });
    expect(host.querySelectorAll(".mention-pill").length).toBe(1);
  });

  test("a longer run is not a match for a shorter handle", () => {
    const host = draw({ text: "@agents unite", tokens: [{ t: "agent" }] });
    expect(host.querySelector(".mention-pill")).toBeNull();
  });

  test("anchor tokens stay plain text — the web app has no page to point at", () => {
    const host = draw({
      text: "see #Pricing table for this",
      tokens: [{ t: "anchor", anchor: { level: "unanchored" }, label: "Pricing table" }],
    });
    expect(host.querySelector(".mention-pill")).toBeNull();
    expect(host.textContent).toBe("see #Pricing table for this");
  });

  test("hostile body text stays text — never parsed as markup", () => {
    const text = 'hi <img src=x onerror="alert(1)"> @agent';
    const host = draw({ text, tokens: [{ t: "agent" }] });
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toBe(text);
    expect(host.querySelectorAll(".mention-pill").length).toBe(1);
  });

  test("a token whose wire text is absent is skipped, text intact", () => {
    const host = draw({ text: "no mention here", tokens: [{ t: "actor", actorId: ADA }] });
    expect(host.querySelector(".mention-pill")).toBeNull();
    expect(host.textContent).toBe("no mention here");
  });
});

describe("fenced code blocks", () => {
  afterEach(() => setCodeHighlighter(null));

  test("a block renders as a code block; pills outside it stay pills", async () => {
    const asked: string[] = [];
    setCodeHighlighter({
      peek: () => undefined,
      load: async (lang) => {
        asked.push(lang);
        return null;
      },
    });
    const host = draw({
      text: '@agent run this:\n```ts\nconst who = "@agent";\n```\nthanks @Ada Lovelace',
      tokens: [{ t: "agent" }, { t: "actor", actorId: ADA }],
    });
    const pills = [...host.querySelectorAll(".mention-pill")];
    expect(pills.map((p) => p.textContent)).toEqual(["@agent", "@Ada Lovelace"]);
    const block = host.querySelector(".code-block") as HTMLElement;
    expect(block.querySelector(".code-text")?.textContent).toBe('const who = "@agent";');
    expect(block.querySelector(".mention-pill")).toBeNull();
    expect(block.querySelector(".code-copy")?.textContent).toBe("Copy");
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toEqual(["typescript"]);
  });

  test("an Edit's intent without fences is the same plain element as before", () => {
    const plain = fencedText("p", "hero-question", "make it bigger");
    expect(plain.tagName).toBe("P");
    expect(plain.textContent).toBe("make it bigger");
    const fenced = fencedText("p", "hero-question", "use\n```css\na { color: red }\n```");
    expect(fenced.tagName).toBe("DIV");
    expect(fenced.querySelector(".code-block .code-text")?.textContent).toBe("a { color: red }");
  });
});

describe("people the web app cannot resolve yet", () => {
  test("their mention stays plain text until it can", () => {
    const host = document.createElement("p");
    host.append(
      renderRichText(
        { text: "hey @Zed", tokens: [{ t: "actor", actorId: "p_zzzzzzzzzzzzzzzzzzzz" }] },
        () => undefined,
      ),
    );
    expect(host.querySelector(".mention-pill")).toBeNull();
    expect(host.textContent).toBe("hey @Zed");
  });
});
