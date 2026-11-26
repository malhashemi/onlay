// Optimistic reaction toggles (ADR-0018 §4), shared by both thread surfaces
// (extension thread panel, PWA detail): the click paints the LOCAL snapshot
// copy immediately; server truth reconciles on the next `interactions-state`
// frame. The returned undo reverts a failed send.
import type { RawThreadMsg } from "@onlay/protocol";

/** The quick-react set both surfaces offer as one-tap reactions. */
export const REACTIONS: readonly string[] = ["👍", "✅", "👀", "🎉", "❤️"];

/**
 * Apply a reaction toggle to the local message (mirrors kernel `react()`
 * semantics: idempotent, empty sets removed). Returns an undo that restores
 * the previous reactions object.
 */
export function applyLocalReaction(
  m: RawThreadMsg,
  emoji: string,
  actorId: string,
  on: boolean,
): () => void {
  const before = m.reactions;
  const restore = (): void => {
    if (before === undefined) delete m.reactions;
    else m.reactions = before;
  };
  const prev = before?.[emoji] ?? [];
  const has = prev.includes(actorId);
  if (on === has) return restore;
  const nextIds = on ? [...prev, actorId] : prev.filter((a) => a !== actorId);
  const reactions = { ...(before ?? {}) };
  if (nextIds.length > 0) reactions[emoji] = nextIds;
  else delete reactions[emoji];
  if (Object.keys(reactions).length > 0) m.reactions = reactions;
  else delete m.reactions;
  return restore;
}
