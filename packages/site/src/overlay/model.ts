// What the overlay views draw: a small model of an interaction, shaped after
// the product's snapshots (kind, state, thread, agent work, a variant set)
// with only what the demo and the section fragments need. Pure data and pure
// rules; the rules follow the extension's (overlay/kinds.ts).
import type { MutationProgram } from "@onlay/protocol";
import { flattenFences } from "@onlay/protocol";
import type { Person } from "./dom";

/** The wire kinds: an Edit is `change` on the wire, as in the product. */
export type Kind = "comment" | "change";

/** Interaction state. `kept` is a picked variant staying on as a preview. */
export type ItemState = "open" | "working" | "kept" | "resolved";

/** An interaction's agent work, as the person reads it. */
export type AgentWork = "pending" | "taken" | "answered";

export interface Msg {
  id: string;
  authorId: string;
  /** Written by the author's agent: shown as the person, with an "agent" tag. */
  agent?: boolean;
  text: string;
  ts: number;
  editedAt?: number;
  deleted?: boolean;
  /** The message this one answers. */
  replyTo?: string;
  /** emoji → the people who reacted. */
  reactions: Record<string, string[]>;
}

export interface Variant {
  id: string;
  label: string;
  program: MutationProgram;
}

export interface VariantSet {
  status: "generating" | "previewing" | "resolved";
  outcome?: "picked" | "discarded";
  variants: Variant[];
  /** What the page shows: a variant's index, -1 for the original, null before the first preview. */
  shown: number | null;
  /** The index picked, once one is. */
  picked?: number;
}

/** Where an interaction is anchored: a block of this page, or the page. */
export interface BlockAnchor {
  /** Finds the block again (`demo/blocks.ts`). */
  selector: string;
  /** The block's first words, as the overlay labels it. */
  label: string;
  /** The selector as the variant panel prints it (tag and id). */
  target: string;
  /** Names the Variants the demo agent has ready for this block, if it has any. */
  prepared?: string;
}

export interface Item {
  id: string;
  kind: Kind;
  state: ItemState;
  authorId: string;
  anchor: BlockAnchor | null;
  thread: Msg[];
  change?: { intent: string; method: "direct" | "variant-set"; count: number };
  variants?: VariantSet;
  agentWork?: AgentWork;
  /** It waits on the viewer: the amber chip, the launcher's count. */
  needsYou: boolean;
  /** A kept Edit's switch for this viewer. */
  keptOn?: boolean;
  /** The order it was kept in: kept edits apply in this order. */
  keptAt?: number;
  createdAt: number;
  /** The space it lives in, when a row should say so. */
  space?: string;
}

export type Directory = Readonly<Record<string, Person>>;

const UNKNOWN_PERSON: Person = { name: "Someone", initials: "?", tint: "" };

export function personOf(people: Directory, id: string): Person {
  return people[id] ?? UNKNOWN_PERSON;
}

/** Still counted and pinned (the product's live states). */
export function isLive(state: ItemState): boolean {
  return state !== "resolved";
}

export type Chip = "needs-you" | "waiting" | "resolved";

export function chipFor(item: Pick<Item, "state" | "needsYou">): Chip {
  if (item.state === "resolved") return "resolved";
  return item.needsYou ? "needs-you" : "waiting";
}

/** One line for a row: an Edit's intent, or a thread's first words, code without its fences. */
export function summaryOf(item: Item): string {
  if (item.kind === "change" && item.change) return firstLine(item.change.intent);
  const first = item.thread.find((m) => !m.deleted);
  return first ? firstLine(first.text) : "";
}

function firstLine(text: string): string {
  const line =
    flattenFences(text)
      .split("\n")
      .find((l) => l.trim().length > 0) ?? "";
  return line.trim().slice(0, 200);
}

function lastTs(item: Item): number {
  return item.thread[item.thread.length - 1]?.ts ?? item.createdAt;
}

/** The place line: the block's label, or the page. */
export function placeLabel(item: Item, pageLevel: string): string {
  return item.anchor ? item.anchor.label : pageLevel;
}

/** A hand-off: `@agent` as a word of its own (the product's rule, token-input.ts). */
export function mentionsAgent(text: string): boolean {
  return /(^|\s)@agent\b/i.test(flattenFencesKeepingText(text));
}

/** Text outside fenced blocks only: an `@agent` inside code hands nothing over. */
function flattenFencesKeepingText(text: string): string {
  if (!text.includes("```")) return text;
  const out: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out.join("\n");
}

/** Inbox order: what needs you first (oldest debt first), then the rest newest first; resolved last. */
export function inboxOrder(items: readonly Item[]): Item[] {
  return [...items].sort((a, b) => {
    const la = isLive(a.state);
    const lb = isLive(b.state);
    if (la !== lb) return la ? -1 : 1;
    if (a.needsYou !== b.needsYou) return a.needsYou ? -1 : 1;
    if (a.needsYou && b.needsYou) return lastTs(a) - lastTs(b);
    return lastTs(b) - lastTs(a);
  });
}

/** The command bar's search, over what a row shows. */
export function matchesQuery(item: Item, people: Directory, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    summaryOf(item),
    personOf(people, item.authorId).name,
    item.anchor?.label ?? "",
    item.state,
  ]
    .join(" ")
    .toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
}
