/**
 * `wait` (spec §7, §9): blocks until the next journal event on the item, or
 * the timeout, and says what happened in a sentence each. The space's wait
 * route returns the event kinds and the interaction after them; what changed
 * is read off the difference with the interaction before.
 */
import {
  LIMITS,
  MCP_WAIT_DEFAULT_SECONDS,
  MCP_WAIT_MAX_MESSAGES,
  type RawInteractionSnapshot,
  type WaitToolInputSchema,
} from "@onlay/protocol";
import type * as z from "zod/mini";
import { renderThread } from "../../space/render";
import { loadItem, type NamesIn, namesIn } from "../item";
import { dc, kindLabel, plural, ToolError, type ToolResult, textResult, who } from "../result";
import type { AgentSpaces } from "../space";

/** What an event kind says when the interaction alone doesn't tell more. */
const EVENT_SENTENCES: Record<string, string> = {
  "int-msg-edit": "A message was edited.",
  "int-msg-delete": "A message was deleted.",
  "int-react": "Someone reacted to a message.",
  "int-answer": "Someone answered the question.",
  "int-reanchor": "The item was moved to another block.",
  "int-anchored": "The item was placed on the page.",
  "int-anchor-lost": "The block the item sat on is gone from the page.",
  "int-resnap-request": "Someone asked for a fresh look.",
  "int-resnap-fulfill": "A fresh look was captured.",
  "int-pick": "A variant was picked.",
  "int-batch": "The hand-made edit changed.",
  "int-send-batch": "The hand-made edit was sent.",
  "int-attach-set": "A variant set was attached.",
  "int-variants": "Variants were posted or revised.",
  "int-variant-outcome":
    "The browser of the person who asked reported how a variant applied on their page; read the item to see which steps, if any, couldn't be applied.",
};

function changes(
  before: RawInteractionSnapshot,
  after: RawInteractionSnapshot,
  kinds: string[],
  nameOf: NamesIn,
  selfId: string,
): string[] {
  const out: string[] = [];
  const seen = new Set(before.thread.map((m) => m.msgId));
  const fresh = after.thread.filter((m) => !seen.has(m.msgId));
  if (fresh.length > 0) {
    const shown = fresh.slice(-MCP_WAIT_MAX_MESSAGES);
    const earlier = fresh.length - shown.length;
    const head =
      earlier > 0
        ? `${plural(fresh.length, "new message")}; the newest ${shown.length} shown, oldest first (read the item for the other ${earlier}):`
        : `New ${fresh.length === 1 ? "message" : "messages"}:`;
    out.push(
      `${head}\n${renderThread(shown, { nameOf, aliasOf: nameOf.aliasOf, selfPersonId: selfId })}`,
    );
  }
  if (after.state !== before.state)
    out.push(`The ${kindLabel(after.kind)} is now ${dc(after.state, LIMITS.MAX_TAG)}.`);
  const work = after.agentWork;
  if (work?.status !== before.agentWork?.status || work?.takenBy !== before.agentWork?.takenBy) {
    if (!work) out.push("It is no longer for an agent.");
    else if (work.status === "taken")
      out.push(
        `It is taken by ${work.takenBy === selfId ? "you" : `the agent of ${who(nameOf(work.takenBy ?? ""))}`}.`,
      );
    else out.push(`It is ${dc(work.status, LIMITS.MAX_TAG)} for an agent.`);
  }
  for (const kind of new Set(kinds)) {
    const sentence = EVENT_SENTENCES[kind];
    if (sentence) out.push(sentence);
  }
  if (out.length === 0) out.push("Something on the item changed; read it to see what.");
  return out;
}

export async function wait(
  spaces: AgentSpaces,
  input: z.infer<typeof WaitToolInputSchema>,
): Promise<ToolResult> {
  const timeout = Math.min(
    LIMITS.MAX_WAIT_SECONDS,
    Math.max(0, input.timeoutSeconds ?? MCP_WAIT_DEFAULT_SECONDS),
  );
  const item = await loadItem(spaces, input.ref);
  const res = await spaces.call(
    item.spaceId,
    "GET",
    `/interaction/${item.id}/wait?since=${item.seq}&timeout=${timeout}`,
  );
  if (res.status !== 200) {
    throw new ToolError(
      res.status === 404
        ? "This item is gone, or your person can no longer open it. Call inbox."
        : "The wait ended early. Call wait again.",
    );
  }
  const events = (res.body.events ?? []) as { k: string }[];
  if (events.length === 0 || !res.body.interaction) {
    return textResult(
      `Nothing yet on ${item.ref} after ${timeout} s. Call wait again, or work on something else.`,
    );
  }
  const nameOf = await namesIn(spaces, item.spaceId);
  const lines = changes(
    item.interaction,
    res.body.interaction as RawInteractionSnapshot,
    events.map((e) => e.k),
    nameOf,
    spaces.agent.person.id,
  );
  return textResult(`On ${item.ref}:\n${lines.join("\n")}`);
}
