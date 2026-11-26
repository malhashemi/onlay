/**
 * `POST /mcp` (spec §9): hand-written, stateless JSON-RPC 2.0 over Streamable
 * HTTP. Every request is answered with one `application/json` body; there is
 * no session and no server-sent stream, so `GET` is 405. Batches are refused.
 *
 * Order: the method, the credential (401 with the discovery header), the
 * per-person rate limit, the `MCP-Protocol-Version` header, then the
 * JSON-RPC message itself (at most 1.5 MiB, room for a full variant set, refused with 413 before
 * parsing), validated strictly: `jsonrpc` "2.0", no response
 * shapes, a `method` string, and an id that is a string or a finite number
 * (a request) or absent (a notification). A writing tool is also charged to
 * the person's shared write bucket.
 */
import {
  MCP_PROTOCOL_VERSIONS,
  MCP_TOOLS,
  type McpToolName,
  mcpToolList,
  PROTOCOL_VERSION,
} from "@onlay/protocol";
import * as z from "zod/mini";
import { Failure, failureResponse } from "../directory/failure";
import type { AgentIdentity } from "../edge/caller";
import { limit, MCP_PER_MINUTE } from "../edge/rate";
import type { Env } from "../env";
import { type AgentKeys, authorizationNeeded, resolveAgentCaller } from "./auth";
import { readBounded } from "./bounded";
import { MCP_INSTRUCTIONS } from "./instructions";
import { errorResult, ToolError, type ToolResult } from "./result";
import { AgentSpaces } from "./space";
import { TOOLS } from "./tools";

export interface McpDeps {
  /** Token verification keys; AuthKit's remote key set when absent. */
  keys?: AgentKeys;
}

const VERSION_HEADER = "MCP-Protocol-Version";
/** The largest request body read; a larger one is refused before parsing. */
/** Room for `post_variants` with a full set (1 MiB of programs) plus its JSON-RPC wrapping. */
export const MAX_MCP_BODY_BYTES = 1.5 * 1024 * 1024;

/* JSON-RPC error codes. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

type Id = string | number | null;

function rpcResult(id: Id, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function rpcError(id: Id, code: number, message: string, status = 200): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });
}

class InvalidParams extends Error {}

/** The first schema issue as a sentence that names the field. */
function paramsMessage(issues: z.core.$ZodIssue[], where: string): string {
  const issue = issues[0];
  if (issue === undefined) return `Invalid params: check ${where}.`;
  const path = issue.path.map(String).join(".");
  const field = path.length > 0 ? `\`${path}\`` : where;
  const hint = path === "ref" ? " Write it as <spaceId>/<interactionId>, as inbox lists it." : "";
  return `Invalid params: ${field}: ${issue.message}.${hint}`;
}

function negotiate(params: unknown): string {
  const asked =
    typeof params === "object" && params !== null
      ? (params as Record<string, unknown>).protocolVersion
      : undefined;
  const known = MCP_PROTOCOL_VERSIONS as readonly string[];
  return typeof asked === "string" && known.includes(asked)
    ? asked
    : (known[known.length - 1] ?? "2025-06-18");
}

/** The tools that write: each call is charged to the person's shared write bucket. */
const WRITING_TOOLS: ReadonlySet<McpToolName> = new Set([
  "take",
  "release",
  "reply",
  "post_variants",
  "set_edit_state",
]);

const CallParamsSchema = z.object({
  name: z.string(),
  arguments: z.optional(z.record(z.string(), z.unknown())),
});

async function callTool(spaces: AgentSpaces, params: unknown): Promise<ToolResult> {
  const call = z.safeParse(CallParamsSchema, params ?? {});
  if (!call.success) throw new InvalidParams(paramsMessage(call.error.issues, "params"));
  const tool = MCP_TOOLS.find((t) => t.name === call.data.name);
  if (tool === undefined) {
    throw new InvalidParams(
      `Invalid params: \`name\`: there is no tool ${JSON.stringify(call.data.name.slice(0, 64))}.`,
    );
  }
  const input = z.safeParse(tool.inputSchema, call.data.arguments ?? {});
  if (!input.success) throw new InvalidParams(paramsMessage(input.error.issues, "arguments"));
  const name = tool.name as McpToolName;
  try {
    if (WRITING_TOOLS.has(name)) await spaces.chargeWrite();
    return await TOOLS[name](spaces, input.data);
  } catch (error) {
    if (error instanceof ToolError) return errorResult(error.message);
    if (error instanceof Failure) return errorResult(error.message);
    console.error(`mcp tool ${tool.name} failed`, error);
    return errorResult("Something went wrong in onlay. Try again in a moment.");
  }
}

