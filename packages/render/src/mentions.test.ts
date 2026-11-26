import { describe, expect, test } from "bun:test";
import { parseFences, type Token } from "@onlay/protocol";
import {
  AGENT_MENTION_TEXT,
  findMention,
  mentionSpellings,
  mentionTextOf,
  personMentionText,
  withPrefix,
} from "./mentions";

const ADA = "p_adaadaadaadaadaadaad";
const names: Record<string, string> = { [ADA]: "Ada Lovelace" };
const nameOf = (id: string) => names[id] ?? "Someone";
const ada: Token = { t: "actor", actorId: ADA };

describe("mention text", () => {
  test("a person reads as @ and their display name; the agent as @agent", () => {
    expect(personMentionText("Ada Lovelace")).toBe("@Ada Lovelace");
    expect(mentionTextOf(ada, nameOf)).toBe("@Ada Lovelace");
    expect(mentionTextOf({ t: "agent" }, nameOf)).toBe(AGENT_MENTION_TEXT);
  });

  test("finds each token's text in order, from the cursor on", () => {
    const text = "@Ada Lovelace, then @agent, then @Ada Lovelace again";
    const first = findMention(text, ada, nameOf, 0);
    expect(first).toEqual({ index: 0, length: "@Ada Lovelace".length });
    const agent = findMention(text, { t: "agent" }, nameOf, (first?.index ?? 0) + 1);
    expect(text.slice(agent?.index, (agent?.index ?? 0) + (agent?.length ?? 0))).toBe("@agent");
    expect(findMention(text, ada, nameOf, 1)?.index).toBe(text.lastIndexOf("@Ada"));
  });

  test("falls back to the bare person id, and gives up when neither is there", () => {
    expect(findMention(`hi @${ADA}`, ada, nameOf, 0)).toEqual({ index: 3, length: ADA.length + 1 });
    expect(findMention("hi @ada-lovelace", ada, nameOf, 0)).toBeNull();
  });

  test("matches whole words only", () => {
    expect(findMention("@agents unite", { t: "agent" }, nameOf, 0)).toBeNull();
    expect(findMention("@agent, unite", { t: "agent" }, nameOf, 0)?.index).toBe(0);
    expect(findMention("@Ada Lovelaces", ada, nameOf, 0)).toBeNull();
  });
});

describe("withPrefix and a body that opens with code", () => {
  test("the prefix takes a line of its own, the fence still opens a block, spans move by it", () => {
    const text = "```css\na { color: red }\n```\n@agent this one";
    const body = {
      text,
      tokens: [{ t: "agent" as const, spans: [{ start: text.indexOf("@agent"), length: 6 }] }],
    };
    const prefix = "Variant 1/2 — Blue: ";
    const sent = withPrefix(body, prefix, 4096);
    expect(sent.text.startsWith("Variant 1/2 — Blue:\n```css\n")).toBe(true);
    const [block] = parseFences(sent.text);
    expect(block?.code).toBe("a { color: red }");
    const span = sent.tokens?.[0]?.spans?.[0];
    expect(sent.text.slice(span?.start, (span?.start ?? 0) + (span?.length ?? 0))).toBe("@agent");
  });

  test("a body that opens with words keeps the prefix on its line", () => {
    expect(withPrefix({ text: "nice" }, "Variant 1/2 — Blue: ", 4096).text).toBe(
      "Variant 1/2 — Blue: nice",
    );
  });
});

describe("withPrefix, more", () => {
  test("a label with a newline stays one line, and makes no fence of its own", () => {
    const sent = withPrefix({ text: "nice" }, "Variant 1/2 — a\n```: ", 4096);
    expect(sent.text).toBe("Variant 1/2 — a ```: nice");
    expect(parseFences(sent.text)).toEqual([]);
  });

  test("a body of only three backticks is no block: no line break is added", () => {
    expect(withPrefix({ text: "```" }, "Variant 1/2 — Blue: ", 4096).text).toBe(
      "Variant 1/2 — Blue: ```",
    );
  });

  test("a token whose only span the cut removed is dropped, not left to match elsewhere", () => {
    const text = "@Ada said hi, and later @Ada";
    const body = {
      text,
      tokens: [{ t: "actor" as const, actorId: ADA, spans: [{ start: 24, length: 4 }] }],
    };
    const sent = withPrefix(body, "P: ", 20);
    expect(sent.text).toBe("P: @Ada said hi, and");
    expect(sent.tokens).toBeUndefined();
  });

  test("a token without spans is kept as it was", () => {
    const sent = withPrefix({ text: "@agent go", tokens: [{ t: "agent" }] }, "P: ", 4096);
    expect(sent.tokens).toEqual([{ t: "agent" }]);
  });
});

describe("findMention", () => {
  test("the earliest spelling wins: a bare @<id> before the name", () => {
    const text = `@${ADA} and @Ada Lovelace`;
    expect(findMention(text, ada, nameOf, 0)).toEqual({ index: 0, length: ADA.length + 1 });
  });
});

describe("a mention written under the person's alias", () => {
  const OLD = "@lovelace said so, and @Ada Lovelace agreed";
  const aliasOf = (id: string) => (id === ADA ? "lovelace" : undefined);

  test("still finds its pill for a reader who knows the alias", () => {
    expect(mentionSpellings(ada, nameOf, aliasOf)).toContain("@lovelace");
    expect(findMention(OLD, ada, nameOf, 0, aliasOf)).toEqual({ index: 0, length: 9 });
  });

  test("stays text for one who doesn't (a guest), and the name still finds it", () => {
    expect(mentionSpellings(ada, nameOf)).not.toContain("@lovelace");
    expect(findMention(OLD, ada, nameOf, 0)?.index).toBe(OLD.indexOf("@Ada"));
  });

  test("a whole run only: @lovelaces is not @lovelace", () => {
    expect(findMention("@lovelaces", ada, nameOf, 0, aliasOf)).toBeNull();
  });
});

describe("the one boundary rule (@onlay/protocol mention-rule)", () => {
  const aliasOf = (id: string) => (id === ADA ? "ada" : undefined);
  test("an @alias glued to a word on its left (an email address) is not a mention", () => {
    expect(findMention("write to me@ada.example", ada, nameOf, 0, aliasOf)).toBeNull();
    expect(findMention("(@ada) thanks", ada, nameOf, 0, aliasOf)).toEqual({ index: 1, length: 4 });
  });
});
