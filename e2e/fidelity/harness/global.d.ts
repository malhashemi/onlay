// Ambient shape of the in-page fidelity bridge (`window.__onlayFidelity`) the
// bundled `render-entry.ts` attaches. Kept loose (`unknown` programs) so the
// spec needs no cross-package import of `@onlay/protocol`.

interface OnlayRenderReport {
  srcdoc: string;
  residue: {
    strippedPlaceholders: number;
    strippedUrls: number;
    authorRulesMissing: boolean;
    applied: number;
    misses: number;
    rejected: number;
  };
  captureResidue: string[];
  layoutWidth: number;
  blockRect: { x: number; y: number; width: number; height: number };
  nodeCount: number;
  strippedAssetRefs: number;
}

interface Window {
  __onlayFidelity: {
    render(blockSelector: string, program?: unknown): Promise<OnlayRenderReport>;
    applyLive(
      blockSelector: string,
      program: unknown,
    ): { applied: number; misses: number; rejected: number };
  };
}
