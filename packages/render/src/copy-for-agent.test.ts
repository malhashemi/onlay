// Copy for agent, byte for byte against spec §9: the round form and the
// single-item form, plus the "changed since copied" memory.
import { describe, expect, test } from "bun:test";
import {
  changedSinceCopied,
  interactionUpdatedAt,
  itemCopyText,
  type KeyValue,
  markCopied,
  roundCopyText,
  threadLink,
} from "./copy-for-agent";

const ORIGIN = "https://app.onlay.dev";
const SPACE = "s_aaaaaaaaaaaaaaaaaaaa";
const IID = "11111111-2222-4333-8444-555555555555";

describe("round form", () => {
  test("matches the spec's three lines", () => {
    const url = "https://acme.test/pricing?plan=pro";
    expect(
      roundCopyText({ origin: ORIGIN, spaceId: SPACE, spaceName: "acme", url, count: 3 }),
    ).toBe(
      "Onlay: 3 item(s) for an agent on https://acme.test/pricing?plan=pro (acme)\n" +
        "https://app.onlay.dev/app/#/round/s_aaaaaaaaaaaaaaaaaaaa?url=https%3A%2F%2Facme.test%2Fpricing%3Fplan%3Dpro\n" +
        'With the onlay MCP tools: inbox {"space": "s_aaaaaaaaaaaaaaaaaaaa", "url": "https://acme.test/pricing?plan=pro"}, then for each item take, read, and answer.',
    );
  });

  test("a quote in the url stays valid JSON in the inbox call", () => {
    const text = roundCopyText({
      origin: ORIGIN,
      spaceId: SPACE,
      spaceName: "acme",
      url: 'https://acme.test/"x"',
      count: 1,
    });
    const call = text.split("\n")[2] ?? "";
    const json = call.slice(call.indexOf("{"), call.indexOf("}") + 1);
    expect(JSON.parse(json)).toEqual({ space: SPACE, url: 'https://acme.test/"x"' });
  });

  test("a round over a tab's frames names each page, the top page first (A-2)", () => {
    const top = "https://shell.test/goals";
    const frame = "https://content.test/page";
    expect(
      roundCopyText({
        origin: ORIGIN,
        spaceId: SPACE,
        spaceName: "acme",
        url: top,
        count: 3,
        pages: [top, frame],
      }),
    ).toBe(
      "Onlay: 3 items for an agent on 2 pages (acme)\n" +
        "https://app.onlay.dev/app/#/round/s_aaaaaaaaaaaaaaaaaaaa?url=https%3A%2F%2Fshell.test%2Fgoals\n" +
        "https://app.onlay.dev/app/#/round/s_aaaaaaaaaaaaaaaaaaaa?url=https%3A%2F%2Fcontent.test%2Fpage\n" +
        "With the onlay MCP tools, call:\n" +
        'inbox {"space": "s_aaaaaaaaaaaaaaaaaaaa", "url": "https://shell.test/goals"}\n' +
        'inbox {"space": "s_aaaaaaaaaaaaaaaaaaaa", "url": "https://content.test/page"}\n' +
        "Then for each item, take, read, and answer.",
    );
    // One page stays the three lines it always was.
    expect(
      roundCopyText({
        origin: ORIGIN,
        spaceId: SPACE,
        spaceName: "acme",
        url: frame,
        count: 1,
        pages: [frame],
      }),
    ).toBe(
      roundCopyText({ origin: ORIGIN, spaceId: SPACE, spaceName: "acme", url: frame, count: 1 }),
    );
  });
});

describe("single-item form", () => {
  test("matches the spec's three lines", () => {
    expect(
      itemCopyText({
        origin: ORIGIN,
        spaceId: SPACE,
        spaceName: "acme",
        interactionId: IID,
        kind: "change",
        url: "https://acme.test/pricing",
      }),
    ).toBe(
      "Onlay: Edit on https://acme.test/pricing (acme)\n" +
        "https://app.onlay.dev/app/#/t/s_aaaaaaaaaaaaaaaaaaaa/11111111-2222-4333-8444-555555555555\n" +
        'read {"ref": "s_aaaaaaaaaaaaaaaaaaaa/11111111-2222-4333-8444-555555555555"}',
    );
  });

  test("an unanchored item has no page to name", () => {
    expect(
      itemCopyText({
        origin: ORIGIN,
        spaceId: SPACE,
        spaceName: "personal",
        interactionId: IID,
        kind: "comment",
      }).split("\n")[0],
    ).toBe("Onlay: Comment (personal)");
  });

  test("the thread link is the web link of spec §4", () => {
    expect(threadLink(ORIGIN, SPACE, IID)).toBe(`${ORIGIN}/app/#/t/${SPACE}/${IID}`);
  });
});

describe("changed since copied", () => {
  function kv(): KeyValue & { map: Map<string, string> } {
    const map = new Map<string, string>();
    return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
  }

  test("never copied → no marker; updated after the copy → marker", () => {
    const s = kv();
    const ref = `${SPACE}/${IID}`;
    expect(changedSinceCopied(s, "p1", ref, 100)).toBe(false);
    markCopied(s, "p1", [ref], 50);
    expect(changedSinceCopied(s, "p1", ref, 50)).toBe(false);
    expect(changedSinceCopied(s, "p1", ref, 51)).toBe(true);
    expect(changedSinceCopied(s, "p2", ref, 51)).toBe(false);
  });

  test("broken storage is a quiet no", () => {
    const s: KeyValue = {
      getItem: () => "{not json",
      setItem: () => {
        throw new Error("denied");
      },
    };
    markCopied(s, "p1", ["r"], 1);
    expect(changedSinceCopied(s, "p1", "r", 2)).toBe(false);
  });
});

describe("one update time for both clients", () => {
  test("an edited message counts as a change, not only a new one", () => {
    const base = {
      id: IID,
      kind: "comment",
      anchor: { level: "page" },
      authorId: "p1",
      participants: [],
      waitingOn: [],
      state: "open",
      createdAt: 10,
      thread: [{ msgId: "m1", authorId: "p1", body: { text: "hi" }, ts: 20 }],
    } as unknown as Parameters<typeof interactionUpdatedAt>[0];
    expect(interactionUpdatedAt(base)).toBe(20);
    const edited = { ...base, thread: [{ ...base.thread[0], editedAt: 90 }] } as typeof base;
    expect(interactionUpdatedAt(edited)).toBe(90);
    expect(interactionUpdatedAt({ ...base, resolvedAt: 120 } as typeof base)).toBe(120);
  });
});
