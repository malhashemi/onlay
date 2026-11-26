// The section fragments: each of the page's sections shows its idea with a
// small working piece of the overlay, made of the same views and the same
// store as the demo layer, over a sample page (the film's pricing page).
//
// A fragment is built twice from this one file: once by the build, in a
// happy-dom document, so the page is complete without JavaScript; and once in
// the browser, in place of that markup, so its controls work (reactions,
// replies, stepping through Variants, Copy). Both builds draw the same DOM.
import { OWN } from "./copy";
import { sampleVariants } from "./demo/programs";
import { createStore, type DemoStore } from "./demo/store";
import { createCommandBar } from "./overlay/bar";
import { el, GLYPHS, icon, markSvg, type Person } from "./overlay/dom";
import type { Directory, Item, Variant } from "./overlay/model";
import type { RichDeps } from "./overlay/rich";
import { VARIANTS } from "./overlay/strings";
import { createThreadPanel, type ThreadActions } from "./overlay/thread";

export const FRAGMENTS = ["comment", "edit", "agent", "inbox"] as const;
export type FragmentName = (typeof FRAGMENTS)[number];

/** The id of the sample plan the Edit fragment's Variants change. */
export const SAMPLE_PLAN_ID = "sample-plan-team";

export interface FragmentDeps {
  now: number;
  rich: Pick<RichDeps, "highlighter" | "copy" | "trusted">;
  /**
   * Put a variant on the sample plan, or take it off (null). The build
   * applies the program to the markup; the browser uses the preview engine.
   */
  applyVariant(plan: Element, variant: Variant | null): void;
}

const S = OWN.sample;
const MAYA = "maya";
const DANIEL = "daniel";
const PEOPLE: Directory = {
  [MAYA]: { name: S.maya, initials: "MC", tint: "tint-a" } satisfies Person,
  [DANIEL]: { name: S.daniel, initials: "DO", tint: "tint-b" } satisfies Person,
};

let seq = 0;
const id = (): string => `sample-${++seq}`;

function storeOf(seed: Item[], now: number): DemoStore {
  return createStore({ now: () => now, id, self: MAYA, seed });
}

function threadActions(store: DemoStore): ThreadActions {
  return {
    reply: (i, text, to) => store.reply(i, text, to),
    react: (i, m, emoji, on) => store.react(i, m, emoji, on),
    editMsg: (i, m, text) => store.editMsg(i, m, text),
    deleteMsg: (i, m) => store.deleteMsg(i, m),
    resolve: (i) => store.resolve(i),
    reopen: (i) => store.reopen(i),
    cycle: (i, d) => store.cycle(i, d),
    pick: (i) => store.pick(i),
    discard: (i) => store.discard(i),
    more: () => {},
    commentVariant: (i, text) => store.commentVariant(i, text, VARIANTS.prefix),
    away: () => {},
  };
}

/** A thread panel over one seeded item, set in the page. */
function threadFor(item: Item, deps: FragmentDeps, onChange?: (store: DemoStore) => void) {
  const store = storeOf([item], deps.now);
  const panel = createThreadPanel({
    people: PEOPLE,
    selfId: MAYA,
    now: () => deps.now,
    rich: { people: PEOPLE, ...deps.rich },
    get: (i) => store.get(i),
    floating: false,
    actions: threadActions(store),
  });
  store.subscribe(() => {
    panel.render();
    onChange?.(store);
  });
  panel.open(item.id);
  const wrap = el("div", "ov ov-static scene-panel");
  wrap.appendChild(panel.element);
  return { wrap, store };
}

/* ── the sample page ── */

function plan(name: string, price: string, planId?: string): HTMLElement {
  const card = el("div", "mini-plan");
  if (planId) card.id = planId;
  card.append(el("p", "mini-plan-name", name), el("p", "mini-plan-price", price));
  return card;
}

/**
 * The sample page with Onlay on it: the page's own content, a few lines
 * standing for the rest of it, and the launcher at its corner, where it sits
 * on every page (with the preview pill beside it while a variant shows).
 */
