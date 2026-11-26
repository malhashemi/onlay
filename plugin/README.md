# The onlay agent plugin

The `onlay` MCP server (`https://app.onlay.dev/mcp`, Streamable HTTP) and the `onlay` skill, which tells an agent how to work the comments and Edits people hand to it on web pages. The agent acts as the person who signs in, sees what that person sees, and everything it writes is marked as an agent's. It works on its person's own hand-offs, and on a teammate's only when its person asks. What other people wrote and what came from a page reach it framed as data, never as instructions. The first tool call opens Onlay's sign-in (OAuth through WorkOS AuthKit) in the browser; the agent client must support OAuth for remote MCP servers.

The tools: `inbox`, `read`, `read_markup`, `look`, `take`, `release`, `reply`, `post_variants`, `set_edit_state` and `wait`. The skill (`skills/onlay/SKILL.md`) explains each.

Install it one way per agent.

## Claude Code

```sh
claude plugin marketplace add malhashemi/onlay
claude plugin install onlay@onlay
```

## Codex

```sh
codex plugin marketplace add malhashemi/onlay
codex plugin add onlay@onlay
```

## Other agents

Install the skill:

```sh
npx skills add malhashemi/onlay --skill onlay
```

Then add the MCP server in your agent's MCP settings, as a remote (Streamable HTTP) server named `onlay` with the URL `https://app.onlay.dev/mcp`. For agents that read the common JSON shape:

```json
{
  "mcpServers": {
    "onlay": { "type": "http", "url": "https://app.onlay.dev/mcp" }
  }
}
```

## Source stamps

When an Edit reads `Source: unknown` on a page served from a project the agent works in, the skill has the agent offer to add `@onlay/stamp`, and add it only when you agree. It is a dev-only build plugin for Vite, Next, SvelteKit and Astro that marks each block with the file and line it came from, so new Edits on that page read `Source: known` and the agent can change the source instead of only posting variants. It installs from `https://onlay.dev/download/onlay-stamp.tgz` (`npm i -D`, `pnpm add -D` or `bun add -d`); the configuration for each framework is in [`packages/stamp/README.md`](../packages/stamp/README.md).
