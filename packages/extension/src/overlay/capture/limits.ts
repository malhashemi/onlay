// Extension-local capture ceilings (Stage 1 capture spec §2, §5).
//
// These are the walk/quiescence/witness bounds that never ride the wire — the
// protocol `LIMITS` (byte/part budgets) stays the transport contract. Kept in
// one frozen block so the walker/quiescence/witness read one source and tests
// can pin them.
import { LIMITS } from "@onlay/protocol";

export const CAPTURE_LIMITS = {
  // walk / serialize (§1.5, §2)
  MAX_SPINE_ANCESTORS: 12, // <html>..block ancestor cap; deeper chains collapse the middle
  MAX_CAPTURE_NODES: 1500, // hard node ceiling for spine + habitat + block subtree
  MAX_NODE_DECLS: 120, // defensive per-node declaration cap (allowlist keeps it far lower)
  MAX_WALK_STEPS: 20_000, // node-visit budget; exhaustion serializes what exists
  HABITAT_SIBLINGS: 2, // ±N previous/next siblings reproduced around the block
  HABITAT_DEPTH: 2, // sibling subtree serialization depth
  MAX_SNIPPET: 512, // per-habitat-text truncation

  // quiescence (§3)
  QUIESCE_DEADLINE_MS: 1_500, // whole-quiescence bound; timeout freezes the current frame

  // harvest (§4) — the caller-side timings the SW fetch leg obeys
  HARVEST_FETCH_TIMEOUT_MS: 5_000,
  MAX_REDIRECTS: 3,
  MAX_IMPORT_DEPTH: 3,

  // witness (§5)
  OVERLAP: 0.1, // vertical tile overlap fraction (first-write-wins seam)
  WITNESS_STEP_MS: 550, // throttle between captureVisibleTab grabs (~2/sec limit)
  MAX_WITNESS_TILES: 12, // scroll-and-stitch tile cap
  THUMB_MAX_EDGE: 320, // thumbnail longest-edge px

  // residue (§6) — bounds on the closed enumeration. Sourced FROM the protocol
  // `LIMITS` (not re-stated) so the extension can never emit a manifest the
  // server schema then rejects: if the wire bounds tighten, these follow.
  MAX_RESIDUE_ENTRIES: LIMITS.MAX_RESIDUE_ENTRIES,
  MAX_RESIDUE_ORIGINS: LIMITS.MAX_RESIDUE_ORIGINS,
  MAX_RESIDUE_DETAIL: LIMITS.MAX_RESIDUE_DETAIL,
} as const;

// Widened to plain `number` (vs. the literal types `as const` gives the values
// above) so callers — chiefly tests — can override individual bounds with
// arbitrary numbers.
export type CaptureLimits = { [K in keyof typeof CAPTURE_LIMITS]: number };
