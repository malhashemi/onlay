// An MCP client as an agent's harness would be: JSON-RPC 2.0 over `POST /mcp`,
// stateless, authenticated with the dev bearer (`Bearer dev:<email>`), which
// the dev environment accepts in place of an AuthKit access token.

export interface ToolResult {
  text: string;
  isError: boolean;
}

export interface McpClient {
  initialize(): Promise<{ serverInfo: { name: string } }>;
  /** Calls a tool; returns its text block and whether it failed. */
  call(tool: string, args?: Record<string, unknown>): Promise<ToolResult>;
}

export function mcpClient(origin: string, email: string): McpClient {
  let id = 0;
  async function rpc(method: string, params: unknown): Promise<unknown> {
    id += 1;
    const res = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer dev:${email}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${await res.text()}`);
    const body = (await res.json()) as {
      result?: unknown;
      error?: { code: number; message: string };
    };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  }
  return {
    initialize: async () =>
      (await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "onlay-e2e", version: "0" },
      })) as { serverInfo: { name: string } },
    async call(tool, args = {}) {
      const result = (await rpc("tools/call", { name: tool, arguments: args })) as {
        content: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      const text = result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      return { text, isError: result.isError === true };
    },
  };
}
