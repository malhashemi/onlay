// Which space an interaction or a variant set lives in, for the paths that
// hold only an id (capture uploads, variant frames). The App writes it from
// every space-tagged snapshot and receipt; readers fall back to undefined and
// the service worker refuses a frame with no space.
const interactionSpace = new Map<string, string>();
const setSpace = new Map<string, string>();

export function noteInteractionSpace(interactionId: string, spaceId: string): void {
  interactionSpace.set(interactionId, spaceId);
}

export function spaceOfInteraction(interactionId: string): string | undefined {
  return interactionSpace.get(interactionId);
}

export function noteSetSpace(setId: string, spaceId: string): void {
  setSpace.set(setId, spaceId);
}

export function spaceOfSet(setId: string): string | undefined {
  return setSpace.get(setId);
}

/** The space a frame belongs to: its own `spaceId`, else its interaction's, else its set's. */
export function spaceOfFrame(frame: Record<string, unknown>): string | undefined {
  if (typeof frame.spaceId === "string") return frame.spaceId;
  if (typeof frame.interactionId === "string") {
    const s = interactionSpace.get(frame.interactionId);
    if (s) return s;
  }
  if (typeof frame.setId === "string") return setSpace.get(frame.setId);
  return undefined;
}
