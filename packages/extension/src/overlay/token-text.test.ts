/// <reference types="chrome" />
// TokenText — the display twin: tokens-as-data render as chips. A mentioned
// person's chip reads `@Name` (or a pre-rename `@<id>`), `@agent` is the same
// round pill, and anchor chips click through to the reveal hook. A message
// with no tokens is plain text.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Token } from "@onlay/protocol";
import { Window } from "happy-dom";
import { type AppInternals, createApp } from "./app";
import { setCodeHighlighter } from "./code-blocks";
import type { PersonView } from "./people";
import type { AnchorToken } from "./token-input";
import { renderRichText } from "./token-text";

const SPACE = "s_aaaaaaaaaaaaaaaaaaaa";
let win: Window | null = null;

function installDom(): void {
  win = new Window({ url: "http://127.0.0.1:8124/page.html" });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = win;
  g.document = win.document;
  g.Element = win.Element;
  g.HTMLElement = win.HTMLElement;
  g.Node = win.Node;
  g.Event = win.Event;
  g.crypto = win.crypto ?? globalThis.crypto;
}

beforeEach(installDom);
afterEach(() => {
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
});

const ADA = "p_adaadaadaadaadaadaad";
const DIRECTORY: PersonView[] = [{ id: ADA, name: "Ada", tint: "#0ea5e9", initials: "AD" }];

function makeApp(): ReturnType<typeof createApp> & AppInternals {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const app = createApp({ shadow, host, isTopFrame: true, toast: () => {} }) as ReturnType<
    typeof createApp
  > &
    AppInternals;
  app._setDirectory(SPACE, DIRECTORY);
  return app;
}

function render(
  app: ReturnType<typeof makeApp>,
  body: { text: string; tokens?: Token[] },
  deps?: Parameters<typeof renderRichText>[2],
): HTMLElement {
  const holder = document.createElement("div");
  holder.appendChild(renderRichText(app, body, deps));
  return holder;
}

const ANCHOR_TOKEN: AnchorToken = {
  t: "anchor",
  anchor: { level: "element", selector: "#hero" },
  label: "§hero",
};

describe("tokens as data", () => {
  test("person, agent and anchor tokens render as chips in reading order", () => {
    const app = makeApp();
    const holder = render(app, {
      text: "fix @Ada at #§hero, @agent please",
      tokens: [{ t: "actor", actorId: ADA }, ANCHOR_TOKEN, { t: "agent" }],
    });
    expect(holder.textContent).toBe("fix @Ada at #§hero, @agent please");
    const chips = [...holder.querySelectorAll(".token-pill")];
    expect(chips.map((c) => c.textContent)).toEqual(["@Ada", "#§hero", "@agent"]);
    expect(chips[0]?.className).toContain("token-actor");
    expect(chips[2]?.className).toContain("token-actor");
    expect(chips[1]?.className).toContain("token-anchor");
  });

  test("a mention written before a rename still finds its @<id> text", () => {
    const app = makeApp();
    const holder = render(app, {
      text: `ping @${ADA}`,
      tokens: [{ t: "actor", actorId: ADA }],
    });
    expect(holder.querySelectorAll(".token-pill").length).toBe(1);
  });

  test("a mention written while the person went by their alias pills as their name now", () => {
    const app = makeApp();
    app._setDirectory(SPACE, [{ ...DIRECTORY[0], alias: "ada.l" } as PersonView]);
    const body = {
      text: "ping @ada.l about it",
      tokens: [{ t: "actor" as const, actorId: ADA, spans: [{ start: 5, length: 6 }] }],
    };
    const holder = render(app, body, { spaceId: SPACE });
    const chips = [...holder.querySelectorAll(".token-pill")];
    expect(chips.map((c) => c.textContent)).toEqual(["@Ada"]);
    // A thread in another space (where this reader is a guest) never uses an
    // alias learned as a member here.
    const GUEST_SPACE = "s_bbbbbbbbbbbbbbbbbbbb";
    app._setDirectory(GUEST_SPACE, [{ ...DIRECTORY[0] } as PersonView]);
    const elsewhere = render(app, body, { spaceId: GUEST_SPACE });
    expect(elsewhere.querySelectorAll(".token-pill").length).toBe(0);
    // A reader who isn't given the alias (a guest) keeps the words as text.
    const guest = makeApp();
    const plain = render(guest, {
      text: "ping @ada.l about it",
      tokens: [{ t: "actor", actorId: ADA, spans: [{ start: 5, length: 6 }] }],
    });
    expect(plain.querySelectorAll(".token-pill").length).toBe(0);
    expect(plain.textContent).toBe("ping @ada.l about it");
  });

  test("no agent class or squared shape survives: one pill for everyone", () => {
    const app = makeApp();
    const holder = render(app, { text: "@agent go", tokens: [{ t: "agent" }] });
    const chip = holder.querySelector(".token-actor");
    expect(chip?.className).not.toContain("agent");
    expect(chip?.className).not.toContain("human");
  });

  test("a message without tokens is plain text, even with @words in it", () => {
    const app = makeApp();
    const holder = render(app, { text: "@Ada and @agent" });
    expect(holder.querySelectorAll(".token-pill").length).toBe(0);
    expect(holder.textContent).toBe("@Ada and @agent");
  });

  test("anchor chips click through to the reveal hook", () => {
    const app = makeApp();
    let clicked: AnchorToken | null = null;
    const holder = render(
      app,
      { text: "see #§hero", tokens: [ANCHOR_TOKEN] },
      {
        onAnchorClick: (tok) => {
          clicked = tok;
        },
      },
    );
    const chip = holder.querySelector(".token-anchor") as HTMLElement;
    expect(chip.className).toContain("clickable");
    // A synthesized click reveals nothing; a person's click does.
    chip.dispatchEvent(new Event("click", { bubbles: true }));
    expect(clicked as AnchorToken | null).toBeNull();
    const trusted = new Event("click", { bubbles: true });
    Object.defineProperty(trusted, "isTrusted", { value: true });
    chip.dispatchEvent(trusted);
    expect(clicked as AnchorToken | null).toEqual(ANCHOR_TOKEN);
  });
});

