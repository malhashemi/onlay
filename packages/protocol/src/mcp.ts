/**
 * The MCP tools an agent uses to work in onlay (spec §9).
 *
 * Input schemas are zod here and JSON Schema on the wire: `mcpToolList()`
 * produces the `tools/list` entries from the same schemas the server
 * validates `tools/call` arguments with, so the two never drift.
 */
import * as z from "zod/mini";
import { AGENT_EDIT_STATES, ClientIdSchema } from "./interaction";
import { LIMITS } from "./limits";
import { bounded, count } from "./schema-helpers";
import { RefSchema, SpaceIdSchema } from "./space";
import { PageMutationProgramSchema } from "./variant";

/** The MCP protocol revisions `initialize` answers with; the last is the newest. */
export const MCP_PROTOCOL_VERSIONS = [
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
] as const;

/** `wait` blocks this long when the call names no timeout. */
export const MCP_WAIT_DEFAULT_SECONDS = 20;
/** `read` includes at most this much captured markup; `read_markup` pages through the rest. */
export const MCP_MARKUP_EXCERPT_CHARS = 8_000;
/** One `read_markup` slice. */
export const MCP_MAX_MARKUP_SLICE = 20_000;
/** No tool result's text is longer than this. */
export const MCP_MAX_RESULT_CHARS = 24_000;
/** `read` shows the newest thread messages that fit this many characters. */
export const MCP_THREAD_BUDGET_CHARS = 12_000;
/** `inbox` lists at most this many items per list, newest first. */
export const MCP_INBOX_MAX_ITEMS = 40;
/** `wait` shows at most this many of the new messages, the newest. */
export const MCP_WAIT_MAX_MESSAGES = 5;

const ref = () =>
  RefSchema.check(z.describe("The item's ref, as `inbox` lists it: <spaceId>/<interactionId>."));

/** A write's own id (the socket's `clientId` bounds): a repeat with it changes nothing. */
const clientId = (what: string) =>
  z.optional(
    ClientIdSchema.check(
      z.describe(
        `Your own id for this ${what}, 1 to 64 characters, new for each ${what}. When you retry a ${what} that may have gone through, send the same clientId: a repeat changes nothing and answers as the first did.`,
      ),
    ),
  );

export const InboxToolInputSchema = z.object({
  space: z.optional(SpaceIdSchema.check(z.describe("Only this space."))),
  url: z.optional(bounded(LIMITS.MAX_URL).check(z.describe("Only items on this page."))),
  origin: z.optional(
    bounded(LIMITS.MAX_RESIDUE_ORIGIN).check(
      z.describe("Only items on this site, e.g. https://example.com."),
    ),
  ),
  repo: z.optional(
    bounded(LIMITS.MAX_PROVENANCE).check(
      z.describe("Only agent work on pages built from this repository."),
    ),
  ),
  after: z.optional(
    RefSchema.check(
      z.describe(
        "Continue a list past its first items: the ref the list named as the last one shown. Pass the same filters.",
      ),
    ),
  ),
});

export const ReadToolInputSchema = z.object({
  ref: ref(),
  before: z.optional(
    bounded(LIMITS.MAX_ANCHOR_ID).check(
      z.minLength(1),
      z.describe(
        "A message id from the thread (such as m12): return only the messages before it, as many as fit.",
      ),
    ),
  ),
});

export const ReadMarkupToolInputSchema = z.object({
  ref: ref(),
  selector: z.optional(
    bounded(LIMITS.MAX_SELECTOR).check(
      z.describe("Return only the elements matching this CSS selector."),
    ),
  ),
  offset: z.optional(count().check(z.describe("Character offset to start from. Defaults to 0."))),
  limit: z.optional(
    z
      .number()
      .check(
        z.gte(1),
        z.lte(MCP_MAX_MARKUP_SLICE),
        z.describe(`Characters to return, at most ${MCP_MAX_MARKUP_SLICE}.`),
      ),
  ),
});

export const LookToolInputSchema = z.object({
  ref: ref(),
  captureId: z.optional(
    bounded(LIMITS.MAX_CAPTURE_ID).check(
      z.describe(
        "A capture id from `read`. Defaults to the newest captured look or snapshot; an attached image needs its id.",
      ),
    ),
  ),
});

export const TakeToolInputSchema = z.object({
  ref: ref(),
  onBehalf: z.optional(
    z
      .boolean()
      .check(z.describe("Set true only when your person asked you to take a teammate's item.")),
  ),
});

export const ReleaseToolInputSchema = z.object({ ref: ref() });

export const ReplyToolInputSchema = z.object({
  ref: ref(),
  text: bounded(LIMITS.MAX_COMMENT_TEXT).check(
    z.minLength(1),
    z.describe("What you say in the thread."),
  ),
  clientId: clientId("reply"),
});