export async function handleMcp(request: Request, env: Env, deps: McpDeps = {}): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  let agent: AgentIdentity | null;
  try {
    agent = await resolveAgentCaller(request, env, deps.keys);
    if (agent === null) return authorizationNeeded(env);
    await limit(env.DB, `mcp:${agent.person.id}`, MCP_PER_MINUTE);
  } catch (error) {
    // An unverified email, or too many calls.
    if (error instanceof Failure) return failureResponse(error.code, error.message);
    throw error;
  }
  const version = request.headers.get(VERSION_HEADER);
  if (version !== null && !(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    return rpcError(
      null,
      INVALID_REQUEST,
      `Unsupported ${VERSION_HEADER} ${version.slice(0, 32)}; use one of ${MCP_PROTOCOL_VERSIONS.join(", ")}.`,
      400,
    );
  }

  const raw = await readBounded(request.body, request.headers, MAX_MCP_BODY_BYTES);
  if (raw === null) {
    return rpcError(null, INVALID_REQUEST, "Invalid request: the body is over 1.5 MiB.", 413);
  }
  let message: unknown;
  try {
    message = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return rpcError(null, PARSE_ERROR, "Parse error: the body isn't JSON.", 400);
  }
  if (Array.isArray(message)) {
    return rpcError(null, INVALID_REQUEST, "Batches aren't supported; send one message.", 400);
  }
  if (typeof message !== "object" || message === null) {
    return rpcError(null, INVALID_REQUEST, "Invalid request: send one JSON-RPC object.", 400);
  }
  const msg = message as Record<string, unknown>;
  // A request id is a string or a finite number; anything else is answered with a null id.
  const rawId = msg.id;
  const validId =
    typeof rawId === "string" || (typeof rawId === "number" && Number.isFinite(rawId));
  const id: Id = validId ? (rawId as string | number) : null;
  if (msg.jsonrpc !== "2.0") {
    return rpcError(id, INVALID_REQUEST, 'Invalid request: `jsonrpc` must be "2.0".', 400);
  }
  // This server never sends requests, so nothing shaped like a response is expected.
  if ("result" in msg || "error" in msg) {
    return rpcError(
      id,
      INVALID_REQUEST,
      "Invalid request: send a request or a notification, not a response.",
      400,
    );
  }
  if (typeof msg.method !== "string") {
    return rpcError(id, INVALID_REQUEST, "Invalid request: `method` is missing.", 400);
  }
  // A notification (no id) is accepted and never answered.
  if (!("id" in msg)) return new Response(null, { status: 202 });
  if (!validId) {
    return rpcError(
      null,
      INVALID_REQUEST,
      "Invalid request: `id` must be a string or a finite number.",
      400,
    );
  }

  try {
    switch (msg.method) {
      case "initialize":
        return rpcResult(id, {
          protocolVersion: negotiate(msg.params),
          capabilities: { tools: {} },
          serverInfo: { name: "onlay", version: `${PROTOCOL_VERSION}.0.0+${env.SHA ?? "dev"}` },
          instructions: MCP_INSTRUCTIONS,
        });
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: mcpToolList() });
      case "tools/call":
        return rpcResult(id, await callTool(new AgentSpaces(env, agent), msg.params));
      default:
        return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${msg.method.slice(0, 64)}.`);
    }
  } catch (error) {
    if (error instanceof InvalidParams) return rpcError(id, INVALID_PARAMS, error.message);
    console.error("mcp request failed", error);
    return rpcError(id, INTERNAL_ERROR, "Something went wrong in onlay.");
  }
}
