// The section fragments, as the build makes them: whole as markup, with no
// inline style (the page's policy is `style-src 'self'`), and alive when the
// same builders run in a browser.
import { beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { OWN } from "./copy";
import { buildFragment, FRAGMENTS, type FragmentDeps, SAMPLE_PLAN_ID } from "./fragments";
import { useDocument } from "./overlay/dom";
import type { Variant } from "./overlay/model";
import { THREAD, VARIANTS } from "./overlay/strings";

let applied: Array<string | null>;
let deps: FragmentDeps;
beforeEach(() => {
  const win = new Window({ url: "https://onlay.dev/" });
  useDocument(win.document as unknown as Document);
  applied = [];
  deps = {
    now: 1_000,
    rich: { copy: () => Promise.resolve(true) },
    applyVariant: (_plan, variant: Variant | null) => applied.push(variant?.label ?? null),
  };
});

const click = (node: Element | null | undefined): void => {
  (node as HTMLElement).click();
};
const button = (root: Element, text: string): Element | undefined =>
  [...root.querySelectorAll("button")].find((b) => b.textContent === text);

describe("every fragment", () => {
  test("builds to markup with no inline style", () => {
    for (const name of FRAGMENTS) {
      const html = buildFragment(name, deps).outerHTML;
      expect(html.length).toBeGreaterThan(400);
      expect(html).not.toMatch(/\sstyle=/);
      expect(html).not.toMatch(/<script/i);
    }
  });

  test("builds the same markup each time (what the browser puts in place of the build's)", () => {
    for (const name of FRAGMENTS) {
      expect(buildFragment(name, deps).outerHTML).toBe(buildFragment(name, deps).outerHTML);
    }
  });
});

describe("the Comment fragment", () => {
  test("shows the sample thread, and a reply lands in it", () => {
    const node = buildFragment("comment", deps);
    expect(node.querySelectorAll(".msg")).toHaveLength(2);
    expect(node.querySelector(".token-pill")?.textContent).toBe(`@${OWN.sample.daniel}`);
    const box = node.querySelector("textarea") as HTMLTextAreaElement;
    expect(box.placeholder).toBe(THREAD.replyPlaceholder);
    box.value = "Agreed.";
    click(button(node, THREAD.replySend));
    expect(node.querySelectorAll(".msg")).toHaveLength(3);
    expect(node.querySelectorAll(".msg-body")[2]?.textContent).toBe("Agreed.");
  });

  test("resolving turns the reply box into a follow-up", () => {
    const node = buildFragment("comment", deps);
    click(button(node, THREAD.resolve));
    expect(node.querySelector(".chip-resolved")?.textContent).toBe("resolved");
    expect((node.querySelector("textarea") as HTMLTextAreaElement).placeholder).toBe(
      THREAD.followPlaceholder,
    );
    expect(button(node, THREAD.reopen)).toBeDefined();
  });
});

describe("the Edit fragment", () => {
  test("starts on its first variant, on the sample plan", () => {
    const node = buildFragment("edit", deps);
    expect(applied).toEqual([OWN.sample.variantLabels[0]]);
    expect(node.querySelector(`#${SAMPLE_PLAN_ID}`)).not.toBeNull();
    expect(node.querySelector(".variant-current")?.textContent).toBe(
      VARIANTS.current(1, 2, OWN.sample.variantLabels[0]),
    );
    expect(node.querySelector(".mini-chrome .preview-label")?.textContent).toBe(
      VARIANTS.pill(OWN.sample.variantLabels[0]),
    );
  });

  test("stepping goes to the next variant, then the original, and a pick keeps one", () => {
    const node = buildFragment("edit", deps);
    click(button(node, VARIANTS.next));
    click(button(node, VARIANTS.next));
    expect(applied).toEqual([OWN.sample.variantLabels[0], OWN.sample.variantLabels[1], null]);
    expect(node.querySelector(".variant-current")?.textContent).toBe(VARIANTS.original);
    expect((button(node, VARIANTS.pick) as HTMLButtonElement).disabled).toBe(true);
    click(button(node, VARIANTS.next));
    click(button(node, VARIANTS.pick));
    expect(node.querySelector(".variant-status")?.textContent).toBe("resolved — picked");
    expect(applied.at(-1)).toBe(OWN.sample.variantLabels[0]);
    expect(node.querySelector(".mini-chrome .preview-label")?.hasAttribute("hidden")).toBe(true);
  });
});

describe("the agent fragment", () => {
  test("tags the agent's message and shows its code as a block with Copy", () => {
    const node = buildFragment("agent", deps);
    expect(node.querySelector(".agent-tag")?.textContent).toBe(THREAD.agentTag);
    expect(node.querySelector(".token-pill")?.textContent).toBe("@agent");
    expect(node.querySelector(".code-block .code-lang")?.textContent).toBe("json");
    expect(node.querySelector(".code-block .code-text")?.textContent).toContain('"headline"');
    expect(node.querySelector(".code-copy")?.getAttribute("aria-label")).toBe("Copy code");
  });
});

describe("the Inbox fragment", () => {
  test("lists what needs you first, and searching it filters the rows", () => {
    const node = buildFragment("inbox", deps);
    const texts = (): string[] =>
      [...node.querySelectorAll(".q-text")].map((n) => n.textContent ?? "");
    expect(texts()).toEqual([...OWN.sample.inbox]);
    expect([...node.querySelectorAll(".bar-group")].map((n) => n.textContent)).toEqual([
      "on this page",
      "recent",
    ]);
    const input = node.querySelector("input") as HTMLInputElement;
    input.value = "studio";
    input.dispatchEvent(
      new (input.ownerDocument.defaultView as unknown as { Event: typeof Event }).Event("input"),
    );
    expect(texts()).toEqual([OWN.sample.inbox[1], OWN.sample.inbox[3]]);
  });
});

describe("a fragment before the page's script takes it over", () => {
  test("is an example to read: nothing in it is a control", async () => {
    const { asStaticExample } = await import("./static");
    for (const name of FRAGMENTS) {
      const node = buildFragment(name, deps);
      const read = (): string[] =>
        [...node.querySelectorAll(".msg-author, .msg-body, .q-text, .edit-intent, .micro")].map(
          (n) => n.textContent ?? "",
        );
      const before = read();
      asStaticExample(node);
      expect(node.querySelectorAll("button, textarea, input, select, a[href]")).toHaveLength(0);
      for (const n of node.querySelectorAll("[role]")) {
        expect(["group", "status", "presentation"]).toContain(n.getAttribute("role") as string);
      }
      // Only a scrolling code block may take focus: scrolling needs no script.
      for (const n of node.querySelectorAll("[tabindex]")) {
        expect(n.classList.contains("code-pre")).toBe(true);
      }
      expect(
        node.querySelectorAll("[aria-selected], [aria-pressed], [aria-activedescendant]"),
      ).toHaveLength(0);
      // What was read is still read.
      expect(read()).toEqual(before);
      expect(node.outerHTML).not.toMatch(/\sstyle=/);
    }
  });

  test("keeps its dress: a button's classes are on its stand-in, a field shows its placeholder", async () => {
    const { asStaticExample } = await import("./static");
    const node = buildFragment("comment", deps);
    asStaticExample(node);
    const reply = [...node.querySelectorAll("span.btn")].find(
      (n) => n.textContent === THREAD.replySend,
    );
    expect(reply?.getAttribute("class")).toBe("btn primary sm");
    expect(node.querySelector("div.token-editor.is-placeholder")?.textContent).toBe(
      THREAD.replyPlaceholder,
    );
    const inbox = buildFragment("inbox", deps);
    asStaticExample(inbox);
    expect(inbox.querySelector("span.bar-input.is-placeholder")?.textContent).toBe(
      "Search your inbox…",
    );
  });
});

describe("the Inbox fragment's list", () => {
  test("is a listbox the search field names its active option in", () => {
    const node = buildFragment("inbox", deps);
    const input = node.querySelector("input") as HTMLInputElement;
    const list = node.querySelector("[role=listbox]") as HTMLElement;
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-controls")).toBe(list.id);
    const options = [...node.querySelectorAll("[role=option]")];
    expect(options).toHaveLength(4);
    const active = input.getAttribute("aria-activedescendant");
    expect(active).toBe(options[0]?.id as string);
    expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
      "false",
    ]);
    input.dispatchEvent(
      new (
        input.ownerDocument.defaultView as unknown as { KeyboardEvent: typeof KeyboardEvent }
      ).KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    expect(input.getAttribute("aria-activedescendant")).toBe(options[1]?.id as string);
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");
  });
});
