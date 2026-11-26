// What a page does when the person's access to a space changed (3b-C9): the
// space's in-flight kept-entry recovery stops (a newer snapshot decides), and
// a thread of that space open in the side panel is read again by id and
// closes with a note when the read answers not_found. The modal re-reads on
// its own (interaction-modal.ts).

export interface AccessChangedDeps {
  /** Invalidate the space's in-flight kept-entry recovery. */
  cancelKept(spaceId: string): void;
  /** The thread open in the side panel, with its space, or null. */
  openThread(): { id: string; spaceId: string | undefined } | null;
  /** Read it by id; calls `gone` when the answer is not_found. */
  readById(spaceId: string, id: string, gone: () => void): void;
  /** Close the side panel if it still shows `id`, with the short note. */
  closeIfStill(id: string): void;
  /** Ask the space for fresh snapshots (when connected). */
  resync(): void;
}

export function onAccessChanged(spaceId: string, deps: AccessChangedDeps): void {
  deps.cancelKept(spaceId);
  const open = deps.openThread();
  if (open && open.spaceId === spaceId) {
    deps.readById(spaceId, open.id, () => deps.closeIfStill(open.id));
  }
  deps.resync();
}