function samplePage(plans: HTMLElement[], pill?: HTMLElement): HTMLElement {
  const page = el("div", "mini-page");
  const bar = el("div", "mini-bar");
  bar.append(el("span", "mini-dots"), el("span", "mini-url", S.site));
  const body = el("div", "mini-body");
  const rest = el("div", "mini-rest");
  rest.setAttribute("aria-hidden", "true");
  for (const w of ["a", "b", "c", "b", "a", "c"]) rest.appendChild(el("span", `mini-bone w-${w}`));
  body.append(el("p", "mini-title", S.pageTitle), el("p", "mini-lede", S.pageLede), ...plans, rest);
  const chrome = el("div", "ov ov-static mini-chrome");
  chrome.setAttribute("aria-hidden", "true");
  const orb = el("span", "orb");
  orb.append(markSvg(), el("span", "orb-status connected"));
  if (pill) chrome.appendChild(pill);
  chrome.appendChild(orb);
  page.append(bar, body, chrome);
  return page;
}

/** A pin where the extension puts it: at the block's top right corner. */
function pin(kind: "comment" | "change"): HTMLElement {
  const wrap = el("span", "ov ov-static mini-pin");
  wrap.setAttribute("aria-hidden", "true");
  const p = el("span", `pin ${kind === "comment" ? "k-comment" : "k-change"}`);
  p.appendChild(icon(GLYPHS[kind], "icon-sm"));
  wrap.appendChild(p);
  return wrap;
}

function scene(name: FragmentName, ...parts: HTMLElement[]): HTMLElement {
  const node = el("div", `scene scene-${name}`);
  node.append(...parts);
  return node;
}

/* ── the four fragments ── */

function commentFragment(deps: FragmentDeps): HTMLElement {
  const team = plan(S.planTeam, S.planTeamPrice);
  const price = team.querySelector(".mini-plan-price") as HTMLElement;
  price.classList.add("is-ringed");
  price.appendChild(pin("comment"));
  const page = samplePage([team, plan(S.planStudio, S.planStudioPrice)]);
  const { wrap } = threadFor(
    {
      id: id(),
      kind: "comment",
      state: "open",
      authorId: MAYA,
      anchor: { selector: "", label: S.planTeamPrice, target: "p" },
      thread: [
        {
          id: id(),
          authorId: MAYA,
          text: S.commentAsk,
          ts: deps.now,
          reactions: { "👍": [DANIEL] },
        },
        { id: id(), authorId: DANIEL, text: S.commentAnswer, ts: deps.now, reactions: {} },
      ],
      needsYou: false,
      createdAt: deps.now,
      space: S.workspace,
    },
    deps,
  );
  return scene("comment", page, wrap);
}

function editFragment(deps: FragmentDeps): HTMLElement {
  const team = plan(S.planTeam, S.planTeamPrice, SAMPLE_PLAN_ID);
  const holder = el("div", "mini-plan-holder is-ringed");
  holder.append(team, pin("change"));
  const pill = el("div", "preview-label");
  const page = samplePage([holder, plan(S.planStudio, S.planStudioPrice)], pill);

  const variants = sampleVariants();
  let applied: string | null = null;
  const sync = (store: DemoStore): void => {
    const item = store.items()[0];
    const set = item?.variants;
    if (!item || !set) return;
    const previewing = set.status === "previewing" && set.shown !== null;
    const want =
      previewing && (set.shown as number) >= 0
        ? set.variants[set.shown as number]
        : item.state === "kept" && set.picked !== undefined
          ? set.variants[set.picked]
          : undefined;
    pill.textContent = previewing ? (want ? VARIANTS.pill(want.label) : VARIANTS.original) : "";
    pill.hidden = !previewing;
    if ((want?.id ?? null) === applied) return;
    applied = want?.id ?? null;
    deps.applyVariant(team, want ?? null);
  };
  const { wrap, store } = threadFor(
    {
      id: "1c8e42a7",
      kind: "change",
      state: "working",
      authorId: MAYA,
      anchor: {
        selector: `#${SAMPLE_PLAN_ID}`,
        label: `${S.planTeam} ${S.planTeamPrice}`.slice(0, 40),
        target: "section#plan-team",
      },
      thread: [],
      change: { intent: S.editIntent, method: "variant-set", count: variants.length },
      variants: { status: "previewing", variants, shown: 0 },
      agentWork: "answered",
      needsYou: true,
      createdAt: deps.now,
    },
    deps,
    sync,
  );
  sync(store);
  return scene("edit", page, wrap);
}

