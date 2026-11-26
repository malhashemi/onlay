// Settings → Agent: the MCP config and the plugin install lines.
import { describe, expect, test } from "bun:test";
import { mcpConfig, PLUGIN_LINES } from "./copy-for-agent";

const ORIGIN = "https://app.onlay.dev";

describe("connecting an agent", () => {
  test("the MCP config points at <origin>/mcp", () => {
    expect(JSON.parse(mcpConfig(ORIGIN))).toEqual({
      mcpServers: { onlay: { type: "http", url: "https://app.onlay.dev/mcp" } },
    });
  });

  test("the plugin lines are the published ones", () => {
    expect(PLUGIN_LINES.claude).toBe(
      "claude plugin marketplace add malhashemi/onlay\nclaude plugin install onlay@onlay",
    );
    expect(PLUGIN_LINES.codex).toBe(
      "codex plugin marketplace add malhashemi/onlay\ncodex plugin add onlay@onlay",
    );
    expect(PLUGIN_LINES.others).toBe("npx skills add malhashemi/onlay --skill onlay");
  });
});
