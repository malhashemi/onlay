// @onlay/render — the chrome-free portable renderer + op core, shared verbatim
// by the extension full-page view and the broker-served PWA. Protocol-only leaf
// (no chrome.*, proven by the fidelity gate and the absence of @types/chrome).

export { gunzip, inlinePlaceholders } from "./inline";
export { buildSrcdoc, type RenderResidue } from "./portable-renderer";
export {
  type ApplyResult,
  applyProgramToRoot,
  createPreviewEngine,
  type PreviewEngine,
  type PreviewRoot,
  type RefusedOp,
} from "./preview-engine";
