// Whose page may be captured. A variant arriving, or a set being opened, is a
// UI update and nothing more: onlay applies a program to the live page and
// uploads pixels or structured context from it automatically ONLY in the
// browser of the person who authored the owning Edit, in a tab whose own
// snapshot holds that Edit, on the Edit's exact page (`page-url.ts`). Anyone
// else viewing the same page captures nothing.
import type { App } from "./app";
import { samePage } from "./page-url";

/** True when this tab may capture for the Edit `interactionId` on its own. */
export function ownsEditHere(
  app: Pick<App, "byId" | "selfId" | "frameUrl">,
  interactionId: string | undefined,
): boolean {
  if (!interactionId) return false;
  const edit = app.byId(interactionId); // seen through this tab's own snapshot
  const self = app.selfId();
  return (
    edit !== undefined &&
    edit.kind === "change" &&
    self !== null &&
    edit.authorId === self &&
    samePage(edit.url, app.frameUrl())
  );
}
