/**
 * `inbox` (spec §9): who the agent acts as, the pending agent work across the
 * person's spaces split `yours` / `teammates`, and what waits on the person.
 *
 * Scope comes before any cap: `space` picks the spaces, `url` and `origin`
 * go to each space's agent-work and attention reads (and are applied here
 * again, for a space that ignores them), `repo` narrows the agent work only.
 * Each list then shows at most `MCP_INBOX_MAX_ITEMS`, newest first, within
 * its share of the result budget, and names the ref to pass as `after` for
 * the next items in the same order.
 *
 * Spaces are read at most `FAN_OUT` at a time, each under a deadline that
 * aborts its requests; a space that fails or is slow is named as skipped.
 */
import {
  type AgentWorkItem,
  type AttentionRow,
  type InboxToolInputSchema,
  LIMITS,
  MCP_INBOX_MAX_ITEMS,
  MCP_MAX_RESULT_CHARS,
  makeRef,
  parseRef,
} from "@onlay/protocol";
import type * as z from "zod/mini";
import { namesIn } from "../item";
import {
  age,
  dc,
  foreign,
  kindLabel,
  plural,
  ToolError,
  type ToolResult,
  textResult,
  who,
} from "../result";
import type { AgentSpaces, SpaceListing } from "../space";

type InboxInput = z.infer<typeof InboxToolInputSchema>;

/** A page URL in a list line; `read` shows it in full. */
const LISTED_URL_CHARS = 500;
/** The lists share this much of the result; the rest is the header and the notes. */
const LISTS_BUDGET = MCP_MAX_RESULT_CHARS - 3_000;
/** Spaces read at once. */
const FAN_OUT = 6;
/** One space's reads, all three, must finish within this; then they are aborted. */
const SPACE_DEADLINE_MS = 5_000;

interface SpaceInbox {
  space: SpaceListing;
  yours: AgentWorkItem[];
  teammates: AgentWorkItem[];
  needsYou: AttentionRow[];
  nameOf: (personId: string) => string;
}

interface Skipped {
  skipped: SpaceListing;
  slow: boolean;
}

function originOf(url: string): string | null {
  try {
    const o = new URL(url).origin;
    return o === "null" ? null : o;
  } catch {
    return null;
  }
}

/** The same page and site scope the space applies, for a space that ignores the query. */
function inScope(row: AttentionRow, input: InboxInput): boolean {
  if (!input.url && !input.origin) return true;
  if (row.unanchored || !row.url) return false;
  if (input.url && row.url !== input.url) return false;
  if (input.origin && originOf(row.url) !== input.origin) return false;
  return true;
}

function query(entries: [string, string | undefined][]): string {
  const q = new URLSearchParams();
  for (const [key, value] of entries) if (value) q.set(key, value);
  return q.size > 0 ? `?${q}` : "";
}

/**
 * One space's three reads, one after another, under one deadline that aborts
 * the request in flight. Resolves at the deadline even if a step ignores it.
 */
async function spaceInbox(
  spaces: AgentSpaces,
  space: SpaceListing,
  input: InboxInput,
): Promise<SpaceInbox | Skipped> {
  const controller = new AbortController();
  const signal = controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error("deadline"));
      reject(signal.reason);
    }, SPACE_DEADLINE_MS);
  });
  const reads = (async (): Promise<SpaceInbox> => {
    const work = await spaces.read(
      space.id,
      `/agent-work${query([
        ["url", input.url],
        ["origin", input.origin],
        ["repo", input.repo],
      ])}`,
      signal,
    );
    const attention = await spaces.read(
      space.id,
      `/attention${query([
        ["url", input.url],
        ["origin", input.origin],
      ])}`,
      signal,
    );
    const nameOf = await namesIn(spaces, space.id, signal);
    return {
      space,
      yours: work.yours ?? [],
      teammates: work.teammates ?? [],
      needsYou: ((attention.needsYou ?? []) as AttentionRow[]).filter((row) => inScope(row, input)),
      nameOf,
    };
  })();
  try {
    return await Promise.race([reads, deadline]);
  } catch {
    reads.catch(() => undefined);
    return { skipped: space, slow: signal.aborted };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    deadline.catch(() => undefined);
  }
}