function agentFragment(deps: FragmentDeps): HTMLElement {
  const { wrap } = threadFor(
    {
      id: id(),
      kind: "comment",
      state: "open",
      authorId: MAYA,
      anchor: { selector: "", label: S.pageTitle, target: "h1" },
      thread: [
        { id: id(), authorId: MAYA, text: S.agentAsk, ts: deps.now, reactions: {} },
        {
          id: id(),
          authorId: MAYA,
          agent: true,
          text: S.agentAnswer,
          ts: deps.now,
          reactions: {},
        },
      ],
      agentWork: "answered",
      needsYou: true,
      createdAt: deps.now,
    },
    deps,
  );
  return scene("agent", wrap);
}

function inboxFragment(deps: FragmentDeps): HTMLElement {
  const base: Pick<Item, "thread" | "createdAt"> = { thread: [], createdAt: deps.now };
  const text = (authorId: string, body: string) => [
    { id: id(), authorId, text: body, ts: deps.now, reactions: {} },
  ];
  const items: Item[] = [
    {
      ...base,
      id: id(),
      kind: "change",
      state: "working",
      authorId: MAYA,
      anchor: {
        selector: "a",
        label: `${S.planTeam} ${S.planTeamPrice}`.slice(0, 40),
        target: "",
      },
      change: { intent: S.inbox[0], method: "variant-set", count: 2 },
      agentWork: "answered",
      needsYou: true,
      space: OWN.demo.space,
    },
    {
      ...base,
      id: id(),
      kind: "comment",
      state: "open",
      authorId: DANIEL,
      anchor: { selector: "b", label: S.planStudioPrice, target: "" },
      thread: text(DANIEL, S.inbox[1]),
      needsYou: true,
      space: S.workspace,
    },
    {
      ...base,
      id: id(),
      kind: "comment",
      state: "open",
      authorId: MAYA,
      anchor: { selector: "c", label: S.pageLede, target: "" },
      thread: text(MAYA, S.inbox[2]),
      agentWork: "pending",
      needsYou: false,
      space: OWN.demo.space,
    },
    {
      ...base,
      id: id(),
      kind: "comment",
      state: "resolved",
      authorId: MAYA,
      anchor: {
        selector: "d",
        label: `${S.planStudio} ${S.planStudioPrice}`.slice(0, 40),
        target: "",
      },
      thread: text(MAYA, S.inbox[3]),
      needsYou: false,
      space: OWN.demo.space,
    },
  ];
  const bar = createCommandBar({
    people: PEOPLE,
    now: () => deps.now,
    items: () => items,
    canRun: () => false,
    run: () => {},
    away: () => {},
    openItem: () => {},
    setKept: () => {},
    awayChip: "",
    fixedMode: "inbox",
    space: OWN.demo.space,
    idBase: "sample-inbox",
  });
  const wrap = el("div", "ov ov-static scene-bar");
  wrap.appendChild(bar.element);
  return scene("inbox", wrap);
}

export function buildFragment(name: FragmentName, deps: FragmentDeps): HTMLElement {
  seq = 0;
  switch (name) {
    case "comment":
      return commentFragment(deps);
    case "edit":
      return editFragment(deps);
    case "agent":
      return agentFragment(deps);
    case "inbox":
      return inboxFragment(deps);
  }
}
