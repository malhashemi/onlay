// The demo's truth: the threads a visitor made on this page, in memory only.
// Nothing here is sent or stored: no network, no sessionStorage, no
// localStorage, no cookie. A reload, or Start over, begins clean.
//
// Every act of the visitor and of the demo agent is a method here, and the
// rules that move an interaction (who it waits on, what a pick does, what a
// hand-off is) live here, where they can be tested without a page.
import {
  type AgentWork,
  type BlockAnchor,
  type Item,
  type Kind,
  type Msg,
  mentionsAgent,
  type Variant,
} from "../overlay/model";

/** The visitor, as the demo's one person. */
export const SELF = "you";

/** The three things the rail counts. */
type Step = 0 | 1 | 2;
export type Steps = readonly [boolean, boolean, boolean];

/** Why an interaction went to the agent. */
export type HandOff = "edit" | "mention" | "more";

export interface StoreDeps {
  now(): number;
  /** A new id (the product's are UUIDs). */
  id(): string;
  /** Who is looking (the section fragments have a sample person). */
  self?: string;
  /** Interactions to start with (the section fragments' sample threads). */
  seed?: Item[];
}

export interface DemoStore {
  items(): readonly Item[];
  get(id: string): Item | undefined;
  steps(): Steps;
  /** True once every step is done. */
  complete(): boolean;
  /** How many interactions wait on the visitor (the launcher's count). */
  needsYou(): number;
  /** How many wait for an agent (the launcher's "for agent" marker). */
  agentPending(): number;
  /** How many kept edits are showing (the launcher's "edits shown" marker). */
  keptShown(): number;

  /** A pick landed on a block. */
  picked(): void;
  comment(anchor: BlockAnchor | null, text: string): Item;
  edit(
    anchor: BlockAnchor | null,
    req: { intent: string; method: "direct" | "variant-set"; count: number },
  ): Item;
  reply(id: string, text: string, replyTo: string | null): void;
  react(id: string, msgId: string, emoji: string, on: boolean): void;
  editMsg(id: string, msgId: string, text: string): void;
  deleteMsg(id: string, msgId: string): void;
  resolve(id: string): void;
  reopen(id: string): void;

  /** Step the preview: past the last variant is the original, and round again. */
  cycle(id: string, delta: 1 | -1): void;
  pick(id: string): void;
  discard(id: string): void;
  /** Ask the agent for one more variant. */
  askMore(id: string): void;
  /** A comment on the variant showing: a reply in the Edit's thread, prefixed with which. */
  commentVariant(
    id: string,
    text: string,
    prefix: (i: number, n: number, label: string) => string,
  ): void;
  setKept(id: string, on: boolean): void;

  /* the agent's side */
  take(id: string): void;
  agentReply(id: string, text: string): void;
  postVariants(id: string, variants: Variant[], preview: boolean): void;
  addVariant(id: string, variant: Variant): void;

  reset(): void;
  subscribe(fn: () => void): () => void;
  /** Hear each hand-off to the agent. */
  onHandOff(fn: (id: string, why: HandOff) => void): () => void;
}

