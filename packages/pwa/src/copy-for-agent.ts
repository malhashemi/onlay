// What Settings → Agent shows. The Copy for agent text itself lives in
// `@onlay/render/copy-for-agent`, shared with the extension.
/* ── connecting an agent (Settings → Agent) ────────────────────────── */

/** The MCP client config for this deployment. */
export function mcpConfig(origin: string): string {
  return JSON.stringify({ mcpServers: { onlay: { type: "http", url: `${origin}/mcp` } } }, null, 2);
}

/** The plugin install lines, per agent. */
export const PLUGIN_LINES = {
  claude: "claude plugin marketplace add malhashemi/onlay\nclaude plugin install onlay@onlay",
  codex: "codex plugin marketplace add malhashemi/onlay\ncodex plugin add onlay@onlay",
  others: "npx skills add malhashemi/onlay --skill onlay",
} as const;