/** `fn` over `items`, at most `limit` at a time, results in order. */
async function pooled<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** A ref the space formed: bare when it parses, framed otherwise. */
const shownRef = (ref: string): string =>
  parseRef(ref) === null ? foreign(ref, LIMITS.MAX_URL) : ref;

function pageLine(url: string | undefined): string {
  return url ? `\n  page: ${foreign(url, LISTED_URL_CHARS)}` : "\n  page: none (unanchored)";
}

function summaryLine(text: string): string {
  return `\n  summary: ${foreign(text, LIMITS.MAX_ANCHOR_LABEL)}`;
}

interface Line {
  ref: string;
  at: number;
  text: string;
}

function workLine(item: AgentWorkItem, label: string, now: number, selfId: string): Line {
  const by = item.requestedBy.id === selfId ? "your person" : who(item.requestedBy.name);
  const head = `- ${shownRef(item.ref)} · ${kindLabel(item.kind)} · ${dc(item.status, LIMITS.MAX_TAG)} · asked by ${by} ${age(item.requestedAt, now)} · in ${label}`;
  return {
    ref: item.ref,
    at: item.requestedAt,
    text: `${head}${pageLine(item.url)}${summaryLine(item.summary)}`,
  };
}

function needsYouLine(
  spaceId: string,
  row: AttentionRow,
  label: string,
  nameOf: (id: string) => string,
  now: number,
): Line {
  const ref = makeRef(spaceId, row.interactionId);
  const head = `- ${shownRef(ref)} · ${kindLabel(row.kind)} · ${dc(row.state, LIMITS.MAX_TAG)} · from ${who(nameOf(row.fromActorId))} ${age(row.ts, now)} · in ${label}`;
  return {
    ref,
    at: row.ts,
    text: `${head}${row.url ? pageLine(row.url) : ""}${summaryLine(row.text)}`,
  };
}

/** Newest first, ties by ref: the one order `after` continues. */
const ordered = (lines: Line[]): Line[] =>
  [...lines].sort((a, b) => b.at - a.at || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));

const lengthOf = (lines: Line[]): number =>
  lines.slice(0, MCP_INBOX_MAX_ITEMS).reduce((n, l) => n + l.text.length + 1, 0);

/** Shares `total` among lists wanting `wants`: evenly, a list's unused share going to the others. */
function shares(wants: number[], total: number): number[] {
  const out = wants.map(() => 0);
  let open = wants.map((_, i) => i);
  let left = total;
  while (open.length > 0) {
    const share = Math.floor(left / open.length);
    const met = open.filter((i) => (wants[i] ?? 0) <= share);
    if (met.length === 0) {
      for (const i of open) out[i] = share;
      break;
    }
    for (const i of met) {
      out[i] = wants[i] ?? 0;
      left -= wants[i] ?? 0;
    }
    open = open.filter((i) => !met.includes(i));
  }
  return out;
}

interface List {
  heading: string;
  empty: string;
  lines: Line[];
}

/**
 * One list: its ordered lines from the start, at most 40 within `budget`,
 * then where to continue. `total` and `after` describe a continued list.
 */
function listSection(
  list: List,
  budget: number,
  total = list.lines.length,
  after?: string,
): string {
  if (list.lines.length === 0) return list.empty;
  const shown: Line[] = [];
  let used = 0;
  for (const line of list.lines) {
    if (shown.length >= MCP_INBOX_MAX_ITEMS || used + line.text.length + 1 > budget) break;
    shown.push(line);
    used += line.text.length + 1;
  }
  const more = list.lines.length - shown.length;
  const last = shown.at(-1);
  const rest =
    more > 0 && last
      ? `\n${plural(more, "more item")} not shown; call inbox with after ${shownRef(last.ref)} and the same filters for the next ones.`
      : "";
  const order = after ? `newest first; continuing after ${shownRef(after)}` : "newest first";
  return `${list.heading} (${total}, ${order}):\n${shown.map((l) => l.text).join("\n")}${rest}`;
}

