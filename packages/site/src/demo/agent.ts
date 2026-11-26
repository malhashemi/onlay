// The demo agent: what stands in for a visitor's own coding agent on this
// page. It follows the product's hand-off: work goes pending, the agent takes
// it, then answers with a reply or Variants, and everything it writes carries
// the agent tag. It is honest about being a demo: it has Variants for the
// headline and says so everywhere else.
import type { Variant } from "../overlay/model";
import type { DemoStore, HandOff } from "./store";

export interface AgentDeps {
  store: DemoStore;
  /** The Variants ready for a block (by its `data-variants` name); none for any other. */
  prepared(key: string | undefined): Variant[];
  /** What the agent says with its Variants, and what it says when it has none. */
  words: { variants: string; other: string };
  /** True when the variants should go straight onto the page as a preview. */
  previewNow(id: string): boolean;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** How long before the agent takes an item, and how long it then works. */
  takeMs?: number;
  workMs?: number;
}

export interface DemoAgent {
  /** Drop everything in flight (Start over). */
  stop(): void;
  /** True when more Variants can still be asked for on this Edit. */
  hasMore(id: string): boolean;
}

export function createAgent(deps: AgentDeps): DemoAgent {
  const { store } = deps;
  const takeMs = deps.takeMs ?? 700;
  const workMs = deps.workMs ?? 1400;
  const timers = new Set<unknown>();

  const later = (ms: number, fn: () => void): void => {
    const handle = deps.setTimeout(() => {
      timers.delete(handle);
      fn();
    }, ms);
    timers.add(handle);
  };

  function ready(id: string): Variant[] {
    const item = store.get(id);
    return item?.kind === "change" ? deps.prepared(item.anchor?.prepared) : [];
  }

  function answer(id: string, why: HandOff): void {
    const item = store.get(id);
    if (!item || item.state === "resolved") return;
    const all = ready(id);
    if (why === "more") {
      const have = item.variants?.variants.length ?? 0;
      const next = all[have];
      if (next) store.addVariant(id, next);
      else store.agentReply(id, deps.words.other);
      return;
    }
    if (why === "edit" && all.length > 0) {
      const count = Math.max(1, Math.min(item.change?.count ?? all.length, all.length));
      store.postVariants(id, all.slice(0, count), deps.previewNow(id));
      store.agentReply(id, deps.words.variants);
      return;
    }
    store.agentReply(id, deps.words.other);
  }

  store.onHandOff((id, why) => {
    later(takeMs, () => {
      if (store.get(id)?.agentWork !== "pending") return;
      store.take(id);
      later(workMs, () => answer(id, why));
    });
  });

  return {
    stop() {
      for (const handle of timers) deps.clearTimeout(handle);
      timers.clear();
    },
    hasMore(id) {
      const item = store.get(id);
      const have = item?.variants?.variants.length ?? 0;
      return (
        item?.agentWork !== "pending" && item?.agentWork !== "taken" && have < ready(id).length
      );
    },
  };
}
