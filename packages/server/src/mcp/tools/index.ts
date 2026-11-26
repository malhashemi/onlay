/**
 * The ten tools (spec §9), by name. Arguments arrive validated against the
 * tool's input schema from `@onlay/protocol`, the same schema `tools/list`
 * publishes.
 */
import type { McpToolName } from "@onlay/protocol";
import type { ToolResult } from "../result";
import type { AgentSpaces } from "../space";
import { inbox } from "./inbox";
import { look, read, readMarkup } from "./read";
import { wait } from "./wait";
import { postVariants, release, reply, setEditState, take } from "./work";

// biome-ignore lint/suspicious/noExplicitAny: each tool takes its own schema's output
type Tool = (spaces: AgentSpaces, input: any) => Promise<ToolResult>;

export const TOOLS: Record<McpToolName, Tool> = {
  inbox,
  read,
  read_markup: readMarkup,
  look,
  take,
  release,
  reply,
  post_variants: postVariants,
  set_edit_state: setEditState,
  wait,
};
