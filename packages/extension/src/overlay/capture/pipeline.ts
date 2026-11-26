// The real capture pipeline wiring (capture §10 items 11-14).
//
// Assembles the content-side privileged legs — harvest (§4), the witness (§5),
// and the two-phase SW upload (§8) — and installs them onto `captureFull` via
// `registerCapturePipeline`. The content entry calls `installCapturePipeline()`
// once at startup, so a locally-picked Edit-request actually produces a
// committed `edit-context` capture end to end (rung 1). Without this call
// `captureFull` still quiesces + walks, then no-ops — the fail-soft default.
import { inFrameOfPage } from "./frame-env";
import { harvest } from "./harvest";
import type { CaptureDraft } from "./index";
import { registerCapturePipeline } from "./index";
import { upload } from "./upload";
import { witness } from "./witness";

/** Install the real harvest/witness/upload legs onto `captureFull`. Idempotent. */
export function installCapturePipeline(): void {
  registerCapturePipeline({
    witness: framedWitness,
    // A block inside a frame of this page: its own document's sheets (A-3).
    harvest: (draft) =>
      harvest(draft, inFrameOfPage(draft.block) ? { doc: draft.block.ownerDocument } : {}),
    // upload reports the committed-or-refused outcome so the one-action
    // fresh-look can confirm success or admit a storage-cap refusal (§3).
    upload,
  });
}

/**
 * The witness, never for a block outside this document (2-A1): a block inside
 * a frame of this page without an address of its own keeps its structured
 * capture (walked and harvested in its own document) and gets no screenshot,
 * said as residue.
 */
function framedWitness(draft: CaptureDraft): Promise<void> {
  if (draft.block.ownerDocument === document) return witness(draft);
  draft.dropped ??= "unplaced";
  draft.residue.screenshotDropped("screenshot-inner-frame");
  return Promise.resolve();
}