export const PostVariantsToolInputSchema = z.object({
  ref: ref(),
  variants: z
    .array(
      z.object({
        label: bounded(LIMITS.MAX_VARIANT_LABEL).check(z.minLength(1)),
        program: PageMutationProgramSchema,
      }),
    )
    .check(z.minLength(1), z.maxLength(LIMITS.MAX_VARIANTS_PER_SET)),
  reviseVariantId: z.optional(
    bounded(LIMITS.MAX_VARIANT_SET_ID).check(
      z.describe("Replace this variant's program instead of appending. Pass exactly one variant."),
    ),
  ),
  clientId: clientId("post"),
});

export const SetEditStateToolInputSchema = z.object({
  ref: ref(),
  state: z.enum(AGENT_EDIT_STATES),
});

export const WaitToolInputSchema = z.object({
  ref: ref(),
  timeoutSeconds: z.optional(
    z
      .number()
      .check(
        z.gte(0),
        z.lte(LIMITS.MAX_WAIT_SECONDS),
        z.describe(
          `Seconds to wait, at most ${LIMITS.MAX_WAIT_SECONDS}. Defaults to ${MCP_WAIT_DEFAULT_SECONDS}.`,
        ),
      ),
  ),
});

export const MCP_TOOL_NAMES = [
  "inbox",
  "read",
  "read_markup",
  "look",
  "take",
  "release",
  "reply",
  "post_variants",
  "set_edit_state",
  "wait",
] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export interface McpTool {
  name: McpToolName;
  description: string;
  inputSchema: z.ZodMiniObject;
}

/** Every tool, in the order `tools/list` shows them. */
export const MCP_TOOLS: readonly McpTool[] = [
  {
    name: "inbox",
    description:
      "Lists what people have handed to agents: your person's items under `yours`, teammates' under `teammates`, and what waits on your person. `space`, `url` and `origin` narrow every list; `repo` narrows only the agent work. Each list shows at most 40 items, newest first, and names the ref to pass as `after` (with the same filters) for the next items in that list. A space that fails or is slow is named as skipped. Start here, and work only on `yours` unless your person asked otherwise.",
    inputSchema: InboxToolInputSchema,
  },
  {
    name: "read",
    description:
      "Reads one item in full: its page, anchor, thread, an Edit's variants and kept state, its captures, and an excerpt of the captured markup. A long thread shows its newest messages; pass `before` with the oldest message id shown to get the earlier ones (only the thread comes back then). Read before you act, and again after waiting.",
    inputSchema: ReadToolInputSchema,
  },
  {
    name: "read_markup",
    description:
      "Returns a slice of the captured block or page HTML, optionally only the elements matching a selector. Use it when the excerpt in `read` is not enough.",
    inputSchema: ReadMarkupToolInputSchema,
  },
  {
    name: "look",
    description:
      "Returns one captured image of the item: by default the newest captured look or snapshot, or the capture you name with `captureId` (the only way to see an attached image). Use it only when the markup cannot tell you what you need to see.",
    inputSchema: LookToolInputSchema,
  },
  {
    name: "take",
    description:
      "Claims an item so other agents leave it alone for ten minutes; each of your writes extends the claim. Take an item before you start working on it.",
    inputSchema: TakeToolInputSchema,
  },
  {
    name: "release",
    description:
      "Gives up your claim and returns the item to pending. Use it when you stop without answering.",
    inputSchema: ReleaseToolInputSchema,
  },
  {
    name: "reply",
    description:
      "Adds your message to the item's thread, marked as written by an agent. Use it to say what you did, or to ask what you need to know. Pass a `clientId` and send the same one when retrying a reply that may have gone through.",
    inputSchema: ReplyToolInputSchema,
  },
  {
    name: "post_variants",
    description:
      "Adds variants to an Edit, each a labelled mutation program the person can preview and pick, or revises one variant. A refused op is reported with its index and reason. Pass a `clientId` and send the same one when retrying a call that may have gone through.",
    inputSchema: PostVariantsToolInputSchema,
  },
  {
    name: "set_edit_state",
    description:
      "Moves an Edit to `working` when you start changing the source, and to `implemented` when the change is done. Only for an Edit whose source onlay knows and you have; skip `working` when the Edit is already there.",
    inputSchema: SetEditStateToolInputSchema,
  },
  {
    name: "wait",
    description:
      'Waits for the next event on an item, such as a reply or a pick, and returns it (at most the 5 newest new messages), or "nothing yet" at the timeout. Use it when you need the person\'s answer to go on.',
    inputSchema: WaitToolInputSchema,
  },
];

/** One `tools/list` entry, its input schema as JSON Schema. */
export interface McpToolListing {
  name: McpToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** JSON Schema for one tool's input, as MCP clients read it. */
export function mcpInputJsonSchema(tool: McpTool): Record<string, unknown> {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(tool.inputSchema, {
    io: "input",
  }) as Record<string, unknown>;
  return schema;
}

/** The `tools/list` result's `tools` array. */
export function mcpToolList(): McpToolListing[] {
  return MCP_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: mcpInputJsonSchema(tool),
  }));
}
