/**
 * Rendering helpers for agent-facing surfaces (spec §9): plain functions the
 * MCP layer composes. Nothing here delivers anything.
 */
export { htmlToMarkdown } from "./markdown";
export {
  anchorLine,
  fitFramed,
  formatProvenance,
  markupExcerpt,
  promptSafeProgram,
  renderMessage,
  renderThread,
  type ThreadRenderOptions,
  untrustedBlock,
  untrustedInline,
} from "./thread";