export async function inbox(spaces: AgentSpaces, input: InboxInput): Promise<ToolResult> {
  const all = await spaces.spaces();
  const chosen = input.space ? all.filter((s) => s.id === input.space) : all;
  if (input.space && chosen.length === 0) {
    throw new ToolError(
      "Your person can't open that space. Call `inbox` without `space` to see every space.",
    );
  }
  const now = Date.now();
  const self = spaces.agent.person;
  const results = await pooled(chosen, FAN_OUT, (space) => spaceInbox(spaces, space, input));
  const yours: Line[] = [];
  const teammates: Line[] = [];
  const needsYou: Line[] = [];
  const skipped: string[] = [];
  for (const part of results) {
    const label = await spaces.label("skipped" in part ? part.skipped.id : part.space.id);
    if ("skipped" in part) {
      skipped.push(`${label} (${part.slow ? "it didn't answer in time" : "it failed to answer"})`);
      continue;
    }
    for (const item of part.yours) yours.push(workLine(item, label, now, self.id));
    for (const item of part.teammates) teammates.push(workLine(item, label, now, self.id));
    for (const row of part.needsYou)
      needsYou.push(needsYouLine(part.space.id, row, label, part.nameOf, now));
  }
  const lists: List[] = [
    {
      heading: "Yours, handed to an agent by your person",
      empty: "Yours: nothing is waiting for an agent.",
      lines: ordered(yours),
    },
    {
      heading:
        "Teammates', for their agents. Take one only if your person asked you to, with onBehalf: true",
      empty: "Teammates': nothing is waiting for an agent.",
      lines: ordered(teammates),
    },
    {
      heading: "Waiting on your person",
      empty: "Waiting on your person: nothing.",
      lines: ordered(needsYou),
    },
  ];

  const filters = [
    input.url ? `page ${foreign(input.url, LISTED_URL_CHARS)}` : "",
    input.origin ? `site ${foreign(input.origin, LIMITS.MAX_RESIDUE_ORIGIN)}` : "",
    input.repo ? `repository ${foreign(input.repo, LIMITS.MAX_PROVENANCE)} (agent work only)` : "",
  ].filter(Boolean);
  const where =
    chosen.length === 1 && chosen[0]
      ? await spaces.label(chosen[0].id)
      : plural(chosen.length, "space");
  const scope = `${where}${filters.length > 0 ? `, only ${filters.join(", ")}` : ""}`;
  const out = [
    `You act as ${who(self.name)} (${dc(self.email, LIMITS.MAX_URL)}). What you write is marked as written by their agent.`,
    `Looking in ${scope}.`,
  ];
  if (skipped.length > 0) out.push(`Skipped, try again later: ${skipped.join("; ")}.`);

  if (input.after !== undefined) {
    // Continue the one list that holds `after`, in the same order, from the item after it.
    const list = lists.find((l) => l.lines.some((line) => line.ref === input.after));
    if (list === undefined) {
      throw new ToolError(
        "That item isn't in any list on this scope now. Call inbox without after to start again.",
      );
    }
    const at = list.lines.findIndex((line) => line.ref === input.after);
    const rest: List = { ...list, lines: list.lines.slice(at + 1) };
    out.push(
      "",
      rest.lines.length === 0
        ? `${list.heading}: nothing after ${shownRef(input.after)}.`
        : listSection(rest, LISTS_BUDGET, list.lines.length, input.after),
    );
    return textResult(out.join("\n"));
  }

  const budgets = shares(
    lists.map((l) => lengthOf(l.lines)),
    LISTS_BUDGET,
  );
  lists.forEach((list, i) => {
    out.push("", listSection(list, budgets[i] ?? 0));
  });
  if (yours.length > 0) out.push("", "Next: `take` an item of yours, then `read` it.");
  return textResult(out.join("\n"));
}