export function createStore(deps: StoreDeps): DemoStore {
  const self = deps.self ?? SELF;
  let items: Item[] = deps.seed ? [...deps.seed] : [];
  let steps: [boolean, boolean, boolean] = [false, false, false];
  const subs = new Set<() => void>();
  const handOffs = new Set<(id: string, why: HandOff) => void>();

  const changed = (): void => {
    for (const fn of [...subs]) fn();
  };
  const handOff = (id: string, why: HandOff): void => {
    for (const fn of [...handOffs]) fn(id, why);
  };
  const find = (id: string): Item | undefined => items.find((i) => i.id === id);
  const done = (step: Step): void => {
    steps[step] = true;
  };
  const msg = (text: string, extra: Partial<Msg> = {}): Msg => ({
    id: deps.id(),
    authorId: self,
    text,
    ts: deps.now(),
    reactions: {},
    ...extra,
  });
  /** Agent work starts pending; an item already with the agent keeps its place. */
  const toAgent = (item: Item, why: HandOff): void => {
    item.agentWork = "pending";
    item.needsYou = false;
    done(2);
    handOff(item.id, why);
  };
  const create = (kind: Kind, anchor: BlockAnchor | null): Item => {
    const item: Item = {
      id: deps.id(),
      kind,
      state: "open",
      authorId: self,
      anchor,
      thread: [],
      needsYou: false,
      createdAt: deps.now(),
    };
    items = [...items, item];
    done(1);
    return item;
  };
  /** The visitor acted on it: whatever it owed them is paid. */
  const acted = (item: Item): void => {
    item.needsYou = false;
  };
  /**
   * One Edit previews on a block at a time. When an Edit's set starts showing
   * (a variant, or the original), every other set on that block stops: its
   * variants are ready again, not showing, so no panel claims a preview the
   * page does not have. Kept edits are not previews and stay.
   */
  const takeBlock = (item: Item): void => {
    const where = item.anchor?.selector;
    if (where === undefined) return;
    for (const other of items) {
      if (other === item || other.anchor?.selector !== where) continue;
      if (other.variants?.status === "previewing") other.variants.shown = null;
    }
  };
  let kept = 0;

  return {
    items: () => items,
    get: find,
    steps: () => [steps[0], steps[1], steps[2]],
    complete: () => steps.every(Boolean),
    needsYou: () => items.filter((i) => i.needsYou && i.state !== "resolved").length,
    agentPending: () =>
      items.filter((i) => i.state !== "resolved" && i.agentWork === "pending").length,
    keptShown: () => items.filter((i) => i.state === "kept" && i.keptOn !== false).length,

    picked() {
      if (steps[0]) return;
      done(0);
      changed();
    },

    comment(anchor, text) {
      const item = create("comment", anchor);
      item.thread.push(msg(text));
      if (mentionsAgent(text)) toAgent(item, "mention");
      changed();
      return item;
    },

    edit(anchor, req) {
      const item = create("change", anchor);
      item.change = { intent: req.intent, method: req.method, count: req.count };
      // An Edit goes to an agent on its own: there is no one to route it to.
      toAgent(item, "edit");
      changed();
      return item;
    },

    reply(id, text, replyTo) {
      const item = find(id);
      if (!item) return;
      item.thread.push(msg(text, replyTo ? { replyTo } : {}));
      acted(item);
      if (mentionsAgent(text)) toAgent(item, "mention");
      changed();
    },

    react(id, msgId, emoji, on) {
      const item = find(id);
      const m = item?.thread.find((t) => t.id === msgId);
      if (!item || !m) return;
      const who = new Set(m.reactions[emoji] ?? []);
      if (on) who.add(self);
      else who.delete(self);
      if (who.size > 0) m.reactions[emoji] = [...who];
      else delete m.reactions[emoji];
      // A reaction counts as seen.
      if (on) acted(item);
      changed();
    },

    editMsg(id, msgId, text) {
      const m = find(id)?.thread.find((t) => t.id === msgId);
      if (!m || m.authorId !== self || m.agent || m.deleted) return;
      m.text = text;
      m.editedAt = deps.now();
      changed();
    },

    deleteMsg(id, msgId) {
      const m = find(id)?.thread.find((t) => t.id === msgId);
      if (!m || m.authorId !== self || m.agent) return;
      m.deleted = true;
      m.text = "";
      m.reactions = {};
      changed();
    },

    resolve(id) {
      const item = find(id);
      if (!item || item.state === "resolved") return;
      item.state = "resolved";
      acted(item);
      // A set still on preview ends with its Edit: nothing stays on the page.
      if (item.variants && item.variants.status !== "resolved") {
        item.variants.status = "resolved";
        item.variants.outcome = "discarded";
        item.variants.shown = null;
      }
      changed();
    },

    reopen(id) {
      const item = find(id);
      if (item?.state !== "resolved") return;
      item.state = item.variants?.outcome === "picked" ? "kept" : "open";
      changed();
    },

    cycle(id, delta) {
      const set = find(id)?.variants;
      if (set?.status !== "previewing" || set.variants.length === 0) return;
      const n = set.variants.length;
      let next = (set.shown ?? -1) + delta;
      if (next < -1) next = n - 1;
      if (next > n - 1) next = -1;
      set.shown = next;
      const item = find(id);
      if (item) takeBlock(item);
      changed();
    },

    pick(id) {
      const item = find(id);
      const set = item?.variants;
      if (!item || !set || set.status !== "previewing") return;
      if (set.shown === null || set.shown < 0) return;
      // Pick is keep: on a page whose source no agent can change, the picked
      // program stays applied as a preview, and that is the deliverable.
      set.status = "resolved";
      set.outcome = "picked";
      set.picked = set.shown;
      item.state = "kept";
      item.keptOn = true;
      kept += 1;
      item.keptAt = kept;
      acted(item);
      changed();
    },

    discard(id) {
      const item = find(id);
      const set = item?.variants;
      if (!item || !set || set.status !== "previewing") return;
      set.status = "resolved";
      set.outcome = "discarded";
      set.shown = null;
      item.state = "open";
      acted(item);
      changed();
    },

    askMore(id) {
      const item = find(id);
      if (item?.variants?.status !== "previewing") return;
      toAgent(item, "more");
      changed();
    },

    commentVariant(id, text, prefix) {
      const item = find(id);
      const set = item?.variants;
      if (!item || !set || set.shown === null || set.shown < 0) return;
      const shown = set.variants[set.shown];
      if (!shown) return;
      const lead = prefix(set.shown + 1, set.variants.length, shown.label);
      // A comment that opens with a fence gets its prefix on a line of its own.
      const body = text.startsWith("```") ? `${lead}\n${text}` : `${lead} ${text}`;
      item.thread.push(msg(body));
      acted(item);
      if (mentionsAgent(text)) toAgent(item, "mention");
      changed();
    },

    setKept(id, on) {
      const item = find(id);
      if (item?.state !== "kept") return;
      item.keptOn = on;
      changed();
    },

    take(id) {
      const item = find(id);
      if (item?.agentWork !== "pending") return;
      item.agentWork = "taken";
      changed();
    },

    agentReply(id, text) {
      const item = find(id);
      if (!item || item.state === "resolved") return;
      // The agent acts as its person: the same author, marked as an agent's.
      item.thread.push(msg(text, { agent: true }));
      answered(item);
      changed();
    },

    postVariants(id, variants, preview) {
      const item = find(id);
      if (item?.kind !== "change" || !item.change || item.state === "resolved") return;
      item.change.method = "variant-set";
      item.state = "working";
      item.variants = {
        status: "previewing",
        variants,
        shown: preview && variants.length > 0 ? 0 : null,
      };
      if (item.variants.shown !== null) takeBlock(item);
      answered(item);
      changed();
    },

    addVariant(id, variant) {
      const item = find(id);
      const set = item?.variants;
      if (!item || !set || set.status !== "previewing") return;
      set.variants = [...set.variants, variant];
      set.shown = set.variants.length - 1;
      takeBlock(item);
      answered(item);
      changed();
    },

    reset() {
      items = [];
      kept = 0;
      steps = [false, false, false];
      changed();
    },

    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },

    onHandOff(fn) {
      handOffs.add(fn);
      return () => handOffs.delete(fn);
    },
  };

  /** An agent's answer: its work is done, and the item waits on its requester. */
  function answered(item: Item): void {
    const work: AgentWork = "answered";
    item.agentWork = work;
    item.needsYou = true;
  }
}