describe("fenced code blocks", () => {
  const g = globalThis as unknown as Record<string, unknown>;
  let asked: Array<Record<string, unknown>> = [];
  let answer: unknown = null;
  beforeEach(() => {
    asked = [];
    answer = null;
    setCodeHighlighter(null);
    g.chrome = {
      runtime: {
        id: "test",
        sendMessage: async (m: Record<string, unknown>) => {
          asked.push(m);
          return answer;
        },
      },
    };
  });
  afterEach(() => {
    setCodeHighlighter(null);
    delete g.chrome;
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));

  test("pills around a block stay pills; nothing inside the block becomes one", () => {
    const app = makeApp();
    const holder = render(app, {
      text: "@Ada try this\n```bash\necho @agent\n```\nthanks @agent",
      tokens: [{ t: "actor", actorId: ADA }, { t: "agent" }],
    });
    const chips = [...holder.querySelectorAll(".token-pill")];
    expect(chips.map((c) => c.textContent)).toEqual(["@Ada", "@agent"]);
    expect(chips.every((c) => c.parentElement === holder)).toBe(true);
    const block = holder.querySelector(".code-block") as HTMLElement;
    expect(block.querySelector(".code-lang")?.textContent).toBe("bash");
    expect(block.querySelector(".code-text")?.textContent).toBe("echo @agent");
    expect(block.querySelector(".token-pill")).toBeNull();
  });

  test("colors come from the service worker, checked against the code first", async () => {
    answer = {
      ok: true,
      runs: [
        ["echo", 5],
        [" hi", 2],
      ],
    };
    const holder = render(makeApp(), { text: "```sh\necho hi\n```" });
    await tick();
    await tick();
    expect(asked).toEqual([{ type: "highlight", lang: "bash", code: "echo hi" }]);
    const spans = [...holder.querySelectorAll(".code-text span")];
    expect(spans.map((s) => [s.className, s.textContent])).toEqual([
      ["code-k-function", "echo"],
      ["code-k-string", " hi"],
    ]);
  });

  test("runs that do not spell the code, or carry an unknown kind, paint nothing", async () => {
    for (const runs of [[["echo hi; rm -rf /", 1]], [["echo hi", 99]], "<b>echo hi</b>"]) {
      setCodeHighlighter(null);
      answer = { ok: true, runs };
      const holder = render(makeApp(), { text: "```bash\necho hi\n```" });
      await tick();
      await tick();
      expect(holder.querySelectorAll(".code-text *").length).toBe(0);
      expect(holder.querySelector(".code-text")?.textContent).toBe("echo hi");
    }
  });

  test("a block with no language or an unknown one is never sent to be colored", async () => {
    render(makeApp(), { text: "```\nplain\n```\n```cobol\nMOVE A TO B\n```" });
    await tick();
    expect(asked).toEqual([]);
  });
});

describe("stored spans are checked before a pill is drawn", () => {
  test("a span over another name, or part of a longer name, draws no pill", () => {
    const app = makeApp();
    const wrong = render(app, {
      text: "ping @Other now",
      tokens: [{ t: "actor", actorId: ADA, spans: [{ start: 5, length: 6 }] }],
    });
    expect(wrong.querySelector(".token-pill")).toBeNull();
    expect(wrong.textContent).toBe("ping @Other now");
    const partial = render(app, {
      text: "ping @Adam now",
      tokens: [{ t: "actor", actorId: ADA, spans: [{ start: 5, length: 4 }] }],
    });
    expect(partial.querySelector(".token-pill")).toBeNull();
  });

  test("a span that holds its token draws the pill, even past the same words as text", () => {
    const app = makeApp();
    const holder = render(app, {
      text: "@Ada wrote; then @Ada",
      tokens: [{ t: "actor", actorId: ADA, spans: [{ start: 17, length: 4 }] }],
    });
    const chips = [...holder.querySelectorAll(".token-pill")];
    expect(chips).toHaveLength(1);
    expect(holder.firstChild?.textContent).toBe("@Ada wrote; then ");
  });

  test("a person this client cannot resolve yet stays plain text", () => {
    const app = makeApp();
    const holder = render(app, {
      text: "hey @Zed",
      tokens: [{ t: "actor", actorId: "p_zzzzzzzzzzzzzzzzzzzz", spans: [{ start: 4, length: 4 }] }],
    });
    expect(holder.querySelector(".token-pill")).toBeNull();
    expect(holder.textContent).toBe("hey @Zed");
  });
});
